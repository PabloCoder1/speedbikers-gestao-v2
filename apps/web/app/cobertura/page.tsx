import { toSalesMetricDate } from "@sb/domain";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Cobertura de estoque — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Primeira fatia de "Cobertura, ruptura, vendas perdidas estimadas" (Fase
 * 5B, docs/ROADMAP.md). Cobertura e ruptura só — "vendas perdidas
 * estimadas" fica de fora desta fatia, ver comentário na migration
 * (`get_stock_coverage`, `20260823175030_create_stock_coverage_rpc.sql`).
 *
 * Janela FIXA de 30 dias — sem seletor de período nesta primeira fatia,
 * mesmo raciocínio de "escopo deliberadamente menor" já usado em outras
 * telas desta sessão. `get_stock_coverage` faz a soma em SQL, nunca aqui
 * (docs/ARCHITECTURE.md secao 21: "Zero agregação em JavaScript").
 */

const LOOKBACK_DAYS = 30;

/**
 * O gerador de tipos do Supabase não marca colunas de retorno de RPC como
 * anuláveis a partir da lógica SQL (`title`/`days_of_coverage` podem ser
 * `NULL` de verdade — `skus.title` é uma coluna anulável, e o `CASE` da
 * função devolve `NULL` quando não há venda no período) — mesma lacuna já
 * documentada nesta sessão para PARÂMETROS de RPC, aqui do lado do retorno.
 * Tipo local reflete a nulidade real, conferida contra o corpo da função.
 */
interface CoverageRow {
  sku_id: string;
  sku: string;
  title: string | null;
  local_quantity: number;
  units_sold: number;
  avg_daily_sales: number;
  days_of_coverage: number | null;
  is_ruptura: boolean;
  stock_is_virtual: boolean;
}

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

export default async function CoberturaPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Cobertura de estoque</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const now = new Date();
  const dateTo = toSalesMetricDate(now);
  const dateFrom = toSalesMetricDate(new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000));

  const { data, error } = await supabase.rpc("get_stock_coverage", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });

  const rows = ((data ?? []) as CoverageRow[]).slice().sort((a, b) => {
    // Estoque virtual vai para o FIM: não é urgência, é ausência de resposta.
    if (a.stock_is_virtual !== b.stock_is_virtual) return a.stock_is_virtual ? 1 : -1;
    if (a.is_ruptura !== b.is_ruptura) return a.is_ruptura ? -1 : 1;

    return (a.days_of_coverage ?? Infinity) - (b.days_of_coverage ?? Infinity);
  });

  const virtualCount = rows.filter((row) => row.stock_is_virtual).length;

  const rupturaCount = rows.filter((row) => row.is_ruptura).length;

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Cobertura de estoque</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Últimos {LOOKBACK_DAYS} dias ({dateFrom} a {dateTo}). Cobertura é o estoque local dividido pela venda média
        diária do período — quantos dias faltam para esgotar no ritmo atual. Ruptura: sem estoque local, mas com
        venda registrada no período (indica demanda perdida agora).
        {rupturaCount > 0 && (
          <strong style={{ color: "var(--sb-danger)" }}> {formatCount(rupturaCount)} SKU(s) em ruptura.</strong>
        )}
        {virtualCount > 0 && (
          <>
            {" "}
            {formatCount(virtualCount)} SKU(s) com <strong>estoque virtual</strong> — saldo sentinela no ERP, não
            contagem física (D-127). Para esses a cobertura fica em branco de propósito: sem saldo real, um número
            aqui seria resposta errada com cara de precisa.
          </>
        )}
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && rows.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum SKU com estoque local ou venda recente.</p>
      )}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "40rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Estoque local</th>
                <th style={th}>Vendido no período</th>
                <th style={th}>Média/dia</th>
                <th style={th}>Cobertura (dias)</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.sku_id}
                  style={
                    row.stock_is_virtual
                      ? { color: "var(--sb-text-soft)" }
                      : row.is_ruptura
                        ? { background: "#fdeaea" }
                        : undefined
                  }
                >
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    {row.sku}
                    {row.title !== null && (
                      <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                        {row.title}
                      </div>
                    )}
                  </td>
                  <td style={tdNumber}>{formatCount(row.local_quantity)}</td>
                  <td style={tdNumber}>{formatCount(row.units_sold)}</td>
                  <td style={tdNumber}>{row.avg_daily_sales}</td>
                  <td style={tdNumber}>
                    {row.stock_is_virtual
                      ? "estoque virtual"
                      : row.is_ruptura
                        ? "Em ruptura"
                        : (row.days_of_coverage ?? "—")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
