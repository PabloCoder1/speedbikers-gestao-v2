import {
  classifySalesTrend,
  classifyStockState,
  computePurchaseSuggestion,
  computeUsableStock,
  resolveReplenishmentPolicy,
  toSalesMetricDate,
} from "@sb/domain";
import type {
  PurchaseSuggestionRefusal,
  ReplenishmentSetting,
  StockOperationalState,
  StockStateRefusal,
} from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { FILTER_SUBMIT_STYLE, FilterGroup, FilterPill } from "../../components/filter-pill";
import { Shell } from "../../components/shell";
import { TrendBadge } from "../../components/trend-badge";
import { formatCount, formatCurrency } from "../../lib/format";
import {
  PAGE_SIZE,
  buildReplenishmentHref,
  resolveReplenishmentFilters,
  summarizeReplenishmentWindow,
} from "../../lib/replenishment-filters";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Reposição — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Sugestão de compra auditável (D-147) — o coração da Fase 5D, e a resposta
 * do PRD a "quanto eu deveria comprar?", nunca só "quantos dias eu tenho".
 *
 * A conta inteira mora em `@sb/domain` (`computePurchaseSuggestion`) e é a
 * composição das três fatias anteriores: política (D-144) dá a janela de
 * demanda; tendência (D-145) dá a taxa dos últimos 30 dias; aproveitável
 * (D-146) dá o que já existe. A RPC entrega INGREDIENTES; a tela monta cada
 * linha pela fórmula única e mostra a decomposição — "por que comprar 48?".
 *
 * **As recusas são resposta, não erro**, e todas aparecem: sem configuração
 * aplicável, estoque virtual, histórico incompleto, amostra insuficiente.
 * Número só quando defensável.
 */

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

/** Nulidade real conferida contra o corpo da RPC — o gerador não a marca. */
interface SuggestionRow {
  sku_id: string;
  sku: string;
  title: string | null;
  supplier_brand: string | null;
  purchase_cost: number | null;
  stock_is_virtual: boolean;
  local_quantity: number;
  reservado: number;
  transito: number;
  full_quantity: number;
  units_15d: number;
  units_30d: number;
  units_60d: number;
  units_90d: number;
  history_days_90: number;
  total_count: number;
}

const REFUSAL_LABEL: Record<PurchaseSuggestionRefusal, string> = {
  SEM_CONFIGURACAO: "sem configuração",
  ESTOQUE_VIRTUAL: "estoque virtual",
  HISTORICO_INCOMPLETO: "histórico incompleto",
  AMOSTRA_INSUFICIENTE: "sem amostra",
};

/** Os estados (D-148) herdam as recusas da sugestão, mais uma própria. */
const STATE_REFUSAL_LABEL: Record<StockStateRefusal, string> = {
  ...REFUSAL_LABEL,
  SEM_DEMANDA_RECENTE: "sem demanda recente",
};

/**
 * Tons por severidade (D-007: nunca todas as cores com o mesmo peso):
 * ruptura/urgente em vermelho, os avisos no amarelo-tinta legível, adequada
 * no tom positivo já usado pela tendência.
 */
const STATE_TONE: Record<StockOperationalState, { label: string; color: string; bold?: boolean }> = {
  RUPTURA: { label: "Ruptura", color: "var(--sb-danger)", bold: true },
  COMPRA_URGENTE: { label: "Compra urgente", color: "var(--sb-danger)" },
  COMPRAR_EM_BREVE: { label: "Comprar em breve", color: "var(--sb-accent-ink)" },
  COBERTURA_BAIXA: { label: "Cobertura baixa", color: "var(--sb-text-soft)" },
  ADEQUADA: { label: "Adequada", color: "var(--sb-secondary)" },
  EXCESSO: { label: "Excesso", color: "var(--sb-accent-ink)", bold: true },
};

const RATE = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function scopeLabel(scope: "SKU" | "MARCA" | "PADRAO", brand: string | null): string {
  if (scope === "SKU") return "regra do SKU";
  if (scope === "MARCA") return `regra da marca ${brand ?? ""}`;

  return "padrão da organização";
}

