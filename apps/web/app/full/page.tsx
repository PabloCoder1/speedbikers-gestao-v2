import type { ReactNode } from "react";

import Link from "next/link";

import { FILTER_SUBMIT_STYLE, FilterPill } from "../../components/filter-pill";
import { Shell } from "../../components/shell";
import { formatCount, formatDateTime } from "../../lib/format";
import {
  FULL_SITUATIONS,
  PAGE_SIZE,
  buildFullHref,
  fullSituationCriterion,
  fullSituationLabel,
  resolveFullFilters,
  summarizePagedWindow,
} from "../../lib/full-filters";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Full — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Central Full (D-173, trilha 5E) — o Full deixa de ser uma coluna dispersa
 * e vira operação própria.
 *
 * Três coisas que esta tela NÃO faz, porque o item as veta explicitamente:
 *
 * 1. **Não soma Full com estoque físico.** Full é por CONTA; Local é da
 *    ORGANIZAÇÃO (regra do PRD). As duas colunas existem lado a lado e a
 *    prosa diz que são autoridades diferentes.
 * 2. **Não sugere quanto enviar.** Mostra que há saldo local para um item em
 *    ruptura e para por aí — política logística (custo de envio, lote
 *    mínimo, prazo) não existe no sistema, e sugerir número sem ela seria
 *    inventar.
 * 3. **Não afirma "saúde" com score.** As quatro situações são regras
 *    determinísticas, e o critério de cada uma aparece na tela.
 *
 * A "Curva A sem Full" que o item também pede JÁ existe em `/curva-abc`
 * (filtro `semFull`), e esta tela aponta para lá em vez de recriar o
 * critério — duas telas com a mesma pergunta e respostas diferentes é
 * exatamente a "cópia divergente" que a casa evita.
 */

const LOOKBACK_DAYS = 30;

/** Mesma janela da RPC — declarada aqui porque a tela precisa explicá-la. */
const FRESHNESS_DAYS = 3;


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
  verticalAlign: "top",
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

function situationColor(situation: string): string | undefined {
  if (situation === "ruptura") return "var(--sb-danger)";
  if (situation === "parado") return "var(--sb-accent-ink)";

  return undefined;
}

