import { toSalesMetricDate } from "@sb/domain";
import type { ReactNode } from "react";

import { FilterPill } from "../../components/filter-pill";
import { Shell } from "../../components/shell";
import { TrendBadge } from "../../components/trend-badge";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { buildCoverageHref, resolveCoverageFilters } from "../../lib/coverage-filters";
import { currentMembership } from "../../lib/membership";

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
  units_15d: number;
  units_30d: number;
  units_60d: number;
  units_90d: number;
  history_days_90: number;
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

/**
 * Quantas linhas a tela mostra por vez. O conjunto real passa de 2.600 e o
 * teto do PostgREST é 1.000 — pedir "tudo" nunca trouxe tudo, só escondia o
 * corte (D-131). Com a ordenação em SQL, as primeiras linhas são as que
 * importam: ruptura antes, cobertura mais curta antes.
 */
const PAGE_SIZE = 200;

export default async function CoberturaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Cobertura de estoque</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const filters = resolveCoverageFilters(query);

  const now = new Date();
  const dateTo = toSalesMetricDate(now);
  const dateFrom = toSalesMetricDate(new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000));

  // ORDENAÇÃO E LIMITE EXPLÍCITOS (D-131). Antes, esta chamada não tinha
  // `.range()`: o PostgREST devolvia 1.000 das 2.602 linhas por causa de
  // `max_rows = 1000`, e a página ordenava e CONTAVA em JavaScript sobre essa
  // fatia arbitrária. O cabeçalho anunciava uma ruptura contada numa amostra
  // — a real é 924. Ordenar em SQL também respeita `docs/ARCHITECTURE.md`
  // secao 15/21; a ordem é a mesma de antes, só que agora sobre o conjunto
  // inteiro: virtual por último (não é urgência, é ausência de resposta),
  // ruptura primeiro, depois menor cobertura.
  const [coverage, summary, brandsResult] = await Promise.all([
    supabase
      .rpc("get_stock_coverage", {
        p_organization_id: organizationId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_supplier_brand: filters.brand,
      })
      .order("stock_is_virtual")
      .order("is_ruptura", { ascending: false })
      .order("days_of_coverage", { nullsFirst: false })
      .range(0, PAGE_SIZE - 1),
    // Os totais recebem o MESMO filtro: com recorte, "924 em ruptura" tem de
    // ser da marca, não da operação inteira — senão o cabeçalho contradiz a
    // tabela logo abaixo dele.
    supabase.rpc("get_stock_coverage_summary", {
      p_organization_id: organizationId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
      p_supplier_brand: filters.brand,
    }),
    // A lista vem do BANCO, nunca das linhas da página (D-194): montá-la a
    // partir do resultado paginado fazia 10 das 19 marcas nunca aparecerem.
    supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
  ]);

  const { data, error } = coverage;

  const rows = (data ?? []) as CoverageRow[];

  // Os totais vêm do Postgres sobre o conjunto INTEIRO — nunca de contar o
  // que coube na página.
  const brands = (brandsResult.data ?? []).map((r) => r.supplier_brand);
  const totals = summary.data?.[0] ?? null;
  const rupturaCount = totals?.em_ruptura ?? 0;
  const virtualCount = totals?.virtuais ?? 0;
  const totalCount = totals?.total ?? rows.length;

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Cobertura de estoque</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Últimos {LOOKBACK_DAYS} dias ({dateFrom} a {dateTo})
        {filters.brand === null ? "" : `, só ${filters.brand}`}. Cobertura é o estoque local dividido pela venda média
        diária do período — quantos dias faltam para esgotar no ritmo atual. Ruptura: sem estoque local, mas com
        venda registrada no período (indica demanda perdida agora).
        {rupturaCount > 0 && (
          <strong style={{ color: "var(--sb-danger)" }}> {formatCount(rupturaCount)} SKU(s) em ruptura.</strong>
        )}{" "}
        <a href="/produtos?estado=pendente&amp;sinal=sentinela">Classificar estoque virtual</a> — SKU com saldo
        sentinela ainda não classificado aparece aqui como se o número fosse real.
        {virtualCount > 0 && (
          <>
            {" "}
            {formatCount(virtualCount)} SKU(s) com <strong>estoque virtual</strong> — saldo sentinela no ERP, não
            contagem física (D-127). Para esses a cobertura fica em branco de propósito: sem saldo real, um número
            aqui seria resposta errada com cara de precisa.
          </>
        )}
      </p>

      {/*
        Só MARCA. Não há seletor de conta aqui de propósito: estoque físico é
        da organização (regra do item P1) — Full é que é por conta, e quem
        responde por conta é a Central Full.
      */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--sb-space-2)",
          alignItems: "center",
          marginBottom: "var(--sb-space-3)",
        }}
      >
        <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "4rem" }}>Marca</span>
        <FilterPill href={buildCoverageHref(filters, { brand: null })} active={filters.brand === null}>
          Todas
        </FilterPill>
        {brands.map((brand) => (
          <FilterPill key={brand} href={buildCoverageHref(filters, { brand })} active={filters.brand === brand}>
            {brand}
          </FilterPill>
        ))}
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && totalCount > rows.length && (
        <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          Mostrando os <strong>{formatCount(rows.length)}</strong> mais urgentes de{" "}
          <strong>{formatCount(totalCount)}</strong> SKUs. Os totais acima são do conjunto inteiro, não desta página.
        </p>
      )}

      {error === null && rows.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          {filters.brand === null
            ? "Nenhum SKU com estoque local ou venda recente."
            : `Nenhum SKU de ${filters.brand} com estoque local ou venda recente. A operação inteira pode ter — este é o recorte da marca.`}
        </p>
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
                <th style={th}>Tendência</th>
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
                        ? { background: "var(--sb-danger-soft)" }
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
                  <td style={td}>
                    {/* Classificação e aparência compartilhadas com /reposicao (D-147). */}
                    <TrendBadge
                      units15={row.units_15d}
                      units30={row.units_30d}
                      units60={row.units_60d}
                      units90={row.units_90d}
                      historyDays90={row.history_days_90}
                    />
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
