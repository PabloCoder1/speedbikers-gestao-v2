import { computeUsableStock } from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { FILTER_SUBMIT_STYLE, FilterPill } from "../../components/filter-pill";
import { Shell } from "../../components/shell";
import { formatBusinessDate, formatCount, formatCurrency } from "../../lib/format";
import { PAGE_SIZE, buildStockHref, resolveStockFilters, summarizeStockWindow } from "../../lib/stock-filters";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Estoque — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/compras/page.tsx.
export const dynamic = "force-dynamic";

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };


interface StockRow {
  sku_id: string;
  sku: string;
  title: string | null;
  local_quantity: number;
  reservado: number;
  transito: number;
  full_quantity: number | null;
  supplier_brand: string | null;
  category: string | null;
  purchase_cost: number | null;
  created_at: string;
  last_movement_at: string | null;
  stock_is_virtual: boolean;
  stock_is_virtual_set_at: string | null;
  total_count: number;
}

/**
 * Estoque enriquecido (Fase 5C, D-139).
 *
 * A tela mostrava quatro colunas enquanto marca, categoria, custo, Full e
 * datas já existiam no banco e ninguém as lia — era literalmente o que o
 * `docs/PRODUCT_REQUIREMENTS.md` apontava.
 *
 * **Duas ausências são deliberadas e valem mais que as colunas novas:**
 *
 * 1. **Não há coluna Origem.** `is_imported` e `origin_code` carregam a origem
 *    FISCAL (preenchida por quem emite a nota), não a rota de compra. Medido:
 *    `is_imported` diz que 187 dos 228 SKUs NAVETEC são nacionais, contra a
 *    regra do negócio. Mostrar "Nacional" ali seria a tela afirmando com
 *    confiança algo falso (D-129, D-139).
 * 2. **Não há Valor de estoque.** `docs/METRICS.md` 5C.4 o bloqueia, e a razão
 *    mudou de lugar: a questão do sentinela foi respondida (D-127) e a
 *    ferramenta existe (D-133), mas **1.089 SKUs têm a assinatura sentinela e
 *    ZERO estão classificados**. Multiplicar quantidade por custo hoje daria
 *    número inflado com cara de preciso.
 */
