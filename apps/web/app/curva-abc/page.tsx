import type { ReactNode } from "react";

import { FilterPill } from "../../components/filter-pill";
import { Shell } from "../../components/shell";
import {
  ABC_CRITERIA,
  ABC_PERIODS,
  PAGE_SIZE,
  buildAbcHref,
  resolveAbcFilters,
  summarizeAbcWindow,
} from "../../lib/abc-filters";
import { formatCount, formatCurrency } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Curva ABC — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Curva ABC com escopo, critério e período (Fase 5C, D-140).
 *
 * **O escopo de conta RECALCULA a curva, não a filtra.** Medido em
 * 2026-08-29: 743 SKUs vendem em mais de uma conta e 476 (64,1%) mudam de
 * classe conforme a conta. O parâmetro entra nas duas pontas do RPC —
 * conjunto e denominador —, nunca em JavaScript.
 *
 * 🔴 **A versão anterior mostrava 1.000 de 1.492 SKUs e somava as classes em
 * JavaScript sobre esse resultado truncado**: exibia classe C = 298 quando o
 * real era 790, e o filtro "sem Full" via 699 de 1.180. Sétima ocorrência da
 * classe de D-131, e a primeira em que o estrago foi uma ESTATÍSTICA e não
 * uma lista. As contagens agora são janela sobre o conjunto filtrado inteiro,
 * calculadas no Postgres.
 */
interface AbcRow {
  sku_id: string;
  sku: string;
  title: string | null;
  metric_value: number;
  metric_share: number;
  cumulative_share: number;
  abc_class: "A" | "B" | "C";
  full_quantity: number;
  total_count: number;
  class_a_count: number;
  class_b_count: number;
  class_c_count: number;
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
  const supabase = await createClient();

  // As contas não dependem da organização: a RLS já as restringe, e o `select`
  // de `organization_members` existe para o guarda de "sem organização", não
  // para filtrar. As duas leituras saem juntas desde D-195; a RPC abaixo
  // continua depois, porque ela SIM precisa da conta escolhida.
  const [membership, accountsResult] = await Promise.all([
    supabase.from("organization_members").select("organization_id").maybeSingle(),
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
  ]);

  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Curva ABC</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const filters = resolveAbcFilters(query);

  const accounts = accountsResult.data ?? [];
  // Slug desconhecido cai em "consolidado" em silêncio — mesmo tratamento de
  // `/vendas` e `/anuncios`.
  const selectedAccount = accounts.find((a) => a.slug === filters.accountSlug) ?? null;

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (filters.days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("get_sku_abc_curve", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: selectedAccount?.id ?? null,
    p_criterion: filters.criterion.key,
    p_only_without_full: filters.onlyWithoutFull,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
  });

  const rows = (data ?? []) as AbcRow[];
  const first = rows[0];
  const totalCount = first?.total_count ?? 0;
  const windowInfo = summarizeAbcWindow(filters.page, totalCount, rows.length);
  const formatValue = filters.criterion.format === "currency" ? formatCurrency : formatCount;

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Curva ABC</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Últimos {filters.days} dias ({dateFrom} a {dateTo}), por {filters.criterion.label.toLowerCase()}
        {selectedAccount === null ? ", consolidado" : `, recalculada dentro de ${selectedAccount.label}`}. Classe A
        concentra até 80% do acumulado, B até 95%, C o resto — SKU sem venda no período não entra na curva.
        {first !== undefined && (
          <>
            {" "}
            Classe A: {formatCount(first.class_a_count)} · B: {formatCount(first.class_b_count)} · C:{" "}
            {formatCount(first.class_c_count)}.
          </>
        )}
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-3)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "5rem" }}>Escopo</span>
          <FilterPill href={buildAbcHref(filters, { accountSlug: null })} active={filters.accountSlug === null}>
            Consolidado
          </FilterPill>
          {accounts.map((account) => (
            <FilterPill
              key={account.id}
              href={buildAbcHref(filters, { accountSlug: account.slug })} active={filters.accountSlug === account.slug}
            >
              {account.label}
            </FilterPill>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "5rem" }}>Critério</span>
          {ABC_CRITERIA.map((criterion) => (
            <FilterPill
              key={criterion.key}
              href={buildAbcHref(filters, { criterion })} active={filters.criterion.key === criterion.key}
            >
              {criterion.label}
            </FilterPill>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "5rem" }}>Período</span>
          {ABC_PERIODS.map((days) => (
            <FilterPill key={days} href={buildAbcHref(filters, { days })} active={filters.days === days}>
              {days} dias
            </FilterPill>
          ))}

          <FilterPill
            href={buildAbcHref(filters, { onlyWithoutFull: !filters.onlyWithoutFull })} active={filters.onlyWithoutFull}
          >
            Somente sem estoque em Full
          </FilterPill>
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

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "44rem" }}>
            <thead>
              <tr>
                <th style={th}>Classe</th>
                <th style={th}>SKU</th>
                <th style={th}>{filters.criterion.label}</th>
                <th style={th}>% do total</th>
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
                  <td style={tdNumber}>{formatValue(row.metric_value)}</td>
                  <td style={tdNumber}>{row.metric_share}%</td>
                  <td style={tdNumber}>{row.cumulative_share}%</td>
                  <td style={tdNumber}>{formatCount(row.full_quantity)}</td>
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
            <FilterPill href={buildAbcHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          <span style={{ color: "var(--sb-text-soft)" }}>
            Página {filters.page} de {windowInfo.totalPages}
          </span>
          {filters.page < windowInfo.totalPages && (
            <FilterPill href={buildAbcHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