export default async function ReposicaoPage({
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
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Reposição</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const filters = resolveReplenishmentFilters(query);
  const dateTo = toSalesMetricDate(new Date());

  // Ingredientes, filtros, ordenação e contagem vêm do Postgres (D-131);
  // a FÓRMULA roda aqui pela implementação canônica — nunca nas duas pontas.
  const [suggestionsResult, settingsResult, brandsResult] = await Promise.all([
    supabase.rpc("get_purchase_suggestions", {
      p_organization_id: organizationId,
      p_date_to: dateTo,
      p_supplier_brand: filters.brand,
      p_search: filters.search,
      p_limit: PAGE_SIZE,
      p_offset: (filters.page - 1) * PAGE_SIZE,
    }),
    supabase
      .from("replenishment_settings")
      .select(
        "supplier_brand, sku_id, lead_time_days, target_coverage_days, safety_stock_days, max_coverage_days, policy_note",
      ),
    supabase.from("skus").select("supplier_brand").not("supplier_brand", "is", null).order("supplier_brand"),
  ]);

  const rows = (suggestionsResult.data ?? []) as SuggestionRow[];
  const totalCount = rows[0]?.total_count ?? 0;
  const windowInfo = summarizeReplenishmentWindow(filters.page, totalCount, rows.length);
  const error = suggestionsResult.error ?? settingsResult.error;

  const settings: ReplenishmentSetting[] = (settingsResult.data ?? []).map((s) => ({
    supplierBrand: s.supplier_brand,
    skuId: s.sku_id,
    leadTimeDays: s.lead_time_days,
    targetCoverageDays: s.target_coverage_days,
    safetyStockDays: s.safety_stock_days,
    maxCoverageDays: s.max_coverage_days,
    policyNote: s.policy_note,
  }));

  const brands = [...new Set((brandsResult.data ?? []).map((r) => r.supplier_brand))].filter(
    (b): b is string => b !== null,
  );

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Reposição</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Quanto comprar de cada SKU, com a conta inteira visível:{" "}
        <strong>venda/dia (30d) × janela de demanda − estoque aproveitável</strong>. A janela vem da{" "}
        <Link href="/reposicao/configuracoes">configuração de reposição</Link> (prazo + cobertura + segurança); o
        aproveitável soma local, Full e trânsito, reservado fora. A quantidade é cálculo determinístico, nunca IA —
        e quando falta base (configuração, estoque real, histórico ou amostra), a linha diz o motivo em vez de
        inventar número. O <strong>estado</strong> compara a cobertura em dias com os limiares da própria política
        (prazo, ponto de pedido, janela, teto) — excesso só é afirmado com o teto configurado. SKU com estoque
        virtual destrava no <Link href="/produtos?estado=pendente&sinal=sentinela">ensaio de classificação</Link>.
      </p>

      {error === null && settings.length === 0 && (
        <p role="alert" style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-danger)" }}>
          <strong>Nenhuma configuração de reposição cadastrada</strong> — sem prazo e cobertura desejada, a sugestão
          recusa número para todos os SKUs, de propósito.{" "}
          <Link href="/reposicao/configuracoes">Cadastrar a primeira regra</Link>.
        </p>
      )}

      <div
        style={{ display: "flex", flexDirection: "column", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-3)" }}
      >
        <FilterGroup label="Marca">
          <FilterPill href={buildReplenishmentHref(filters, { brand: null })} active={filters.brand === null}>
            Todas
          </FilterPill>
          {brands.map((brand) => (
            <FilterPill
              key={brand}
              href={buildReplenishmentHref(filters, { brand })}
              active={filters.brand === brand}
            >
              {brand}
            </FilterPill>
          ))}
        </FilterGroup>

        <form method="get" style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
          {/* Hidden por dimensão ativa: GET nativo só envia campos do form (D-136). */}
          {filters.brand !== null && <input type="hidden" name="marca" value={filters.brand} />}
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
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "76rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Marca</th>
                <th style={th}>Venda/dia (30d)</th>
                <th style={th}>Tendência</th>
                <th style={th}>Aproveitável</th>
                <th style={th}>Janela (dias)</th>
                <th style={th}>Estado</th>
                <th style={th}>Sugestão</th>
                <th style={th}>Custo estimado</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => {
                // A composição inteira vem das peças canônicas — a tela nunca
                // refaz uma conta por dentro (regra da fórmula única).
                const trend = classifySalesTrend({
                  units15: row.units_15d,
                  units30: row.units_30d,
                  units60: row.units_60d,
                  units90: row.units_90d,
                  historyDays90: row.history_days_90,
                });
                const usable = computeUsableStock({
                  localQuantity: row.local_quantity,
                  fullQuantity: row.full_quantity,
                  transitQuantity: row.transito,
                  reservedQuantity: row.reservado,
                  stockIsVirtual: row.stock_is_virtual,
                });
                const policy = resolveReplenishmentPolicy(settings, {
                  id: row.sku_id,
                  supplierBrand: row.supplier_brand,
                });
                const suggestion = computePurchaseSuggestion({ policy, trend, usable });
                const { breakdown } = suggestion;
                const stockState = classifyStockState({ policy, trend, usable });

                return (
                  <tr key={row.sku_id}>
                    <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                      {row.sku}
                      {row.title !== null && (
                        <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                          {row.title}
                        </div>
                      )}
                    </td>
                    {/* Marca vazia é estado legítimo (36% preenchidos, D-129). */}
                    <td style={td}>{row.supplier_brand ?? "—"}</td>
                    <td style={tdNumber}>{RATE.format(breakdown.dailyRate)}</td>
                    <td style={td}>
                      <TrendBadge
                        units15={row.units_15d}
                        units30={row.units_30d}
                        units60={row.units_60d}
                        units90={row.units_90d}
                        historyDays90={row.history_days_90}
                      />
                    </td>
                    <td style={tdNumber}>
                      {usable.total === null ? (
                        <span style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>estoque virtual</span>
                      ) : (
                        <span
                          title={`local ${String(usable.components.local)} + full ${String(usable.components.full)} + trânsito ${String(usable.components.transit)} (reservado ${String(usable.components.reservedExcluded)} fica fora)`}
                          style={usable.total < 0 ? { color: "var(--sb-danger)" } : undefined}
                        >
                          {formatCount(usable.total)}
                        </span>
                      )}
                    </td>
                    <td style={tdNumber}>
                      {policy === null || breakdown.demandWindowDays === null ? (
                        "—"
                      ) : (
                        <span
                          title={`prazo ${String(policy.leadTimeDays)} + cobertura ${String(policy.targetCoverageDays)} + segurança ${String(policy.safetyStockDays)} · ${scopeLabel(policy.scope, policy.supplierBrand)}`}
                        >
                          {formatCount(breakdown.demandWindowDays)}
                        </span>
                      )}
                    </td>
                    <td style={td}>
                      {stockState.state === null ? (
                        <span
                          style={{ color: "var(--sb-muted-ink)", fontSize: "0.75rem", whiteSpace: "nowrap" }}
                          title={
                            stockState.coverageDays === null
                              ? undefined
                              : `cobertura ${RATE.format(stockState.coverageDays)}d — sem régua completa para um selo`
                          }
                        >
                          {stockState.refusals.map((r) => STATE_REFUSAL_LABEL[r]).join(" · ")}
                        </span>
                      ) : (
                        <span
                          style={{
                            color: STATE_TONE[stockState.state].color,
                            fontWeight: STATE_TONE[stockState.state].bold === true ? 600 : undefined,
                            fontSize: "0.8125rem",
                            whiteSpace: "nowrap",
                          }}
                          title={`cobertura ${stockState.coverageDays === null ? "0" : RATE.format(stockState.coverageDays)}d · prazo ${String(stockState.thresholds.leadTimeDays)} · ponto de pedido ${String(stockState.thresholds.reorderPointDays)} · janela ${String(stockState.thresholds.demandWindowDays)}${stockState.thresholds.maxCoverageDays === null ? " · teto de excesso não configurado" : ` · teto ${String(stockState.thresholds.maxCoverageDays)}`}`}
                        >
                          {STATE_TONE[stockState.state].label}
                        </span>
                      )}
                    </td>
                    <td style={tdNumber}>
                      {suggestion.suggestedQuantity === null ? (
                        <span style={{ color: "var(--sb-muted-ink)", fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                          {suggestion.refusals.map((r) => REFUSAL_LABEL[r]).join(" · ")}
                        </span>
                      ) : suggestion.suggestedQuantity === 0 ? (
                        <span
                          style={{ color: "var(--sb-text-soft)" }}
                          title={`${RATE.format(breakdown.dailyRate)}/dia × ${String(breakdown.demandWindowDays)}d = ${String(breakdown.projectedDemand)} projetado − ${String(breakdown.usableStock)} aproveitável — a janela já está coberta`}
                        >
                          0
                        </span>
                      ) : (
                        <span
                          style={{ fontWeight: 600 }}
                          title={`${RATE.format(breakdown.dailyRate)}/dia × ${String(breakdown.demandWindowDays)}d = ${String(breakdown.projectedDemand)} projetado − ${String(breakdown.usableStock)} aproveitável = comprar ${String(suggestion.suggestedQuantity)}`}
                        >
                          {formatCount(suggestion.suggestedQuantity)}
                        </span>
                      )}
                    </td>
                    <td style={tdNumber}>
                      {suggestion.suggestedQuantity !== null &&
                      suggestion.suggestedQuantity > 0 &&
                      row.purchase_cost !== null ? (
                        <span title="custo CADASTRADO × sugestão — sobrescrito a cada importação; custo de simulação separado é item aberto da Fase 5D">
                          {formatCurrency(suggestion.suggestedQuantity * row.purchase_cost)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
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
            <FilterPill href={buildReplenishmentHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          <span style={{ color: "var(--sb-text-soft)" }}>
            Página {filters.page} de {windowInfo.totalPages}
          </span>
          {filters.page < windowInfo.totalPages && (
            <FilterPill href={buildReplenishmentHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
