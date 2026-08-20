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
