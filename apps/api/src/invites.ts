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
  /**
   * Para onde o link leva depois de verificado — a primeira origem de
   * `WEB_ORIGINS`.
   *
   * **Sem ela o Auth usa a "Site URL" do projeto**, e em 2026-09-10 essa URL
   * era `http://localhost:3000`: todo convite mandava a pessoa para a MÁQUINA
   * DELA. O convidado abria o link e não chegava a lugar nenhum (D-303).
   *
   * Opcional porque o ambiente pode não declarar `WEB_ORIGINS` (serviço que só
   * recebe chamada servidor a servidor). E ela só vale se a URL estiver na
   * lista de redirecionamentos permitidos do projeto Supabase — o GoTrue cai
   * de volta na Site URL em silêncio quando não está.
   */
  webUrl?: string;
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
    const gerado = await deps.db.auth.admin.generateLink({
      type: "invite",
      email,
      ...(deps.webUrl === undefined ? {} : { options: { redirectTo: deps.webUrl } }),
    });

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

/**
 * REEMITIR O LINK DE ACESSO de quem já é membro (D-303).
 *
 * ---------------------------------------------------------------------------
 * POR QUE EXISTE
 * ---------------------------------------------------------------------------
 *
 * O convite de D-296 mostra o link UMA VEZ e não o guarda — ele é credencial.
 * Convidar a mesma pessoa de novo devolve `already_member` sem link, de
 * propósito: repetir o convite não pode mudar papel nem alcance.
 *
 * Sobrou um caso real, e ele apareceu no primeiro uso de verdade: o link se
 * perdeu (ou foi aberto antes de a tela de definir senha existir, que foi o
 * que aconteceu em 2026-09-10). A pessoa tem vínculo, tem conta no Auth, e
 * **não tem como entrar**. Sem esta rota, o caminho seria apagar o usuário e
 * convidar de novo — que apaga junto a trilha de acesso dela.
 *
 * ---------------------------------------------------------------------------
 * É `recovery`, NÃO `invite`
 * ---------------------------------------------------------------------------
 *
 * `invite` recusa e-mail que já existe. `recovery` é o mesmo mecanismo do
 * "esqueci minha senha": leva à tela de definir senha (D-302 aceita os dois
 * tipos), e a senha antiga, se houver, continua valendo até a nova ser salva.
 *
 * ---------------------------------------------------------------------------
 * O QUE ELA IMPÕE
 * ---------------------------------------------------------------------------
 *
 * **A pessoa precisa ser membro DESTA organização.** `AdminClient` atravessa a
 * RLS: sem esta checagem, um ADMIN emitiria link de acesso para a conta de
 * qualquer usuário do sistema — inclusive de outra empresa. É a fronteira de
 * D-161, no ponto onde ela mais custa.
 *
 * O poder que resta é real e fica dito: um ADMIN pode emitir link para outro
 * membro da própria organização e, com ele, definir a senha daquela conta.
 * Isso é menos do que ele já pode fazer (mudar papel, revogar acesso), e a
 * tela avisa antes de gerar.
 */
export type ReissueOutcome =
  | { status: "issued"; link: string }
  | { status: "not_member" }
  | { status: "error"; reason: string };

export async function reissueAccessLink(
  deps: InviteDeps,
  caller: Caller,
  userId: string,
): Promise<ReissueOutcome> {
  const membro = await deps.db
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", caller.organizationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (membro.error !== null) {
    return { status: "error", reason: membro.error.message };
  }

  // Não é membro daqui: a resposta é a mesma para "não existe" e "existe em
  // outra organização" — distinguir as duas contaria quem existe no sistema.
  if (membro.data === null) {
    return { status: "not_member" };
  }

  const pessoa = await deps.db.auth.admin.getUserById(userId);

  if (pessoa.error !== null) {
    return { status: "error", reason: pessoa.error.message };
  }

  const email = pessoa.data.user.email ?? "";

  // Membro sem e-mail no Auth não tem por onde receber link — e inventar um
  // seria criar acesso para um endereço que ninguém escolheu.
  if (email === "") {
    return { status: "error", reason: "esta pessoa não tem e-mail no Auth" };
  }

  const gerado = await deps.db.auth.admin.generateLink({
    type: "recovery",
    email,
    ...(deps.webUrl === undefined ? {} : { options: { redirectTo: deps.webUrl } }),
  });

  if (gerado.error !== null) {
    deps.logger.error("access_link_failed", {
      organization_id: caller.organizationId,
      email_domain: dominio(email),
      error: gerado.error.message,
    });

    return { status: "error", reason: gerado.error.message };
  }

  // O e-mail e o link ficam FORA do log: os dois são credencial, e log é o
  // lugar que mais gente lê depois.
  deps.logger.info("access_link_issued", {
    organization_id: caller.organizationId,
    actor_user_id: caller.userId,
    target_user_id: userId,
  });

  return { status: "issued", link: gerado.data.properties.action_link };
}
