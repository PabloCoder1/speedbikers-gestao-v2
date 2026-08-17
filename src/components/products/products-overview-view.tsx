import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import type {
  ProductCommercialStatus,
  ProductsFilter,
  ProductsOverview,
  ProductsOverviewRow,
} from "@/features/products/get-products-overview";

type ProductsOverviewViewProps = {
  overview: ProductsOverview;
  query: string;
  status: ProductsFilter;
};

const integer = new Intl.NumberFormat("pt-BR");
const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const filters: { value: ProductsFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "with_sales", label: "Com venda 30d" },
  { value: "without_sales", label: "Sem venda 30d" },
  { value: "alerts", label: "Com alerta" },
  { value: "unmapped", label: "Sem vínculo" },
  { value: "conflicts", label: "Conflitos" },
  { value: "full", label: "Com Full" },
];

const statusConfig: Record<
  ProductCommercialStatus,
  {
    label: string;
    variant: "success" | "warning" | "danger" | "neutral";
  }
> = {
  healthy: { label: "Saudável", variant: "success" },
  attention: { label: "Atenção", variant: "warning" },
  critical: { label: "Crítico", variant: "danger" },
  missing: { label: "Sem vínculo", variant: "neutral" },
  conflict: { label: "Conflito", variant: "warning" },
};

function productsHref({
  query,
  status,
  page,
}: {
  query: string;
  status: ProductsFilter;
  page?: number;
}) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (status !== "all") params.set("status", status);
  if (page && page > 1) params.set("page", String(page));
  const suffix = params.toString();
  return suffix ? `/produtos?${suffix}` : "/produtos";
}

function formatQuantity(value: number | null) {
  return value === null ? "—" : integer.format(value);
}

function formatPrice(product: ProductsOverviewRow) {
  if (product.minimumPrice === null) return "—";
  if (
    product.maximumPrice !== null &&
    product.maximumPrice !== product.minimumPrice
  ) {
    return `${currency.format(product.minimumPrice)} – ${currency.format(product.maximumPrice)}`;
  }
  return currency.format(product.minimumPrice);
}

function SummaryCard({
  label,
  value,
  helper,
  dark = false,
}: {
  label: string;
  value: string;
  helper: string;
  dark?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-5 shadow-sm ${
        dark
          ? "border-gray-950 bg-gray-950 text-white"
          : "border-gray-200 bg-white text-gray-950"
      }`}
    >
      <p className={`text-xs font-medium ${dark ? "text-white/60" : "text-gray-500"}`}>
        {label}
      </p>
      <p className="mt-3 text-2xl font-bold tracking-tight">{value}</p>
      <p className={`mt-2 text-xs leading-5 ${dark ? "text-white/60" : "text-gray-500"}`}>
        {helper}
      </p>
    </div>
  );
}

function AccountBadges({ product }: { product: ProductsOverviewRow }) {
  if (product.accounts.length === 0) {
    return <span className="text-gray-400">—</span>;
  }

  return (
    <div className="flex max-w-56 flex-wrap gap-1.5">
      {product.accounts.map((account) => (
        <Badge key={account.id} variant="neutral" title={account.name}>
          {account.code.toUpperCase()}
        </Badge>
      ))}
    </div>
  );
}

function ProductStatus({ status }: { status: ProductCommercialStatus }) {
  const config = statusConfig[status];
  return <Badge variant={config.variant}>{config.label}</Badge>;
}

function MobileProductCard({ product }: { product: ProductsOverviewRow }) {
  return (
    <article className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/produto/${product.id}`}
            className="font-bold text-gray-950 transition hover:text-gray-600"
          >
            {product.sku}
          </Link>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500">
            {product.name ?? "Produto sem nome cadastrado"}
          </p>
        </div>
        <ProductStatus status={product.status} />
      </div>

      <div className="mt-4">
        <AccountBadges product={product} />
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-xl bg-gray-50 p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Vendas 30d</dt>
          <dd className="mt-1 font-bold text-gray-950">{integer.format(product.unitsSold30)}</dd>
        </div>
        <div className="rounded-xl bg-gray-50 p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Faturamento</dt>
          <dd className="mt-1 font-bold text-gray-950">{currency.format(product.grossRevenue30)}</dd>
        </div>
        <div className="rounded-xl bg-gray-50 p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Físico</dt>
          <dd className="mt-1 font-bold text-gray-950">
            {product.physicalReady ? formatQuantity(product.physicalAvailable) : "—"}
          </dd>
        </div>
        <div className="rounded-xl bg-gray-50 p-3">
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">Full</dt>
          <dd className="mt-1 font-bold text-gray-950">
            {product.fullApplicable ? formatQuantity(product.fullAvailable) : "—"}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-4 text-xs">
        <span className="font-semibold text-gray-700">{formatPrice(product)}</span>
        <Link
          href={`/produto/${product.id}`}
          className="font-semibold text-gray-950 transition hover:text-gray-600"
        >
          Ver detalhe →
        </Link>
      </div>
    </article>
  );
}

