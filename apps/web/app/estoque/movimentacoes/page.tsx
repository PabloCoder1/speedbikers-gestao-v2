import type { ReactNode } from "react";

import Link from "next/link";

import { FILTER_SUBMIT_STYLE, FilterPill } from "../../../components/filter-pill";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { formatDateTime, formatCount } from "../../../lib/format";
import {
  LOCATION_KINDS,
  MOVEMENT_TYPES,
  PAGE_SIZE,
  SOURCE_TYPES,
  buildMovementHref,
  resolveMovementFilters,
  summarizePagedWindow,
} from "../../../lib/movement-filters";
import {
  formatQtyDelta,
  locationKindLabel,
  movementSourceLabel,
  movementTypeLabel,
} from "../../../lib/movement-labels";
import { createClient } from "../../../lib/supabase/server";
import { currentMembership } from "../../../lib/membership";

export const metadata = { title: "Movimentações de Estoque — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Movimentações de estoque (D-167, trilha 5E — "experiência sobre dados
 * prontos"): o extrato do ledger, para responder "por que o saldo mudou?".
 *
 * Leitura PURA: o ledger é append-only e esta tela não tem um único caminho
 * de escrita — nem botão, nem Server Action. Tudo somado/filtrado/paginado
 * em SQL (`get_stock_movements`, 64 ms medidos), com a contagem sobre o
 * conjunto filtrado inteiro e a janela declarada (classe D-131: nunca uma
 * lista silenciosamente cortada).
 *
 * Estoque físico é da ORGANIZAÇÃO, não de uma conta ML (regra do PRD) — por
 * isso não há filtro de conta aqui: LOCAL/RESERVADO/TRANSITO são
 * compartilhados, e atribuí-los a uma conta seria o erro que o requisito
 * manda evitar.
 */

interface MovementRow {
  id: string;
  occurred_at: string;
  movement_type: string;
  location_kind: string;
  qty_delta: number;
  sku_id: string;
  sku: string;
  sku_title: string | null;
  source_type: string | null;
  source_id: string | null;
  reason: string | null;
  created_by_name: string | null;
  total_count: number;
}

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

export default async function MovimentacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const filters = resolveMovementFilters(query);

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Movimentações de Estoque</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  // O recorte é o MESMO nas duas: uma faixa que ignora o filtro da tabela faz
  // cabeçalho e corpo falarem de conjuntos diferentes na mesma tela (D-236).
  const recorte = {
    p_organization_id: organizationId,
    p_search: filters.search,
    p_movement_type: filters.movementType,
    p_location_kind: filters.locationKind,
    p_source_type: filters.sourceType,
    p_date_from: filters.dateFrom,
    p_date_to: filters.dateTo,
  };

  const [ledger, resumo] = await Promise.all([
    supabase.rpc("get_stock_movements", {
      ...recorte,
      p_limit: PAGE_SIZE,
      p_offset: (filters.page - 1) * PAGE_SIZE,
    }),
    supabase.rpc("get_stock_movements_summary", recorte).maybeSingle(),
  ]);

  const { data, error } = ledger;

  const rows = (data ?? []) as MovementRow[];

  /*
    Os três cartões do frame CONTAM movimentação, nunca somam unidade — e a
    diferença é medida (D-252). `AJUSTE_RECONCILIACAO` despeja o saldo
    sentinela do ERP no ledger: +9,6 milhões e −3,5 milhões de unidades em 30
    dias, contra ~29,5 mil de venda real. Um cartão "Entradas: 9.638.833
    unidades" seria a tela afirmando movimento físico que não houve.

    Contando linha, os três fecham: 36.360 = 6.776 entradas + 29.584 saídas.
  */
  const total = resumo.data;

  const celulas: readonly KpiCellData[] = [
    {
      label: "Movimentações no recorte",
      formula: "Linhas do ledger que passam pelos filtros atuais — contagem, nunca soma de quantidade.",
      value: formatCount(total?.movimentacoes ?? 0),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Entradas",
      formula: "Movimentações com delta positivo. O sinal decide, não o tipo: AJUSTE_RECONCILIACAO produz os dois.",
      value: formatCount(total?.entradas ?? 0),
      previous: null,
      tom: "ok",
    },
    {
      label: "Saídas",
      formula: "Movimentações com delta negativo, pelo mesmo critério de sinal.",
      value: formatCount(total?.saidas ?? 0),
      previous: null,
      tom: "atencao",
    },
    {
      label: "SKUs tocados",
      formula: "Quantos SKUs distintos aparecem no recorte.",
      value: formatCount(total?.skus_tocados ?? 0),
      previous: null,
      tom: "neutro",
    },
  ];
  const totalCount = rows[0]?.total_count ?? 0;
  const window = summarizePagedWindow({
    page: filters.page,
    totalCount,
    rowsOnPage: rows.length,
    pageSize: PAGE_SIZE,
    noun: { singular: "movimento", plural: "movimentos" },
    emptyLabel: "Nenhum movimento encontrado com estes filtros.",
  });

  return (
    <Shell>
      {/* Sobrancelha e título do frame `ProcessScreen type="movements"`. */}
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Movimentações"
        subtitle="Histórico auditável de entradas, saídas e ajustes de estoque."
      />

      <KpiStrip cells={celulas} />

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        O extrato do ledger — cada linha é um movimento auditável, com origem e motivo. Estoque físico
        (Local/Reservado/Trânsito) pertence à organização, não a uma conta Mercado Livre. Somente leitura.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-2)" }}>
        <FilterPill href={buildMovementHref(filters, { movementType: null })} active={filters.movementType === null}>
          Todos os tipos
        </FilterPill>
        {MOVEMENT_TYPES.map((type) => (
          <FilterPill
            key={type}
            href={buildMovementHref(filters, { movementType: type })}
            active={filters.movementType === type}
          >
            {movementTypeLabel(type)}
          </FilterPill>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-2)" }}>
        <FilterPill href={buildMovementHref(filters, { locationKind: null })} active={filters.locationKind === null}>
          Todos os locais
        </FilterPill>
        {LOCATION_KINDS.map((kind) => (
          <FilterPill
            key={kind}
            href={buildMovementHref(filters, { locationKind: kind })}
            active={filters.locationKind === kind}
          >
            {locationKindLabel(kind)}
          </FilterPill>
        ))}

        <span style={{ color: "var(--sb-border)" }}>|</span>

        <FilterPill href={buildMovementHref(filters, { sourceType: null })} active={filters.sourceType === null}>
          Todas as origens
        </FilterPill>
        {SOURCE_TYPES.map((source) => (
          <FilterPill
            key={source}
            href={buildMovementHref(filters, { sourceType: source })}
            active={filters.sourceType === source}
          >
            {movementSourceLabel(source, null)}
          </FilterPill>
        ))}
      </div>

      <form
        method="get"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.375rem",
          marginBottom: "var(--sb-space-3)",
          fontSize: "0.8125rem",
        }}
      >
        {/* GET nativo só envia os campos do form — preservar as dimensões de pill (regra de /vendas). */}
        {filters.movementType !== null && <input type="hidden" name="tipo" value={filters.movementType} />}
        {filters.locationKind !== null && <input type="hidden" name="local" value={filters.locationKind} />}
        {filters.sourceType !== null && <input type="hidden" name="origem" value={filters.sourceType} />}
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
        <input
          type="date"
          name="de"
          defaultValue={filters.dateFrom ?? undefined}
          aria-label="Data inicial"
          style={{ padding: "0.25rem 0.5rem", borderRadius: "var(--sb-radius)", border: "1px solid var(--sb-border)", fontSize: "0.8125rem" }}
        />
        <span style={{ color: "var(--sb-text-soft)" }}>até</span>
        <input
          type="date"
          name="ate"
          defaultValue={filters.dateTo ?? undefined}
          aria-label="Data final"
          style={{ padding: "0.25rem 0.5rem", borderRadius: "var(--sb-radius)", border: "1px solid var(--sb-border)", fontSize: "0.8125rem" }}
        />
        <button type="submit" style={FILTER_SUBMIT_STYLE}>
          Filtrar
        </button>
      </form>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar as movimentações: {error.message}
        </p>
      )}

      {error === null && (
        <Panel title="Ledger de estoque" subtitle={window.label}>
          {rows.length === 0 && <p className="sb-empty">Nenhum movimento encontrado com estes filtros.</p>}

          {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="sb-table">
            <thead>
              <tr>
                <th>Quando</th>
                <th>SKU</th>
                <th>Tipo</th>
                <th>Local</th>
                <th className="sb-num">Δ</th>
                <th>Origem</th>
                <th>Motivo / Por</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(row.occurred_at)}</td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>
                    {row.sku_title !== null && (
                      <div style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem", fontFamily: "inherit" }}>
                        {row.sku_title}
                      </div>
                    )}
                  </td>
                  <td>{movementTypeLabel(row.movement_type)}</td>
                  <td>{locationKindLabel(row.location_kind)}</td>
                  <td
                    style={{
                      ...td,
                      textAlign: "right",
                      fontVariantNumeric: "tabular-nums",
                      color: row.qty_delta > 0 ? "var(--sb-secondary)" : "var(--sb-danger)",
                    }}
                  >
                    {formatQtyDelta(row.qty_delta)}
                  </td>
                  <td>{movementSourceLabel(row.source_type, row.source_id)}</td>
                  <td style={{ ...td, color: "var(--sb-text-soft)" }}>
                    {row.reason ?? "—"}
                    {row.created_by_name !== null && (
                      <div style={{ fontSize: "0.75rem" }}>por {row.created_by_name}</div>
                    )}
                  </td>
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
            <FilterPill href={buildMovementHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          {filters.page < window.totalPages && (
            <FilterPill href={buildMovementHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
