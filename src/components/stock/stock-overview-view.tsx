import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { StockExitForm } from "@/components/stock/stock-exit-form";
import { NfeStockReceiptForm } from "@/components/stock/nfe-stock-receipt-form";
import type {
  StockOverview,
  StockOverviewRow,
  StockOverviewStatus,
} from "@/features/stock/get-stock-overview";

type StockOverviewViewProps = {
  overview: StockOverview;
  query: string;
  status: string;
};

type StockFilter =
  | "all"
  | "attention"
  | "unmapped"
  | "conflicts"
  | "ready"
  | "full"
  | "kits";

const integer = new Intl.NumberFormat("pt-BR");

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

const filters: { value: StockFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "attention", label: "Com atenção" },
  { value: "unmapped", label: "Sem vínculo" },
  { value: "conflicts", label: "Conflitos" },
  { value: "ready", label: "Físico pronto" },
  { value: "full", label: "Com Full" },
  { value: "kits", label: "Kits" },
];

const statusConfig: Record<
  StockOverviewStatus,
  {
    label: string;
    variant: "danger" | "warning" | "success" | "neutral";
    dot: string;
  }
> = {
  critical: {
    label: "Crítico",
    variant: "danger",
    dot: "bg-red-500",
  },
  warning: {
    label: "Atenção",
    variant: "warning",
    dot: "bg-amber-500",
  },
  healthy: {
    label: "Pronto",
    variant: "success",
    dot: "bg-emerald-500",
  },
  pending: {
    label: "Aguardando",
    variant: "neutral",
    dot: "bg-gray-300",
  },
};

function formatQuantity(value: number | null) {
  return value === null ? "—" : integer.format(value);
}

function formatUpdatedAt(value: string | null) {
  if (!value) return "Sem atualização";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Data indisponível" : dateTime.format(date);
}

function filterHref(filter: StockFilter, query: string) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (filter !== "all") params.set("status", filter);
  const suffix = params.toString();
  return suffix ? `/estoque?${suffix}` : "/estoque";
}

function mappingLabel(product: StockOverviewRow) {
  if (product.mappingStatus === "conflict") return "Conflito de vínculo";
  if (product.mappingStatus === "linked") {
    return product.sourceKind === "kit" ? "Kit vinculado" : "SKU vinculado";
  }
  return "Aguardando UpSeller";
}

function SummaryCard({
  label,
  value,
  helper,
  tone = "default",
}: {
  label: string;
  value: string;
  helper: string;
  tone?: "default" | "dark" | "warning";
}) {
  const classes = {
    default: "border-gray-200 bg-white text-gray-950",
    dark: "border-gray-950 bg-gray-950 text-white",
    warning: "border-amber-200 bg-amber-50 text-gray-950",
  }[tone];
  const muted = tone === "dark" ? "text-white/60" : "text-gray-500";

  return (
    <div className={`rounded-2xl border p-5 shadow-sm ${classes}`}>
      <p className={`text-xs font-medium ${muted}`}>
        {label}
      </p>
      <p className="mt-3 text-3xl font-bold tracking-tight">
        {value}
      </p>
      <p className={`mt-2 text-xs leading-5 ${muted}`}>
        {helper}
      </p>
    </div>
  );
}

function StatusBadge({ status }: { status: StockOverviewStatus }) {
  const config = statusConfig[status];
  return (
    <Badge variant={config.variant}>
      <span className={`mr-1.5 h-1.5 w-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </Badge>
  );
}

function FullAccountBalances({
  product,
  compact = false,
}: {
  product: StockOverviewRow;
  compact?: boolean;
}) {
  if (!product.fullApplicable) {
    return <span className="text-gray-400">—</span>;
  }

  return (
    <div className={compact ? "space-y-2" : "ml-auto w-fit min-w-36 space-y-2"}>
      {product.fullAccounts.map((account) => (
        <div
          key={account.accountId}
          className={`flex items-center justify-between gap-3 ${compact ? "text-xs" : "text-[11px]"}`}
        >
          <span className="max-w-32 truncate text-gray-500" title={account.accountName}>
            {account.accountName}
          </span>
          <span className="font-bold text-gray-950">
            {formatQuantity(account.available)}
          </span>
        </div>
      ))}
      {!product.fullReady ? (
        <p className="text-[10px] font-medium text-amber-800">
          {integer.format(product.fullPending)} leitura(s) pendente(s)
        </p>
      ) : null}
    </div>
  );
}

function MobileProductCard({ product }: { product: StockOverviewRow }) {
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/produto/${product.id}`}
            className="text-base font-bold tracking-tight text-gray-950 transition hover:text-gray-600"
          >
            {product.sku}
          </Link>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">
            {product.name ?? "Produto sem nome cadastrado"}
          </p>
        </div>
        <StatusBadge status={product.status} />
      </div>

      <p className="mt-3 text-xs font-medium text-gray-500">
        {mappingLabel(product)}
        {product.sourceSku ? ` · ${product.sourceSku}` : ""}
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-gray-50 p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-600">
            Físico
          </dt>
          <dd className="mt-2 text-lg font-bold text-gray-950">
            {product.physicalReady ? formatQuantity(product.physicalAvailable) : "—"}
          </dd>
        </div>
        <div className="rounded-xl bg-gray-50 p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-600">
            Anunciado
          </dt>
          <dd className="mt-2 text-lg font-bold text-gray-950">
            {formatQuantity(product.advertisedAvailable)}
          </dd>
        </div>
        <div className="col-span-2 rounded-xl bg-emerald-50/70 p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-600">
            Full por conta
          </dt>
          <dd className="mt-3">
            <FullAccountBalances product={product} compact />
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-gray-100 pt-4 text-xs text-gray-500">
        <span>
          {product.openAlerts > 0
            ? `${integer.format(product.openAlerts)} alerta(s)`
            : "Sem alertas abertos"}
        </span>
        <Link
          href={`/produto/${product.id}`}
          className="font-semibold text-gray-950 transition hover:text-gray-600"
        >
          Ver produto →
        </Link>
      </div>
    </article>
  );
}