export default async function FullPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const filters = resolveFullFilters(query);

  // O `.eq("organization_id", ...)` que morava aqui era REDUNDANTE, e o preço
  // dele era um nível inteiro de latência (D-197). A policy de `ml_accounts` é
  // `id in (select private.accessible_accounts())`, e essa função junta
  // `organization_members` por `auth.uid()`: a RLS já restringe por
  // organização **e** por permissão de conta — estritamente mais estreita que
  // o filtro manual. O filtro não removia uma linha sequer; só amarrava esta
  // leitura à anterior, obrigando três latências em fila onde duas bastam.
  //
  // É como `/vendas`, `/anuncios`, `/curva-abc`, `/atendimento` e
  // `/vinculacoes` já liam. A RPC abaixo continua depois — ela SIM depende da
  // conta escolhida.
  const [membership, accounts] = await Promise.all([
    currentMembership(supabase),
    supabase.from("ml_accounts").select("id, label").order("label"),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Full</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const accountIds = new Set((accounts.data ?? []).map((row) => row.id));
  const account = filters.account !== null && accountIds.has(filters.account) ? filters.account : null;

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("get_fulfillment_overview", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: account,
    p_situation: filters.situation,
    p_search: filters.search,
    p_sku_id: null,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
  });

  const rows = data ?? [];
  const totalCount = rows[0]?.total_count ?? 0;
  const window = summarizePagedWindow({
    page: filters.page,
    totalCount,
    rowsOnPage: rows.length,
    pageSize: PAGE_SIZE,
    noun: totalCount === 1 ? "SKU por conta" : "SKUs por conta",
    emptyLabel: "Nenhum SKU encontrado com estes filtros.",
  });

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Full</h1>

      <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Saldo no Full por conta e SKU, somando todas as variações do anúncio, com a venda dos últimos{" "}
        {LOOKBACK_DAYS} dias ao lado. <strong>Full é por conta; estoque local é da organização</strong> — são
        autoridades diferentes e a tela nunca soma as duas colunas.
      </p>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
        Só entram saldos capturados nos últimos {FRESHNESS_DAYS} dias: bucket que o Mercado Livre parou de
        reportar não é estoque atual. A tela mostra que existe saldo local para repor, mas{" "}
        <strong>não sugere quanto enviar</strong> — custo de envio, lote mínimo e prazo não estão no sistema.
        Para “Curva A sem Full”, use a <Link href="/curva-abc?semFull=1">Curva ABC com o filtro sem Full</Link>.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-2)" }}>
        <FilterPill href={buildFullHref(filters, { situation: null })} active={filters.situation === null}>
          Todas as situações
        </FilterPill>
        {FULL_SITUATIONS.map((situation) => (
          <FilterPill
            key={situation}
            href={buildFullHref(filters, { situation })}
            active={filters.situation === situation}
          >
            {fullSituationLabel(situation)}
          </FilterPill>
        ))}

        <span style={{ color: "var(--sb-border)" }}>|</span>

        <FilterPill href={buildFullHref(filters, { account: null })} active={account === null}>
          Todas as contas
        </FilterPill>
        {(accounts.data ?? []).map((row) => (
          <FilterPill key={row.id} href={buildFullHref(filters, { account: row.id })} active={account === row.id}>
            {row.label}
          </FilterPill>
        ))}
      </div>

      {filters.situation !== null && (
        <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
          <strong>{fullSituationLabel(filters.situation)}</strong>: {fullSituationCriterion(filters.situation)}.
        </p>
      )}

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
        {filters.situation !== null && <input type="hidden" name="situacao" value={filters.situation} />}
        {account !== null && <input type="hidden" name="conta" value={account} />}
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
          Filtrar
        </button>
      </form>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar o Full: {error.message}
        </p>
      )}

      {error === null && (
        <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          {window.label}
        </p>
      )}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "58rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Conta</th>
                <th style={th}>Situação</th>
                <th style={{ ...th, textAlign: "right" }}>No Full</th>
                <th style={{ ...th, textAlign: "right" }}>Local (org.)</th>
                <th style={{ ...th, textAlign: "right" }}>Vendido ({LOOKBACK_DAYS}d)</th>
                <th style={th}>Capturado</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.ml_account_id}:${row.sku_id}`}>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>
                    {row.sku_title !== null && (
                      <div style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem", fontFamily: "inherit" }}>
                        {row.sku_title}
                      </div>
                    )}
                  </td>
                  <td style={td}>{row.account_label}</td>
                  <td style={{ ...td, color: situationColor(row.situation) }}>
                    {fullSituationLabel(row.situation)}
                  </td>
                  <td style={tdNumber}>
                    {formatCount(row.full_quantity)}
                    {/* Mais de um bucket = anúncio com variações no Full. É o
                        grão que D-173 corrigiu; dizer quantos são evita que a
                        soma pareça vir do nada. */}
                    {row.buckets > 1 && (
                      <div style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
                        {row.buckets} variações
                      </div>
                    )}
                  </td>
                  <td
                    style={{
                      ...tdNumber,
                      color: row.local_quantity < 0 ? "var(--sb-danger)" : undefined,
                    }}
                    title="Estoque local da organização — nunca somado ao Full"
                  >
                    {formatCount(row.local_quantity)}
                  </td>
                  <td style={tdNumber}>{formatCount(row.units_sold)}</td>
                  <td style={{ ...td, color: "var(--sb-text-soft)", fontSize: "0.8125rem", whiteSpace: "nowrap" }}>
                    {formatDateTime(row.captured_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {error === null && window.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <FilterPill href={buildFullHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          {filters.page < window.totalPages && (
            <FilterPill href={buildFullHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
