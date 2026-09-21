import { readLastRelistFailureReason } from "@sb/db";
import { isRelistRetryEligible, summarizeRelistVariations } from "@sb/domain";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Icone } from "../../../components/icons";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { CopilotContextBeacon } from "../../../components/copilot-context";
import { ObjectHeader, type ObjectBadge } from "../../../components/object-header";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { TOM, tomDeRelist, tomDeStatus } from "../../../components/tone";
import { formatEventDiff } from "../../../lib/event-format";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime, formatPercent } from "../../../lib/format";
import { actionStatusLabel, eventTypeLabel, listingStatusLabel, relistStatusLabel, statusTone } from "../../../lib/labels";
import { fullSituationCriterion, fullSituationLabel, fullSituationTom, isFullRow } from "../../../lib/full-filters";
import { formatDecisionSnapshot } from "../../../lib/decision-format";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import { BarrasDiarias } from "./barras-diarias";
import { checarAnuncio, horasDesde, idadeRelativa, SYNC_VELHO_HORAS } from "./checagem";
import { CopiarMlb } from "./copiar-mlb";
import { RelistPanel } from "./relist-panel";
import { precisaDasVariacoesDoRetrato } from "./republicacao";

/**
 * O endereço público do anúncio. O Mercado Livre resolve `MLB-<número>` para a
 * página do produto; `listings` não guarda `permalink`, e o formato é estável.
 */
function linkNoMercadoLivre(itemId: string): string {
  return `https://produto.mercadolivre.com.br/${itemId.replace(/^MLB/, "MLB-")}`;
}

