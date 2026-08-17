import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type {
  OperationalAlertItem,
  OperationalAlertsOverview,
  OperationalAlertScope,
  OperationalAlertSeverity,
} from "@/features/stock/get-operational-alerts";

type OperationalAlertsViewProps = {
  overview: OperationalAlertsOverview;
  query: string;
  severity: OperationalAlertSeverity | "all";
  scope: OperationalAlertScope;
};

const integer = new Intl.NumberFormat("pt-BR");
const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});


const severityConfig: Record<
  OperationalAlertSeverity,
  {
    label: string;
    badge: "danger" | "warning" | "info";
    border: string;
    marker: string;
  }
> = {
  critical: {
    label: "Crítico",
    badge: "danger",
    border: "border-l-red-500",
    marker: "bg-red-500",
  },
  warning: {
    label: "Atenção",
    badge: "warning",
    border: "border-l-amber-500",
    marker: "bg-amber-500",
  },
  info: {
    label: "Informativo",
    badge: "info",
    border: "border-l-blue-500",
    marker: "bg-blue-500",
  },
};

const severityFilters: { value: OperationalAlertSeverity | "all"; label: string }[] = [
  { value: "all", label: "Todas as prioridades" },
  { value: "critical", label: "Críticos" },
  { value: "warning", label: "Atenção" },
  { value: "info", label: "Informativos" },
];

const scopeFilters: { value: OperationalAlertScope; label: string }[] = [
  { value: "open", label: "Em aberto" },
  { value: "resolved", label: "Resolvidos" },
  { value: "all", label: "Histórico completo" },
];

function formatDate(value: string | null) {
  if (!value) return "Sem data";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Data indisponível" : dateTime.format(date);
}

function alertsHref({
  query,
  severity,
  scope,
}: {
  query: string;
  severity: OperationalAlertSeverity | "all";
  scope: OperationalAlertScope;
}) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (severity !== "all") params.set("severity", severity);
  if (scope !== "open") params.set("scope", scope);
  const suffix = params.toString();
  return suffix ? `/alertas?${suffix}` : "/alertas";
}

function SummaryCard({
  label,
  value,
  helper,
  tone = "default",
}: {
  label: string;
  value: number;
  helper: string;
  tone?: "default" | "dark" | "critical" | "warning";
}) {
  const styles = {
    default: "border-gray-200 bg-white text-gray-950",
    dark: "border-gray-950 bg-gray-950 text-white",
    critical: "border-red-200 bg-red-50 text-red-950",
    warning: "border-amber-200 bg-amber-50 text-amber-950",
  }[tone];
  const muted = tone === "dark"
    ? "text-white/60"
    : tone === "critical"
      ? "text-red-700"
      : tone === "warning"
        ? "text-amber-700"
        : "text-gray-500";

  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${styles}`}>
      <p className={`text-xs font-medium ${muted}`}>{label}</p>
      <p className="mt-3 text-3xl font-bold tracking-tight">
        {integer.format(value)}
      </p>
      <p className={`mt-2 text-xs leading-5 ${muted}`}>{helper}</p>
    </div>
  );
}

function AlertCard({ alert }: { alert: OperationalAlertItem }) {
  const config = severityConfig[alert.severity];

  return (
    <article className={`rounded-2xl border border-l-4 border-gray-200 bg-white p-5 shadow-sm ${config.border}`}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={config.badge}>
              <span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${config.marker}`} />
              {config.label}
            </Badge>
            {alert.status === "resolved" ? (
              <Badge variant="success">Resolvido</Badge>
            ) : null}
            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              {alert.category}
            </span>
          </div>

          <h2 className="mt-3 text-base font-bold tracking-tight text-gray-950">
            {alert.title}
          </h2>
          <p className="mt-1 text-sm leading-6 text-gray-600">
            {alert.description}
          </p>
        </div>

        <Link
          href={`/produto/${alert.productId}`}
          className="shrink-0 rounded-xl bg-gray-950 px-4 py-2.5 text-center text-xs font-semibold text-white transition hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-gray-200"
        >
          {alert.actionLabel} →
        </Link>
      </div>

      <div className="mt-5 grid gap-3 border-t border-gray-100 pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div className="min-w-0">
          <Link
            href={`/produto/${alert.productId}`}
            className="font-semibold text-gray-950 transition hover:text-gray-600"
          >
            {alert.sku}
          </Link>
          <p className="mt-1 truncate text-xs text-gray-500">
            {alert.productName ?? "Produto sem nome cadastrado"}
          </p>
        </div>
        <p className="text-xs text-gray-400 sm:text-right">
          {alert.status === "resolved"
            ? `Resolvido em ${formatDate(alert.resolvedAt)}`
            : `Visto por último em ${formatDate(alert.lastSeenAt)}`}
        </p>
      </div>
    </article>
  );
}