export function ProductsOverviewView({
  overview,
  query,
  status,
}: ProductsOverviewViewProps) {
  const firstResult = overview.matchCount === 0
    ? 0
    : (overview.page - 1) * overview.limit + 1;
  const lastResult = Math.min(
    overview.page * overview.limit,
    overview.matchCount,
  );
  const hasPrevious = overview.page > 1;
  const hasNext = lastResult < overview.matchCount;

  return (
    <div className="mx-auto w-full max-w-[1500px] overflow-x-clip px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="mb-6">
        <p className="text-sm font-medium text-gray-500">Análise</p>
        <h1 className="mt-1 text-3xl font-bold tracking-tight text-gray-950">Produtos</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-500">
          Catálogo comercial com vendas, preços atuais, contas e disponibilidade por SKU.
        </p>
      </header>

      <section aria-label="Resumo de produtos" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Produtos monitorados"
          value={integer.format(overview.summary.totalProducts)}
          helper="SKUs canônicos da organização"
          dark
        />
        <SummaryCard
          label="Com anúncio ativo"
          value={integer.format(overview.summary.activeProducts)}
          helper="Produtos presentes em ofertas ativas"
        />
        <SummaryCard
          label="Unidades vendidas 30d"
          value={integer.format(overview.summary.unitsSold30)}
          helper="30 dias completos anteriores a hoje"
        />
        <SummaryCard
          label="Faturamento bruto 30d"
          value={currency.format(overview.summary.grossRevenue30)}
          helper="Receita bruta consolidada"
        />
      </section>

      <section className="mt-6" aria-labelledby="products-table-title">
        <div className="mb-4">
          <h2 id="products-table-title" className="text-sm font-semibold text-gray-950">
            Catálogo e inteligência comercial
          </h2>
          <p className="mt-1 text-xs text-gray-500">
            Dados agregados no banco para exibir somente os produtos desta página.
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
          <form method="get" action="/produtos" className="flex flex-col gap-3 sm:flex-row">
            <label htmlFor="products-search" className="sr-only">
              Buscar produto por SKU ou nome
            </label>
            <input
              id="products-search"
              name="q"
              type="search"
              defaultValue={query}
              placeholder="Buscar por SKU ou nome"
              className="min-w-0 flex-1 rounded-xl border border-gray-200 bg-gray-50 px-4 py-2.5 text-sm text-gray-950 outline-none transition placeholder:text-gray-400 focus:border-gray-400 focus:bg-white focus:ring-4 focus:ring-gray-100"
            />
            {status !== "all" ? <input type="hidden" name="status" value={status} /> : null}
            <button
              type="submit"
              className="rounded-xl bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-gray-200"
            >
              Buscar
            </button>
            {query ? (
              <Link
                href={productsHref({ query: "", status })}
                className="rounded-xl border border-gray-200 px-4 py-2.5 text-center text-sm font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Limpar
              </Link>
            ) : null}
          </form>

          <nav aria-label="Filtros de produtos" className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {filters.map((filter) => (
              <Link
                key={filter.value}
                href={productsHref({ query, status: filter.value })}
                aria-current={status === filter.value ? "page" : undefined}
                className={`shrink-0 rounded-xl border px-3 py-2 text-xs font-semibold transition ${
                  status === filter.value
                    ? "border-gray-950 bg-gray-950 text-white"
                    : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                {filter.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 px-1 text-xs text-gray-500">
          <p>
            Exibindo {integer.format(firstResult)}–{integer.format(lastResult)} de {integer.format(overview.matchCount)} resultado(s)
          </p>
          <div className="flex gap-2">
            {hasPrevious ? (
              <Link
                href={productsHref({ query, status, page: overview.page - 1 })}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2 font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                ← Anterior
              </Link>
            ) : null}
            {hasNext ? (
              <Link
                href={productsHref({ query, status, page: overview.page + 1 })}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2 font-semibold text-gray-700 transition hover:bg-gray-50"
              >
                Próxima →
              </Link>
            ) : null}
          </div>
        </div>

        {overview.products.length === 0 ? (
          <div className="mt-4 rounded-2xl border border-gray-200 bg-white p-10 text-center shadow-sm">
            <p className="text-sm font-semibold text-gray-950">Nenhum produto encontrado</p>
            <p className="mt-2 text-xs text-gray-500">Tente limpar a busca ou selecionar outro filtro.</p>
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-3 md:hidden">
              {overview.products.map((product) => (
                <MobileProductCard key={product.id} product={product} />
              ))}
            </div>

            <div className="mt-4 hidden overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm md:block">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[1320px] text-left">
                  <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-600">
                    <tr>
                      <th className="px-5 py-3">Produto</th>
                      <th className="px-5 py-3">Contas</th>
                      <th className="px-5 py-3 text-right">Anúncios ativos</th>
                      <th className="px-5 py-3 text-right">Vendas 30d</th>
                      <th className="px-5 py-3 text-right">Faturamento 30d</th>
                      <th className="px-5 py-3 text-right">Preço final</th>
                      <th className="px-5 py-3 text-right">Físico</th>
                      <th className="px-5 py-3 text-right">Full</th>
                      <th className="px-5 py-3">Situação</th>
                      <th className="px-5 py-3 text-right"><span className="sr-only">Ação</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {overview.products.map((product) => (
                      <tr key={product.id} className="text-sm transition hover:bg-gray-50/70">
                        <td className="max-w-[280px] px-5 py-4">
                          <Link
                            href={`/produto/${product.id}`}
                            className="font-bold text-gray-950 transition hover:text-gray-600"
                          >
                            {product.sku}
                          </Link>
                          <p className="mt-1 truncate text-xs text-gray-500">
                            {product.name ?? "Produto sem nome cadastrado"}
                          </p>
                        </td>
                        <td className="px-5 py-4"><AccountBadges product={product} /></td>
                        <td className="px-5 py-4 text-right font-bold text-gray-950">
                          {integer.format(product.activeListings)}
                        </td>
                        <td className="px-5 py-4 text-right font-bold text-gray-950">
                          {integer.format(product.unitsSold30)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-right font-bold text-gray-950">
                          {currency.format(product.grossRevenue30)}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-right text-xs font-semibold text-gray-700">
                          {formatPrice(product)}
                        </td>
                        <td className="px-5 py-4 text-right font-bold text-gray-950">
                          {product.physicalReady ? formatQuantity(product.physicalAvailable) : "—"}
                        </td>
                        <td className="px-5 py-4 text-right font-bold text-gray-950">
                          {product.fullApplicable ? formatQuantity(product.fullAvailable) : "—"}
                        </td>
                        <td className="px-5 py-4"><ProductStatus status={product.status} /></td>
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

