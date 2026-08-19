"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createPurchaseOrderFromPlanningAction } from "@/features/purchase-orders/actions";
import type {
  PurchasePlanningFilter,
  PurchasePlanningItem,
  PurchasePlanningOverview,
} from "@/features/stock/get-purchase-planning";

const openOrderLabel: Record<string, string> = {
  draft: "Em pedido pendente",
  approved: "Em pedido pendente",
  ordered: "Pedido em trânsito",
  partially_received: "Pedido em trânsito",
};

function isSelectable(item: PurchasePlanningItem) {
  return (
    (item.status === "urgent" || item.status === "due") &&
    (item.suggestedPurchaseQuantity ?? 0) > 0 &&
    item.salesVelocityReady &&
    item.planningIssue === null &&
    item.openOrders.length === 0
  );
}

type PurchasePlanningViewProps = {
  overview: PurchasePlanningOverview;
  query: string;
  filter: PurchasePlanningFilter;
};

const integer = new Intl.NumberFormat("pt-BR");
const decimal = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const currency = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const statusConfig: Record<
  PurchasePlanningItem["status"],
  { label: string; badge: "danger" | "warning" | "info" | "success"; border: string }
> = {
  urgent: { label: "Urgente", badge: "danger", border: "border-l-red-500" },
  due: { label: "Comprar", badge: "warning", border: "border-l-amber-500" },
  covered: { label: "Coberto", badge: "success", border: "border-l-emerald-500" },
  no_sales: { label: "Sem venda", badge: "info", border: "border-l-gray-300" },
  insufficient_data: { label: "Dados insuficientes", badge: "info", border: "border-l-blue-400" },
  mapping_issue: { label: "Vínculo pendente", badge: "info", border: "border-l-blue-400" },
};

const filters: { value: PurchasePlanningFilter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "purchase", label: "Comprar agora" },
  { value: "urgent", label: "Urgentes" },
  { value: "covered", label: "Cobertos" },
  { value: "no_sales", label: "Sem venda" },
  { value: "insufficient_data", label: "Dados insuficientes" },
  { value: "imported", label: "Importados 90d" },
  { value: "domestic", label: "Nacionais 15d" },
];

function purchaseHref({
  query,
  filter,
}: {
  query: string;
  filter: PurchasePlanningFilter;
}) {
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (filter !== "all") params.set("filter", filter);
  const suffix = params.toString();
  return suffix ? `/compras?${suffix}` : "/compras";
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
      <p className="mt-3 text-3xl font-bold tracking-tight">{value}</p>
      <p className={`mt-2 text-xs leading-5 ${muted}`}>{helper}</p>
    </div>
  );
}

function CoverageCell({ item }: { item: PurchasePlanningItem }) {
  if (!item.salesVelocityReady) {
    return <span className="text-xs text-gray-400">Dados insuficientes</span>;
  }
  if (item.coverageDays === null) {
    return <span className="text-xs text-gray-400">Sem venda</span>;
  }
  const tone = item.coverageDays <= item.leadTimeDays ? "text-red-700" : "text-gray-950";
  return (
    <span className={`text-sm font-semibold ${tone}`}>
      {decimal.format(item.coverageDays)} dias
    </span>
  );
}

function SuggestionCell({ item }: { item: PurchasePlanningItem }) {
  if (item.suggestedPurchaseQuantity === null) {
    return <span className="text-xs text-gray-400">Não calculado</span>;
  }
  if (item.suggestedPurchaseQuantity === 0) {
    return <span className="text-xs text-gray-500">Não comprar</span>;
  }
  return (
    <div>
      <p className="text-lg font-bold tracking-tight text-gray-950">
        {integer.format(item.suggestedPurchaseQuantity)} un.
      </p>
      {item.estimatedPurchaseValue !== null ? (
        <p className="mt-0.5 text-xs text-gray-500">
          ~{currency.format(item.estimatedPurchaseValue)}
        </p>
      ) : (
        <p className="mt-0.5 text-xs text-gray-400">Custo desconhecido</p>
      )}
    </div>
  );
}