export function OperationalAlertsView({
  overview,
  query,
  severity,
  scope,
}: OperationalAlertsViewProps) {
  /*
   * Escopo, severidade e busca agora são aplicados na RPC, que também
   * limita a página. A tela apenas renderiza o que recebeu.
   */
  const visibleAlerts = overview.alerts;
  const scopeLabel = scopeFilters.find((filter) => filter.value === scope)?.label ?? "Em aberto";

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="mb-6">
        <p className="text-sm font-medium text-gray-500">Operação</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-950">
              Alertas
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-500">
              Priorize problemas de estoque, Full, anúncios e preços com acesso direto ao produto afetado.
            </p>
          </div>
          <Link
            href="/estoque"
            className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50"
          >
            Ver visão de estoque
          </Link>
        </div>
      </header>

      <section aria-label="Resumo dos alertas" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Alertas em aberto"
          value={overview.summary.open}
          helper={`${integer.format(overview.summary.resolved)} resolvido(s) no histórico`}
          tone="dark"
        />
        <SummaryCard
          label="Críticos"
          value={overview.summary.critical}
          helper="Rupturas que pedem ação imediata"
          tone={overview.summary.critical > 0 ? "critical" : "default"}
        />
        <SummaryCard
          label="Precisam de atenção"
          value={overview.summary.warning}
          helper="Inconsistências e riscos operacionais"
          tone={overview.summary.warning > 0 ? "warning" : "default"}
        />
        <SummaryCard
          label="Informativos"
          value={overview.summary.info}
          helper="Preços, promoções e sinais para conferência"
        />
      </section>

      <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm" aria-label="Filtros dos alertas">
        <form method="get" action="/alertas" className="flex flex-col gap-3 sm:flex-row">
          <label htmlFor="alerts-search" className="sr-only">
            Buscar alerta por produto, SKU ou assunto
          </label>
          <input
            id="alerts-search"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Buscar por SKU, produto ou assunto"
            className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-gray-400 focus:bg-white focus:ring-4 focus:ring-gray-100"
          />
          {severity !== "all" ? (
            <input type="hidden" name="severity" value={severity} />
          ) : null}
          {scope !== "open" ? (
            <input type="hidden" name="scope" value={scope} />
          ) : null}
          <button
            type="submit"
            className="rounded-xl bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-gray-200"
          >
            Buscar
          </button>
          {query ? (
            <Link
              href={alertsHref({ query: "", severity, scope })}
              className="rounded-xl border border-gray-200 px-4 py-2.5 text-center text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              Limpar
            </Link>
          ) : null}
        </form>

        <div className="mt-4 grid gap-3 lg:grid-cols-2">
          <nav aria-label="Prioridade dos alertas" className="flex gap-2 overflow-x-auto pb-1">
            {severityFilters.map((filter) => (
              <Link
                key={filter.value}
                href={alertsHref({ query, severity: filter.value, scope })}
                aria-current={severity === filter.value ? "page" : undefined}
                className={`shrink-0 rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                  severity === filter.value
                    ? "border-gray-950 bg-gray-950 text-white"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                {filter.label}
              </Link>
            ))}
          </nav>

          <nav aria-label="Situação dos alertas" className="flex gap-2 overflow-x-auto pb-1 lg:justify-end">
            {scopeFilters.map((filter) => (
              <Link
                key={filter.value}
                href={alertsHref({ query, severity, scope: filter.value })}
                aria-current={scope === filter.value ? "page" : undefined}
                className={`shrink-0 rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                  scope === filter.value
                    ? "border-gray-950 bg-gray-950 text-white"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                {filter.label}
              </Link>
            ))}
          </nav>
        </div>
      </section>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-gray-500">
        <p>
          {scopeLabel}: exibindo {integer.format(visibleAlerts.length)} de {integer.format(overview.totalMatching)} resultado(s)
        </p>
        {overview.totalMatching > visibleAlerts.length ? (
          <p>Refine a busca para visualizar outros alertas.</p>
        ) : null}
      </div>

      {visibleAlerts.length === 0 ? (
        <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-10 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-xl text-emerald-700">
            ✓
          </div>
          <h2 className="mt-4 text-base font-bold text-gray-950">
            {overview.summary.open === 0 && scope === "open"
              ? "Nenhum alerta em aberto"
              : "Nenhum alerta encontrado"}
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-500">
            {overview.summary.open === 0 && scope === "open"
              ? "A central continuará acompanhando estoque, Full, anúncios e preços conforme as sincronizações forem processadas."
              : "Tente limpar a busca ou selecionar outra prioridade e situação."}
          </p>
        </section>
      ) : (
        <section className="mt-4 grid gap-3" aria-label="Lista de alertas">
          {visibleAlerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} />
          ))}
        </section>
      )}

      <aside className="mt-6 rounded-2xl border border-blue-200 bg-blue-50 p-5 shadow-sm">
        <p className="text-sm font-semibold text-blue-950">
          Esta central também prepara o planejamento de compras
        </p>
        <p className="mt-1 max-w-4xl text-xs leading-5 text-blue-800">
          Na próxima etapa, os sinais de ruptura serão combinados com giro de vendas e estoque em trânsito. Offracer e Navetec usarão 90 dias de antecedência; as demais marcas, 15 dias. As quantidades só aparecerão depois que houver saldo físico e histórico suficientes para uma recomendação confiável.
        </p>
      </aside>
    </div>
  );
}
