import { loadEncryptionKey } from "@sb/mercado-livre";
import { z } from "zod";

/**
 * Variáveis de ambiente do `worker`.
 *
 * `docs/DEPLOYMENT.md` secao 5: validação com Zod no boot. Falta variável, o
 * processo morre no start — nunca em runtime, às três da manhã.
 *
 * O schema cresce junto com as features. Não declarar aqui um segredo que
 * ainda não é usado: isso só impediria o desenvolvimento local sem ganho.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /** O Cloud Run injeta `PORT`; localmente cai no padrão. */
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),

  /** URL do projeto Supabase. Não é segredo. */
  SUPABASE_URL: z.url(),

  /**
   * Chave `service_role`. É segredo: vem do Secret Manager, nunca de variável
   * versionada. Ignora RLS, então é a credencial mais poderosa do sistema
   * (docs/DEPLOYMENT.md secao 5).
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  /** Bucket que guarda as exportações do UpSeller. */
  ERP_IMPORTS_BUCKET: z.string().min(1),

  /**
   * OAuth do Mercado Livre (D-041, D-046) — o worker só usa isto para
   * RENOVAR (`refresh_token`) um `access_token` perto de expirar durante a
   * reconciliação; a troca inicial do `code` é só da `api`.
   */
  MERCADO_LIVRE_CLIENT_ID: z.string().min(1),
  MERCADO_LIVRE_CLIENT_SECRET: z.string().min(1),

  /** Mesma chave que a `api` usa para cifrar — precisa decifrar o que ela gravou. */
  ML_TOKEN_ENCRYPTION_KEY: z.string().refine(
    (value) => {
      try {
        loadEncryptionKey(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: "precisa decodificar em base64 para 32 bytes (AES-256)" },
  ),

  /**
   * Cloud Tasks — o worker se REENFILEIRA para si mesmo (`backfill.orders`
   * avançando pedaço a pedaço, `docs/HANDOFF.md`). `WORKER_URL` é a própria
   * URL deste serviço: alvo e audience OIDC do próximo pedaço.
   */
  GCP_PROJECT_ID: z.string().min(1),
  GCP_REGION: z.string().min(1),
  WORKER_URL: z.url(),
  TASKS_INVOKER_SERVICE_ACCOUNT: z.email(),
});

export type Env = z.infer<typeof envSchema>;

export type EnvResult =
  | { ok: true; env: Env }
  | { ok: false; issues: string[] };

/** Valida sem efeito colateral, para poder ser testado. */
export function parseEnv(source: Record<string, string | undefined>): EnvResult {
  const result = envSchema.safeParse(source);

  if (result.success) {
    return { ok: true, env: result.data };
  }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.join(".");

      return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    }),
  };
}

/**
 * Valida e encerra o processo se o ambiente estiver inválido.
 *
 * Sai com código 1 e lista todos os problemas de uma vez, para não descobrir
 * um por execução.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const result = parseEnv(source);

  if (result.ok) {
    return result.env;
  }

  process.stderr.write(
    `${JSON.stringify({
      severity: "ERROR",
      message: "invalid_environment",
      issues: result.issues,
    })}\n`,
  );

  process.exit(1);
}
