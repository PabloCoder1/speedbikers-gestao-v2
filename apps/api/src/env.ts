import { loadEncryptionKey } from "@sb/mercado-livre";
import { z } from "zod";

/**
 * Variáveis de ambiente da `api`.
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

  // Cloud Tasks. Nenhuma destas é segredo — são identificadores de recurso —
  // por isso ficam em variável de ambiente e não no Secret Manager.
  GCP_PROJECT_ID: z.string().min(1),
  GCP_REGION: z.string().min(1),

  /** URL base do serviço worker. É também a audience do token OIDC. */
  WORKER_URL: z.url(),

  /** Identidade que o Cloud Tasks assume para invocar o worker (D-024). */
  TASKS_INVOKER_SERVICE_ACCOUNT: z.email(),

  /** URL pública desta api. É a audience esperada nos tokens OIDC recebidos. */
  API_URL: z.url(),

  /** Identidade autorizada a chamar as rotas `/internal/` desta api. */
  SCHEDULER_INVOKER_SERVICE_ACCOUNT: z.email(),

  /** Supabase. A chave de service role é segredo e vem do Secret Manager. */
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),

  /**
   * Chave PUBLICÁVEL do Supabase — a mesma que `apps/web` embute no bundle
   * do navegador (`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`), não é segredo.
   * Usada só por `createUserClient` (`@sb/db`): o Copiloto (`docs/COPILOT.md`
   * secao 3) lê sob a RLS do usuário, não com `service_role` — precisa de
   * um cliente instanciado com a chave pública + o JWT do chamador, mesmo
   * modelo do `web`.
   */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20),

  /** Bucket que recebe as exportações do UpSeller. */
  ERP_IMPORTS_BUCKET: z.string().min(1),

  /**
   * Bucket que recebe os XML de NF-e. Opcional de propósito: o bucket real
   * ainda não existe no GCP (`docs/HANDOFF.md`) — declarar como obrigatório
   * derrubaria a `api` no boot antes da infra existir. A rota de upload
   * (`app.ts`) só é registrada quando esta variável está presente, mesmo
   * raciocínio de `DOCUMENTS_BUCKET` em `apps/worker/src/env.ts`.
   */
  DOCUMENTS_BUCKET: z.string().min(1).optional(),

  /**
   * OAuth do Mercado Livre (D-041, D-046). `MERCADO_LIVRE_CLIENT_SECRET` é
   * segredo, vem do Secret Manager. `MERCADO_LIVRE_REDIRECT_URI` precisa
   * bater exatamente com o cadastrado no painel de aplicações do Mercado
   * Livre — por isso é variável, não derivada de `API_URL` em código.
   */
  MERCADO_LIVRE_CLIENT_ID: z.string().min(1),
  MERCADO_LIVRE_CLIENT_SECRET: z.string().min(1),
  MERCADO_LIVRE_REDIRECT_URI: z.url(),

  /**
   * Chave AES-256 (base64) que cifra `ml_credentials.*_ciphertext` (D-046).
   * Validada aqui, não só no primeiro uso: uma chave com tamanho errado deve
   * derrubar o boot, não a primeira tentativa de conectar uma conta.
   */
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
   * Origens do `web` autorizadas no CORS de `/v1/*`, separadas por vírgula.
   *
   * Opcional: sem ela, nenhuma origem de navegador é liberada — que é o
   * comportamento correto para um ambiente que só recebe chamada servidor a
   * servidor.
   */
  WEB_ORIGINS: z.string().optional(),

  /**
   * Copiloto (D-082) — narração de diagnóstico via Claude Haiku 4.5. Segredo,
   * vem do Secret Manager (`infra/lib.sh` `SECRET_ANTHROPIC_KEY`). Único
   * consumidor: `narrate_sku_diagnosis` em `src/copilot.ts`.
   */
  ANTHROPIC_API_KEY: z.string().min(20),
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