function PurchaseRow({
  item,
  selected,
  onToggle,
}: {
  item: PurchasePlanningItem;
  selected: boolean;
  onToggle: () => void;
}) {
  const config = statusConfig[item.status];
  const selectable = isSelectable(item);

  return (
    <tr className={`border-b border-l-4 border-gray-100 ${config.border} align-top`}>
      <td className="px-4 py-4">
        <input
          type="checkbox"
          checked={selected}
          disabled={!selectable}
          onChange={onToggle}
          aria-label={`Selecionar ${item.sourceSku}`}
        />
      </td>
      <td className="px-4 py-4">
        <p className="font-semibold text-gray-950">{item.sourceSku}</p>
        <p className="mt-0.5 max-w-xs truncate text-xs text-gray-500">
          {item.title ?? "Sem título no catálogo"}
        </p>
        {item.sourceProductsCount > 1 ? (
          <p className="mt-1 text-[11px] text-gray-400">
            {integer.format(item.sourceProductsCount)} produtos vinculados
          </p>
        ) : null}
        {item.consumesViaKits ? (
          <p className="mt-1 text-[11px] font-medium text-indigo-600">Consumo inclui kits</p>
        ) : null}
      </td>

      <td className="px-4 py-4 text-sm text-gray-700">{item.brand ?? "—"}</td>

      <td className="px-4 py-4">
        <p className="text-sm font-semibold text-gray-950">
          {item.physicalAvailable === null
            ? "—"
            : `${integer.format(item.physicalAvailable)} disp.`}
        </p>
        {item.physicalCurrent !== null ? (
          <p className="mt-0.5 text-xs text-gray-500">
            Atual: {integer.format(item.physicalCurrent)}
          </p>
        ) : null}
      </td>

      <td className="px-4 py-4">
        <p className="text-sm text-gray-950">
          Compra: <span className="font-semibold">{integer.format(item.purchaseInTransit)}</span>
        </p>
        <p className="mt-0.5 text-[11px] text-gray-400">
          UpSeller {integer.format(item.upsellerPurchaseInTransit)} · Interno{" "}
          {integer.format(item.internalPurchaseInTransit)}
        </p>
        <p className="mt-0.5 text-xs text-gray-500">
          Transf.: {integer.format(item.transferInTransit)}
        </p>
      </td>

      <td className="px-4 py-4">
        <p className="text-sm font-semibold text-gray-950">
          {integer.format(item.physicalUnitsConsumed30)}
        </p>
        {item.consumesViaKits ? (
          <p className="mt-0.5 text-[11px] text-gray-500">
            direto {integer.format(item.directUnitsSold30)} · kits{" "}
            {integer.format(item.kitUnitsConsumed30)}
          </p>
        ) : null}
      </td>

      <td className="px-4 py-4">
        <CoverageCell item={item} />
      </td>

      <td className="px-4 py-4">
        <Badge variant={item.leadTimeDays === 90 ? "warning" : "info"}>
          {item.leadTimeDays} dias
        </Badge>
        <p className="mt-1 text-[11px] text-gray-500">
          {item.leadTimeDays === 90 ? "Importado" : "Nacional"}
        </p>
      </td>

      <td className="px-4 py-4">
        {item.projectedStockAtArrival === null ? (
          <span className="text-xs text-gray-400">—</span>
        ) : (
          <span
            className={`text-sm font-semibold ${
              item.projectedStockAtArrival < 0 ? "text-red-700" : "text-gray-950"
            }`}
          >
            {integer.format(Math.round(item.projectedStockAtArrival))}
          </span>
        )}
      </td>

      <td className="px-4 py-4">
        <SuggestionCell item={item} />
      </td>

      <td className="px-4 py-4">
        <Badge variant={config.badge}>{config.label}</Badge>
        {item.planningIssue === "kit_components_unknown" ? (
          <p className="mt-1 text-[11px] text-gray-500">Composição do kit incompleta</p>
        ) : null}
        {item.openOrders[0] ? (
          <Link
            href={`/pedidos-compra/${item.openOrders[0].purchaseOrderId}`}
            className="mt-2 block text-[11px] font-semibold text-blue-700 hover:underline"
          >
            {openOrderLabel[item.openOrders[0].status]} · Ver pedido
          </Link>
        ) : null}
        {item.sourceProductIds.length === 1 ? (
          <Link
            href={`/produto/${item.sourceProductIds[0]}`}
            className="mt-2 block text-xs font-semibold text-gray-950 underline-offset-2 hover:underline"
          >
            Ver produto →
          </Link>
        ) : item.sourceProductIds.length > 1 ? (
          <Link
            href={`/produtos?q=${encodeURIComponent(item.sourceSku)}`}
            className="mt-2 block text-xs font-semibold text-gray-950 underline-offset-2 hover:underline"
          >
            Ver produtos vinculados
          </Link>
        ) : null}
      </td>
    </tr>
  );
}

