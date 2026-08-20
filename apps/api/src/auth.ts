import type { AdminClient } from "@sb/db";

/**
 * Autenticação de USUÁRIO na `api`.
 *
 * Diferente do OIDC de `src/oidc.ts`, que autentica Cloud Scheduler e Cloud
 * Tasks. Aqui o chamador é uma pessoa, com sessão do Supabase Auth.
 *
 * `docs/PROMPT_MASTER.md` secao 10: não confiar na interface para autorização.
 * A `api` reavalia papel e organização no servidor, sempre.
 */

export type Role = "ADMIN" | "GESTOR" | "ANALISTA" | "OPERADOR" | "VISUALIZADOR";

export interface Caller {
  userId: string;
  organizationId: string;
  role: Role;
}

export type AuthResult =
  | { ok: true; caller: Caller }
  | { ok: false; status: 401 | 403; reason: string };

const BEARER = /^Bearer (.+)$/i;

export interface Authenticator {
  authenticate: (
    authorizationHeader: string | undefined,
    allowed: readonly Role[],
  ) => Promise<AuthResult>;
}

export function createAuthenticator(db: AdminClient): Authenticator {
  return {
    authenticate: async (authorizationHeader, allowed) => {
      const match = BEARER.exec(authorizationHeader ?? "");
      const token = match?.[1];

      if (token === undefined) {
        return { ok: false, status: 401, reason: "authorization ausente ou malformado" };
      }

      // Valida contra o próprio Auth do Supabase. Custa uma chamada de rede por
      // request; para uma ferramenta interna de baixo volume isso é irrelevante
      // perto do ganho de não reimplementar verificação de assinatura.
      //
      // Se algum dia virar gargalo medido, o caminho é verificar o JWT
      // localmente via JWKS — não é otimização para fazer agora.
      const { data, error } = await db.auth.getUser(token);

      // `getUser` devolve união discriminada: sem erro, `data.user` existe.
      // Checar os dois seria redundante e o lint com tipos acusa.
      if (error !== null) {
        return { ok: false, status: 401, reason: "token inválido" };
      }

      // Papel e organização vêm do BANCO, nunca do token. Claim é editável no
      // futuro; a tabela é a verdade.
      const membership = await db
        .from("organization_members")
        .select("organization_id, role")
        .eq("user_id", data.user.id)
        .limit(1)
        .maybeSingle();

      if (membership.error !== null || membership.data === null) {
        return { ok: false, status: 403, reason: "usuário sem organização" };
      }

      const role = membership.data.role as Role;

      if (!allowed.includes(role)) {
        return { ok: false, status: 403, reason: "papel sem permissão para esta ação" };
      }

      return {
        ok: true,
        caller: {
          userId: data.user.id,
          organizationId: membership.data.organization_id,
          role,
        },
      };
    },
  };
}
