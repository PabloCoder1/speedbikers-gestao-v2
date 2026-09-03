import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { entityLabel, formatEventDiff } from "../../../lib/event-format";
import { formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { eventTypeLabel, listingStatusLabel } from "../../../lib/labels";
import { fullSituationCriterion, fullSituationLabel } from "../../../lib/full-filters";
import { createClient } from "../../../lib/supabase/server";
import { DiagnosisPanel } from "./diagnosis-panel";
import { SimulatorPanel } from "./simulator-panel";

export const metadata = { title: "Dashboard de SKU — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * "Dashboard de SKU" (Fase 5B) evoluído para ABAS (item P1, D-169) — o
 * progressive disclosure alinhado ao Figma: a página deixou de ser uma
 * vertical única e cada aba só carrega as consultas de que precisa.
 *
 * Só existem as abas com dado real HOJE (a regra do item P1): Visão geral,
 * Estoque, Anúncios, Histórico e Diagnóstico. Vendas fica na Visão geral
 * (são dois números, não uma aba).
 *
 * As seis abas do Figma que faltam NÃO estão bloqueadas por falta de dado —
 * a distinção importa para quem for continuar. `Full` tem
 * `fulfillment_stock_snapshots` por SKU e conta (a Visão geral já mostra o
 * total), `Decisões` alcança o SKU por `actions.sku_id`, `Preços` tem
 * `listing.price.changed` e `Tráfego` tem `daily_listing_visits` por
 * anúncio. O que falta em cada uma é a CONSULTA agregada por SKU — e
 * inventá-la de dentro desta tela seria somar em JS o que a casa exige somar
 * em SQL. `Atendimento` é o único sem caminho pronto: `support_cases` não
 * tem vínculo de SKU (a Caixa de Entrada liga por anúncio).
 *
 * A aba vive na URL (`?aba=`, mesmo padrão dos filtros de Movimentações):
 * valor fora do conjunto fechado cai para a Visão geral antes de tocar o
 * banco. Janela FIXA de 30 dias, mesma convenção de /cobertura.
 */

const LOOKBACK_DAYS = 30;

/** A linha do tempo mostra os últimos N — e diz isso quando o corte agiu. */
const TIMELINE_LIMIT = 50;

const TAB_KEYS = ["visao-geral", "estoque", "anuncios", "full", "historico", "diagnostico"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  "visao-geral": "Visão geral",
  estoque: "Estoque",
  anuncios: "Anúncios",
  full: "Full",
  historico: "Histórico",
  diagnostico: "Diagnóstico",
};

function parseTab(value: string | string[] | undefined): TabKey {
  return typeof value === "string" && (TAB_KEYS as readonly string[]).includes(value)
    ? (value as TabKey)
    : "visao-geral";
}

/**
 * Nulidade real conferida contra o corpo da RPC (o gerador não marca
 * `account_label` do left join como anulável) — mesmo padrão das demais
 * telas.
 */
interface TimelineRow {
  id: string;
  occurred_at: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  severity: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  account_label: string | null;
}

const statBox: React.CSSProperties = {
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  padding: "var(--sb-space-3)",
  minWidth: "9rem",
};

const statLabel: React.CSSProperties = {
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
};

const statValue: React.CSSProperties = {
  fontSize: "1.375rem",
  fontVariantNumeric: "tabular-nums",
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

function StockBoxes({
  dashboard,
}: {
  dashboard: {
    local_quantity: number;
    reservado_quantity: number;
    transito_quantity: number;
    full_quantity: number;
  };
}): ReactNode {
  return (
    <div style={{ display: "flex", gap: "var(--sb-space-3)", flexWrap: "wrap", marginBottom: "var(--sb-space-2)" }}>
      <div style={statBox}>
        <div style={statLabel}>Local</div>
        <div style={statValue}>{formatCount(dashboard.local_quantity)}</div>
      </div>
      <div style={statBox}>
        <div style={statLabel}>Reservado</div>
        <div style={statValue}>{formatCount(dashboard.reservado_quantity)}</div>
      </div>
      <div style={statBox}>
        <div style={statLabel}>Em trânsito</div>
        <div style={statValue}>{formatCount(dashboard.transito_quantity)}</div>
      </div>
      <div style={statBox}>
        <div style={statLabel}>Full</div>
        <div style={statValue}>{formatCount(dashboard.full_quantity)}</div>
      </div>
    </div>
  );
}

export default async function SkuDashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ skuId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { skuId } = await params;
  const query = await searchParams;
  const tab = parseTab(query.aba);

  const supabase = await createClient();

  const sku = await supabase
    .from("skus")
    .select("id, sku, title, organization_id, purchase_cost")
    .eq("id", skuId)
    .maybeSingle();

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — mesmo
  // raciocínio já usado em apps/web/app/compras/[id]/page.tsx.
  if (sku.error !== null || sku.data === null) {
    notFound();
  }

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Cada aba só dispara as consultas de que precisa (progressive disclosure
  // de verdade, não só visual); o que a aba ativa não usa vira
  // Promise.resolve — mesmo padrão do Full no Dashboard de Anúncio.
  const needsDashboard = tab === "visao-geral" || tab === "estoque";
  const needsCoverage = tab === "estoque";
  const needsListings = tab === "anuncios";
  const needsHistory = tab === "historico";
  const needsFull = tab === "full";

  const [dashboardResult, listingsResult, coverageResult, costHistoryResult, timelineResult, fullResult] =
    await Promise.all([
    needsDashboard
      ? supabase
          .rpc("get_sku_dashboard", {
            p_organization_id: sku.data.organization_id,
            p_sku_id: sku.data.id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
          })
          .single()
      : Promise.resolve({ data: null, error: null }),
    needsListings
      ? supabase
          .from("listings")
          .select("id, item_id, title, status, price, ml_accounts(label)")
          .eq("sku_id", sku.data.id)
          .order("title")
      : Promise.resolve({ data: null, error: null }),
    // Mesma janela de 30 dias do resumo — venda média diária real, só para
    // pré-preencher a premissa do simulador (D-080); o usuário pode ajustar
    // livremente a partir daí.
    needsCoverage
      ? supabase
          .rpc("get_stock_coverage", {
            p_organization_id: sku.data.organization_id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
            p_sku_id: sku.data.id,
          })
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // Histórico de custo cadastrado (D-149) — alimentado por trigger a cada
    // mudança de `skus.purchase_cost`. Sem backfill: o registro começa em
    // 30/08/2026 e a tela diz isso.
    needsHistory
      ? supabase
          .from("sku_cost_history")
          .select("id, previous_cost, new_cost, changed_by_role, changed_at")
          .eq("sku_id", sku.data.id)
          .order("changed_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: null, error: null }),
    // Linha do tempo (D-153): todos os eventos mapeáveis ao SKU — dele, dos
    // seus anúncios e dos seus pedidos. História, não causa: aqui o
    // vocabulário é ABERTO (contrato oposto ao da correlação de D-152).
    needsHistory
      ? supabase.rpc("get_sku_timeline", {
          p_organization_id: sku.data.organization_id,
          p_sku_id: sku.data.id,
          p_limit: TIMELINE_LIMIT,
        })
      : Promise.resolve({ data: null, error: null }),
    // Full por CONTA (D-224). Reusa `get_fulfillment_overview`, que já aceita
    // `p_sku_id` desde D-173 — nenhuma RPC nova, e o grão certo vem de graça:
    // a soma é por bucket `inventory_id`, que é o achado que D-173 mediu em
    // 15,6% de unidades a menos quando se colapsa por (sku, conta).
    // `p_limit` pequeno porque um SKU existe em poucas contas.
      needsFull
        ? supabase.rpc("get_fulfillment_overview", {
            p_organization_id: sku.data.organization_id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
            p_ml_account_id: null,
            p_situation: null,
            p_search: null,
            p_sku_id: sku.data.id,
            p_limit: 20,
            p_offset: 0,
          })
        : Promise.resolve({ data: null, error: null }),
    ]);

  const dashboard = dashboardResult.data;
  const listings = listingsResult.data ?? [];
  const coverage = coverageResult.data;
  const costHistory = costHistoryResult.data ?? [];
  const timeline = (timelineResult.data ?? []) as unknown as TimelineRow[];
  const full = fullResult.data ?? [];

  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/estoque">← Estoque</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0", fontSize: "1.375rem" }}>{sku.data.sku}</h1>

      {sku.data.title !== null && (
        <p style={{ margin: "0 0 var(--sb-space-2)", color: "var(--sb-text-soft)" }}>{sku.data.title}</p>
      )}

      {/*
        aria-label próprio: os rótulos "Anúncios"/"Estoque"/"Diagnóstico"
        também existem no menu lateral — o nome distingue os dois navs para
        leitores de tela e para o Playwright.
      */}
      <nav
        aria-label="Abas do SKU"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--sb-space-1)",
          borderBottom: "1px solid var(--sb-border)",
          margin: "var(--sb-space-2) 0 var(--sb-space-4)",
        }}
      >
        {TAB_KEYS.map((key) => (
          <Link
            key={key}
            href={key === "visao-geral" ? `/skus/${skuId}` : `/skus/${skuId}?aba=${key}`}
            aria-current={key === tab ? "page" : undefined}
            style={{
              padding: "0.5rem 0.75rem",
              fontSize: "0.875rem",
              textDecoration: "none",
              color: key === tab ? "inherit" : "var(--sb-text-soft)",
              fontWeight: key === tab ? 600 : 400,
              borderBottom: key === tab ? "2px solid var(--sb-accent-ink)" : "2px solid transparent",
              marginBottom: "-1px",
            }}
          >
            {TAB_LABELS[key]}
          </Link>
        ))}
      </nav>

      {tab === "visao-geral" && (
        <>
          {dashboardResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar o resumo: {dashboardResult.error.message}
            </p>
          )}

          {dashboard !== null && (
            <>
              <StockBoxes dashboard={dashboard} />

              <div
                style={{ display: "flex", gap: "var(--sb-space-3)", flexWrap: "wrap", marginBottom: "var(--sb-space-4)" }}
              >
                <div style={statBox}>
                  <div style={statLabel}>Vendido ({LOOKBACK_DAYS}d)</div>
                  <div style={statValue}>{formatCount(dashboard.units_sold)}</div>
                </div>
                <div style={statBox}>
                  <div style={statLabel}>Receita ({LOOKBACK_DAYS}d)</div>
                  <div style={statValue}>{formatCurrency(dashboard.gross_revenue)}</div>
                </div>
                <div style={statBox}>
                  <div style={statLabel}>Custo cadastrado</div>
                  <div style={statValue}>{formatCurrency(sku.data.purchase_cost)}</div>
                </div>
              </div>

              <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
                Simulador de cobertura na aba Estoque; mudanças de custo e linha do tempo na aba Histórico.
              </p>
            </>
          )}
        </>
      )}

      {tab === "estoque" && (
        <>
          {dashboardResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar o resumo: {dashboardResult.error.message}
            </p>
          )}

          {dashboard !== null && (
            <>
              <StockBoxes dashboard={dashboard} />

              <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.875rem" }}>
                <Link href={`/estoque/${skuId}/ajuste`}>Ajustar estoque</Link> — todo ajuste manual exige motivo e
                fica no ledger.
              </p>

              <SimulatorPanel
                asOf={dateTo}
                initialStockQuantity={coverage?.local_quantity ?? 0}
                initialAvgDailySales={coverage?.avg_daily_sales ?? 0}
              />
            </>
          )}
        </>
      )}

      {tab === "anuncios" && (
        <>
          <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Anúncios vinculados</h2>

          {listingsResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar os anúncios: {listingsResult.error.message}
            </p>
          )}

          {listingsResult.error === null && listings.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)" }}>Nenhum anúncio vinculado a este SKU.</p>
          )}

          {listingsResult.error === null && listings.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "36rem" }}>
                <thead>
                  <tr>
                    <th style={th}>Anúncio</th>
                    <th style={th}>Conta</th>
                    <th style={th}>Estado</th>
                    <th style={th}>Preço</th>
                  </tr>
                </thead>

                <tbody>
                  {listings.map((listing) => (
                    <tr key={listing.id}>
                      <td style={td}>
                        {listing.title}
                        <div
                          style={{
                            fontFamily: "ui-monospace, monospace",
                            color: "var(--sb-text-soft)",
                            fontSize: "0.75rem",
                          }}
                        >
                          <Link href={`/anuncios/${listing.item_id}`}>{listing.item_id}</Link>
                        </div>
                      </td>
                      <td style={td}>{listing.ml_accounts.label}</td>
                      <td style={td}>
                        <StatusPill code={listing.status} label={listingStatusLabel(listing.status)} />
                      </td>
                      <td style={tdNumber}>{formatCurrency(listing.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "full" && (
        <>
          <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Full por conta</h2>

          <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Saldo no Full de cada conta, somado por bucket de variação — o grão que D-173 mediu como certo. O
            estoque LOCAL aparece em coluna separada de propósito: são quatro estados com autoridades
            diferentes, e somá-los daria um número que não existe.
          </p>

          {fullResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar o Full: {fullResult.error.message}
            </p>
          )}

          {fullResult.error === null && full.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)" }}>
              Nenhuma conta com snapshot recente de Full para este SKU. Ausência de snapshot não é o mesmo que
              saldo zero — é a falta do dado.
            </p>
          )}

          {fullResult.error === null && full.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "40rem" }}>
                <thead>
                  <tr>
                    <th style={th}>Conta</th>
                    <th style={{ ...th, textAlign: "right" }}>No Full</th>
                    <th style={{ ...th, textAlign: "right" }}>Buckets</th>
                    <th style={{ ...th, textAlign: "right" }}>Local (org.)</th>
                    <th style={{ ...th, textAlign: "right" }}>Vendas {LOOKBACK_DAYS}d</th>
                    <th style={th}>Situação</th>
                    <th style={th}>Capturado</th>
                  </tr>
                </thead>

                <tbody>
                  {full.map((linha) => (
                    <tr key={linha.ml_account_id}>
                      <td style={td}>{linha.account_label}</td>
                      <td style={tdNumber}>{formatCount(linha.full_quantity)}</td>
                      <td style={tdNumber}>{formatCount(linha.buckets)}</td>
                      <td style={tdNumber}>{formatCount(linha.local_quantity)}</td>
                      <td style={tdNumber}>{formatCount(linha.units_sold)}</td>
                      <td style={{ ...td, color: linha.situation === "ruptura" ? "var(--sb-danger)" : undefined }}>
                        <span title={fullSituationCriterion(linha.situation)}>
                          {fullSituationLabel(linha.situation)}
                        </span>
                      </td>
                      {/* Sem checagem de nulo, e a razão foi conferida no SQL, não no
                          compilador (D-192/D-206): a consulta é DIRIGIDA pelo snapshot —
                          `vendas` e `saldo_local` é que entram por left join —, então
                          toda linha devolvida tem `captured_at`. O nulo é inalcançável. */}
                      <td style={{ ...td, fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
                        {formatDateTime(linha.captured_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {tab === "historico" && (
        <>
          {/*
            Custo cadastrado + histórico (D-149). Duas honestidades: o
            registro começa em 30/08/2026 (não há como historiar o que a
            importação já sobrescreveu antes), e o custo de PEDIDO é outro
            número — vive em purchase_order_items.unit_cost e nunca escreve
            de volta aqui.
          */}
          <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Custo cadastrado</h2>

          <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Custo atual: <strong>{formatCurrency(sku.data.purchase_cost)}</strong> — sobrescrito a cada importação do
            UpSeller; desde 30/08/2026 toda mudança fica registrada abaixo. O custo usado num pedido de compra é
            editável no próprio pedido e nunca altera este cadastro.
          </p>

          {costHistoryResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar o histórico de custo: {costHistoryResult.error.message}
            </p>
          )}

          {costHistoryResult.error === null && costHistory.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", marginBottom: "var(--sb-space-4)" }}>
              Nenhuma mudança registrada desde o início do rastreio (30/08/2026).
            </p>
          )}

          {costHistoryResult.error === null && costHistory.length > 0 && (
            <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "32rem" }}>
                <thead>
                  <tr>
                    <th style={th}>Quando</th>
                    <th style={th}>De</th>
                    <th style={th}>Para</th>
                    <th style={th}>Origem</th>
                  </tr>
                </thead>
                <tbody>
                  {costHistory.map((entry) => (
                    <tr key={entry.id}>
                      <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(entry.changed_at)}</td>
                      {/* `De` vazio = primeiro registro (o SKU nasceu com custo). */}
                      <td style={tdNumber}>{formatCurrency(entry.previous_cost)}</td>
                      <td style={tdNumber}>{formatCurrency(entry.new_cost)}</td>
                      <td style={{ ...td, color: "var(--sb-text-soft)" }}>
                        {entry.changed_by_role === "service_role"
                          ? "importação (worker)"
                          : entry.changed_by_role === "postgres"
                            ? "operação direta no banco"
                            : entry.changed_by_role}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/*
            Linha do tempo (D-153) — a ordem dos acontecimentos. Vocabulário
            ABERTO de propósito (contrato oposto ao da correlação): história
            não edita o passado. Diff só para formatos documentados
            (formatEventDiff devolve null para o resto — nunca leitura
            inventada).
          */}
          <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Linha do tempo</h2>

          {timelineResult.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar a linha do tempo: {timelineResult.error.message}
            </p>
          )}

          {timelineResult.error === null && timeline.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", marginBottom: "var(--sb-space-4)" }}>
              Nenhum evento registrado para este SKU — a linha do tempo nasce dos eventos de domínio (webhook e
              reconciliações) e só enxerga o que o sistema registrou.
            </p>
          )}

          {timelineResult.error === null && timeline.length > 0 && (
            <>
              {timeline.length >= TIMELINE_LIMIT && (
                <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
                  Mostrando os {TIMELINE_LIMIT} eventos mais recentes.
                </p>
              )}
              <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
                <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "48rem" }}>
                  <thead>
                    <tr>
                      <th style={th}>Quando</th>
                      <th style={th}>Evento</th>
                      <th style={th}>Mudança</th>
                      <th style={th}>Onde</th>
                    </tr>
                  </thead>
                  <tbody>
                    {timeline.map((entry) => (
                      <tr key={entry.id}>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(entry.occurred_at)}</td>
                        <td style={td}>
                          <span
                            style={
                              entry.severity === "critico"
                                ? { color: "var(--sb-danger)", fontWeight: 600 }
                                : entry.severity === "importante"
                                  ? { color: "var(--sb-accent-ink)" }
                                  : undefined
                            }
                          >
                            {eventTypeLabel(entry.event_type)}
                          </span>
                        </td>
                        <td style={td}>{formatEventDiff(entry.event_type, entry.before, entry.after) ?? "—"}</td>
                        <td style={{ ...td, color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
                          {entityLabel(entry.entity_type)}
                          {entry.entity_type !== "sku" && (
                            <span style={{ fontFamily: "ui-monospace, monospace" }}> {entry.entity_id}</span>
                          )}
                          {entry.account_label !== null && <> · {entry.account_label}</>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      {tab === "diagnostico" && <DiagnosisPanel skuId={sku.data.id} />}
    </Shell>
  );
}
