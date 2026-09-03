import { classifyJobFreshness, classifyResourceFreshness } from "./sync-health";
import type { SyncVerdict } from "./sync-health";

/**
 * Catálogo e adaptadores de status da Central de Integrações (D-231) — a
 * peça PURA da tela `/integracoes`, no padrão de `lib/sync-health.ts`: recebe
 * o que a página já leu (contas ML, saúde da sincronização, jobs, lotes do
 * UpSeller, uso de IA, `/health` da API) e devolve, para cada integração, três
 * dimensões SEPARADAS — conexão, sincronização e configuração — porque o
 * item do ROADMAP nomeia exatamente essa confusão como o risco: "declarar
 * saúde só por haver configuração".
 *
 * Regras que este módulo fixa (e que os testes provam):
 *
 * 1. **`ok` exige ATIVIDADE observada** — um run, um job, um lote, uma leitura
 *    que acabou de acontecer. Configuração existente sem atividade nunca é
 *    verde. Nesta versão NENHUMA dimensão `configuration` pode ser `ok`: não
 *    há coletor autenticado para Secret Manager, Cloud Scheduler, painel do
 *    Mercado Livre ou Dashboard do Supabase, e o item exclui permissões novas
 *    de nuvem. O honesto é `nao_verificavel`, com o motivo.
 * 2. **A Central não recalcula veredito.** Frescor de recurso e de job vem de
 *    `sync-health.ts` (D-143/D-219), o mesmo que `/sincronizacao` e `/saude`
 *    usam. Um dado, um dono (D-224): aqui só se compõe e se aponta.
 * 3. **Erro sanitizado.** Qualquer texto de erro passa por `sanitizeErrorText`
 *    antes de virar detalhe — mesmo que a fonte já seja limpa (D-217 lembra
 *    que a fonte é limpa até o dia em que não é).
 * 4. **Dimensão que não se aplica é `null`**, não um estado inventado: UpSeller
 *    não tem "conexão" (é planilha), webhook não tem "sincronização".
 */

export type IntegrationState = "ok" | "atencao" | "erro" | "nao_configurado" | "nao_verificavel";

export interface Dimension {
  state: IntegrationState;
  /** Uma linha, já sanitizada, com o motivo quando o estado não é `ok`. */
  detail: string;
  observedAt: string | null;
}

export type IntegrationId = "mercado_livre" | "webhook" | "upseller" | "ia" | "supabase" | "google_cloud";

export interface IntegrationLink {
  label: string;
  href: string;
}

export interface IntegrationCard {
  id: IntegrationId;
  label: string;
  /** Telas DONAS do dado — a Central aponta, não duplica. */
  links: IntegrationLink[];
  connection: Dimension | null;
  sync: Dimension | null;
  configuration: Dimension;
}

// ---------------------------------------------------------------------------
// Entradas cruas (a forma que a página lê; nulo = a leitura falhou)
// ---------------------------------------------------------------------------

export interface MlAccountInput {
  label: string;
  status: string;
  connected_at: string | null;
  last_error: string | null;
}

export interface SyncHealthInput {
  resource: string;
  channel: string;
  last_run_at: string | null;
  last_success_at: string | null;
  failed_24h: number;
  runs_24h: number;
}

export interface JobInput {
  job_type: string | null;
  job_status: string | null;
  job_last_run_at: string | null;
  job_failures_24h: number;
}

export interface ImportBatchInput {
  status: string;
  created_at: string;
  last_error: string | null;
}

export interface AiUsageInput {
  runs: number;
  lastRunAt: string | null;
  monthCostUsd: number | null;
}

export interface ApiInput {
  /** `false` quando `NEXT_PUBLIC_API_URL` não existe nesta build — medir é impossível, não "fora do ar". */
  configured: boolean;
  /** `null` = a API não respondeu ao `/health` (ou respondeu algo estranho). */
  health: { commit: string | null; startedAt: string | null } | null;
}

export interface IntegrationsInput {
  now: Date;
  mlAccounts: MlAccountInput[] | null;
  syncHealth: SyncHealthInput[] | null;
  jobs: JobInput[] | null;
  /** Lotes do UpSeller, do mais recente para o mais antigo. */
  importBatches: ImportBatchInput[] | null;
  ai: AiUsageInput | null;
  api: ApiInput;
  /** A própria página acabou de ler o banco com sucesso — é observação, não presunção. */
  dbReachable: boolean;
}

// ---------------------------------------------------------------------------
// Sanitização
// ---------------------------------------------------------------------------

