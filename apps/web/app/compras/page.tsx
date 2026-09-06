import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { purchaseOrderStatusLabel } from "../../lib/labels";
import { currentMembership } from "../../lib/membership";
import {
  PAGE_SIZE,
  PURCHASE_ORDER_STATUSES,
  buildPurchaseOrderHref,
  resolvePurchaseOrderFilters,
  summarizePurchaseOrderWindow,
} from "../../lib/purchase-order-filters";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Pedidos de Compra — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Pedidos de Compra — a lista, pelo frame `ProcessScreen type="purchases"`
 * (D19, D-255).
 *
 * **É a variação COMPLETA do frame**, ao contrário da `nfe` (D-253): cabeçalho
 * com ação "Novo Pedido", painel "Fila de Pedidos" com busca e menu de estado,
 * e tabela de sete colunas. Continua **sem faixa de KPIs** — o frame não
 * desenha cartão nenhum aqui, e inventá-los seria a mesma recusa de D-253 pelo
 * avesso.
 *
 * Duas das sete colunas do frame não são colunas do banco: **Itens** é
 * contagem e **Valor Estimado** é `sum(quantidade × custo)`. As duas saem de
 * `get_purchase_orders`, por `lateral` DEPOIS do `limit` (page-first, D-196) —
 * nenhuma filtra nem ordena, então calculá-las antes do recorte leria os itens
 * de todos os pedidos para enriquecer os 50 da tela.
 */

interface PurchaseOrderRow {
  id: string;
  order_number: number;
  status: string;
  supplier_name: string | null;
  destination_warehouse_name: string | null;
  expected_at: string | null;
  created_at: string;
  created_by_name: string | null;
  items_count: number;
  items_missing_cost: number;
  estimated_value: number | null;
  total_count: number;
}

export default async function ComprasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filters = resolvePurchaseOrderFilters(query);
  const supabase = await createClient();

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="ESTOQUE / OPERAÇÃO"
          title="Pedidos de Compra"
          subtitle="Planeje, aprove e acompanhe o abastecimento."
        />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const { data, error } = await supabase.rpc("get_purchase_orders", {
    p_organization_id: organizationId,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
    ...(filters.status !== null ? { p_status: filters.status } : {}),
    ...(filters.search !== null ? { p_search: filters.search } : {}),
  });

  const rows = (data ?? []) as unknown as PurchaseOrderRow[];
  const totalCount = rows[0]?.total_count ?? 0;
  const window = summarizePurchaseOrderWindow(filters.page, totalCount, rows.length);

  const rotuloEstado = filters.status === null ? "Estado" : purchaseOrderStatusLabel(filters.status);

  return (
    <Shell>
      {/* `OpsHeader` do frame: sobrancelha, título, linha de apoio e a ação primária. */}
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Pedidos de Compra"
        subtitle="Planeje, aprove e acompanhe o abastecimento."
        aside={
          <Link className="sb-button sb-button-primary" href="/compras/novo">
            Novo Pedido
          </Link>
        }
      />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <Panel
          title="Fila de Pedidos"
          aside={
            <>
              <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)", whiteSpace: "nowrap" }}>
                {window.label}
              </span>

              {/*
                A busca do frame ("Buscar PC, fornecedor..."), como GET nativo:
                o recorte fica na URL, nunca em estado React. O `hidden` do
                estado é obrigatório porque um form GET só envia os campos que
                tem — sem ele, buscar limparia o filtro de estado (regra de
                `/vendas`, repetida em `/estoque/movimentacoes`).
              */}
              <form method="get" style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
                {filters.status !== null && <input type="hidden" name="estado" value={filters.status} />}
                <input
                  className="sb-input"
                  type="search"
                  name="busca"
                  defaultValue={filters.search ?? ""}
                  placeholder="Buscar Nº, fornecedor…"
                  aria-label="Buscar por número do pedido ou fornecedor"
                  style={{ minWidth: "12rem" }}
                />
              </form>

              <FilterMenu
                rotulo={rotuloEstado}
                opcoes={[
                  {
                    href: buildPurchaseOrderHref(filters, { status: null }),
                    label: "Todos os estados",
                    ativo: filters.status === null,
                  },
                  ...PURCHASE_ORDER_STATUSES.map((estado) => ({
                    href: buildPurchaseOrderHref(filters, { status: estado }),
                    label: purchaseOrderStatusLabel(estado),
                    ativo: filters.status === estado,
                  })),
                ]}
              />
            </>
          }
        >
          {rows.length === 0 && (
            <p className="sb-empty">
              {filters.status === null && filters.search === null
                ? "Nenhum pedido de compra criado ainda."
                : window.label}
            </p>
          )}

          {rows.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Número</th>
                    <th>Fornecedor</th>
                    <th>Data</th>
                    <th className="sb-num">Itens</th>
                    <th className="sb-num">Valor Estimado</th>
                    <th>Responsável</th>
                    <th>Estado</th>
                    <th>Previsão</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((order) => (
                    <tr key={order.id}>
                      <td className="sb-mono">
                        <Link href={`/compras/${order.id}`}>#{order.order_number}</Link>
                      </td>
                      {/*
                        Fornecedor é anulável por desenho: um rascunho pode
                        nascer antes de o fornecedor estar decidido.
                      */}
                      <td>{order.supplier_name ?? "—"}</td>
                      <td>{formatDateTime(order.created_at)}</td>
                      <td className="sb-num">{formatCount(order.items_count)}</td>
                      {/*
                        Custo ausente não vira zero (D-254): `estimated_value`
                        é NULO quando há itens e nenhum tem custo, e a ressalva
                        aparece ao lado do número quando só ALGUNS têm
                        (`docs/METRICS.md` 5C.2).
                      */}
                      <td className="sb-num">
                        {formatCurrency(order.estimated_value)}
                        {order.items_missing_cost > 0 && (
                          <div style={{ fontSize: "0.625rem", color: "var(--sb-accent-ink)" }}>
                            {formatCount(order.items_missing_cost)} de {formatCount(order.items_count)} sem custo
                          </div>
                        )}
                      </td>
                      <td>{order.created_by_name ?? "—"}</td>
                      <td>
                        <StatusPill code={order.status} label={purchaseOrderStatusLabel(order.status)} />
                      </td>
                      <td>{order.expected_at === null ? "—" : formatDateTime(order.expected_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {error === null && window.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <Link className="sb-button" href={buildPurchaseOrderHref(filters, { page: filters.page - 1 })}>
              ← Anterior
            </Link>
          )}
          {filters.page < window.totalPages && (
            <Link className="sb-button" href={buildPurchaseOrderHref(filters, { page: filters.page + 1 })}>
              Próxima →
            </Link>
          )}
        </div>
      )}
    </Shell>
  );
}
