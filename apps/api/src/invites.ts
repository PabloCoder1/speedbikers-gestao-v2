import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import type { Caller } from "./auth.js";

/**
 * Convite de usuário (D-296) — o botão "Convidar usuário" que o frame desenha
 * desde sempre e que D-271 recusou por ser **feature, não composição**.
 *
 * A recusa continua correta como regra de fatia visual; o que mudou foi o
 * pedido. E como toda escrita privilegiada desta casa, ela nasce na `api`:
 * criar um usuário exige a chave de service role, que **nunca** alcança o
 * navegador (D-012).
 *
 * ## Por que LINK, e não e-mail enviado
 *
 * `inviteUserByEmail` manda o convite pelo SMTP do projeto — e o projeto não
 * tem SMTP próprio configurado. Um convite que depende de entrega de e-mail
 * que ninguém provou hoje é a promessa que esta casa recusa em toda fatia: a
 * pessoa clicaria, a tela diria "convite enviado", e o e-mail não chegaria.
 *
 * `generateLink({ type: "invite" })` cria o usuário e **devolve o link** sem
 * mandar nada. Quem convida copia e envia pelo canal que já usa. Quando o
 * projeto tiver SMTP, mandar o e-mail vira uma linha a mais — e o link
 * continua sendo o caminho que funciona sem depender dele.
 *
 * ## O que a rota impõe, e o que ela recusa
 *
 * - **ADMIN**, e só: quem convida decide papel e alcance de outra pessoa;
 * - **a organização é a do chamador**, nunca do payload — `AdminClient`
 *   atravessa a RLS, então a fronteira é imposta em código (a lição de D-161);
 * - **contas pedidas precisam ser da organização**: um id de fora não vira
 *   permissão silenciosa, vira recusa;
 * - **e-mail que já tem conta** não é erro: vira vínculo novo na organização,
 *   e a resposta diz que não há link porque não há convite a aceitar.
 */

export interface InviteDeps {
  db: AdminClient;
  logger: Logger;
}

/** Os cinco papéis do `check` de `organization_members` (D-271). */
export const ORGANIZATION_ROLES = ["ADMIN", "GESTOR", "ANALISTA", "OPERADOR", "VISUALIZADOR"] as const;

export const inviteRequestSchema = z.object({
  email: z.email("e-mail inválido").max(254),
  role: z.enum(ORGANIZATION_ROLES),
  /** Contas que a pessoa poderá alcançar. ADMIN alcança todas por papel — a lista fica vazia. */
  mlAccountIds: z.array(z.uuid()).max(50).optional(),
});

export type InviteRequest = z.infer<typeof inviteRequestSchema>;

export type InviteOutcome =
  | { status: "invited"; userId: string; inviteLink: string }
  | { status: "linked"; userId: string }
  | { status: "already_member" }
  | { status: "invalid"; reason: string }
  | { status: "error"; reason: string };

/** O e-mail nunca vai para o log — nem em erro. Só o domínio, que basta para diagnosticar. */
function dominio(email: string): string {
  return email.slice(email.indexOf("@"));
}