// A aspa opcional ANTES do separador existe por um caso real do teste: em JSON
// a chave vem como `"access_token":"APP_USR-…"` — aspa, dois-pontos, aspa — e a
// primeira versão só previa `token=valor` e `token: valor`.
const SECRET_LIKE =
  /(access[_-]?token|refresh[_-]?token|client[_-]?secret|api[_-]?key|apikey|authorization|bearer|password|senha|secret)["']?(\s*[=:]\s*|\s+)["']?[A-Za-z0-9._~+/-]{6,}/gi;

const QUERY_STRING = /\?[^\s"'<>]+/g;

/**
 * Nunca deixa passar o que PARECE segredo, e corta a query string de qualquer
 * URL (é onde token costuma viajar). Não é criptografia — é a última linha
 * antes da tela, para o dia em que a fonte deixar de ser limpa.
 */
export function sanitizeErrorText(text: string | null | undefined, max = 200): string | null {
  if (text === null || text === undefined) return null;

  const limpo = text
    .replace(SECRET_LIKE, "$1=[oculto]")
    .replace(QUERY_STRING, "?[oculto]")
    .replace(/\s+/g, " ")
    .trim();

  if (limpo === "") return null;

  return limpo.length > max ? `${limpo.slice(0, max - 1)}…` : limpo;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hoursBetween(now: Date, iso: string): number {
  return Math.round(((now.getTime() - new Date(iso).getTime()) / 3_600_000) * 10) / 10;
}

function maxIso(values: (string | null)[]): string | null {
  let best: string | null = null;

  for (const value of values) {
    if (value !== null && (best === null || value > best)) best = value;
  }

  return best;
}

/** `sync-health` fala em `critico`; a Central fala em `erro`. Mesma coisa, vocabulário da tela. */
function fromVerdict(verdict: SyncVerdict): IntegrationState {
  switch (verdict) {
    case "ok":
      return "ok";
    case "atencao":
      return "atencao";
    case "critico":
      return "erro";
    case "nunca":
      return "nao_verificavel";
    case "sem_cadencia":
      return "nao_verificavel";
  }
}

const NAO_VERIFICAVEL = (detail: string): Dimension => ({ state: "nao_verificavel", detail, observedAt: null });

function findJob(jobs: JobInput[] | null, jobType: string): JobInput | null {
  return jobs?.find((job) => job.job_type === jobType) ?? null;
}

// ---------------------------------------------------------------------------
// Adaptadores, um por integração
// ---------------------------------------------------------------------------

function mercadoLivre(input: IntegrationsInput): IntegrationCard {
  let connection: Dimension;

  if (input.mlAccounts === null) {
    connection = NAO_VERIFICAVEL("não foi possível ler as contas");
  } else if (input.mlAccounts.length === 0) {
    connection = { state: "nao_configurado", detail: "nenhuma conta cadastrada", observedAt: null };
  } else {
    const conectadas = input.mlAccounts.filter((a) => a.status === "CONNECTED");
    const comErro = input.mlAccounts.filter((a) => a.status === "ERROR" || a.status === "REVOKED");
    const pendentes = input.mlAccounts.filter((a) => a.status === "PENDING");
    const total = input.mlAccounts.length;
    const observedAt = maxIso(input.mlAccounts.map((a) => a.connected_at));

    if (comErro.length > 0) {
      const primeira = comErro[0];
      const motivo = sanitizeErrorText(primeira?.last_error ?? null, 120);

      connection = {
        state: "erro",
        detail: `${String(conectadas.length)} de ${String(total)} contas conectadas; com erro: ${comErro
          .map((a) => a.label)
          .join(", ")}${motivo === null ? "" : ` — ${motivo}`}`,
        observedAt,
      };
    } else if (pendentes.length > 0) {
      connection = {
        state: "atencao",
        detail: `${String(conectadas.length)} de ${String(total)} contas conectadas; aguardando conexão: ${pendentes
          .map((a) => a.label)
          .join(", ")}`,
        observedAt,
      };
    } else {
      connection = { state: "ok", detail: `${String(total)} conta(s) conectada(s)`, observedAt };
    }
  }

  let sync: Dimension;

  if (input.syncHealth === null) {
    sync = NAO_VERIFICAVEL("não foi possível ler a saúde da sincronização");
  } else {
    const reconciliacao = input.syncHealth.filter((row) => row.channel === "reconciliation");

    if (reconciliacao.length === 0) {
      sync = NAO_VERIFICAVEL("nenhuma sincronização registrada");
    } else {
      const vereditos = reconciliacao.map((row) =>
        classifyResourceFreshness(row.resource, row.channel, row.last_success_at, input.now),
      );
      const contagem = (v: SyncVerdict): number => vereditos.filter((x) => x === v).length;
      const falhas24h = reconciliacao.reduce((acc, row) => acc + row.failed_24h, 0);
      const state: IntegrationState =
        contagem("critico") > 0 ? "erro" : contagem("atencao") > 0 ? "atencao" : contagem("nunca") > 0 ? "atencao" : "ok";

      sync = {
        state,
        detail: `${String(contagem("ok"))} em dia, ${String(contagem("atencao"))} atrasando, ${String(
          contagem("critico"),
        )} atrasado(s), ${String(contagem("nunca"))} nunca; ${String(falhas24h)} falha(s) em 24h`,
        observedAt: maxIso(reconciliacao.map((row) => row.last_run_at)),
      };
    }
  }

  return {
    id: "mercado_livre",
    label: "Mercado Livre",
    links: [
      { label: "Contas ML", href: "/contas" },
      { label: "Sincronização", href: "/sincronizacao" },
    ],
    connection,
    sync,
    configuration: NAO_VERIFICAVEL(
      "client id e secret vivem no Secret Manager e o app no painel do Mercado Livre — sem coletor autenticado daqui",
    ),
  };
}

/**
 * 24 h de silêncio é o limiar, e ele é MEDIDO, não escolhido: em 03/09/2026 o
 * webhook produziu 5.218 execuções em 24 h (~217/h). Um dia inteiro sem nada
 * não é noite fraca — é a URL de notificação quebrada ou a API fora do ar.
 * Abaixo disso a Central não carimba: é job movido por evento, e a idade crua
 * é o honesto (mesma regra de `sem_cadencia` em D-143).
 */
const WEBHOOK_SILENCE_ALERT_HOURS = 24;

function webhook(input: IntegrationsInput): IntegrationCard {
  const job = findJob(input.jobs, "sync.webhook.received");
  const recebidoEm = job?.job_last_run_at ?? null;
  let connection: Dimension;

  if (input.jobs === null) {
    connection = NAO_VERIFICAVEL("não foi possível ler as execuções (restrito a ADMIN)");
  } else if (job === null || recebidoEm === null) {
    connection = NAO_VERIFICAVEL("nenhum webhook recebido registrado");
  } else {
    const horas = hoursBetween(input.now, recebidoEm);
    const falhas = job.job_failures_24h > 0 ? `; ${String(job.job_failures_24h)} falha(s) em 24h` : "";

    connection =
      horas > WEBHOOK_SILENCE_ALERT_HOURS
        ? {
            state: "atencao",
            detail: `último webhook há ${String(horas)} h — acima do limiar de ${String(WEBHOOK_SILENCE_ALERT_HOURS)} h${falhas}`,
            observedAt: recebidoEm,
          }
        : { state: "ok", detail: `último webhook há ${String(horas)} h${falhas}`, observedAt: recebidoEm };
  }

  return {
    id: "webhook",
    label: "Webhook do Mercado Livre",
    links: [{ label: "Saúde do Sistema", href: "/saude" }],
    connection,
    sync: null,
    configuration: NAO_VERIFICAVEL("a URL de notificação é configurada no painel do Mercado Livre — não legível daqui"),
  };
}

const BATCH_IN_PROGRESS = new Set(["UPLOADED", "PARSING", "PARSED", "APPLYING"]);

function upseller(input: IntegrationsInput): IntegrationCard {
  let sync: Dimension;

  if (input.importBatches === null) {
    sync = NAO_VERIFICAVEL("não foi possível ler as importações");
  } else if (input.importBatches.length === 0) {
    sync = { state: "nao_configurado", detail: "nenhuma importação registrada", observedAt: null };
  } else {
    const ultimo = input.importBatches[0];

    if (ultimo === undefined) {
      sync = NAO_VERIFICAVEL("nenhuma importação registrada");
    } else {
      const dias = Math.floor(hoursBetween(input.now, ultimo.created_at) / 24);
      const idade = `há ${String(dias)} dia(s)`;

      if (ultimo.status === "APPLIED") {
        sync = { state: "ok", detail: `último lote aplicado ${idade}`, observedAt: ultimo.created_at };
      } else if (BATCH_IN_PROGRESS.has(ultimo.status)) {
        sync = { state: "atencao", detail: `lote em andamento (${ultimo.status}) ${idade}`, observedAt: ultimo.created_at };
      } else {
        const motivo = sanitizeErrorText(ultimo.last_error, 120);

        sync = {
          state: "erro",
          detail: `último lote ${ultimo.status} ${idade}${motivo === null ? "" : ` — ${motivo}`}`,
          observedAt: ultimo.created_at,
        };
      }
    }
  }

  return {
    id: "upseller",
    label: "UpSeller (planilha)",
    links: [{ label: "Importações", href: "/importacoes" }],
    // Não há conexão: é upload de planilha, não integração viva.
    connection: null,
    sync,
    configuration: NAO_VERIFICAVEL("o bucket de importação vive no Google Cloud Storage — sem coletor daqui"),
  };
}

function ia(input: IntegrationsInput): IntegrationCard {
  let sync: Dimension;

  if (input.ai === null) {
    sync = NAO_VERIFICAVEL("não foi possível ler as execuções de IA");
  } else if (input.ai.runs === 0 || input.ai.lastRunAt === null) {
    sync = { state: "nao_configurado", detail: "nenhuma chamada registrada", observedAt: null };
  } else {
    const custo =
      input.ai.monthCostUsd === null ? "custo do mês não observado" : `US$ ${input.ai.monthCostUsd.toFixed(2)} no mês`;

    // Uso é sob demanda, não job: sem cadência, sem selo de atraso (D-143).
    // `ok` aqui diz "há atividade observada", e a data diz quando.
    sync = {
      state: "ok",
      detail: `${String(input.ai.runs)} execução(ões); ${custo}`,
      observedAt: input.ai.lastRunAt,
    };
  }

  const conferidoEm = findJob(input.jobs, "maintenance.check-ai-budget")?.job_last_run_at ?? null;
  const conferencia =
    conferidoEm === null
      ? "conferência do teto nunca registrada"
      : `teto conferido há ${String(hoursBetween(input.now, conferidoEm))} h`;

  return {
    id: "ia",
    label: "IA / Copiloto",
    links: [{ label: "Copiloto", href: "/copiloto" }],
    connection: null,
    sync,
    configuration: NAO_VERIFICAVEL(`chave da Anthropic no Secret Manager; ${conferencia}`),
  };
}

function supabase(input: IntegrationsInput): IntegrationCard {
  return {
    id: "supabase",
    label: "Supabase (banco e Auth)",
    links: [{ label: "Saúde do Sistema", href: "/saude" }],
    connection: input.dbReachable
      ? { state: "ok", detail: "este carregamento acabou de ler o banco", observedAt: input.now.toISOString() }
      : { state: "erro", detail: "as leituras desta página falharam", observedAt: null },
    sync: null,
    configuration: NAO_VERIFICAVEL(
      "backups, PITR e Leaked Password Protection só aparecem no Dashboard — sem coletor daqui",
    ),
  };
}

function googleCloud(input: IntegrationsInput): IntegrationCard {
  const ping = findJob(input.jobs, "system.ping");
  const pingVerdict: SyncVerdict | null =
    input.jobs === null ? null : classifyJobFreshness("system.ping", ping?.job_last_run_at ?? null, input.now);

  let apiState: IntegrationState;
  let apiDetail: string;

  if (!input.api.configured) {
    apiState = "nao_verificavel";
    apiDetail = "API: sem NEXT_PUBLIC_API_URL nesta build";
  } else if (input.api.health === null) {
    apiState = "erro";
    apiDetail = "API: sem resposta no /health";
  } else {
    apiState = "ok";
    apiDetail = `API no ar (commit ${input.api.health.commit ?? "—"})`;
  }

  let workerState: IntegrationState;
  let workerDetail: string;

  if (pingVerdict === null) {
    workerState = "nao_verificavel";
    workerDetail = "worker: execuções restritas a ADMIN";
  } else {
    const pingEm = ping?.job_last_run_at ?? null;

    workerState = fromVerdict(pingVerdict);
    workerDetail =
      pingEm === null
        ? "worker: heartbeat nunca registrado"
        : `worker: heartbeat há ${String(hoursBetween(input.now, pingEm))} h`;
  }

  const ordem: IntegrationState[] = ["erro", "atencao", "nao_verificavel", "nao_configurado", "ok"];
  const state = ordem.find((s) => s === apiState || s === workerState) ?? "nao_verificavel";

  return {
    id: "google_cloud",
    label: "Google Cloud (API e worker)",
    links: [{ label: "Saúde do Sistema", href: "/saude" }],
    connection: {
      state,
      detail: `${apiDetail}; ${workerDetail}`,
      observedAt: maxIso([input.api.health?.startedAt ?? null, ping?.job_last_run_at ?? null]),
    },
    sync: null,
    configuration: NAO_VERIFICAVEL(
      "Cloud Scheduler, Cloud Tasks e Secret Manager — sem coletor autenticado, por decisão do item (sem permissões novas de nuvem)",
    ),
  };
}

export function describeIntegrations(input: IntegrationsInput): IntegrationCard[] {
  return [mercadoLivre(input), webhook(input), upseller(input), ia(input), supabase(input), googleCloud(input)];
}
