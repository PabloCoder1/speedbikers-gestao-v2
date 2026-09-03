import { batchStatusLabel, mlAccountStatusLabel, statusTone } from "./labels";
import { sanitizeErrorText } from "./sanitize";
import { classifyJobFreshness, classifyResourceFreshness, failureRateLabel } from "./sync-health";
import type { SyncVerdict } from "./sync-health";

/**
 * Catálogo e adaptadores de status da Central de Integrações (D-231, refeita
 * em D-232 depois da revisão adversarial) — a peça PURA de `/integracoes`, no
 * padrão de `lib/sync-health.ts`: recebe o que a página já leu e devolve, para
 * cada integração, três dimensões SEPARADAS — conexão, sincronização e
 * configuração — porque o item do ROADMAP nomeia exatamente essa confusão como
 * o risco: "declarar saúde só por haver configuração".
 *
 * Regras que este módulo fixa (e que os testes provam por INVARIANTE, iterando
 * entradas adversas, não por caso único):
 *
 * 1. **`ok` exige ATIVIDADE observada e recente.** Um `status = CONNECTED`
 *    gravado no banco é flag, não atividade — a primeira versão pintava verde
 *    por ele, e a revisão mostrou isso com a conta do seed do e2e (CONNECTED,
 *    sem credencial, sem nenhum run). Conexão do Mercado Livre só é `ok` quando
 *    TODAS as contas conectadas têm sucesso de reconciliação dentro da
 *    cadência (o veredito de D-143). Fonte sob demanda (IA, lote do UpSeller)
 *    nunca vira verde: vira `observado`, o estado neutro que os donos já usam
 *    para `sem_cadencia` — a data diz quando.
 * 2. **Nenhuma dimensão `configuration` pode ser `ok` nesta versão**: não há
 *    coletor autenticado para Secret Manager, Cloud Scheduler, painel do
 *    Mercado Livre ou Dashboard do Supabase, e o item exclui permissões novas
 *    de nuvem. O honesto é `nao_verificavel` com o motivo — e, quando algo DÁ
 *    para medir (a migration aplicada, a conferência do teto de IA), o fato
 *    medido vai no detalhe.
 * 3. **A Central não recalcula veredito.** Frescor de recurso e de job vem de
 *    `sync-health.ts`, o MESMO que `/sincronizacao` e `/saude` usam —
 *    inclusive o silêncio dos jobs de webhook, que D-232 levou para lá. A
 *    taxa de falha usa `failureRateLabel`, o alerta que D-143 criou. Um dado,
 *    um dono (D-224): aqui só se traduz, compõe e aponta.
 * 4. **Uma tradução só** de `SyncVerdict` para o vocabulário da tela
 *    (`fromVerdict`), usada por todos os cards. `nunca` é neutro
 *    (`sem_atividade`), como "Nunca rodou" em cinza nos donos — não é "não
 *    verificável", porque houve coletor e ele observou "nunca".
 * 5. **Dimensão que não se aplica é `null`**, não um estado inventado.
 */

export type IntegrationState =
  | "ok"
  | "atencao"
  | "erro"
  | "observado"
  | "sem_atividade"
  | "nao_configurado"
  | "nao_verificavel";

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
// Entradas cruas (a forma que a página lê; nulo = a leitura falhou ou é
// restrita a quem a página não é)
// ---------------------------------------------------------------------------

export interface MlAccountInput {
  id: string;
  label: string;
  status: string;
  connected_at: string | null;
  last_error: string | null;
}

export interface SyncHealthInput {
  ml_account_id: string;
  resource: string;
  channel: string;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_reason: string | null;
  last_success_at: string | null;
  failed_24h: number;
  runs_24h: number;
}

export interface JobInput {
  job_type: string | null;
  job_status: string | null;
  job_last_run_at: string | null;
  /** Idade calculada NO BANCO por `get_system_health` — a mesma que `/saude` mostra. */
  job_age_hours: number | null;
  job_failures_24h: number;
}

export interface MigrationInput {
  version: string | null;
  name: string | null;
  applied_at: string | null;
  count: number | null;
}