export async function inviteOrganizationMember(
  deps: InviteDeps,
  caller: Caller,
  request: InviteRequest,
): Promise<InviteOutcome> {
  const email = request.email.trim().toLowerCase();

  // As contas pedidas precisam ser DESTA organização. `AdminClient` ignora a
  // RLS: sem esta checagem, um id de outra organização viraria permissão.
  const contasPedidas = request.mlAccountIds ?? [];

  if (contasPedidas.length > 0) {
    const contas = await deps.db
      .from("ml_accounts")
      .select("id")
      .eq("organization_id", caller.organizationId)
      .in("id", contasPedidas);

    if (contas.error !== null) {
      return { status: "error", reason: contas.error.message };
    }

    if (contas.data.length !== contasPedidas.length) {
      return { status: "invalid", reason: "conta que não pertence a esta organização" };
    }
  }

  /*
    O usuário pode já existir — alguém de outra organização, ou um convite
    anterior. `generateLink` falha nesse caso, e a falha NÃO é o fim: o
    caminho certo é vincular, não recusar.
  */
  const existente = await encontrarPorEmail(deps, email);

  if (existente.status === "error") {
    return existente;
  }

  let userId = existente.userId;
  let inviteLink: string | null = null;

  if (userId === null) {
    const gerado = await deps.db.auth.admin.generateLink({ type: "invite", email });

    // `user` nao e anulavel no tipo quando `error` e nulo; a condicao morta
    // esconderia a leitura real (regra do lint desta casa).
    if (gerado.error !== null) {
      deps.logger.error("invite_generate_failed", {
        organization_id: caller.organizationId,
        email_domain: dominio(email),
        error: gerado.error.message,
      });

      return { status: "error", reason: gerado.error.message };
    }

    userId = gerado.data.user.id;
    inviteLink = gerado.data.properties.action_link;
  }

  const jaMembro = await deps.db
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", caller.organizationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (jaMembro.error !== null) {
    return { status: "error", reason: jaMembro.error.message };
  }

  if (jaMembro.data !== null) {
    // Idempotência sem escrita: convidar de novo quem já é membro não muda
    // papel nem alcance — mudar acesso é o outro comando, com trilha própria.
    return { status: "already_member" };
  }

  const vinculo = await deps.db
    .from("organization_members")
    .insert({ organization_id: caller.organizationId, user_id: userId, role: request.role });

  if (vinculo.error !== null) {
    return { status: "error", reason: vinculo.error.message };
  }

  if (contasPedidas.length > 0) {
    const permissoes = await deps.db
      .from("user_account_permissions")
      .insert(contasPedidas.map((id) => ({ user_id: userId, ml_account_id: id })));

    if (permissoes.error !== null) {
      /*
        O vínculo já existe e a permissão falhou: a pessoa entra SEM alcance de
        conta, e isso é dito. Desfazer o vínculo aqui seria pior — deixaria um
        usuário criado no Auth sem organização nenhuma, que é órfão de verdade.
      */
      deps.logger.error("invite_permissions_failed", {
        organization_id: caller.organizationId,
        error: permissoes.error.message,
      });

      return { status: "error", reason: `membro criado, mas sem acesso às contas: ${permissoes.error.message}` };
    }
  }

  deps.logger.info("invite_created", {
    organization_id: caller.organizationId,
    role: request.role,
    accounts: contasPedidas.length,
    novo_usuario: inviteLink !== null,
  });

  return inviteLink === null ? { status: "linked", userId } : { status: "invited", userId, inviteLink };
}

/**
 * Procura o usuário pelo e-mail. `listUsers` pagina, e o filtro por e-mail não
 * é parâmetro da API admin — a varredura é o caminho documentado. O teto de
 * páginas existe para a rota não virar varredura infinita numa base grande;
 * quando ele for atingido, o convite falha DIZENDO isso, em vez de criar um
 * segundo usuário para o mesmo e-mail.
 */
async function encontrarPorEmail(
  deps: InviteDeps,
  email: string,
): Promise<{ status: "ok"; userId: string | null } | { status: "error"; reason: string }> {
  const PAGINAS = 20;
  const POR_PAGINA = 200;

  for (let page = 1; page <= PAGINAS; page += 1) {
    const listados = await deps.db.auth.admin.listUsers({ page, perPage: POR_PAGINA });

    if (listados.error !== null) {
      return { status: "error", reason: listados.error.message };
    }

    const achado = listados.data.users.find((user) => user.email?.toLowerCase() === email);

    if (achado !== undefined) {
      return { status: "ok", userId: achado.id };
    }

    if (listados.data.users.length < POR_PAGINA) {
      return { status: "ok", userId: null };
    }
  }

  return { status: "error", reason: "a base de usuários passou do teto de varredura do convite" };
}
