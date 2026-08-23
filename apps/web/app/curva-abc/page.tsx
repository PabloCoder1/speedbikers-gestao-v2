import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount, formatCurrency } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Curva ABC — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * "Curva ABC e filtros de Full" (Fase 5B, docs/ROADMAP.md) — as duas metades
 * do item de checklist viram UMA tela: classe A/B/C por receita, com um
 * filtro para achar SKUs de alta venda que não têm estoque em Full nenhum
 * (dependem 100% do local). `get_sku_abc_curve` faz toda a soma e o
 * ranqueamento em SQL (docs/ARCHITECTURE.md secao 21).
 *
 * Janela FIXA de 90 dias — mais longa que os 30 dias de /cobertura de
 * propósito: classificação ABC precisa de um sinal mais estável, 30 dias tem
 * ruído demais para SKUs de venda mais espaçada. Sem seletor de período
 * nesta primeira fatia, mesmo raciocínio de "escopo deliberadamente menor"
 * já usado em outras telas desta sessão.
 */

const LOOKBACK_DAYS = 90;

/**
 * `title` é anulável de verdade (`skus.title`), mas o gerador de tipos do
 * Supabase não infere nulidade em coluna de retorno de RPC a partir da
 * lógica SQL — mesma lacuna já documentada em `get_stock_coverage`
 * (apps/web/app/cobertura/page.tsx). Tipo local reflete a nulidade real.
 */
interface AbcRow {
  sku_id: string;
  sku: string;
  title: string | null;
  gross_revenue: number;
  revenue_share: number;
  cumulative_share: number;
  abc_class: "A" | "B" | "C";
  full_quantity: number;
}

const CLASS_TONE: Record<string, { background: string; color: string }> = {
  A: { background: "#e6f4ea", color: "#136c34" },
  B: { background: "#fff8dc", color: "var(--sb-accent-ink)" },
  C: { background: "var(--sb-muted)", color: "var(--sb-text)" },
};

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

export default async function CurvaAbcPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const semFull = query.semFull === "1";

  const supabase = await createClient();

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Curva ABC</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("get_sku_abc_curve", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });

  const allRows = (data ?? []) as AbcRow[];
  const rows = semFull ? allRows.filter((row) => row.full_quantity === 0) : allRows;

  const classCounts = { A: 0, B: 0, C: 0 };
  for (const row of allRows) {
    classCounts[row.abc_class] += 1;
  }

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Curva ABC</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Últimos {LOOKBACK_DAYS} dias ({dateFrom} a {dateTo}). Classe A concentra até 80% da receita acumulada, B até
        95%, C o resto — SKU sem venda no período não entra na curva. Classe A: {formatCount(classCounts.A)} · B:{" "}
        {formatCount(classCounts.B)} · C: {formatCount(classCounts.C)}.
      </p>

      <div style={{ margin: "0 0 var(--sb-space-3)" }}>
        <Link
          href={semFull ? "/curva-abc" : "/curva-abc?semFull=1"}
          style={{
            display: "inline-block",
            border: "1px solid var(--sb-border)",
            borderRadius: "var(--sb-radius)",
            padding: "0.25rem 0.75rem",
            fontSize: "0.8125rem",
            textDecoration: "none",
            color: semFull ? "var(--sb-primary-ink, #fff)" : "var(--sb-text)",
            background: semFull ? "var(--sb-primary)" : "transparent",
          }}
        >
          {semFull ? "✓ Somente sem estoque em Full" : "Somente sem estoque em Full"}
        </Link>
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && rows.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          {semFull ? "Nenhum SKU sem estoque em Full nesta janela." : "Nenhum SKU com venda no período."}
        </p>
      )}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "44rem" }}>
            <thead>
              <tr>
                <th style={th}>Classe</th>
                <th style={th}>SKU</th>
                <th style={th}>Receita</th>
                <th style={th}>% receita</th>
                <th style={th}>% acumulado</th>
                <th style={th}>Estoque Full</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr key={row.sku_id}>
                  <td style={td}>
                    <span
                      style={{
                        ...CLASS_TONE[row.abc_class],
                        display: "inline-block",
                        borderRadius: "999px",
                        padding: "0.125rem 0.5rem",
                        fontSize: "0.75rem",
                        fontWeight: 600,
                      }}
                    >
                      {row.abc_class}
                    </span>
                  </td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    {row.sku}
                    {row.title !== null && (
                      <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                        {row.title}
                      </div>
                    )}
                  </td>
                  <td style={tdNumber}>{formatCurrency(row.gross_revenue)}</td>
                  <td style={tdNumber}>{row.revenue_share}%</td>
                  <td style={tdNumber}>{row.cumulative_share}%</td>
                  <td style={tdNumber}>{formatCount(row.full_quantity)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