export interface ImportBatchInput {
  status: string;
  created_at: string;
  last_error: string | null;
}

export interface AiUsageInput {
  /** Chamadas NO MÊS corrente — a mesma janela do custo, nunca o all-time. */
  runsThisMonth: number;
  lastRunAt: string | null;
  monthCostUsd: number | null;
  /** `ai.budget.exceeded` deste mês em `domain_events`, se houve. */
  budgetExceededAt: string | null;
}

export interface ApiInput {
  /** `false` quando `NEXT_PUBLIC_API_URL` não existe nesta build — medir é impossível, não "fora do ar". */
  configured: boolean;
  /** `null` = a API não respondeu ao `/health` (ou respondeu algo estranho). */
  health: { commit: string | null; startedAt: string | null } | null;
}

export interface IntegrationsInput {
  now: Date;
  /** O que `organization_members.role` diz de quem está olhando — decide o que "zero linhas" significa. */
  viewerIsAdmin: boolean;
  mlAccounts: MlAccountInput[] | null;
  syncHealth: SyncHealthInput[] | null;
  /** `null` = `get_system_health` não devolveu linha (não é ADMIN) ou falhou. */
  jobs: JobInput[] | null;
  migration: MigrationInput | null;
  /** Lotes do UpSeller, do mais recente para o mais antigo, SEM os cancelados. */
  importBatches: ImportBatchInput[] | null;
  ai: AiUsageInput | null;
  api: ApiInput;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hoursBetween(now: Date, iso: string): number {
  return Math.round(((now.getTime() - new Date(iso).getTime()) / 3_600_000) * 10) / 10;
}

function daysBetween(now: Date, iso: string): number {
  return Math.floor(hoursBetween(now, iso) / 24);
}

function maxIso(values: (string | null)[]): string | null {
  let best: string | null = null;

  for (const value of values) {
    if (value !== null && (best === null || value > best)) best = value;
  }

  return best;
}

/**
 * A ÚNICA tradução de `SyncVerdict` para o vocabulário da tela. `critico` é
 * `erro`; `nunca` é neutro (`sem_atividade`), como os donos mostram "Nunca
 * rodou" em cinza; `sem_cadencia` é `observado` — houve atividade, não há
 * régua.
 */
export function fromVerdict(verdict: SyncVerdict): IntegrationState {
  switch (verdict) {
    case "ok":
      return "ok";
    case "atencao":
      return "atencao";
    case "critico":
      return "erro";
    case "nunca":
      return "sem_atividade";
    case "sem_cadencia":
      return "observado";
  }
}

/** Do pior para o melhor — o agregado de um card é o pior dos seus membros. */
const SEVERITY_ORDER: readonly IntegrationState[] = [
  "erro",
  "atencao",
  "nao_verificavel",
  "sem_atividade",
  "nao_configurado",
  "observado",
  "ok",
];

function worst(states: IntegrationState[]): IntegrationState {
  return SEVERITY_ORDER.find((s) => states.includes(s)) ?? "nao_verificavel";
}

const NAO_VERIFICAVEL = (detail: string): Dimension => ({ state: "nao_verificavel", detail, observedAt: null });

function findJob(jobs: JobInput[] | null, jobType: string): JobInput | null {
  return jobs?.find((job) => job.job_type === jobType) ?? null;
}

/**
 * Estado de UM job a partir da mesma linha que `/saude` mostra: frescor pelo
 * dono (`classifyJobFreshness`, que desde D-232 também cobre o silêncio dos
 * jobs de webhook), e as duas coisas que a primeira versão ignorava — a última
 * execução ter FALHADO (`erro`) e haver falhas em 24 h (`atencao`, no mínimo).
 */
function jobState(job: JobInput | null, jobType: string, now: Date): { state: IntegrationState; detail: string } {
  const ultima = job?.job_last_run_at ?? null;

  if (job === null || ultima === null) {
    return { state: "sem_atividade", detail: "nunca rodou" };
  }

  const base = fromVerdict(classifyJobFreshness(jobType, ultima, now));
  const idade = job.job_age_hours ?? hoursBetween(now, ultima);
  const falhas = job.job_failures_24h > 0 ? `; ${String(job.job_failures_24h)} falha(s) em 24h` : "";

  if (job.job_status === "failed") {
    return { state: "erro", detail: `última execução FALHOU há ${String(idade)} h${falhas}` };
  }

  const state: IntegrationState =
    job.job_failures_24h > 0 && (base === "ok" || base === "observado") ? "atencao" : base;

  return { state, detail: `há ${String(idade)} h${falhas}` };
}

// ---------------------------------------------------------------------------
// Adaptadores, um por integração
// ---------------------------------------------------------------------------

const ML_LINKS: IntegrationLink[] = [
  { label: "Contas ML", href: "/contas" },
  { label: "Sincronização", href: "/sincronizacao" },
];

function mercadoLivreConnection(input: IntegrationsInput): Dimension {
  if (input.mlAccounts === null) {
    return NAO_VERIFICAVEL("não foi possível ler as contas");
  }

  if (input.mlAccounts.length === 0) {
    // A policy de `ml_accounts` só mostra a quem é ADMIN ou tem acesso à conta:
    // para os demais, zero linhas não é "nenhuma conta cadastrada".
    return input.viewerIsAdmin
      ? { state: "nao_configurado", detail: "nenhuma conta cadastrada", observedAt: null }
      : NAO_VERIFICAVEL("contas visíveis só para ADMIN ou para quem tem acesso à conta");
  }

  const total = input.mlAccounts.length;
  const conectadas = input.mlAccounts.filter((a) => a.status === "CONNECTED");
  const problematicas = input.mlAccounts.filter((a) => a.status === "REVOKED" || a.status === "ERROR");
  const pendentes = input.mlAccounts.filter((a) => a.status === "PENDING");

  if (problematicas.length > 0) {
    // REVOKED e ERROR com o nome do dono (D-232): revogado exige reautenticação
    // humana; erro pode ser transitório. Colapsar os dois escondia isso.
    const descricao = problematicas
      .map((a) => {
        const motivo = sanitizeErrorText(a.last_error, 100);

        return `${a.label} (${mlAccountStatusLabel(a.status).toLowerCase()}${motivo === null ? "" : `: ${motivo}`})`;
      })
      .join("; ");

    return {
      state: "erro",
      detail: `${String(conectadas.length)} de ${String(total)} contas conectadas — ${descricao}`,
      observedAt: maxIso(input.mlAccounts.map((a) => a.connected_at)),
    };
  }

  if (pendentes.length > 0) {
    return {
      state: "atencao",
      detail: `${String(conectadas.length)} de ${String(total)} contas conectadas; aguardando conexão: ${pendentes
        .map((a) => a.label)
        .join(", ")}`,
      observedAt: maxIso(input.mlAccounts.map((a) => a.connected_at)),
    };
  }

  // Todas CONNECTED. Isso é uma FLAG gravada quando o OAuth passou; só vira
  // `ok` com atividade observada: um sucesso de reconciliação dentro da
  // cadência (D-143) para CADA conta.
  if (input.syncHealth === null) {
    return {
      state: "sem_atividade",
      detail: `${String(total)} conta(s) conectada(s); atividade não pôde ser lida`,
      observedAt: null,
    };
  }

  const semAtividade: string[] = [];
  const atrasadas: string[] = [];
  const sucessos: (string | null)[] = [];

  for (const conta of conectadas) {
    const linhas = input.syncHealth.filter(
      (row) => row.ml_account_id === conta.id && row.channel === "reconciliation",
    );
    const vereditos = linhas.map((row) =>
      classifyResourceFreshness(row.resource, row.channel, row.last_success_at, input.now),
    );
    const ultimoSucesso = maxIso(linhas.map((row) => row.last_success_at));

    sucessos.push(ultimoSucesso);

    if (ultimoSucesso === null) {
      semAtividade.push(conta.label);
    } else if (!vereditos.includes("ok")) {
      atrasadas.push(conta.label);
    }
  }

  if (semAtividade.length > 0) {
    return {
      state: "sem_atividade",
      detail: `${String(total)} conta(s) conectada(s), mas nenhuma chamada ao Mercado Livre bem-sucedida foi observada para: ${semAtividade.join(", ")}`,
      observedAt: maxIso(sucessos),
    };
  }

  if (atrasadas.length > 0) {
    return {
      state: "atencao",
      detail: `${String(total)} conta(s) conectada(s); sem sucesso recente em: ${atrasadas.join(", ")}`,
      observedAt: maxIso(sucessos),
    };
  }

  return {
    state: "ok",
    detail: `${String(total)} conta(s) conectada(s), todas com sincronização recente`,
    observedAt: maxIso(sucessos),
  };
}

function mercadoLivreSync(input: IntegrationsInput): Dimension {
  if (input.syncHealth === null) {
    return NAO_VERIFICAVEL("não foi possível ler a saúde da sincronização");
  }

  const reconciliacao = input.syncHealth.filter((row) => row.channel === "reconciliation");

  if (reconciliacao.length === 0) {
    return { state: "sem_atividade", detail: "nenhuma sincronização registrada", observedAt: null };
  }

  const contagem: Record<SyncVerdict, number> = { ok: 0, atencao: 0, critico: 0, nunca: 0, sem_cadencia: 0 };
  const alertas: string[] = [];
  let ultimaFalha: string | null = null;

  for (const row of reconciliacao) {
    const veredito = classifyResourceFreshness(row.resource, row.channel, row.last_success_at, input.now);
    contagem[veredito] += 1;

    // O alerta de taxa de falha é do dono (D-143): frescor OK com 85% de falha
    // era exatamente o caso que ele nasceu para não esconder.
    const taxa = failureRateLabel(row.runs_24h, row.failed_24h);

    if (taxa !== null) {
      alertas.push(`${row.resource}: ${taxa}`);
    } else if (veredito === "sem_cadencia" && row.failed_24h > 0) {
      alertas.push(`${row.resource}: ${String(row.failed_24h)} falha(s) em 24h`);
    }

    if (row.last_run_status === "failed" && ultimaFalha === null) {
      const motivo = sanitizeErrorText(row.last_run_reason, 80);
      ultimaFalha = `${row.resource}${motivo === null ? "" : ` — ${motivo}`}`;
    }
  }

  const state: IntegrationState =
    contagem.critico > 0
      ? "erro"
      : contagem.atencao > 0 || alertas.length > 0
        ? "atencao"
        : contagem.ok > 0
          ? "ok"
          : "sem_atividade";

  const partes = [
    `${String(contagem.ok)} em dia, ${String(contagem.atencao)} atrasando, ${String(contagem.critico)} atrasado(s), ${String(
      contagem.nunca,
    )} nunca, ${String(contagem.sem_cadencia)} sem cadência`,
  ];

  if (alertas.length > 0) partes.push(`alertas: ${alertas.join(" · ")}`);
  if (ultimaFalha !== null) partes.push(`última falha: ${ultimaFalha}`);

  return { state, detail: partes.join(" — "), observedAt: maxIso(reconciliacao.map((row) => row.last_run_at)) };
}

function mercadoLivre(input: IntegrationsInput): IntegrationCard {
  return {
    id: "mercado_livre",
    label: "Mercado Livre",
    links: ML_LINKS,
    connection: mercadoLivreConnection(input),
    sync: mercadoLivreSync(input),
    configuration: NAO_VERIFICAVEL(
      "client id e secret vivem no Secret Manager e o app no painel do Mercado Livre — sem coletor autenticado daqui",
    ),
  };
}

/**
 * Os três fluxos que o webhook alimenta. O que se observa é a EXECUÇÃO NO
 * WORKER (a linha de `job_runs` é gravada quando o worker termina), não o
 * recebimento na API — a revisão de D-231 apontou que "último webhook" prometia
 * mais do que a fonte sustenta. O silêncio tolerado de cada um é medido e mora
 * em `sync-health.ts` (`EVENT_JOB_SILENCE_MIN`), o mesmo que `/saude` lê.
 */
const WEBHOOK_STREAMS: readonly { jobType: string; label: string }[] = [
  { jobType: "sync.webhook.received", label: "pedidos e pós-venda" },
  { jobType: "sync.support.questions", label: "perguntas" },
  { jobType: "sync.support.messages", label: "mensagens" },
];

function webhook(input: IntegrationsInput): IntegrationCard {
  let connection: Dimension;

  if (input.jobs === null) {
    connection = NAO_VERIFICAVEL("execuções restritas a ADMIN (get_system_health não devolveu linhas)");
  } else {
    const fluxos = WEBHOOK_STREAMS.map((stream) => {
      const job = findJob(input.jobs, stream.jobType);
      const estado = jobState(job, stream.jobType, input.now);

      return { ...stream, job, ...estado };
    });

    const algumRegistro = fluxos.some((f) => f.job !== null && f.job.job_last_run_at !== null);

    connection = algumRegistro
      ? {
          state: worst(fluxos.map((f) => f.state)),
          detail: `processados pelo worker — ${fluxos.map((f) => `${f.label}: ${f.detail}`).join("; ")}`,
          observedAt: maxIso(fluxos.map((f) => f.job?.job_last_run_at ?? null)),
        }
      : { state: "sem_atividade", detail: "nenhum webhook processado registrado", observedAt: null };
  }

  return {
    id: "webhook",
    label: "Webhook do Mercado Livre",
    links: [{ label: "Saúde do Sistema", href: "/saude" }],
    connection,
    sync: null,
    configuration: NAO_VERIFICAVEL(
      "a URL de notificação é configurada no painel do Mercado Livre e o recebimento na API não é observável daqui",
    ),
  };
}

function upseller(input: IntegrationsInput): IntegrationCard {
  let sync: Dimension;

  if (input.importBatches === null) {
    sync = NAO_VERIFICAVEL("não foi possível ler as importações");
  } else {
    const ultimo = input.importBatches[0];

    if (ultimo === undefined) {
      sync = { state: "nao_configurado", detail: "nenhuma importação registrada (cancelados não contam)", observedAt: null };
    } else {
      // Rótulo e tom do DONO (`labels.ts`): PARSED é "Aguardando conferência"
      // — ação humana pendente —, não "em andamento", que era a leitura errada
      // da primeira versão.
      const idade = `há ${String(daysBetween(input.now, ultimo.created_at))} dia(s)`;
      const rotulo = batchStatusLabel(ultimo.status);
      const tom = statusTone(ultimo.status);
      const motivo = sanitizeErrorText(ultimo.last_error, 120);

      sync =
        tom === "bad"
          ? {
              state: "erro",
              detail: `último lote: ${rotulo} ${idade}${motivo === null ? "" : ` — ${motivo}`}`,
              observedAt: ultimo.created_at,
            }
          : tom === "warn"
            ? { state: "atencao", detail: `último lote: ${rotulo} ${idade}`, observedAt: ultimo.created_at }
            : // Lote aplicado é atividade observada, sob demanda: sem régua de
              // frescor, sem verde — a data diz quando.
              { state: "observado", detail: `último lote: ${rotulo} ${idade}`, observedAt: ultimo.created_at };
    }
  }

  return {
    id: "upseller",
    label: "UpSeller (planilha)",
    links: [{ label: "Importações", href: "/importacoes" }],
    connection: null,
    sync,
    configuration: NAO_VERIFICAVEL("o bucket de importação vive no Google Cloud Storage — sem coletor daqui"),
  };
}

function ia(input: IntegrationsInput): IntegrationCard {
  let sync: Dimension;

  if (input.ai === null) {
    sync = NAO_VERIFICAVEL("não foi possível ler as execuções de IA");
  } else {
    const custo =
      input.ai.monthCostUsd === null ? "custo do mês não observado" : `US$ ${input.ai.monthCostUsd.toFixed(2)} no mês`;
    const chamadas = `${String(input.ai.runsThisMonth)} chamada(s) no mês`;

    if (input.ai.budgetExceededAt !== null) {
      sync = {
        state: "atencao",
        detail: `teto do mês ultrapassado em ${input.ai.budgetExceededAt.slice(0, 10)}; ${chamadas}; ${custo}`,
        observedAt: input.ai.budgetExceededAt,
      };
    } else if (input.ai.runsThisMonth === 0 || input.ai.lastRunAt === null) {
      sync = { state: "sem_atividade", detail: `nenhuma chamada no mês; ${custo}`, observedAt: input.ai.lastRunAt };
    } else {
      // Uso sob demanda: atividade observada, sem régua — `observado`, não `ok`.
      sync = { state: "observado", detail: `${chamadas}; ${custo}`, observedAt: input.ai.lastRunAt };
    }
  }

  // A conferência diária do teto (D-100) É mensurável: mesma régua de /saude.
  let configuration: Dimension;

  if (input.jobs === null) {
    configuration = NAO_VERIFICAVEL("chave da Anthropic no Secret Manager; conferência do teto restrita a ADMIN");
  } else {
    const job = findJob(input.jobs, "maintenance.check-ai-budget");
    const conferencia = jobState(job, "maintenance.check-ai-budget", input.now);

    configuration =
      conferencia.state === "ok"
        ? NAO_VERIFICAVEL(`chave da Anthropic no Secret Manager (não legível daqui); teto conferido ${conferencia.detail}`)
        : {
            state: conferencia.state === "sem_atividade" ? "sem_atividade" : "atencao",
            detail: `chave no Secret Manager; conferência do teto: ${conferencia.detail}`,
            observedAt: job?.job_last_run_at ?? null,
          };
  }

  return {
    id: "ia",
    label: "IA / Copiloto",
    // Custo e uso de IA não têm tela dona hoje (registrado em D-232): o teto
    // está descrito em Configurações, e o chat é o Copiloto.
    links: [
      { label: "Configurações", href: "/configuracoes" },
      { label: "Copiloto", href: "/copiloto" },
    ],
    connection: null,
    sync,
    configuration,
  };
}

function supabase(input: IntegrationsInput): IntegrationCard {
  const migracao =
    input.migration?.version === undefined || input.migration.version === null
      ? "migration aplicada não lida (restrita a ADMIN)"
      : `migration ${input.migration.version}${input.migration.name === null ? "" : ` (${input.migration.name})`} aplicada${
          input.migration.applied_at === null ? "" : ` em ${input.migration.applied_at.slice(0, 10)}`
        }${input.migration.count === null ? "" : `, ${String(input.migration.count)} no total`}`;

  return {
    id: "supabase",
    label: "Supabase (banco e Auth)",
    links: [{ label: "Saúde do Sistema", href: "/saude" }],
    // Fato, não veredito: para esta página existir, a sessão passou pela RLS
    // e `organization_members` respondeu. Isso é observação, e é tudo que ela
    // sustenta — por isso `observado`, nunca uma pílula verde que não varia.
    connection: {
      state: "observado",
      detail: "esta página leu organization_members sob a RLS desta sessão",
      observedAt: input.now.toISOString(),
    },
    sync: null,
    configuration: NAO_VERIFICAVEL(`${migracao}; backups, PITR e Leaked Password Protection só aparecem no Dashboard`),
  };
}

function googleCloud(input: IntegrationsInput): IntegrationCard {
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

  if (input.jobs === null) {
    workerState = "nao_verificavel";
    workerDetail = "worker: execuções restritas a ADMIN";
  } else {
    const ping = jobState(findJob(input.jobs, "system.ping"), "system.ping", input.now);

    workerState = ping.state;
    workerDetail = `worker: heartbeat ${ping.detail}`;
  }

  return {
    id: "google_cloud",
    label: "Google Cloud (API e worker)",
    links: [{ label: "Saúde do Sistema", href: "/saude" }],
    connection: {
      state: worst([apiState, workerState]),
      detail: `${apiDetail}; ${workerDetail}`,
      observedAt: maxIso([input.api.health?.startedAt ?? null, findJob(input.jobs, "system.ping")?.job_last_run_at ?? null]),
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