export default async function EstoquePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Estoque</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const filters = resolveStockFilters(query);

  // O pivô, os filtros, a ordenação e a contagem vêm do Postgres (D-131,
  // enriquecido em D-139). A tela nunca lê a tabela inteira.
  const { data, error } = await supabase.rpc("get_stock_balances", {
    p_organization_id: organizationId,
    p_supplier_brand: filters.brand,
    p_category: filters.category,
    p_search: filters.search,
    p_only_negative: filters.onlyNegative,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
  });

  const rows = (data ?? []) as StockRow[];
  const totalCount = rows[0]?.total_count ?? 0;
  const windowInfo = summarizeStockWindow(filters.page, totalCount, rows.length);

  // Marcas disponíveis para o filtro, vindas do que existe de verdade —
  // lista fixa envelheceria no primeiro preenchimento novo em `/produtos`.
  const brandsResult = await supabase
    .from("skus")
    .select("supplier_brand")
    .not("supplier_brand", "is", null)
    .order("supplier_brand");
  const brands = [...new Set((brandsResult.data ?? []).map((r) => r.supplier_brand))];

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Estoque</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Saldo por SKU, recomputado do ledger (<code>stock_movements</code>). Local é o estoque físico; reservado vem
        da reconciliação contra o UpSeller; em trânsito, do ciclo de pedidos de compra; Full é o último snapshot de
        cada conta, somado.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-3)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "4rem" }}>Marca</span>
          <FilterPill href={buildStockHref(filters, { brand: null })} active={filters.brand === null}>
            Todas
          </FilterPill>
          {brands.map((brand) => (
            <FilterPill key={brand} href={buildStockHref(filters, { brand })} active={filters.brand === brand}>
              {brand}
            </FilterPill>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
          <FilterPill
            href={buildStockHref(filters, { onlyNegative: !filters.onlyNegative })} active={filters.onlyNegative}
          >
            Só saldo negativo
          </FilterPill>

          <form method="get" style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
            {/* Hidden por dimensão ativa: GET nativo só envia campos do form (D-136). */}
            {filters.brand !== null && <input type="hidden" name="marca" value={filters.brand} />}
            {filters.category !== null && <input type="hidden" name="categoria" value={filters.category} />}
            {filters.onlyNegative && <input type="hidden" name="negativo" value="1" />}
            <input
              type="search"
              name="busca"
              defaultValue={filters.search ?? ""}
              placeholder="SKU ou título"
              aria-label="Buscar por SKU ou título"
              style={{
                padding: "0.25rem 0.5rem",
                borderRadius: "var(--sb-radius)",
                border: "1px solid var(--sb-border)",
                fontSize: "0.8125rem",
                minWidth: "14rem",
              }}
            />
            <button type="submit" style={FILTER_SUBMIT_STYLE}>
              Buscar
            </button>
          </form>
        </div>
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          {windowInfo.label}
        </p>
      )}

      {error === null && rows.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum SKU corresponde a estes filtros.</p>
      )}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "72rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Marca</th>
                <th style={th}>Categoria</th>
                <th style={th}>Local</th>
                <th style={th}>Full</th>
                <th style={th}>Reservado</th>
                <th style={th}>Em trânsito</th>
                <th style={th}>Aproveitável</th>
                <th style={th}>Custo</th>
                <th style={th}>Último movimento</th>
                <th style={th}></th>
                <th style={th}></th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr key={row.sku_id}>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    {row.sku}
                    {row.title !== null && (
                      <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                        {row.title}
                      </div>
                    )}
                  </td>
                  {/*
                    Marca VAZIA é estado legítimo, não falta de dado: só 36%
                    estão preenchidos, e o resto espera preenchimento humano em
                    `/produtos` (D-129/D-133). Travessão, nunca "—" alarmante.
                  */}
                  <td style={td}>{row.supplier_brand ?? "—"}</td>
                  <td style={td}>{row.category ?? "—"}</td>
                  <td style={{ ...tdNumber, color: row.local_quantity < 0 ? "var(--sb-danger)" : undefined }}>
                    {formatCount(row.local_quantity)}
                    {row.stock_is_virtual && (
                      <div style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>virtual</div>
                    )}
                  </td>
                  {/* Full nulo = SKU sem nada no Full, diferente de zero medido. */}
                  <td style={tdNumber}>{row.full_quantity === null ? "—" : formatCount(row.full_quantity)}</td>
                  <td style={tdNumber}>{formatCount(row.reservado)}</td>
                  <td style={tdNumber}>{formatCount(row.transito)}</td>
                  <td style={tdNumber}>
                    {(() => {
                      /*
                        Aproveitável = LOCAL + FULL + TRÂNSITO, RESERVADO fora
                        (já comprometido; o Disponível do UpSeller já o
                        exclui). Definição normativa em docs/METRICS.md §5D
                        (D-146). SKU virtual recusa o total — somar sentinela
                        com Full real seria lixo com aparência de precisão.
                      */
                      const usable = computeUsableStock({
                        localQuantity: row.local_quantity,
                        fullQuantity: row.full_quantity ?? 0,
                        transitQuantity: row.transito,
                        reservedQuantity: row.reservado,
                        stockIsVirtual: row.stock_is_virtual,
                      });

                      if (usable.total === null) {
                        return (
                          <span style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                            estoque virtual
                          </span>
                        );
                      }

                      return (
                        <span
                          title={`local ${String(usable.components.local)} + full ${String(usable.components.full)} + trânsito ${String(usable.components.transit)} (reservado ${String(usable.components.reservedExcluded)} fica fora)`}
                          style={{ fontWeight: 600 }}
                        >
                          {formatCount(usable.total)}
                        </span>
                      );
                    })()}
                  </td>
                  <td style={tdNumber}>{formatCurrency(row.purchase_cost)}</td>
                  <td style={td}>
                    {row.last_movement_at === null ? "—" : formatBusinessDate(row.last_movement_at.slice(0, 10))}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <Link href={`/skus/${row.sku_id}`}>Detalhes</Link>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <Link href={`/estoque/${row.sku_id}/ajuste`}>Ajustar</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error === null && windowInfo.totalPages > 1 && (
        <div
          style={{
            display: "flex",
            gap: "var(--sb-space-2)",
            alignItems: "center",
            marginTop: "var(--sb-space-3)",
            fontSize: "0.8125rem",
          }}
        >
          {filters.page > 1 && (
            <FilterPill href={buildStockHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          <span style={{ color: "var(--sb-text-soft)" }}>
            Página {filters.page} de {windowInfo.totalPages}
          </span>
          {filters.page < windowInfo.totalPages && (
            <FilterPill href={buildStockHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