/** Variação entre duas etiquetas de preço, para a pílula da aba Preço. */
function variacaoDePreco(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { texto: string; tom: "ok" | "perigo" | "neutro" } | null {
  const de = typeof before?.price === "number" ? before.price : null;
  const para = typeof after?.price === "number" ? after.price : null;

  if (de === null || para === null || de === 0) {
    return null;
  }

  const variacao = (para - de) / de;

  if (variacao === 0) {
    return { texto: "sem variação", tom: "neutro" };
  }

  // Baixar preço é pintado de verde por ser o gesto comercial de estímulo, não
  // por ser "bom": a pílula diz a direção, a decisão continua de quem opera.
  return {
    texto: `${variacao > 0 ? "▲ +" : "▼ "}${formatPercent(variacao)}`,
    tom: variacao > 0 ? "perigo" : "ok",
  };
}

export const metadata = { title: "Dashboard do Anúncio — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Dashboard 360º do Anúncio (D-168, trilha 5E; composição do Figma em D13).
 *
 * Cada anúncio deixou de ser uma linha de lista e virou uma página com estado,
 * desempenho, Full e a própria história. **Agora em ABAS**, que era a evolução
 * registrada na primeira versão e que o dono nomeou por escrito: `Visão geral |
 * Vendas | Tráfego | Preço | Full | Histórico | Diagnóstico | Decisões`.
 *
 * ## O frame, e por que esta é uma PÁGINA e não um drawer
 *
 * O Figma desenha o anúncio como `MlbDetailDrawer` (600px, à direita) com
 * exatamente estas oito abas. A V3 tem uma ROTA — `/anuncios/[itemId]` —, que
 * `/anuncios` e o Dashboard de SKU já linkam e que uma notificação pode abrir.
 * Trocar a rota por um drawer removeria um destino que existe e é
 * compartilhável. O que se copia do frame é a COMPOSIÇÃO: cabeçalho de
 * entidade com identificador em mono, selos, ações à direita, e a fileira de
 * abas — o mesmo `ObjectHeader` que o SKU usa desde D8.
 *
 * O frame só desenha a aba "Visão geral"; as outras sete dizem "Aba em
 * construção". Vale então a mesma regra registrada para o SKU: aplicar o
 * design system, não inventar um frame.
 *
 * ## O que o frame mostra e a V3 não tem
 *
 * "Tipo" (Premium/Clássico) e "Catálogo" (Vencedor) não existem em `listings`
 * — a fileira de fatos do cabeçalho (D-310) usa o que existe: preço e
 * disponível (NOT NULL), o SKU vinculado e, quando veio, a categoria.
 * O bloco "Exposição em Risco" com o botão "Repor Full" é veredito sintetizado
 * mais ação de escrita sem política logística — os dois já são desvios
 * registrados. E "Saúde do Anúncio" (competitividade de preço, qualidade das
 * fotos) não tem fonte: do painel sobra o que é medido, que é o Full.
 *
 * **Republicar SAI daqui desde D-295**, e em dois atos. O motor existe desde a
 * Fase 9 (`listing_relists`, nove estados, worker e API); o que faltava era o
 * lugar onde uma pessoa autoriza. O pedido roda a conferência prévia e não
 * fecha nada; a execução fecha o anúncio pai no Mercado Livre, e fechar é
 * IRREVERSÍVEL — por isso ela exige um gesto a mais. Papel e escopo por conta
 * continuam impostos no servidor: o botão escondido é cortesia, não defesa.
 *
 * ## Leitura
 *
 * Cada aba dispara só as consultas de que precisa (o resto vira
 * `Promise.resolve`) — o mesmo progressive disclosure real do SKU, e o que
 * mata o risco "N+1 por aba" de `docs/ARCHITECTURE.md` §21.
 */

const LOOKBACK_DAYS = 30;
const TIMELINE_LIMIT = 50;

const TAB_KEYS = [
  "visao-geral",
  "vendas",
  "trafego",
  "preco",
  "full",
  "historico",
  "diagnostico",
  "decisoes",
] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  "visao-geral": "Visão geral",
  vendas: "Vendas",
  trafego: "Tráfego",
  preco: "Preço",
  full: "Full",
  historico: "Histórico",
  diagnostico: "Diagnóstico",
  decisoes: "Decisões",
};

/** Valor fora do conjunto fechado cai na Visão geral ANTES de tocar o banco. */
function parseTab(value: string | string[] | undefined): TabKey {
  return typeof value === "string" && (TAB_KEYS as readonly string[]).includes(value)
    ? (value as TabKey)
    : "visao-geral";
}

interface TimelineEventRow {
  id: string;
  event_type: string;
  severity: string;
  occurred_at: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  entity_type: string;
}

interface DiaMetricaRow {
  metric_date: string;
  units_sold: number;
  gross_revenue: number;
  orders_count: number;
  purchases_count: number;
}

interface DiaVisitaRow {
  metric_date: string;
  visits: number;
}

interface RelistRow {
  id: string;
  parent_item_id: string;
  child_item_id: string | null;
  status: string;
  failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface DecisionRow {
  id: string;
  decision: string;
  baseline_snapshot: unknown;
  created_at: string;
  actions: { kind: string; status: string; recommendation: string } | null;
}

interface ContentChangeAnalysisRow {
  occurred_at: string;
  content_changed: string[];
  baseline_units: number;
  outcome_units: number;
  baseline_visits: number | null;
  outcome_visits: number | null;
  verdict: string;
  blocked_reason: string | null;
}

export default async function AnuncioPage({
  params,
  searchParams,
}: {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { itemId } = await params;
  const query = await searchParams;
  const tab = parseTab(query.aba);
  const supabase = await createClient();

  // MLB ids são globais no Mercado Livre — um item pertence a UMA conta.
  // `null` pode ser "não existe" ou "a RLS escondeu": os dois viram 404,
  // mesmo raciocínio do Dashboard de SKU.
  const listing = await supabase
    .from("listings")
    .select(
      "id, organization_id, ml_account_id, item_id, sku_id, title, status, price, currency_id, available_quantity, category_id, synced_at, ml_accounts(label), skus(sku, title)",
    )
    .eq("item_id", itemId)
    .maybeSingle();

  if (listing.error !== null || listing.data === null) {
    notFound();
  }

  const row = listing.data;

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

  const needsSummary = tab === "visao-geral" || tab === "vendas" || tab === "trafego";
  const needsFull = tab === "visao-geral" || tab === "full";
  const needsTimeline = tab === "historico";
  const needsActions = tab === "visao-geral";
  // A Visão geral também desenha as barras por dia: as duas leituras entram no
  // mesmo `Promise.all`, então custam a ida que a página já faz (D-185).
  const needsDaily = tab === "vendas" || tab === "visao-geral";
  const needsVisits = tab === "trafego" || tab === "visao-geral";
  const needsPrices = tab === "preco";
  const needsRelists = tab === "historico";
  const needsDecisions = tab === "decisoes";
  const needsContentAnalysis = tab === "diagnostico";

  const [
    summaryResult,
    fullDoAnuncioResult,
    fullResult,
    timelineResult,
    actionsResult,
    dailyResult,
    visitsResult,
    pricesResult,
    relistsResult,
    decisionsResult,
    contentAnalysisResult,
    /*
      O PAPEL, para a aba Histórico decidir se oferece o disparo (D-295). Entra
      no `Promise.all` que já existe: em fila seria uma ida somada ao custo da
      página (D-185, o custo é o round trip). Esconder o botão de quem não pode
      é CORTESIA — a autorização real é do servidor (D-161).
    */
    membership,
  ] = await Promise.all([
    needsSummary
      ? supabase
          .rpc("get_listing_dashboard_summary", {
            p_organization_id: row.organization_id,
            p_ml_account_id: row.ml_account_id,
            p_item_id: row.item_id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
          })
          .single()
      : Promise.resolve({ data: null, error: null }),
    /*
      O Full DESTE ANÚNCIO, pela MESMA função que a lista `/anuncios` usa
      (D-243): soma do último snapshot por bucket dos últimos 3 dias, com o
      `item_id` do próprio anúncio. Sem isto a lista diria "Full 3" e o detalhe
      diria o total do SKU na conta — dois números sob o mesmo rótulo, que é
      exatamente como faixa e tabela começam a discordar (D-224). MLB é único,
      então a busca por `item_id` devolve este anúncio e mais nenhum.
    */
    needsFull
      ? supabase
          .rpc("get_listings_dashboard", {
            p_organization_id: row.organization_id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
            p_ml_account_id: row.ml_account_id,
            p_search: row.item_id,
            p_limit: 1,
          })
      : Promise.resolve({ data: null, error: null }),
    // O contexto por SKU+CONTA: situação, saldo local e buckets. É espelho por
    // SKU, então sem vínculo não há como rastrear — e a tela DIZ isso em vez
    // de mostrar zero.
    //
    // Via RPC desde D-173, e não mais lendo uma linha da tabela: o saldo do
    // Full é por BUCKET (um por variação), e pegar a captura mais recente do
    // par SKU+conta mostrava UM bucket como se fosse o total. Medido: 246
    // pares têm mais de uma variação, e o erro escondia 15,6% das unidades.
    needsFull && row.sku_id !== null
      ? supabase
          .rpc("get_fulfillment_overview", {
            p_organization_id: row.organization_id,
            p_date_from: dateFrom,
            p_date_to: dateTo,
            p_ml_account_id: row.ml_account_id,
            p_situation: null,
            p_search: null,
            p_sku_id: row.sku_id,
            p_limit: 1,
            p_offset: 0,
          })
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    needsTimeline
      ? supabase
          .from("domain_events")
          .select("id, event_type, severity, occurred_at, before, after, entity_type")
          .eq("ml_account_id", row.ml_account_id)
          .eq("entity_type", "listing")
          .eq("entity_id", row.item_id)
          .order("occurred_at", { ascending: false })
          .limit(TIMELINE_LIMIT)
      : Promise.resolve({ data: null, error: null }),
    needsActions
      ? supabase
          .from("actions")
          .select("id, kind, status, recommendation, created_at")
          .eq("mlb_id", row.item_id)
          .order("created_at", { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null, error: null }),
    // Venda POR DIA deste anúncio. Leitura direta do recálculo diário sob RLS:
    // não é agregação (os totais vêm da RPC acima, somados no banco), é a
    // própria linha do grão — o mesmo que a aba Vendas do SKU faz.
    needsDaily
      ? supabase
          .from("daily_listing_metrics")
          .select("metric_date, units_sold, gross_revenue, orders_count, purchases_count")
          .eq("ml_account_id", row.ml_account_id)
          .eq("mlb_id", row.item_id)
          .gte("metric_date", dateFrom)
          .lte("metric_date", dateTo)
          .order("metric_date", { ascending: false })
      : Promise.resolve({ data: null, error: null }),
    needsVisits
      ? supabase
          .from("daily_listing_visits")
          .select("metric_date, visits")
          .eq("ml_account_id", row.ml_account_id)
          .eq("item_id", row.item_id)
          .gte("metric_date", dateFrom)
          .lte("metric_date", dateTo)
          .order("metric_date", { ascending: false })
      : Promise.resolve({ data: null, error: null }),
    // Preço observado: os eventos `listing.price.changed` DESTE anúncio. É um
    // recorte da mesma linha do tempo da aba Histórico — a fonte é uma só
    // (D-224), o que muda é a lente.
    needsPrices
      ? supabase
          .from("domain_events")
          .select("id, event_type, severity, occurred_at, before, after, entity_type")
          .eq("ml_account_id", row.ml_account_id)
          .eq("entity_type", "listing")
          .eq("entity_id", row.item_id)
          .eq("event_type", "listing.price.changed")
          .order("occurred_at", { ascending: false })
          .limit(TIMELINE_LIMIT)
      : Promise.resolve({ data: null, error: null }),
    // Republicações deste anúncio — como PAI (foi republicado) ou como FILHO
    // (nasceu de uma republicação). Só leitura: a tela nunca dispara relist.
    needsRelists
      ? supabase
          .from("listing_relists")
          .select("id, parent_item_id, child_item_id, status, failure_reason, created_at, updated_at")
          .or(`parent_item_id.eq.${row.item_id},child_item_id.eq.${row.item_id}`)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: null, error: null }),
    // Decisões registradas sobre AÇÕES deste anúncio (`actions.mlb_id`) — o
    // embed filtra pelo anúncio, não pelo SKU.
    needsDecisions
      ? supabase
          .from("action_decisions")
          .select("id, decision, baseline_snapshot, created_at, actions!inner(kind, status, recommendation, mlb_id)")
          .eq("actions.mlb_id", row.item_id)
          .order("created_at", { ascending: false })
          .limit(20)
      : Promise.resolve({ data: null, error: null }),
    needsContentAnalysis
      ? supabase.rpc("get_listing_content_change_analysis", {
          p_organization_id: row.organization_id,
          p_ml_account_id: row.ml_account_id,
          p_item_id: row.item_id,
        })
      : Promise.resolve({ data: null, error: null }),
    needsRelists ? currentMembership() : Promise.resolve(null),
  ]);

  const summary = summaryResult.data;
  // `full_quantity` é NULA sem snapshot recente (D-243): ausência não é zero.
  const linhaDoAnuncio = (fullDoAnuncioResult.data ?? []) as { full_quantity: number | null }[];
  const fullDoAnuncio = fullDoAnuncioResult.error === null ? (linhaDoAnuncio[0]?.full_quantity ?? null) : null;
  /*
    A LINHA-SENTINELA de D-265. `get_fulfillment_overview` passou a devolver
    sempre ao menos uma linha — com as colunas do SKU em NULL — para as
    contagens da faixa de `/full` sobreviverem a um recorte vazio.

    Aqui isso importa MUITO: com `.maybeSingle()`, um SKU sem saldo no Full
    passaria a chegar como objeto de nulos em vez de `null`, e a aba renderizaria
    Full que não existe. O descarte é por `sku_id`.
  */
  const full = fullResult.data !== null && isFullRow(fullResult.data) ? fullResult.data : null;
  const timeline = (timelineResult.data ?? []) as unknown as TimelineEventRow[];
  const contentAnalysis = (contentAnalysisResult.data ?? []) as ContentChangeAnalysisRow[];
  const actions = actionsResult.data ?? [];
  const daily = (dailyResult.data ?? []) as unknown as DiaMetricaRow[];
  const visits = (visitsResult.data ?? []) as unknown as DiaVisitaRow[];
  const prices = (pricesResult.data ?? []) as unknown as TimelineEventRow[];
  const relists = (relistsResult.data ?? []) as unknown as RelistRow[];

  /*
    A operação deste anúncio COMO PAI — a mais recente. A tabela lista os dois
    lados (pai e filho), mas quem pode ser republicado é o pai: oferecer o
    botão na linha do filho seria oferecer outra operação, sobre outro anúncio.
  */
  const operacaoComoPai = relists.find((relist) => relist.parent_item_id === row.item_id) ?? null;
  const papel = membership?.role ?? null;
  const decisions = (decisionsResult.data ?? []) as unknown as DecisionRow[];

  /*
    Duas leituras que dependem da operação lida acima, e só nos estados em que
    o painel pede confirmação (D-364):

    - A ÚLTIMA FALHA, em RELIST_FAILED: é o `reason` desse evento que diz se o
      Mercado Livre RECUSOU (nenhum anúncio novo nasceu) — e só então a tela
      oferece tentar de novo. A consulta é a mesma da `api` e do worker
      (`readLastRelistFailureReason`); a RLS de `listing_relist_events` é a
      mesma de `listing_relists`.
    - As VARIAÇÕES do retrato do pedido, em REQUESTED e RELIST_FAILED: as que
      estão sem estoque ficam fora do anúncio novo, e o dono precisa ler quais
      ANTES de confirmar. Só `variations` sai do jsonb — o retrato inteiro é
      o item do Mercado Livre, pesado demais para uma confirmação. Também na
      operação que a conferência reprovou por variações em conta de user
      products (D-369): com variações no retrato, o painel não oferece outro
      pedido. A condição é `precisaDasVariacoesDoRetrato` (`republicacao.ts`),
      testada lá — sem ela, o painel veria 0 variações e voltaria a oferecer o
      pedido.
  */
  const [ultimaFalhaResult, variacoesDoPedidoResult] = await Promise.all([
    operacaoComoPai?.status === "RELIST_FAILED"
      ? readLastRelistFailureReason(supabase, operacaoComoPai.id)
      : Promise.resolve({ ok: true as const, reason: null }),
    precisaDasVariacoesDoRetrato(operacaoComoPai)
      ? supabase.from("listing_relists").select("variations:parent_snapshot->variations").eq("id", operacaoComoPai.id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);

  const retomavel =
    operacaoComoPai !== null &&
    ultimaFalhaResult.ok &&
    isRelistRetryEligible({
      status: operacaoComoPai.status,
      parentItemId: operacaoComoPai.parent_item_id,
      failureReason: operacaoComoPai.failure_reason,
      lastFailedEventReason: ultimaFalhaResult.reason,
    });
  const variacoesDoPedido = summarizeRelistVariations({ variations: variacoesDoPedidoResult.data?.variations });

  // Falha em qualquer consulta secundária aparece como ERRO, nunca como
  // "sem dado" (D-067).
  const secondaryError =
    summaryResult.error ??
    fullDoAnuncioResult.error ??
    fullResult.error ??
    timelineResult.error ??
    actionsResult.error ??
    dailyResult.error ??
    visitsResult.error ??
    pricesResult.error ??
    relistsResult.error ??
    (ultimaFalhaResult.ok ? null : { message: ultimaFalhaResult.message }) ??
    variacoesDoPedidoResult.error ??
    decisionsResult.error;

  /*
   * Os selos vêm da MESMA linha já lida — nenhum custa ida nova. A ordem é a
   * do frame: estado primeiro, conta depois, e a pendência de vínculo por
   * último, porque ela é trabalho a fazer e não característica do anúncio.
   */
  const badges: ObjectBadge[] = [
    { label: listingStatusLabel(row.status), tom: tomDeStatus(statusTone(row.status)) },
    { label: row.ml_accounts.label, tom: "info" },
    ...(row.sku_id === null ? [{ label: "Sem vínculo de SKU", tom: "atencao" as const }] : []),
  ];

  const href = (key: TabKey): string =>
    key === "visao-geral" ? `/anuncios/${row.item_id}` : `/anuncios/${row.item_id}?aba=${key}`;

  const syncVelho = horasDesde(row.synced_at, now) > SYNC_VELHO_HORAS;

  /*
    As três colunas de D-357 lidas por NOME e com guarda: um banco sem a
    migration (o Preview de um PR, antes do merge na v3) devolve a linha sem
    elas, e `formatCount(undefined)` imprimiria "NaN". Ausente vira "—".
  */
  const razoes = {
    compras: summary !== null && "purchases_count" in summary ? summary.purchases_count : null,
    ticket: summary !== null && "average_ticket" in summary ? summary.average_ticket : null,
    precoMedio: summary !== null && "average_selling_price" in summary ? summary.average_selling_price : null,
  };

  const periodo = { inicio: dateFrom, fim: dateTo };
  const vendasPorDia = daily.map((linha) => ({ data: linha.metric_date, valor: linha.units_sold }));
  const receitaPorDia = daily.map((linha) => ({ data: linha.metric_date, valor: linha.gross_revenue }));
  const visitasPorDia = visits.map((linha) => ({ data: linha.metric_date, valor: linha.visits }));

  const checagem =
    tab === "visao-geral"
      ? checarAnuncio({
          itemId: row.item_id,
          status: row.status,
          disponivel: row.available_quantity,
          skuId: row.sku_id,
          sku: row.skus?.sku ?? null,
          syncedAt: row.synced_at,
          agora: now,
          full: fullDoAnuncioResult.error === null ? fullDoAnuncio : undefined,
          resumo:
            summary === null
              ? null
              : { unidades: summary.units_sold, visitas: summary.visits, diasObservados: summary.days_observed },
          janelaDias: LOOKBACK_DAYS,
        })
      : [];
  const emOrdem = checagem.filter((item) => item.tom === "ok").length;

  return (
    <Shell>
      <PageTitle
        compacto
        eyebrow="COMERCIAL / CATÁLOGO"
        title="Detalhe do anúncio"
        subtitle="Estado, desempenho, Full e a história de um anúncio do Mercado Livre."
      />

      {/*
        O contexto para a gaveta do Copiloto (D-294): o MLB E a conta dona
        dele, que `listing_performance` exige e que a rota sozinha não carrega.
      */}
      <CopilotContextBeacon
        kind="listing"
        id={row.item_id}
        mlAccountId={row.ml_account_id}
        label={`Anúncio ${row.item_id}`}
      />

      <ObjectHeader
        identificador={row.item_id}
        titulo={row.title}
        badges={badges}
        meta={
          <span
            className={syncVelho ? "sb-anuncio-sync sb-anuncio-sync-velho" : "sb-anuncio-sync"}
            title={`sincronizado em ${formatDateTime(row.synced_at)}`}
          >
            <i aria-hidden="true" />
            sincronizado em {formatDateTime(row.synced_at)} · {idadeRelativa(row.synced_at, now)}
          </span>
        }
        /*
          OS DOIS FATOS QUE O CABEÇALHO DEVE, e devia desde D-168 (D-310).
          Aquela versão da tela abria com "conta, status, PREÇO, DISPONÍVEL,
          SKU, frescor"; a migração para abas de D13 levou os dois junto, e o
          preço passou a aparecer só como rabisco dentro da nota de OUTRO
          cartão — que só existe quando a RPC de resumo devolve linha.
          `available_quantity` ficou pior: vinha no `select` e não era
          impresso em nenhuma das oito abas.

          "Tipo" (Premium/Clássico) e "Catálogo" (Vencedor) do frame não
          existem em `listings` — recusa registrada. No lugar entram o SKU
          vinculado e a categoria, que existem na mesma linha já lida.

          Os rótulos carregam o que separa estes números dos vizinhos. "Preço
          atual" porque a fileira de abas tem uma aba chamada "Preço", que é a
          HISTÓRIA dele; "Disponível (este anúncio)" pelo mesmo motivo que a
          aba Full diz "No Full (este anúncio)" — a tela mostra três saldos de
          origens diferentes, e um rótulo cru convidaria a somá-los.
        */
        metricas={[
          {
            rotulo: "Preço atual",
            valor: formatCurrency(row.price),
            nota: "preço deste anúncio no Mercado Livre, como veio na última sincronização",
          },
          {
            rotulo: "Disponível (este anúncio)",
            valor: formatCount(row.available_quantity),
            nota: "estoque DESTE anúncio no Mercado Livre — não é o saldo do ERP nem o do Full",
          },
          {
            rotulo: "SKU vinculado",
            valor: row.skus?.sku ?? "—",
            nota:
              row.sku_id === null
                ? "sem vínculo — a venda deste anúncio não baixa estoque"
                : "o SKU cujo estoque cada venda deste anúncio baixa",
          },
          ...(row.category_id === null
            ? []
            : [
                {
                  rotulo: "Categoria",
                  valor: row.category_id,
                  nota: "categoria do Mercado Livre, como veio na última sincronização",
                },
              ]),
        ]}
        acoes={
          <>
            {/*
              O CAMINHO ATÉ A REPUBLICAÇÃO (D-310). O frame põe "Republicar
              anúncio ›" no cabeçalho, ao lado dos selos; aqui ele LEVA ao
              painel onde o ato mora, e por isso leva o nome do painel — a
              regra de D-309. Duas razões para não prometer o ato no rótulo:

              1. o ato é gated por papel (ADMIN ou GESTOR, D-295), e o papel só
                 é lido na aba Histórico. Prometer "Republicar" a quem não pode
                 seria a promessa falsa; ler o papel nas oito abas para decidir
                 o rótulo custaria uma ida em todas elas, contra o progressive
                 disclosure declarado acima;
              2. a republicação são DOIS atos (pedir e executar), e a execução
                 fecha o anúncio pai — irreversível. O cabeçalho não é lugar de
                 gatilho assim.

              Some quando já se está no destino: link para a aba aberta é
              afordância que não leva a lugar nenhum.
            */}
            {tab !== "historico" && (
              <Link className="sb-text-button" href={href("historico")}>
                Republicações
                <span aria-hidden="true">→</span>
              </Link>
            )}

            <CopiarMlb itemId={row.item_id} />

            <a
              className="sb-button"
              href={linkNoMercadoLivre(row.item_id)}
              target="_blank"
              rel="noopener noreferrer"
            >
              Ver no Mercado Livre
              <span aria-hidden="true">↗</span>
            </a>

            <details className="sb-menu">
            <summary className="sb-button sb-button-primary">
              Ações
              <span aria-hidden="true" className="sb-menu-chevron">
                ⌄
              </span>
            </summary>
            <div className="sb-menu-panel" style={{ right: 0, left: "auto" }}>
              {row.sku_id === null ? (
                <Link className="sb-menu-item" href="/vinculacoes">
                  Vincular a um SKU
                </Link>
              ) : (
                <Link className="sb-menu-item" href={`/skus/${row.sku_id}`}>
                  Abrir o SKU {row.skus?.sku ?? ""}
                </Link>
              )}
              <Link className="sb-menu-item" href={`/precos?busca=${encodeURIComponent(row.item_id)}`}>
                Ver na Central de Preços
              </Link>
              <Link className="sb-menu-item" href={`/anuncios?busca=${encodeURIComponent(row.item_id)}`}>
                Achar na lista de anúncios
              </Link>
              <Link className="sb-menu-item" href={href("historico")}>
                Linha do tempo e republicações
              </Link>
              <Link className="sb-menu-item" href="/acoes">
                Ver ações abertas
              </Link>
              <Link className="sb-menu-item" href="/anuncios">
                Voltar ao catálogo
              </Link>
            </div>
            </details>
          </>
        }
        rotuloAbas="Abas do anúncio"
        abas={TAB_KEYS.map((key) => ({ href: href(key), label: TAB_LABELS[key], active: key === tab }))}
      >
        {secondaryError !== null && (
          <p role="alert" style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-danger)", fontSize: "0.6875rem" }}>
            Não foi possível carregar parte do dashboard: {secondaryError.message}
          </p>
        )}

        {tab === "visao-geral" && (
          <>
            {/*
              Os QUATRO indicadores do frame, nesta ordem: Visitas, Conversão,
              Vendas, Faturamento. O bloco "Exposição em Risco" e o painel
              "Saúde do Anúncio" do frame ficam de fora — veredito sintetizado
              e competitividade/fotos não têm fonte; do que era "saúde" sobra o
              Full, que é medido e tem painel próprio abaixo.
            */}
            {summary !== null && (
              <div className="sb-stat-grid">
                <div className="sb-stat sb-anuncio-stat">
                  <span className="sb-anuncio-stat-icone" aria-hidden="true">
                    <Icone nome="pessoas" tamanho={16} />
                  </span>
                  <span className="sb-stat-label">Visitas ({LOOKBACK_DAYS}d)</span>
                  <b className="sb-stat-value">{formatCount(summary.visits)}</b>
                  <span className="sb-stat-note">
                    {summary.days_observed === 0
                      ? "nenhum dia com coleta de visitas no período"
                      : `observadas em ${String(summary.days_observed)} de ${String(LOOKBACK_DAYS)} dias`}
                  </span>
                </div>

                <div className="sb-stat sb-anuncio-stat">
                  <span className="sb-anuncio-stat-icone" aria-hidden="true">
                    <Icone nome="tendencia" tamanho={16} />
                  </span>
                  <span className="sb-stat-label">Conversão</span>
                  <b className="sb-stat-value">
                    {summary.conversion === null ? "—" : formatPercent(summary.conversion)}
                  </b>
                  <span className="sb-stat-note">
                    {summary.conversion === null
                      ? "sem visita observada — indefinida, não 0%"
                      : "pedidos ÷ visitas dos dias com coleta"}
                  </span>
                </div>

                {/*
                  O zero destes dois cartões vem de `coalesce(...,0)` na RPC, e
                  zero cru não diz de onde veio. `daily_listing_metrics` só
                  materializa dia com movimento — então "0" aqui significa
                  "nenhum dia com venda registrada", e é isso que a nota diz. É
                  a mesma doutrina de `/vendas` ("o recálculo não fabrica zero"),
                  que faltava nesta tela.
                */}
                <div className="sb-stat sb-anuncio-stat">
                  <span className="sb-anuncio-stat-icone" aria-hidden="true">
                    <Icone nome="carrinho" tamanho={16} />
                  </span>
                  <span className="sb-stat-label">Vendas ({LOOKBACK_DAYS}d)</span>
                  <b className="sb-stat-value">{formatCount(summary.units_sold)}</b>
                  <span className="sb-stat-note">
                    {summary.units_sold === 0
                      ? "nenhum dia com venda registrada no período"
                      : `unidades em ${formatCount(summary.orders_count)} pedido(s)`}
                  </span>
                </div>

                <div className="sb-stat sb-anuncio-stat">
                  <span className="sb-anuncio-stat-icone" aria-hidden="true">
                    <Icone nome="cifrao" tamanho={16} />
                  </span>
                  <span className="sb-stat-label">Faturamento ({LOOKBACK_DAYS}d)</span>
                  <b className="sb-stat-value">{formatCurrency(summary.gross_revenue)}</b>
                  <span className="sb-stat-note">
                    {summary.units_sold === 0
                      ? "sem venda registrada"
                      : razoes.ticket === null
                        ? "receita bruta"
                        : `receita bruta · ticket médio ${formatCurrency(razoes.ticket)}`}
                  </span>
                </div>
              </div>
            )}

            {/*
              AS DUAS SÉRIES POR DIA, lado a lado: venda e visita no mesmo
              período. Olhar as duas juntas é a pergunta que a Visão geral
              existe para responder — "tem gente olhando e não compra?" — e
              os totais da legenda vêm da RPC de resumo, não de soma na tela.
            */}
            <div className="sb-pair-grid">
              <Panel
                title="Vendas por dia"
                subtitle={`unidades vendidas, últimos ${String(LOOKBACK_DAYS)} dias`}
                aside={
                  <Link className="sb-anuncio-link" href={href("vendas")}>
                    Detalhar →
                  </Link>
                }
              >
                <div className="sb-panel-body">
                  <BarrasDiarias
                    dias={vendasPorDia}
                    inicio={periodo.inicio}
                    fim={periodo.fim}
                    formatar={formatCount}
                    rotulo="Unidades"
                    semRegistro="sem venda registrada"
                    total={summary === null ? null : formatCount(summary.units_sold)}
                  />
                </div>
              </Panel>

              <Panel
                title="Visitas por dia"
                subtitle={`coletadas por varredura, últimos ${String(LOOKBACK_DAYS)} dias`}
                aside={
                  <Link className="sb-anuncio-link" href={href("trafego")}>
                    Detalhar →
                  </Link>
                }
              >
                <div className="sb-panel-body">
                  <BarrasDiarias
                    dias={visitasPorDia}
                    inicio={periodo.inicio}
                    fim={periodo.fim}
                    formatar={formatCount}
                    rotulo="Visitas"
                    semRegistro="sem coleta"
                    total={summary === null ? null : formatCount(summary.visits)}
                    tom="secundaria"
                  />
                </div>
              </Panel>
            </div>

            <div className="sb-anuncio-grade">
              <Panel
                title="Checagem do anúncio"
                subtitle="fatos medidos, cada um com o critério escrito — não é nota nem veredito"
                aside={
                  <span
                    className="sb-status"
                    style={TOM[emOrdem === checagem.length ? "ok" : "atencao"]}
                  >
                    {String(emOrdem)} de {String(checagem.length)} em ordem
                  </span>
                }
              >
                <ul className="sb-checagem">
                  {checagem.map((item) => (
                    <li key={item.chave} className={`sb-checagem-item sb-checagem-${item.tom}`}>
                      <span className="sb-checagem-marca" aria-hidden="true">
                        {item.tom === "ok" ? "✓" : item.tom === "perigo" ? "!" : item.tom === "atencao" ? "!" : "–"}
                      </span>
                      <span className="sb-checagem-texto">
                        <b>{item.titulo}</b>
                        <small>{item.detalhe}</small>
                      </span>
                      {item.acao !== undefined && item.tom !== "ok" && (
                        <Link className="sb-button sb-button-sm" href={item.acao.href}>
                          {item.acao.rotulo}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </Panel>

              <div className="sb-anuncio-coluna">
              <Panel
                title="Full"
                subtitle="o que o Mercado Livre guarda deste item"
                aside={
                  <Link className="sb-anuncio-link" href="/full">
                    Central Full →
                  </Link>
                }
              >
                <div className="sb-panel-body sb-anuncio-full">
                  <b className={fullDoAnuncio === null ? "sb-anuncio-full-valor sb-anuncio-full-ausente" : "sb-anuncio-full-valor"}>
                    {fullDoAnuncio === null ? "—" : formatCount(fullDoAnuncio)}
                    {fullDoAnuncio !== null && <small> un no Full</small>}
                  </b>
                  <p>
                    {fullDoAnuncio === null
                      ? "Sem snapshot de Full nos últimos 3 dias para este anúncio — ele não está no Full, ou a captura não o alcançou. Ausência de snapshot não é saldo zero."
                      : "Soma do último snapshot por bucket — o mesmo número que a lista de anúncios mostra."}
                  </p>
                </div>
              </Panel>

              <Panel
                title="Ações relacionadas"
                subtitle={`${formatCount(actions.length)} aberta(s) ou registrada(s) para este anúncio`}
                aside={
                  <Link className="sb-anuncio-link" href="/acoes">
                    Central de Ações →
                  </Link>
                }
              >
                {actions.length === 0 ? (
                  <p className="sb-empty">Nenhuma ação registrada para este anúncio.</p>
                ) : (
                  actions.map((action) => (
                    <div key={action.id} className="sb-feed-row">
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <b>{action.recommendation}</b>
                        <small>
                          {action.kind} · {formatDateTime(action.created_at)}
                        </small>
                      </span>
                      <StatusPill code={action.status} label={actionStatusLabel(action.status)} />
                    </div>
                  ))
                )}
              </Panel>
              </div>
            </div>
          </>
        )}

        {tab === "vendas" && (
          <>
            <div className="sb-section-label" style={{ marginTop: 0 }}>
              <span>Vendas do anúncio</span>
              <span className="sb-section-note">
                últimos {LOOKBACK_DAYS} dias · recálculo por dia, não leitura ao vivo
              </span>
            </div>

            {summary !== null && (
              <KpiStrip
                ancora
                cells={
                  [
                    {
                      metricId: "unidades_vendidas",
                      label: "Unidades vendidas",
                      formula: "SUM(order_items.quantity) no grão anúncio/dia",
                      value: formatCount(summary.units_sold),
                      previous: null,
                    },
                    {
                      metricId: "receita_bruta",
                      label: "Receita bruta",
                      formula: "SUM(orders.total_amount) — pedidos pagos ou parcialmente reembolsados",
                      value: formatCurrency(summary.gross_revenue),
                      previous: null,
                    },
                    {
                      metricId: "pedidos",
                      label: "Pedidos",
                      formula: "COUNT(DISTINCT orders.id)",
                      value: formatCount(summary.orders_count),
                      previous: null,
                    },
                    {
                      metricId: "pedidos_por_pack",
                      label: "Compras (por pack)",
                      formula: "COUNT(DISTINCT pack_id, com order_id como fallback) — direto da fonte, no grão do anúncio",
                      value: formatCount(razoes.compras),
                      previous: null,
                    },
                    {
                      metricId: "ticket_medio",
                      label: "Ticket médio",
                      formula: "receita_bruta / pedidos_por_pack — sobre as somas do período",
                      value: formatCurrency(razoes.ticket),
                      previous: null,
                    },
                    {
                      metricId: "preco_medio_praticado",
                      label: "Preço médio praticado",
                      formula: "receita_bruta / unidades_vendidas — sobre as somas do período",
                      value: formatCurrency(razoes.precoMedio),
                      previous: null,
                    },
                  ] satisfies KpiCellData[]
                }
              />
            )}

            <div className="sb-pair-grid">
              <Panel title="Unidades por dia" subtitle="dias sem venda registrada ficam pontilhados, nunca zerados">
                <div className="sb-panel-body">
                  <BarrasDiarias
                    dias={vendasPorDia}
                    inicio={periodo.inicio}
                    fim={periodo.fim}
                    formatar={formatCount}
                    rotulo="Unidades"
                    semRegistro="sem venda registrada"
                    total={summary === null ? null : formatCount(summary.units_sold)}
                  />
                </div>
              </Panel>

              <Panel title="Receita bruta por dia" subtitle="soma dos pedidos pagos de cada dia">
                <div className="sb-panel-body">
                  <BarrasDiarias
                    dias={receitaPorDia}
                    inicio={periodo.inicio}
                    fim={periodo.fim}
                    formatar={formatCurrency}
                    rotulo="Receita"
                    semRegistro="sem venda registrada"
                    total={summary === null ? null : formatCurrency(summary.gross_revenue)}
                    tom="secundaria"
                  />
                </div>
              </Panel>
            </div>

            <div style={{ marginTop: "var(--sb-space-3)" }}>
              <Panel
                title="Por dia"
                subtitle="Dias sem venda registrada não aparecem — o recálculo não fabrica zero (mesmo contrato de /vendas)."
              >
                {daily.length === 0 ? (
                  <p className="sb-empty">Nenhum dia com venda registrada para este anúncio no período.</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th>Dia</th>
                          <th className="sb-num">Unidades</th>
                          <th className="sb-num">Receita bruta</th>
                          <th className="sb-num">Pedidos</th>
                          <th className="sb-num">Compras</th>
                        </tr>
                      </thead>
                      <tbody>
                        {daily.map((linha) => (
                          <tr key={linha.metric_date}>
                            {/* Data de NEGÓCIO (YYYY-MM-DD): formatar por string,
                                nunca por `new Date` (deslocaria o dia civil). */}
                            <td style={{ whiteSpace: "nowrap" }}>{formatBusinessDate(linha.metric_date)}</td>
                            <td className="sb-num">{formatCount(linha.units_sold)}</td>
                            <td className="sb-num">{formatCurrency(linha.gross_revenue)}</td>
                            <td className="sb-num">{formatCount(linha.orders_count)}</td>
                            <td className="sb-num">{formatCount(linha.purchases_count)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          </>
        )}

        {tab === "trafego" && (
          <>
            <div className="sb-section-label" style={{ marginTop: 0 }}>
              <span>Tráfego do anúncio</span>
              <span className="sb-section-note">
                visitas coletadas por varredura, últimos {LOOKBACK_DAYS} dias
              </span>
            </div>

            {summary !== null && (
              <div className="sb-stat-grid" style={{ ["--sb-stat-cols" as string]: "3" }}>
                <div className="sb-stat">
                  <span className="sb-stat-label">Visitas</span>
                  <b className="sb-stat-value">{formatCount(summary.visits)}</b>
                  <span className="sb-stat-note" style={{ fontFamily: "var(--sb-mono)" }}>
                    visitas
                  </span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">Dias observados</span>
                  <b className="sb-stat-value">
                    {summary.days_observed === 0
                      ? "—"
                      : `${String(summary.days_observed)}/${String(LOOKBACK_DAYS)}`}
                  </b>
                  <span className="sb-stat-note">
                    a varredura não alcança todo dia; é o denominador honesto da conversão
                  </span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">Conversão</span>
                  <b className="sb-stat-value">
                    {summary.conversion === null ? "—" : formatPercent(summary.conversion)}
                  </b>
                  <span className="sb-stat-note" style={{ fontFamily: "var(--sb-mono)" }}>
                    taxa_conversao
                  </span>
                </div>
              </div>
            )}

            <div style={{ marginTop: "var(--sb-space-3)" }}>
              <Panel
                title="Curva de visitas"
                subtitle="uma coluna por dia do período — o pontilhado é dia sem coleta, não dia sem visita"
              >
                <div className="sb-panel-body">
                  <BarrasDiarias
                    dias={visitasPorDia}
                    inicio={periodo.inicio}
                    fim={periodo.fim}
                    formatar={formatCount}
                    rotulo="Visitas"
                    semRegistro="sem coleta"
                    total={summary === null ? null : formatCount(summary.visits)}
                    tom="secundaria"
                  />
                </div>
              </Panel>
            </div>

            <div style={{ marginTop: "var(--sb-space-3)" }}>
              <Panel
                title="Visitas por dia"
                subtitle="Só os dias em que a varredura coletou. Ausência de linha é ausência de coleta, não visita zero (D-123)."
              >
                {visits.length === 0 ? (
                  <p className="sb-empty">
                    Nenhum dia com coleta de visitas para este anúncio no período — a varredura ainda não o alcançou.
                  </p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th>Dia</th>
                          <th className="sb-num">Visitas</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visits.map((linha) => (
                          <tr key={linha.metric_date}>
                            <td style={{ whiteSpace: "nowrap" }}>{formatBusinessDate(linha.metric_date)}</td>
                            <td className="sb-num">{formatCount(linha.visits)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          </>
        )}

        {tab === "preco" && (
          <Panel
            title="Mudanças de preço observadas"
            subtitle="As mudanças são o DIFF entre duas sincronizações de 6 em 6 horas — uma alteração feita e desfeita entre elas não deixa registro."
          >
            {prices.length === 0 ? (
              <p className="sb-empty">
                Nenhuma mudança de preço observada neste anúncio. Não quer dizer preço parado: quer dizer que
                nenhuma sincronização viu duas etiquetas diferentes.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Quando</th>
                      <th>Mudança</th>
                      <th>Variação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {prices.map((evento) => (
                      <tr key={evento.id}>
                        <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(evento.occurred_at)}</td>
                        <td>{formatEventDiff(evento.event_type, evento.before, evento.after) ?? "—"}</td>
                        <td>
                          {(() => {
                            const variacao = variacaoDePreco(evento.before, evento.after);

                            return variacao === null ? (
                              "—"
                            ) : (
                              <span className="sb-status" style={TOM[variacao.tom]}>
                                {variacao.texto}
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        {tab === "full" && (
          <Panel
            title="Full deste anúncio"
            subtitle="O saldo do Full é espelhado por SKU e CONTA, somado por bucket de variação (D-173) — não por anúncio."
            aside={
              <Link href="/full" style={{ color: "var(--sb-secondary)", textDecoration: "none", fontSize: "0.6875rem" }}>
                Central Full →
              </Link>
            }
          >
            <div className="sb-panel-body">
              <div className="sb-stat-grid" style={{ ["--sb-stat-cols" as string]: "2" }}>
                <div className="sb-stat">
                  <span className="sb-stat-label">No Full (este anúncio)</span>
                  <b className="sb-stat-value">{fullDoAnuncio === null ? "—" : formatCount(fullDoAnuncio)}</b>
                  <span className="sb-stat-note">
                    {fullDoAnuncio === null
                      ? "sem snapshot nos últimos 3 dias — ausência, não zero"
                      : "último snapshot por bucket, o mesmo número da lista"}
                  </span>
                </div>

                <div className="sb-stat">
                  <span className="sb-stat-label">SKU vinculado</span>
                  <b className="sb-stat-value">{row.skus === null ? "—" : row.skus.sku}</b>
                  <span className="sb-stat-note">
                    {row.skus === null ? "sem vínculo — o Full por SKU não é rastreável" : "o Full por SKU e conta está abaixo"}
                  </span>
                </div>
              </div>
            </div>

            {row.sku_id === null ? (
              <p className="sb-empty">
                Sem vínculo de SKU — o quadro por SKU e conta não é rastreável até vincular.{" "}
                <Link href="/vinculacoes">Central de Vinculações</Link>.
              </p>
            ) : full === null ? (
              <p className="sb-empty">
                {/*
                  TRÊS causas, não duas: a leitura canônica só enxerga captura
                  dos últimos 3 dias (D-173), então "sem linha" pode ser um
                  saldo antigo que a varredura não recapturou. A frase anterior
                  declarava só duas e negava esta.
                */}
                Nenhum snapshot de Full para este SKU nesta conta nos últimos 3 dias — o item não está no Full,
                nunca foi capturado, ou a captura não o alcançou nesse prazo. Ausência de snapshot não é o mesmo
                que saldo zero.
              </p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Conta</th>
                      <th className="sb-num">No Full</th>
                      <th className="sb-num">Buckets</th>
                      <th className="sb-num">Local (org.)</th>
                      <th className="sb-num">Vendas {LOOKBACK_DAYS}d</th>
                      <th>Situação</th>
                      <th>Capturado</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{full.account_label}</td>
                      <td className="sb-num">{formatCount(full.full_quantity)}</td>
                      <td className="sb-num">{formatCount(full.buckets)}</td>
                      <td className="sb-num">{formatCount(full.local_quantity)}</td>
                      <td className="sb-num">{formatCount(full.units_sold)}</td>
                      <td title={fullSituationCriterion(full.situation)}>
                        <span className="sb-status" style={TOM[fullSituationTom(full.situation)]}>
                          {fullSituationLabel(full.situation)}
                        </span>
                      </td>
                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(full.captured_at)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        )}

        {tab === "historico" && (
          <>
            {/*
              Linha do tempo DESTE anúncio — recorte por entidade, não duplicata
              da timeline do SKU (que agrega três caminhos). História, nunca
              causa.
            */}
            <Panel
              title="Linha do tempo do anúncio"
              subtitle={
                timeline.length >= TIMELINE_LIMIT
                  ? `os ${String(TIMELINE_LIMIT)} eventos mais recentes`
                  : "eventos de domínio registrados para este item"
              }
            >
              {timeline.length === 0 ? (
                <p className="sb-empty">
                  Nenhum evento registrado para este anúncio — a linha do tempo nasce dos eventos de domínio e só
                  enxerga o que o sistema registrou.
                </p>
              ) : (
                /*
                  LINHA DO TEMPO DE VERDADE, e não tabela: a pergunta desta aba
                  é "o que aconteceu, em que ordem", e o trilho vertical com o
                  ponto no tom da severidade responde isso num relance. Sem
                  coluna "Onde" pelo mesmo motivo de antes: a consulta fixa
                  `entity_type = 'listing'`.
                */
                <ol className="sb-linha-tempo">
                  {timeline.map((entry) => {
                    const mudanca = formatEventDiff(entry.event_type, entry.before, entry.after);
                    const tom =
                      entry.severity === "critico" ? "perigo" : entry.severity === "importante" ? "atencao" : "info";

                    return (
                      <li key={entry.id} className={`sb-linha-tempo-item sb-linha-tempo-${tom}`}>
                        <span className="sb-linha-tempo-ponto" aria-hidden="true" />
                        <div className="sb-linha-tempo-corpo">
                          <b>{eventTypeLabel(entry.event_type)}</b>
                          {mudanca !== null && <span className="sb-linha-tempo-mudanca">{mudanca}</span>}
                        </div>
                        <time dateTime={entry.occurred_at}>{formatDateTime(entry.occurred_at)}</time>
                      </li>
                    );
                  })}
                </ol>
              )}
            </Panel>

            {/*
              REPUBLICAÇÃO — a fila que a fatia D13 original queria como tela
              própria. Ela não é tela: é a história deste anúncio.

              ⚠️ Este comentário dizia "a tela LÊ e não dispara" e ficou FALSO
              em D-295, que trouxe os dois atos para cá (o pedido, que roda a
              conferência prévia e não fecha nada; e a execução, que fecha o
              anúncio pai e é irreversível). Os dois moram no `aside` abaixo,
              com gate de papel no servidor. Desde D-310 o cabeçalho aponta
              para este painel — aponta, não dispara.
            */}
            <div style={{ marginTop: "var(--sb-space-3)" }}>
              <Panel
                title="Republicações"
                subtitle="Como pai (foi republicado) ou como filho (nasceu de uma republicação). O pedido e a execução são dois atos humanos separados — o segundo fecha este anúncio, e fechar é irreversível."
                aside={
                  <RelistPanel
                    itemId={row.item_id}
                    mlAccountId={row.ml_account_id}
                    podeRepublicar={papel === "ADMIN" || papel === "GESTOR"}
                    variacoes={variacoesDoPedido}
                    operacao={
                      operacaoComoPai === null
                        ? null
                        : {
                            id: operacaoComoPai.id,
                            status: operacaoComoPai.status,
                            failureReason: operacaoComoPai.failure_reason,
                            childItemId: operacaoComoPai.child_item_id,
                            createdAt: operacaoComoPai.created_at,
                            updatedAt: operacaoComoPai.updated_at,
                            retomavel,
                          }
                    }
                  />
                }
              >
                {relists.length === 0 ? (
                  <p className="sb-empty">Nenhuma republicação registrada para este anúncio.</p>
                ) : (
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table">
                      <thead>
                        <tr>
                          <th>Pedida em</th>
                          <th>Estado</th>
                          <th>Anúncio filho</th>
                          <th>Motivo da falha</th>
                          <th>Atualizada em</th>
                        </tr>
                      </thead>
                      <tbody>
                        {relists.map((relist) => (
                          <tr key={relist.id}>
                            <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(relist.created_at)}</td>
                            <td>
                              {/*
                                O RÓTULO, não o código (D-295): esta coluna imprimia
                                `PREFLIGHT_FAILED` na frente de quem opera — a mesma
                                classe que D-273 achou em Sincronização.
                              */}
                              <span className="sb-status" style={TOM[tomDeRelist(relist.status)]}>
                                {relistStatusLabel(relist.status)}
                              </span>
                            </td>
                            <td className="sb-mono">
                              {relist.child_item_id === null ? (
                                "—"
                              ) : (
                                <Link href={`/anuncios/${relist.child_item_id}`}>{relist.child_item_id}</Link>
                              )}
                            </td>
                            <td style={{ color: relist.failure_reason === null ? undefined : "var(--sb-danger)" }}>
                              {relist.failure_reason ?? "—"}
                            </td>
                            <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(relist.updated_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
            </div>
          </>
        )}

        {tab === "diagnostico" && (
          <Panel title="Diagnóstico pós-alteração" subtitle="7 dias completos antes e depois; alerta só com evidência suficiente">
            {/*
              RECUSA HONESTA. O diagnóstico de venda anômala (D-078) compara a
              venda de ontem com o mesmo dia da semana usando
              `get_sku_sales_baseline` — baseline de SKU. Não existe baseline
              por ANÚNCIO, e rodar a fórmula sobre `daily_listing_metrics`
              produziria um número com a mesma cara e outra definição: a classe
              de invenção que D-023 proíbe.
            */}
            <div className="sb-panel-body" style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
              {contentAnalysis.length === 0 ? (
                <p style={{ margin: "0 0 var(--sb-space-3)" }}>
                  Nenhuma alteração de título, foto ou descrição completou ainda uma janela de 7 dias para análise.
                </p>
              ) : (
                <div style={{ display: "grid", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-3)" }}>
                  {contentAnalysis.map((analysis) => {
                    const labels = analysis.content_changed.map(eventTypeLabel).join(" + ");
                    const alert = analysis.verdict === "alert";

                    return (
                      <article
                        key={`${analysis.occurred_at}:${analysis.content_changed.join(",")}`}
                        style={{ borderLeft: `3px solid ${alert ? "var(--sb-danger)" : "var(--sb-border)"}`, paddingLeft: "var(--sb-space-2)" }}
                      >
                        <b style={{ color: alert ? "var(--sb-danger-ink)" : "var(--sb-text)" }}>
                          {alert ? `Alerta: anúncio entrou em queda após ${labels.toLowerCase()}.` : labels}
                        </b>
                        <p style={{ margin: "0.25rem 0 0" }}>
                          Alteração em {formatBusinessDate(analysis.occurred_at)} · vendas {formatCount(analysis.baseline_units)} → {formatCount(analysis.outcome_units)}
                          {analysis.baseline_visits !== null && analysis.outcome_visits !== null
                            ? ` · visitas ${formatCount(analysis.baseline_visits)} → ${formatCount(analysis.outcome_visits)}`
                            : ""}
                          . {analysis.blocked_reason ?? "Sem alteração de preço, estoque ou status na janela."}
                        </p>
                      </article>
                    );
                  })}
                </div>
              )}
              <p style={{ margin: "0 0 var(--sb-space-2)" }}>
                O alerta exige queda de pelo menos 30% em unidades e 25% em visitas, amostra mínima e ausência de preço,
                estoque ou status como explicação concorrente. Se duas partes do conteúdo mudaram juntas, o sistema não culpa uma só.
              </p>
              <p style={{ margin: "0 0 var(--sb-space-2)" }}>
                O diagnóstico de venda anômala compara a venda de ontem com o mesmo dia da semana sobre a{" "}
                <strong>baseline do SKU</strong>. Não existe baseline por anúncio, e aplicar a mesma fórmula ao
                recálculo por anúncio daria um número com a mesma cara e outra definição.
              </p>
              <p style={{ margin: 0 }}>
                {row.sku_id === null ? (
                  <>
                    Este anúncio não tem SKU vinculado, então nem por lá é possível diagnosticar. A fila de
                    vínculos está na <Link href="/vinculacoes">Central de Vinculações</Link>.
                  </>
                ) : (
                  <>
                    O diagnóstico deste item vive no SKU que ele vende:{" "}
                    <Link href={`/skus/${row.sku_id}?aba=diagnostico`}>
                      abrir o diagnóstico de {row.skus?.sku ?? "SKU"}
                    </Link>
                    .
                  </>
                )}
              </p>
            </div>
          </Panel>
        )}

        {tab === "decisoes" && (
          <Panel
            title="Decisões registradas"
            subtitle="Cada decisão nasce de uma ação da Central de Ações e guarda o retrato do momento. Comparação bruta, nunca porcentagem de resultado."
            aside={
              <Link href="/acoes" style={{ color: "var(--sb-secondary)", textDecoration: "none", fontSize: "0.6875rem" }}>
                Central de Ações →
              </Link>
            }
          >
            {decisions.length === 0 ? (
              <p className="sb-empty">
                Nenhuma decisão registrada para este anúncio. Uma decisão nasce de uma ação em{" "}
                <Link href="/acoes">Ações</Link>, e é ela que permite medir o depois contra o antes.
              </p>
            ) : (
              <div style={{ margin: "0 calc(-1 * var(--sb-space-3))" }}>
                {decisions.map((decision) => (
                  <article
                    key={decision.id}
                    className="sb-panel-body"
                    style={{ borderTop: "1px solid var(--sb-border)" }}
                  >
                    <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", flexWrap: "wrap" }}>
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <b style={{ display: "block", fontSize: "0.75rem" }}>{decision.decision}</b>
                        <small
                          style={{ display: "block", marginTop: 3, fontSize: "0.625rem", color: "var(--sb-text-soft)" }}
                        >
                          {decision.actions?.kind ?? "ação"} · {formatDateTime(decision.created_at)}
                        </small>
                      </span>
                      {decision.actions !== null && (
                        <StatusPill
                          code={decision.actions.status}
                          label={actionStatusLabel(decision.actions.status)}
                        />
                      )}
                    </div>

                    <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
                      No momento da decisão — {formatDecisionSnapshot(decision.baseline_snapshot)}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </Panel>
        )}
      </ObjectHeader>
    </Shell>
  );
}
