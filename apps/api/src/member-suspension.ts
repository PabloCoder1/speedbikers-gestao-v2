import { z } from "zod";

import type { Caller } from "./auth.js";
import type { InviteDeps } from "./invites.js";

/**
 * SUSPENDER E REATIVAR o acesso de um membro (D-354).
 *
 * O pedido foi "tirar o acesso de alguém". Há duas coisas diferentes nessa
 * frase, e a tela oferece as duas:
 *
 * - **remover da organização** apaga o vínculo — já era possível no banco
 *   (`organization_members_admin_writes` + `guard_last_admin`) e mora numa
 *   Server Action da web, sob RLS;
 * - **suspender** mantém tudo (vínculo, papel, contas, histórico) e só impede a
 *   pessoa de ENTRAR. É o que se quer em férias, afastamento, dúvida — e é
 *   reversível com um clique.
 *
 * ## Por que no Auth, e não numa coluna da organização
 *
 * Uma coluna `suspended_at` em `organization_members` exigiria reescrever cada
 * função de autorização (`has_org_role`, `has_account_access`, `is_member_of`…)
 * para ignorar o suspenso — dezenas de policies, e bastaria esquecer uma para a
 * suspensão ser só visual. O `banned_until` do Auth recusa o login e a
 * renovação do token num lugar só. Por isso esta escrita é da `api`: mexer no
 * Auth de outra pessoa exige service role (D-012).
 *
 * **O limite, dito:** o token que a pessoa já tem continua válido até expirar
 * (1 hora, `jwt_expiry`). Suspender não derruba uma aba aberta na hora; impede
 * a próxima renovação.
 *
 * ## O que ela recusa
 *
 * - **a si mesmo** — um ADMIN que se suspende perde a tela que desfaria isso;
 * - **quem não é membro DESTA organização** — `AdminClient` atravessa a RLS, e
 *   a fronteira de D-161 é imposta aqui;
 * - **quem também é membro de OUTRA organização** — o ban é da conta inteira, e
 *   suspender aqui a trancaria lá, onde este ADMIN não manda.
 *
 * O último ADMIN não precisa de guarda própria: quem chama é ADMIN desta
 * organização e não é o alvo, então sobra pelo menos um.
 */

export const suspensionRequestSchema = z.object({ suspended: z.boolean() });

export type SuspensionOutcome =
  | { status: "ok"; suspended: boolean; changed: boolean }
  | { status: "not_member" }
  | { status: "invalid"; reason: string }
  | { status: "error"; reason: string };

/**
 * "Para sempre" no GoTrue. Não existe duração infinita na API; cem anos é o
 * valor que a própria documentação do Supabase usa para banimento permanente.
 */
const SUSPENSO_POR = "876000h";

export async function setMemberSuspension(
  deps: InviteDeps,
  caller: Caller,
  userId: string,
  suspended: boolean,
): Promise<SuspensionOutcome> {
  if (userId === caller.userId) {
    return { status: "invalid", reason: "você não pode suspender o próprio acesso" };
  }

  const vinculos = await deps.db.from("organization_members").select("organization_id").eq("user_id", userId);

  if (vinculos.error !== null) {
    return { status: "error", reason: vinculos.error.message };
  }

  // "Não é membro daqui" e "não existe" têm a MESMA resposta: distinguir as
  // duas contaria a um ADMIN quem existe no sistema inteiro.
  if (!vinculos.data.some((vinculo) => vinculo.organization_id === caller.organizationId)) {
    return { status: "not_member" };
  }

  if (vinculos.data.length > 1) {
    return {
      status: "invalid",
      reason: "esta pessoa também pertence a outra organização — suspender bloquearia o acesso dela lá também",
    };
  }

  const atual = await deps.db.auth.admin.getUserById(userId);

  if (atual.error !== null) {
    return { status: "error", reason: atual.error.message };
  }

  const banidoAte = atual.data.user.banned_until;
  const estaSuspenso = typeof banidoAte === "string" && Date.parse(banidoAte) > Date.now();

  /*
    IDEMPOTENTE, e sem escrita. Dois cliques em "Suspender" (ou duas abas) não
    podem gravar dois eventos: o histórico diria que a pessoa foi suspensa
    duas vezes, e ela foi uma.
  */
  if (estaSuspenso === suspended) {
    return { status: "ok", suspended, changed: false };
  }

  const atualizado = await deps.db.auth.admin.updateUserById(userId, {
    ban_duration: suspended ? SUSPENSO_POR : "none",
  });

  if (atualizado.error !== null) {
    deps.logger.error("member_suspension_failed", {
      organization_id: caller.organizationId,
      suspended,
      error: atualizado.error.message,
    });

    return { status: "error", reason: atualizado.error.message };
  }

  /*
    O EVENTO É ESCRITO AQUI, e não por trigger: a suspensão acontece em
    `auth.users`, onde este projeto não põe trigger. O ator vem do token de
    quem chamou — `service_role` não tem `auth.uid()`, e sem isto o histórico
    diria "sistema" sobre um ato de uma pessoa.
  */
  const evento = await deps.db.from("organization_access_events").insert({
    organization_id: caller.organizationId,
    event_type: suspended ? "MEMBER_SUSPENDED" : "MEMBER_REACTIVATED",
    target_user_id: userId,
    actor_user_id: caller.userId,
  });

  if (evento.error !== null) {
    // A suspensão JÁ valeu. Dizer "falhou" mandaria tentar de novo algo que
    // deu certo; dizer "deu certo" esconderia o buraco no histórico.
    deps.logger.error("member_suspension_event_failed", {
      organization_id: caller.organizationId,
      suspended,
      error: evento.error.message,
    });

    return {
      status: "error",
      reason: `acesso ${suspended ? "suspenso" : "reativado"}, mas o histórico não registrou: ${evento.error.message}`,
    };
  }

  deps.logger.info("member_suspension_changed", { organization_id: caller.organizationId, suspended });

  return { status: "ok", suspended, changed: true };
}