export function StockOverviewView({
  overview,
  query,
  status,
}: StockOverviewViewProps) {
  const selectedFilter = filters.some((filter) => filter.value === status)
    ? status as StockFilter
    : "all";
  const visibleProducts = overview.products;
  const mappingPercent = overview.summary.totalProducts > 0
    ? (overview.summary.mappedProducts / overview.summary.totalProducts) * 100
    : 0;

  return (
    <div className="mx-auto w-full max-w-[1500px] overflow-x-clip px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="mb-6">
        <p className="text-sm font-medium text-gray-500">
          Operação
        </p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-950">
              Estoque
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-500">
              Acompanhe o estoque físico, o Full de cada conta e o saldo publicado de todos os produtos.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StockExitForm />

            <div className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-xs text-gray-500">
              Atualização baseada nas sincronizações disponíveis
            </div>
          </div>
        </div>
      </header>

      {!overview.sourceConnected ? (
        <section className="mb-5 rounded-2xl border border-amber-200 bg-amber-50 p-5 shadow-sm">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-3xl">
              <p className="text-sm font-semibold text-amber-950">
                Central de estoque pronta — aguardando o UpSeller
              </p>
              <p className="mt-1 text-xs leading-5 text-amber-800">
                Você já pode consultar o Full e o estoque anunciado. Importe os arquivos do UpSeller para conectar saldos físicos, custos, marcas e kits.
              </p>
            </div>
            {overview.canImportUpseller ? (
              <Link
                href="/administracao"
                className="w-fit shrink-0 rounded-xl bg-amber-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-amber-900"
              >
                Abrir importação
              </Link>
            ) : (
              <Badge variant="warning" className="w-fit shrink-0">
                Importação pendente
              </Badge>
            )}
          </div>
        </section>
      ) : null}

      {overview.canReceiveStock ? (
        <NfeStockReceiptForm
          warehouses={overview.warehouses}
          backendReady={overview.stockReceiptReady}
        />
      ) : null}

      <section aria-label="Resumo do estoque" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Produtos monitorados"
          value={integer.format(overview.summary.totalProducts)}
          helper={`${integer.format(overview.summary.listedProducts)} com anúncios vinculados`}
          tone="dark"
        />
        <SummaryCard
          label="Vínculo com estoque físico"
          value={`${integer.format(overview.summary.mappedProducts)} / ${integer.format(overview.summary.totalProducts)}`}
          helper={`${mappingPercent.toFixed(1)}% dos produtos vinculados ao UpSeller`}
        />
        <SummaryCard
          label="Saldo físico pronto"
          value={integer.format(overview.summary.physicalReadyProducts)}
          helper={`${integer.format(overview.summary.fullTrackedProducts)} produto(s) também monitorado(s) no Full`}
        />
        <SummaryCard
          label="Precisam de atenção"
          value={integer.format(overview.summary.attentionProducts)}
          helper={`${integer.format(overview.summary.openAlerts)} alerta(s) aberto(s) · ${integer.format(overview.summary.conflictingProducts)} conflito(s)`}
          tone={overview.summary.attentionProducts > 0 ? "warning" : "default"}
        />
      </section>

      <section className="mt-5 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-gray-950">
              Cobertura do estoque físico
            </p>
            <p className="mt-1 text-xs text-gray-500">
              Progresso dos vínculos entre os produtos do site e os SKUs do UpSeller
            </p>
          </div>
          <p className="text-sm font-bold text-gray-950">
            {mappingPercent.toFixed(1)}%
          </p>
        </div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-100">
          <div
            className="h-full rounded-full bg-gray-950 transition-[width]"
            style={{ width: `${Math.min(mappingPercent, 100)}%` }}
          />
        </div>
      </section>

      <section className="mt-6" aria-labelledby="stock-products-title">
        <div className="mb-4">
          <h2 id="stock-products-title" className="text-sm font-semibold text-gray-950">
            Produtos
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Prioridade operacional, saldos por origem e acesso ao detalhe de cada SKU
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <form method="get" action="/estoque" className="flex flex-col gap-3 sm:flex-row">
            <label htmlFor="stock-search" className="sr-only">
              Buscar produto por SKU ou nome
            </label>
            <input
              id="stock-search"
              name="q"
              type="search"
              defaultValue={query}
              placeholder="Buscar por SKU, nome ou SKU do UpSeller"
              className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-gray-400 focus:bg-white focus:ring-4 focus:ring-gray-100"
            />
            {selectedFilter !== "all" ? (
              <input type="hidden" name="status" value={selectedFilter} />
            ) : null}
            <button
              type="submit"
              className="rounded-xl bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-gray-200"
            >
              Buscar
            </button>
            {query ? (
              <Link
                href={filterHref(selectedFilter, "")}
                className="rounded-xl border border-gray-200 px-4 py-2.5 text-center text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Limpar
              </Link>
            ) : null}
          </form>

          <nav aria-label="Filtros do estoque" className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {filters.map((filter) => (
              <Link
                key={filter.value}
                href={filterHref(filter.value, query)}
                aria-current={selectedFilter === filter.value ? "page" : undefined}
                className={`shrink-0 rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                  selectedFilter === filter.value
                    ? "border-gray-950 bg-gray-950 text-white"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                {filter.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-gray-500">
          <p>
            Exibindo {integer.format(visibleProducts.length)} de {integer.format(overview.matchCount)} resultado(s)
          </p>
          {overview.matchCount > visibleProducts.length ? (
            <p>
              Refine a busca para visualizar outros produtos.
            </p>
          ) : null}
        </div>

        {visibleProducts.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-10 text-center shadow-sm">
            <p className="text-sm font-semibold text-gray-950">
              Nenhum produto encontrado
            </p>
            <p className="mt-2 text-xs text-gray-500">
              Tente limpar a busca ou selecionar outro filtro.
            </p>
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-3 md:hidden">
              {visibleProducts.map((product) => (
                <MobileProductCard key={product.id} product={product} />
              ))}
            </div>

            <div className="mt-4 hidden overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm md:block">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1240px] text-left">
                  <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-600">
                    <tr>
                      <th className="px-5 py-3">Produto</th>
                      <th className="px-5 py-3">Situação</th>
                      <th className="px-5 py-3 text-right">Físico</th>
                      <th className="px-5 py-3 text-right">Full por conta</th>
                      <th className="px-5 py-3 text-right">Anunciado</th>
                      <th className="px-5 py-3 text-right">Alertas</th>
                      <th className="px-5 py-3 text-right">Atualização</th>
                      <th className="px-5 py-3 text-right"><span className="sr-only">Ação</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visibleProducts.map((product) => (
                      <tr key={product.id} className="text-sm transition hover:bg-gray-50/70">
                        <td className="max-w-[300px] px-5 py-4">
                          <Link
                            href={`/produto/${product.id}`}
                            className="font-bold text-gray-950 transition hover:text-gray-600"
                          >
                            {product.sku}
                          </Link>
                          <p className="mt-1 truncate text-xs text-gray-500">
                            {product.name ?? "Produto sem nome cadastrado"}
                          </p>
                          <p className="mt-1 text-[11px] text-gray-400">
                            {mappingLabel(product)}
                            {product.sourceSku ? ` · ${product.sourceSku}` : ""}
                          </p>
                        </td>
                        <td className="px-5 py-4">
                          <StatusBadge status={product.status} />
                        </td>
                        <td className="px-5 py-4 text-right">
                          <p className="font-bold text-gray-950">
                            {product.physicalReady ? formatQuantity(product.physicalAvailable) : "—"}
                          </p>
                          <p className="mt-1 text-[11px] text-gray-400">
                            {product.physicalReady
                              ? product.sourceKind === "kit" ? "kits" : "disponível"
                              : "aguardando"}
                          </p>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <FullAccountBalances product={product} />
                        </td>
                        <td className="px-5 py-4 text-right">
                          <p className="font-bold text-gray-950">
                            {formatQuantity(product.advertisedAvailable)}
                          </p>
                          <p className="mt-1 text-[11px] text-gray-400">
                            {integer.format(product.activeOffers)} de {integer.format(product.advertisedOffers)} ativa(s)
                          </p>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <p className={`font-bold ${product.openAlerts > 0 ? "text-amber-700" : "text-gray-400"}`}>
                            {integer.format(product.openAlerts)}
                          </p>
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-right text-xs text-gray-500">
                          {formatUpdatedAt(product.updatedAt)}
                        </td>
                        <td className="px-5 py-4 text-right">
                          <Link
                            href={`/produto/${product.id}`}
                            className="whitespace-nowrap text-xs font-semibold text-gray-950 transition hover:text-gray-600"
                          >
                            Ver detalhe →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
