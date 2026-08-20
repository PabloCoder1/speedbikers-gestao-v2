import { OAuth2Client } from "google-auth-library";

/**
 * Verificação de token OIDC do Google.
 *
 * A `api` é pública no Cloud Run porque o webhook do Mercado Livre precisa
 * alcançá-la e não envia credencial do Google. Por isso as rotas `/internal/`
 * verificam o token **na aplicação**, e não na plataforma.
 *
 * Sem segredo compartilhado (D-024): a confiança vem da assinatura do Google e
 * do e-mail da service account, ambos verificáveis.
 */

export interface OidcVerifierConfig {
  /** Audience esperada — a URL do próprio serviço. */
  audience: string;
  /** Service accounts autorizadas a chamar. Lista fechada. */
  allowedServiceAccounts: readonly string[];
}

export interface VerificationResult {
  ok: boolean;
  email?: string;
  reason?: string;
}

export interface OidcVerifier {
  verify: (authorizationHeader: string | undefined) => Promise<VerificationResult>;
}

const BEARER = /^Bearer (.+)$/i;

export function createOidcVerifier(
  config: OidcVerifierConfig,
  client = new OAuth2Client(),
): OidcVerifier {
  const allowed = new Set(config.allowedServiceAccounts);

  return {
    verify: async (authorizationHeader) => {
      if (authorizationHeader === undefined) {
        return { ok: false, reason: "authorization ausente" };
      }

      const match = BEARER.exec(authorizationHeader);

      if (match?.[1] === undefined) {
        return { ok: false, reason: "authorization não é Bearer" };
      }

      let email: string | undefined;

      try {
        const ticket = await client.verifyIdToken({
          idToken: match[1],
          audience: config.audience,
        });

        email = ticket.getPayload()?.email;
      } catch {
        // A mensagem da biblioteca pode conter fragmento do token. Nunca
        // propagar: erro de autenticação não deve virar canal de vazamento.
        return { ok: false, reason: "token inválido" };
      }

      if (email === undefined) {
        return { ok: false, reason: "token sem e-mail" };
      }

      if (!allowed.has(email)) {
        return { ok: false, reason: "service account não autorizada" };
      }

      return { ok: true, email };
    },
  };
}