export function PurchasePlanningView({
  overview,
  query,
  filter,
}: PurchasePlanningViewProps) {
  const { summary, items } = overview;
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [creationFeedback, setCreationFeedback] = useState<{ type: "error" | "warning"; message: string } | null>(null);

  const selectableCount = useMemo(() => items.filter(isSelectable).length, [items]);

  function toggleRow(sourceSkuKey: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sourceSkuKey)) next.delete(sourceSkuKey);
      else next.add(sourceSkuKey);
      return next;
    });
  }

  function handleCreateOrder() {
    if (selected.size === 0) return;
    setCreationFeedback(null);
    startTransition(async () => {
      const result = await createPurchaseOrderFromPlanningAction(Array.from(selected));
      if (result.error) {
        setCreationFeedback({ type: "error", message: result.error });
        return;
      }
      if (result.created && result.purchaseOrderId) {
        setSelected(new Set());
        router.push(`/pedidos-compra/${result.purchaseOrderId}`);
        return;
      }
      if (result.existingOpenOrders.length > 0) {
        setCreationFeedback({
          type: "warning",
          message: "Todos os SKUs selecionados já estão em pedidos abertos. Abra o pedido existente para ajustá-lo.",
        });
      }
    });
  }

  return (
    <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="mb-6">
        <p className="text-sm font-medium text-gray-500">Operação</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-950">
              Compras e reposição
            </h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-gray-500">
              Planejamento de compra baseado em giro, estoque físico e prazo de reposição.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/pedidos-compra"
              className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50"
            >
              Ver pedidos de compra
            </Link>
            <Link
              href="/estoque"
              className="rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-xs font-semibold text-gray-700 shadow-sm transition hover:bg-gray-50"
            >
              Ver visão de estoque
            </Link>
            <Button onClick={handleCreateOrder} disabled={selected.size === 0 || isPending}>
              {isPending ? "Criando pedido…" : `Criar pedido com selecionados (${selected.size})`}
            </Button>
          </div>
        </div>
        {creationFeedback ? (
          <div
            className={`mt-4 rounded-xl border p-3 text-sm ${
              creationFeedback.type === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-amber-200 bg-amber-50 text-amber-800"
            }`}
          >
            {creationFeedback.message}
          </div>
        ) : null}
        {selectableCount > 0 ? (
          <p className="mt-2 text-xs text-gray-400">
            {selectableCount} SKU(s) elegível(is) para criação de pedido nesta página.
          </p>
        ) : null}
      </header>

      <section aria-label="Resumo de compras" className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <SummaryCard
          label="SKUs físicos"
          value={integer.format(summary.monitoredSkus)}
          helper={
            summary.periodFrom && summary.periodTo
              ? `Giro de ${summary.periodFrom} a ${summary.periodTo}`
              : "Monitorados no planejamento"
          }
          tone="dark"
        />
        <SummaryCard
          label="Precisam comprar"
          value={integer.format(summary.needPurchase)}
          helper="Sugestão calculada maior que zero"
          tone={summary.needPurchase > 0 ? "warning" : "default"}
        />
        <SummaryCard
          label="Urgentes"
          value={integer.format(summary.urgent)}
          helper="Sem estoque físico disponível"
          tone={summary.urgent > 0 ? "critical" : "default"}
        />
        <SummaryCard
          label="Unidades sugeridas"
          value={integer.format(summary.suggestedUnits)}
          helper="Soma das sugestões calculadas"
        />
        <SummaryCard
          label="Valor sugerido"
          value={currency.format(summary.estimatedPurchaseValue)}
          helper={
            summary.skusWithoutCost > 0
              ? `Exclui ${integer.format(summary.skusWithoutCost)} SKU(s) sem custo conhecido`
              : "Todos os SKUs têm custo conhecido"
          }
        />
      </section>

      <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <label htmlFor="purchase-search" className="sr-only">
            Buscar SKU físico, título ou marca
          </label>
          <input
            id="purchase-search"
            name="q"
            defaultValue={query}
            placeholder="Buscar SKU físico, título ou marca"
            className="min-w-64 flex-1 rounded-xl border border-gray-200 px-4 py-2.5 text-sm outline-none focus:border-gray-950"
          />
          {filter !== "all" ? <input type="hidden" name="filter" value={filter} /> : null}
          <button
            type="submit"
            className="rounded-xl bg-gray-950 px-4 py-2.5 text-xs font-semibold text-white transition hover:bg-gray-800"
          >
            Buscar
          </button>
          {query ? (
            <Link
              href={purchaseHref({ query: "", filter })}
              className="rounded-xl border border-gray-200 px-4 py-2.5 text-xs font-semibold text-gray-700 transition hover:bg-gray-50"
            >
              Limpar
            </Link>
          ) : null}
        </form>

        <nav className="mt-3 flex flex-wrap gap-2">
          {filters.map((option) => (
            <Link
              key={option.value}
              href={purchaseHref({ query, filter: option.value })}
              aria-current={filter === option.value ? "page" : undefined}
              className={`rounded-xl px-3 py-2 text-xs font-semibold transition ${
                filter === option.value
                  ? "bg-gray-950 text-white"
                  : "border border-gray-200 text-gray-700 hover:bg-gray-50"
              }`}
            >
              {option.label}
            </Link>
          ))}
        </nav>
      </section>

      <div className="mt-4 rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs leading-5 text-gray-600">
        <span className="font-semibold text-gray-950">Como a sugestão é calculada:</span>{" "}
        demanda durante o prazo de entrega + estoque mínimo − disponível − compras em trânsito.
        O resultado é arredondado para cima e nunca fica negativo. Transferências entre depósitos
        e estoque no Mercado Livre Full são exibidos como contexto, mas não reduzem a sugestão.
        É um cálculo determinístico, não uma previsão.
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-gray-500">
        <p>
          Exibindo {integer.format(items.length)} de {integer.format(overview.matchCount)} SKU(s)
          físico(s)
        </p>
        {overview.matchCount > items.length ? (
          <p>Refine a busca para visualizar outros SKUs.</p>
        ) : null}
      </div>

      {items.length === 0 ? (
        <section className="mt-4 rounded-2xl border border-gray-200 bg-white p-10 text-center shadow-sm">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-xl text-emerald-700">
            ✓
          </div>
          <h2 className="mt-4 text-base font-bold text-gray-950">Nenhum SKU encontrado</h2>
          <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-gray-500">
            Ajuste a busca ou o filtro para ver outros SKUs físicos.
          </p>
        </section>
      ) : (
        <section className="mt-4 overflow-x-auto rounded-2xl border border-gray-200 bg-white shadow-sm">
          <table className="w-full min-w-[1200px] text-left">
            <thead className="border-b border-gray-200 bg-gray-50 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              <tr>
                <th className="w-10 px-4 py-3" />
                <th className="px-4 py-3">Produto físico</th>
                <th className="px-4 py-3">Marca</th>
                <th className="px-4 py-3">Estoque</th>
                <th className="px-4 py-3">Em trânsito</th>
                <th className="px-4 py-3">Vendas 30d</th>
                <th className="px-4 py-3">Cobertura</th>
                <th className="px-4 py-3">Lead time</th>
                <th className="px-4 py-3">Projeção chegada</th>
                <th className="px-4 py-3">Sugestão</th>
                <th className="px-4 py-3">Situação</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <PurchaseRow
                  key={item.sourceSkuKey}
                  item={item}
                  selected={selected.has(item.sourceSkuKey)}
                  onToggle={() => toggleRow(item.sourceSkuKey)}
                />
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
