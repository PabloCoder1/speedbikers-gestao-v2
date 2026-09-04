import type { FreshnessLevel } from "@sb/domain";
import {
  businessDateRangeLength,
  classifySyncFreshness,
  previousBusinessDateRange,
  shiftBusinessDate,
  toSalesMetricDate,
} from "@sb/domain";
import type { ReactNode } from "react";

import type { SavedFilter } from "../../components/saved-filters";
import Link from "next/link";
import { SavedFilters } from "../../components/saved-filters";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime, formatPercent } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { DEFAULT_SALES_METRIC, SALES_METRICS, resolveSalesMetric } from "../../lib/sales-metric";
import { SalesChart } from "./sales-chart";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Dashboard de Vendas — Speed Bikers Gestão" };

// A sessão vem de cookie e o RLS depende de quem está logado: pré-renderizar
// no build mostraria dado de outra pessoa. Ver apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Dashboard Geral e por Conta de vendas — tela âncora da V3 (D-033).
 *
 * Terceira fatia da Fase 5A: seletor de conta somado ao filtro de período
 * (`docs/PRODUCT_REQUIREMENTS.md` — 7/15/30/60/90 dias e período
 * personalizado) e à comparação com o período anterior. "Geral" e "por
 * Conta" são a MESMA tela e a mesma `get_sales_summary` — o que muda é só
 * `p_ml_account_id`: nulo soma o grão organização (RLS já filtra para as
 * contas que o usuário alcança), preenchido restringe a uma conta. Duas
 * telas seriam a mesma UI duplicada.
 *
 * Filtro por link/formulário GET, sem componente cliente — mesmo padrão de
 * `apps/web/app/importacoes/[id]/page.tsx`. Toda soma acontece em SQL
 * (`get_sales_summary`), nunca em JavaScript (docs/ARCHITECTURE.md secao 21).
 *
 * "Comparação" aqui é o MESMO conjunto de seis métricas já aprovadas em
 * `docs/METRICS.md`, calculado duas vezes (período atual e anterior) — não é
 * uma métrica nova. `variacao_percentual_periodo`/`comparacao_periodo_anterior`
 * (docs/METRICS.md secao 5.4) têm definição pendente da Fase 5B; exibir um
 * "+12%" sintetizado agora seria um número sem `metric_definitions` por trás,
 * o que D-023 proíbe. Por isso a tela mostra os dois valores lado a lado e
 * deixa a leitura da variação para quem olha, não calcula a % sozinha.
 *
 * Os quatro backfills de 12 meses ainda não terminaram e nenhum rebuild
 * histórico rodou (docs/HANDOFF.md): é esperado que `get_sales_summary`
 * devolva `last_computed_at` nulo para janelas fora do que a reconciliação
 * já tocou — a tela distingue "nunca calculado" de "calculado e zero" em vez
 * de fingir um número que ainda não existe.
 */

const PRESET_DAYS = [7, 15, 30, 60, 90] as const;
const DEFAULT_DAYS = 30;

const FRESHNESS_TONE: Record<FreshnessLevel, { color: string; label: string }> = {
  ok: { color: "var(--sb-secondary)", label: "Atualizado" },
  atencao: { color: "var(--sb-accent-ink)", label: "Cálculo atrasando" },
  critico: { color: "var(--sb-danger)", label: "Cálculo desatualizado" },
  nunca_sincronizado: { color: "var(--sb-muted-ink)", label: "Nunca calculado" },
};


interface SalesSummary {
  units_sold: number;
  gross_revenue: number;
  orders_count: number;
  /** NULL sob recorte de marca (D-237): pack atravessa SKU, e somar contagem distinta entre grãos conta o mesmo pack duas vezes. */
  purchases_count: number | null;
  average_ticket: number | null;
  average_selling_price: number | null;
  last_computed_at: string | null;
}

/**
 * Métricas 5C (D-157) — nulidade REAL por cima do tipo gerado (o gerador não
 * marca retorno anulável; padrão de D-153): `taxa_cancelamento` vem NULL
 * quando não há pedido elegível no período — nunca 0% fingido.
 */
interface ExpandedSummary {
  taxas_ml: number;
  /** As três de cancelamento são NULL sob recorte de marca (D-237): contagem
   *  distinta em pedidos, e `valor_cancelado` é o total do PEDIDO inteiro. */
  pedidos_cancelados: number | null;
  taxa_cancelamento: number | null;
  valor_cancelado: number | null;
  skus_distintos_vendidos: number;
}

/**
 * Visão "hoje" (D-158) — nulidade real: `last_order_at` é NULL quando o dia
 * ainda não tem venda (max sobre conjunto vazio), e os zeros são zeros DE
 * VERDADE — `orders` chega ao vivo pelo webhook, diferente do rollup L3.
 */
interface TodaySummary {
  units_sold: number;
  gross_revenue: number;
  orders_count: number;
  /** NULL sob recorte de marca (D-237): pack atravessa SKU, e somar contagem distinta entre grãos conta o mesmo pack duas vezes. */
  purchases_count: number | null;
  last_order_at: string | null;
}

/**
 * Margem operacional (D-166) — nulidade REAL: com zero pedidos cobertos,
 * TUDO vem NULL (recusa como contrato) — nunca R$ 0,00 fingido.
 */
interface MarginSummary {
  /** Sob recorte de marca (D-237) a margem sai INTEIRA em NULL: frete e
   *  desconto são do PEDIDO, e não há cota de marca. */
  orders_total: number | null;
  orders_covered: number | null;
  gross_revenue_covered: number | null;
  taxas_ml_covered: number | null;
  frete_vendedor: number | null;
  desconto_vendedor: number | null;
  margem_operacional: number | null;
}

/**
 * O recorte de marca tem TRÊS estados, e "sem marca" não é ausência de
 * filtro: é a venda que nenhuma marca alcança — 23,2% da receita, itens sem
 * `sku_id` vinculado (D-237). Sem esse estado, somar as 19 marcas não
 * chegaria ao total e um quarto do faturamento sumiria sem explicação.
 */
type BrandFilter = { kind: "todas" } | { kind: "marca"; value: string } | { kind: "sem_marca" };

interface MetricCardSpec {
  metricId: string;
  label: string;
  formula: string;
  format: (value: number | null) => string;
  current: number | null;
  previous: number | null;
  /** Ressalva OBRIGATÓRIA de docs/METRICS.md 5C.2 — visível ao lado do número, nunca só em tooltip. */
  ressalva?: string;
}

/**
 * `MetricCardSpec` -> célula da faixa do Figma.
 *
 * Os construtores (`buildCards`, `buildTodayCards`, `buildExpandedCards`,
 * `buildMarginCards`) não mudaram uma linha: eles são verdade funcional —
 * fórmula canônica, id catalogado e ressalva de METRICS 5C.2. O que mudou é
 * para onde eles vão. Este adaptador é a fronteira entre as duas coisas.
 *
 * `showPrevious` continua sendo decisão de CADA bloco: a seção "hoje" não
 * compara (o dia não fechou), e a margem só compara quando o período anterior
 * teve pedido coberto.
 */
function toCells(cards: readonly MetricCardSpec[], showPrevious: boolean): KpiCellData[] {
  return cards.map((card) => ({
    metricId: card.metricId,
    label: card.label,
    formula: card.formula,
    value: card.format(card.current),
    previous: showPrevious ? (card.previous === null ? "sem dado" : card.format(card.previous)) : null,
    // `exactOptionalPropertyTypes`: a propriedade opcional não aceita
    // `undefined` explícito — ou ela existe, ou não está no objeto.
    ...(card.ressalva === undefined ? {} : { ressalva: card.ressalva }),
  }));
}

const FILTER_DATE_STYLE: React.CSSProperties = {
  padding: "0.25rem 0.5rem",
  borderRadius: "var(--sb-radius-md)",
  border: "1px solid var(--sb-border)",
  fontSize: "0.8125rem",
};

const MARGIN_NOTE_STYLE: React.CSSProperties = {
  margin: 0,
  padding: "var(--sb-space-2) var(--sb-space-3) var(--sb-space-3)",
  color: "var(--sb-text-soft)",
  fontSize: "0.8125rem",
};

function buildCards(current: SalesSummary, previous: SalesSummary | null): MetricCardSpec[] {
  return [
    {
      metricId: "receita_bruta",
      label: "Receita bruta",
      formula: "SUM(orders.total_amount) — pedidos pagos ou parcialmente reembolsados",
      format: formatCurrency,
      current: current.gross_revenue,
      previous: previous?.gross_revenue ?? null,
    },
    {
      metricId: "unidades_vendidas",
      label: "Unidades vendidas",
      formula: "SUM(order_items.quantity)",
      format: formatCount,
      current: current.units_sold,
      previous: previous?.units_sold ?? null,
    },
    {
      metricId: "pedidos",
      label: "Pedidos do Mercado Livre",
      formula: "COUNT(DISTINCT orders.id)",
      format: formatCount,
      current: current.orders_count,
      previous: previous?.orders_count ?? null,
    },
    {
      metricId: "pedidos_por_pack",
      label: "Compras (por pack)",
      formula: "COUNT(DISTINCT pack_id, com order_id como fallback)",
      format: formatCount,
      current: current.purchases_count,
      previous: previous?.purchases_count ?? null,
    },
    {
      metricId: "ticket_medio",
      label: "Ticket médio",
      formula: "receita_bruta / pedidos_por_pack",
      format: formatCurrency,
      current: current.average_ticket,
      previous: previous?.average_ticket ?? null,
    },
    {
      metricId: "preco_medio_praticado",
      label: "Preço médio praticado",
      formula: "receita_bruta / unidades_vendidas",
      format: formatCurrency,
      current: current.average_selling_price,
      previous: previous?.average_selling_price ?? null,
    },
  ];
}

/**
 * Visão "hoje" (D-158, 5C.4): as MESMAS quatro fórmulas canônicas do topo da
 * tela, avaliadas ao vivo sobre `orders` (L1) — nenhuma métrica nova, por
 * isso os IDs são os já catalogados. A incompletude é UMA verdade sobre as
 * quatro e vive no cabeçalho da seção, não em cada card.
 */
function buildTodayCards(today: TodaySummary): MetricCardSpec[] {
  return [
    {
      metricId: "receita_bruta",
      label: "Receita bruta (hoje)",
      formula: "SUM(orders.total_amount) — avaliada ao vivo sobre orders",
      format: formatCurrency,
      current: today.gross_revenue,
      previous: null,
    },
    {
      metricId: "unidades_vendidas",
      label: "Unidades vendidas (hoje)",
      formula: "SUM(order_items.quantity) — avaliada ao vivo sobre orders",
      format: formatCount,
      current: today.units_sold,
      previous: null,
    },
    {
      metricId: "pedidos",
      label: "Pedidos (hoje)",
      formula: "COUNT(DISTINCT orders.id) — avaliada ao vivo sobre orders",
      format: formatCount,
      current: today.orders_count,
      previous: null,
    },
    {
      metricId: "pedidos_por_pack",
      label: "Compras (hoje)",
      formula: "COUNT(DISTINCT pack_id, order_id como fallback) — avaliada ao vivo",
      format: formatCount,
      current: today.purchases_count,
      previous: null,
    },
  ];
}

/**
 * Métricas 5C de vendas (D-157) — cancelamentos e taxas vêm de `orders`
 * direto (L1): não existem no rollup L3 por construção, e a taxa de
 * cancelamento usa os dois lados da MESMA leitura (misturar L1 com L3
 * embutiria o atraso do recálculo na razão — 0,1% medido). Por isso podem
 * divergir ligeiramente dos cards L3 acima, e a seção declara a fonte.
 */
function buildExpandedCards(current: ExpandedSummary, previous: ExpandedSummary | null): MetricCardSpec[] {
  return [
    {
      metricId: "taxas_ml",
      label: "Taxas do Mercado Livre",
      formula: "SUM(order_items.sale_fee) sobre vendas válidas",
      format: formatCurrency,
      current: current.taxas_ml,
      previous: previous?.taxas_ml ?? null,
      ressalva: "Comissão de venda. Não inclui frete, taxa fixa, parcelamento nem impostos.",
    },
    {
      metricId: "pedidos_cancelados",
      label: "Pedidos cancelados",
      formula: "COUNT(DISTINCT orders.id) em cancelled/pending_cancel",
      format: formatCount,
      current: current.pedidos_cancelados,
      previous: previous?.pedidos_cancelados ?? null,
      ressalva: "Inclui pending_cancel. Cancelamento não é devolução, reembolso nem mediação.",
    },
    {
      metricId: "taxa_cancelamento",
      label: "Taxa de cancelamento",
      formula: "cancelados ÷ elegíveis (válidos + cancelados)",
      format: formatPercent,
      current: current.taxa_cancelamento,
      previous: previous?.taxa_cancelamento ?? null,
      ressalva: "Denominador: pedidos elegíveis, os dois lados da mesma leitura de orders.",
    },
    {
      metricId: "valor_cancelado",
      label: "Valor cancelado",
      formula: "SUM(orders.total_amount) dos cancelados",
      format: formatCurrency,
      current: current.valor_cancelado,
      previous: previous?.valor_cancelado ?? null,
      ressalva: "Valor pedido, não valor estornado — o estorno financeiro não é observado.",
    },
    {
      metricId: "skus_distintos_vendidos",
      label: "SKUs distintos vendidos",
      formula: "COUNT(DISTINCT sku_id) no grão pedido",
      format: formatCount,
      current: current.skus_distintos_vendidos,
      previous: previous?.skus_distintos_vendidos ?? null,
      ressalva: "Exclui itens vendidos sem vínculo de SKU (21,8% dos itens em 30 dias, medido).",
    },
  ];
}

/**
 * Margem operacional (D-166, METRICS 5C.2) — computada SÓ sobre pedidos
 * COBERTOS (frete E desconto observados, D-165), receita e taxas do MESMO
 * subconjunto. A cobertura e o veto de 5C.1 vivem no cabeçalho da seção.
 */
function buildMarginCards(margin: MarginSummary, previous: MarginSummary | null): MetricCardSpec[] {
  return [
    {
      metricId: "margem_operacional_pedido",
      label: "Margem operacional",
      formula: "receita − taxas − frete do vendedor − desconto, sobre pedidos cobertos",
      format: formatCurrency,
      current: margin.margem_operacional,
      previous: previous?.margem_operacional ?? null,
      ressalva: "Não é receita líquida: taxa fixa, parcelamento, custo do MP, impostos e reembolsos posteriores ficam fora.",
    },
    {
      metricId: "frete_vendedor",
      label: "Frete do vendedor",
      formula: "SUM(senders[].cost) sobre pedidos cobertos",
      format: formatCurrency,
      current: margin.frete_vendedor,
      previous: previous?.frete_vendedor ?? null,
      ressalva: "Só pedidos com o custo observado — não observado nunca vira R$ 0,00.",
    },
    {
      metricId: "desconto_vendedor",
      label: "Desconto bancado pelo vendedor",
      formula: "SUM(amounts.seller) sobre pedidos cobertos",
      format: formatCurrency,
      current: margin.desconto_vendedor,
      previous: previous?.desconto_vendedor ?? null,
      ressalva: "Exclui taxas adicionais e reembolsos posteriores (limite da própria doc).",
    },
  ];
}


interface DateRange {
  from: string;
  to: string;
}

type Period = { days: number } | { from: string; to: string };

/**
 * Resolve a janela pedida pela URL. `from`/`to` explícitos vencem um `days`
 * concorrente; formato ruim ou intervalo invertido caem para o padrão em vez
 * de derrubar a página com 500 — mesmo espírito de `formatBusinessDate`.
 */
function resolveRange(
  query: Record<string, string | string[] | undefined>,
  today: string,
): { range: DateRange; days: number | null; invalidCustom: boolean } {
  const rawFrom = typeof query.from === "string" ? query.from : null;
  const rawTo = typeof query.to === "string" ? query.to : null;
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

  if (rawFrom !== null && rawTo !== null) {
    if (dateRegex.test(rawFrom) && dateRegex.test(rawTo) && rawFrom <= rawTo) {
      return { range: { from: rawFrom, to: rawTo }, days: null, invalidCustom: false };
    }

    return {
      range: { from: shiftBusinessDate(today, -(DEFAULT_DAYS - 1)), to: today },
      days: DEFAULT_DAYS,
      invalidCustom: true,
    };
  }

  const rawDays = typeof query.days === "string" ? Number(query.days) : DEFAULT_DAYS;
  const days = (PRESET_DAYS as readonly number[]).includes(rawDays) ? rawDays : DEFAULT_DAYS;

  return { range: { from: shiftBusinessDate(today, -(days - 1)), to: today }, days, invalidCustom: false };
}

interface AccountOption {
  id: string;
  slug: string;
  label: string;
}

/**
 * Monta a URL preservando a outra dimensão do filtro — trocar de conta não
 * pode resetar o período, e vice-versa. Mesma ideia do `href()` de
 * `apps/web/app/importacoes/[id]/page.tsx`, com duas dimensões em vez de uma.
 */
function buildHref(
  current: { period: Period; accountSlug: string | null; metricKey: string; brand: BrandFilter },
  override: {
    period?: Period;
    accountSlug?: string | null;
    metricKey?: string;
    brand?: BrandFilter;
  },
): string {
  const period = override.period ?? current.period;
  const accountSlug = override.accountSlug !== undefined ? override.accountSlug : current.accountSlug;
  const metricKey = override.metricKey ?? current.metricKey;
  const brand = override.brand ?? current.brand;

  const search = new URLSearchParams();

  if ("from" in period) {
    search.set("from", period.from);
    search.set("to", period.to);
  } else if (period.days !== DEFAULT_DAYS) {
    search.set("days", String(period.days));
  }

  if (accountSlug !== null) {
    search.set("account", accountSlug);
  }

  // Marca e "sem marca" são estados MUTUAMENTE exclusivos, e por isso viram
  // dois parâmetros distintos: um valor reservado dentro de `marca` colidiria
  // com marca real e precisaria da mesma constante em SQL e em TypeScript —
  // as "duas listas" que D-232 puniu.
  if (brand.kind === "marca") {
    search.set("marca", brand.value);
  } else if (brand.kind === "sem_marca") {
    search.set("semMarca", "1");
  }

  // O default fica FORA da URL, como `days` e `account` já fazem: `/vendas`
  // limpo continua sendo a mesma página de sempre, e um link compartilhado só
  // carrega o que foi realmente escolhido.
  if (metricKey !== DEFAULT_SALES_METRIC.key) {
    search.set("metric", metricKey);
  }

  const qs = search.toString();

  return qs === "" ? "/vendas" : `/vendas?${qs}`;
}

export default async function VendasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const now = new Date();
  const today = toSalesMetricDate(now);

  const { range, days, invalidCustom } = resolveRange(query, today);
  const previousRange = previousBusinessDateRange(range.from, range.to);
  const isCustom = days === null;
  const period: Period = isCustom ? range : { days };

  const [accountsResult, membershipResult, savedFiltersResult] = await Promise.all([
    supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true }),
    currentMembership(supabase),
    supabase.from("saved_filters").select("id, name, params").eq("screen", "/vendas").order("name"),
  ]);

  const accounts: AccountOption[] = accountsResult.data ?? [];
  const organizationId = membershipResult.organizationId;
  const savedFilters: SavedFilter[] = (savedFiltersResult.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    params: row.params as Record<string, string>,
  }));

  const metric = resolveSalesMetric(query.metric);

  const requestedSlug = typeof query.account === "string" ? query.account : null;
  const selectedAccount = accounts.find((account) => account.slug === requestedSlug) ?? null;
  // Slug desconhecido (conta removida, digitado à mão) cai em "todas as
  // contas" em silêncio — mesmo tratamento de status desconhecido em
  // apps/web/app/importacoes/[id]/page.tsx, não é erro de rede nem de dado.
  const accountSlug = selectedAccount?.slug ?? null;

  // `exactOptionalPropertyTypes` distingue "propriedade ausente" de
  // "propriedade com undefined" — o spread condicional omite a chave de
  // vez, em vez de atribuir `undefined` a um campo opcional.
  const accountFilter = selectedAccount === null ? {} : { p_ml_account_id: selectedAccount.id };

  // `semMarca=1` vence sobre `marca=` quando os dois vêm na URL: um recorte
  // só, e o mais específico é o que isola a venda que nenhuma marca alcança.
  const brand: BrandFilter =
    query.semMarca === "1"
      ? { kind: "sem_marca" }
      : typeof query.marca === "string" && query.marca.trim() !== ""
        ? { kind: "marca", value: query.marca.trim() }
        : { kind: "todas" };

  const brandFilter =
    brand.kind === "marca"
      ? { p_supplier_brand: brand.value }
      : brand.kind === "sem_marca"
        ? { p_sem_marca: true }
        : {};

  const [
    currentResult,
    previousResult,
    seriesResult,
    previousSeriesResult,
    expandedResult,
    previousExpandedResult,
    todayResult,
    brandsResult,
    marginResult,
    previousMarginResult,
  ] = await Promise.all([
    supabase
      .rpc("get_sales_summary", { p_date_from: range.from, p_date_to: range.to, ...accountFilter, ...brandFilter })
      .single(),
    supabase
      .rpc("get_sales_summary", {
        p_date_from: previousRange.from,
        p_date_to: previousRange.to,
        ...accountFilter, ...brandFilter,
      })
      .single(),
    supabase.rpc("get_sales_daily_series", {
      p_date_from: range.from,
      p_date_to: range.to,
      ...accountFilter, ...brandFilter,
    }),
    // Quarta consulta EM PARALELO, não em cascata (docs/ARCHITECTURE.md §21).
    // Mesma RPC, outra janela: a comparação de período já existia nos cards
    // desde a Fase 5A e o `docs/PRODUCT_REQUIREMENTS.md` pede que ela alcance
    // o gráfico. Nenhuma RPC nova.
    supabase.rpc("get_sales_daily_series", {
      p_date_from: previousRange.from,
      p_date_to: previousRange.to,
      ...accountFilter, ...brandFilter,
    }),
    // Quinta e sexta (D-157): métricas 5C — cancelamentos, taxas e SKUs
    // distintos, período atual e anterior, no mesmo paralelo.
    supabase
      .rpc("get_sales_expanded_summary", { p_date_from: range.from, p_date_to: range.to, ...accountFilter, ...brandFilter })
      .single(),
    supabase
      .rpc("get_sales_expanded_summary", {
        p_date_from: previousRange.from,
        p_date_to: previousRange.to,
        ...accountFilter, ...brandFilter,
      })
      .single(),
    // Sétima (D-158): visão "hoje" ao vivo sobre orders (L1) — independente
    // do período selecionado, respeita só o filtro de conta.
    supabase.rpc("get_sales_today_summary", { p_date: today, ...accountFilter, ...brandFilter }).single(),
    // A lista vem do BANCO, nunca das linhas da página (D-194). Não depende do
    // recorte: as pílulas têm de continuar mostrando as outras marcas.
    // Sem organização a página ainda renderiza (ela não faz early-return), e
    // pedir a lista com id nulo seria erro de rede em vez de filtro vazio.
    organizationId === null
      ? Promise.resolve({ data: null, error: null })
      : supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
    // Oitava e nona (D-166): margem operacional sobre janela COBERTA,
    // período atual e anterior, no mesmo paralelo.
    supabase
      .rpc("get_sales_margin_summary", { p_date_from: range.from, p_date_to: range.to, ...accountFilter, ...brandFilter })
      .single(),
    supabase
      .rpc("get_sales_margin_summary", {
        p_date_from: previousRange.from,
        p_date_to: previousRange.to,
        ...accountFilter, ...brandFilter,
      })
      .single(),
  ]);

  const brands = (brandsResult.data ?? []).map((r) => r.supplier_brand);

  const summary: SalesSummary | null = currentResult.data ?? null;
  const previousSummary: SalesSummary | null = previousResult.data ?? null;
  const dailySeries = seriesResult.data ?? [];
  const previousDailySeries = previousSeriesResult.data ?? [];
  // Falha em QUALQUER uma das QUATRO: mostrar erro, nunca "sem dado" — uma
  // falha em previousResult/seriesResult isolada ficava invisível antes
  // (só currentResult.error era checado), e a comparação de período/gráfico
  // silenciosamente pareciam legítimos com dado incompleto (D-067).
  //
  // A quarta entrou com a série do período anterior (D-137) e é o caso mais
  // traiçoeiro dos quatro: sem ela aqui, falhar a consulta produziria um
  // gráfico SEM a linha de comparação — visualmente idêntico a "o período
  // anterior não teve venda", que é uma afirmação sobre o negócio, não sobre
  // a rede. É exatamente a classe de defeito que D-067 existe para impedir.
  // As duas de D-157 entram na MESMA agregação: falhar só a expandida
  // produziria a tela sem a seção de cancelamentos — visualmente idêntico a
  // "não houve cancelamento", afirmação sobre o negócio, não sobre a rede.
  const error =
    currentResult.error ??
    previousResult.error ??
    seriesResult.error ??
    previousSeriesResult.error ??
    expandedResult.error ??
    previousExpandedResult.error ??
    todayResult.error ??
    marginResult.error ??
    previousMarginResult.error;

  const expanded: ExpandedSummary | null = expandedResult.data ?? null;
  const previousExpanded: ExpandedSummary | null = previousExpandedResult.data ?? null;
  const todaySummary: TodaySummary | null = todayResult.data ?? null;
  const margin: MarginSummary | null = marginResult.data ?? null;
  const previousMargin: MarginSummary | null = previousMarginResult.data ?? null;

  const lastComputedAt = summary?.last_computed_at ?? null;
  const freshness = classifySyncFreshness(lastComputedAt === null ? null : new Date(lastComputedAt), now);
  const freshnessTone = FRESHNESS_TONE[freshness];

  // "Nunca calculado" é diferente de "calculado e deu zero" — a primeira não
  // deve fingir R$ 0,00 real. Ver o comentário do módulo.
  const neverComputed = summary !== null && lastComputedAt === null;
  const previousHasData = previousSummary !== null && previousSummary.last_computed_at !== null;

  const contaLabel = selectedAccount === null ? "Todas as contas" : selectedAccount.label;
  const periodoLabel = isCustom ? "Período personalizado" : `Últimos ${String(days)} dias`;
  const marcaLabel =
    brand.kind === "todas" ? "Todas as marcas" : brand.kind === "sem_marca" ? "Sem marca" : brand.value;

  return (
    <Shell>
      <PageTitle
        eyebrow="COMERCIAL / RESULTADOS"
        title="Dashboard de vendas"
        subtitle={
          <>
            {contaLabel}, {formatBusinessDate(range.from)} até {formatBusinessDate(range.to)} — comparado com{" "}
            {formatBusinessDate(previousRange.from)} até {formatBusinessDate(previousRange.to)}.
          </>
        }
        aside={
          <>
            {/*
              Os filtros saíram das linhas de pílulas e viraram a barra de menus
              do Figma. O comportamento é o mesmo — link com `href`, estado na
              URL, sem componente cliente —, e o `<details>` nativo faz o
              dropdown, como na navegação. Eram TRÊS linhas de pílulas (conta,
              marca, período) empurrando o conteúdo para baixo antes do
              primeiro número.
            */}
            {accountsResult.error === null && accounts.length > 0 && (
              <details className="sb-menu">
                <summary className="sb-button">{contaLabel} ▾</summary>
                <div className="sb-menu-panel">
                  <Link
                    className="sb-menu-item"
                    aria-current={selectedAccount === null ? "true" : undefined}
                    href={buildHref({ period, accountSlug, metricKey: metric.key, brand }, { accountSlug: null })}
                  >
                    Todas as contas
                  </Link>
                  {accounts.map((account) => (
                    <Link
                      key={account.id}
                      className="sb-menu-item"
                      aria-current={selectedAccount?.id === account.id ? "true" : undefined}
                      href={buildHref({ period, accountSlug, metricKey: metric.key, brand }, { accountSlug: account.slug })}
                    >
                      {account.label}
                    </Link>
                  ))}
                </div>
              </details>
            )}

            {/*
              "Sem marca" NÃO é ausência de filtro: é a venda que nenhuma marca
              alcança — item sem SKU vinculado, 23,2% da receita. Sem essa
              opção, somar as marcas não chegaria ao total e um quarto do
              faturamento sumiria sem explicação (D-237).
            */}
            <details className="sb-menu">
              <summary className="sb-button">{marcaLabel} ▾</summary>
              <div className="sb-menu-panel">
                <Link
                  className="sb-menu-item"
                  aria-current={brand.kind === "todas" ? "true" : undefined}
                  href={buildHref({ period, accountSlug, metricKey: metric.key, brand }, { brand: { kind: "todas" } })}
                >
                  Todas as marcas
                </Link>
                <Link
                  className="sb-menu-item"
                  aria-current={brand.kind === "sem_marca" ? "true" : undefined}
                  href={buildHref({ period, accountSlug, metricKey: metric.key, brand }, { brand: { kind: "sem_marca" } })}
                >
                  Sem marca
                </Link>
                {brands.map((nome) => (
                  <Link
                    key={nome}
                    className="sb-menu-item"
                    aria-current={brand.kind === "marca" && brand.value === nome ? "true" : undefined}
                    href={buildHref({ period, accountSlug, metricKey: metric.key, brand }, { brand: { kind: "marca", value: nome } })}
                  >
                    {nome}
                  </Link>
                ))}
              </div>
            </details>

            <details className="sb-menu">
              <summary className="sb-button">{periodoLabel} ▾</summary>
              <div className="sb-menu-panel">
                {PRESET_DAYS.map((preset) => (
                  <Link
                    key={preset}
                    className="sb-menu-item"
                    aria-current={!isCustom && days === preset ? "true" : undefined}
                    href={buildHref({ period, accountSlug, metricKey: metric.key, brand }, { period: { days: preset } })}
                  >
                    Últimos {preset} dias
                  </Link>
                ))}

                <form
                  method="get"
                  style={{
                    display: "grid",
                    gap: "0.375rem",
                    padding: "0.5rem 0.625rem 0.375rem",
                    borderTop: "1px solid var(--sb-border)",
                    marginTop: "0.25rem",
                  }}
                >
                  {accountSlug !== null && <input type="hidden" name="account" value={accountSlug} />}
                  {/*
                    Mesmo motivo do hidden de `account` logo acima: um GET
                    nativo envia SÓ os campos do formulário, então sem isto
                    escolher um período personalizado descartaria a métrica
                    escolhida e o gráfico voltaria para faturamento sozinho.
                    O recorte de marca entrou na mesma conta — antes ele se
                    perdia, e este é o segundo campo que a varredura achou.
                  */}
                  {metric.key !== DEFAULT_SALES_METRIC.key && (
                    <input type="hidden" name="metric" value={metric.key} />
                  )}
                  {brand.kind === "marca" && <input type="hidden" name="marca" value={brand.value} />}
                  {brand.kind === "sem_marca" && <input type="hidden" name="semMarca" value="1" />}

                  <input
                    type="date"
                    name="from"
                    defaultValue={isCustom ? range.from : undefined}
                    aria-label="Data inicial"
                    style={FILTER_DATE_STYLE}
                  />
                  <input
                    type="date"
                    name="to"
                    defaultValue={isCustom ? range.to : undefined}
                    aria-label="Data final"
                    style={FILTER_DATE_STYLE}
                  />
                  <button type="submit" className="sb-button sb-button-primary" style={{ justifyContent: "center" }}>
                    Aplicar período
                  </button>
                </form>
              </div>
            </details>

            {organizationId !== null && (
              <SavedFilters screen="/vendas" organizationId={organizationId} filters={savedFilters} />
            )}

            {/*
              O veredito de frescor é verdade funcional (D-143/D-219) e não sai
              da tela por não estar no frame do Figma: ele diz se o número que
              está sendo lido foi recalculado.
            */}
            {summary !== null && (
              <span
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 700,
                  color: freshnessTone.color,
                  whiteSpace: "nowrap",
                }}
              >
                {freshnessTone.label}
                {lastComputedAt !== null && ` · até ${formatDateTime(lastComputedAt)}`}
              </span>
            )}
          </>
        }
      />

      {(accountsResult.error !== null || membershipResult.error !== null || savedFiltersResult.error !== null) && (
        <p role="alert" style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-danger)" }}>
          Alguns filtros podem estar incompletos — não foi possível carregar{" "}
          {[
            accountsResult.error !== null ? "contas" : null,
            membershipResult.error !== null ? "organização" : null,
            savedFiltersResult.error !== null ? "filtros salvos" : null,
          ]
            .filter((item): item is string => item !== null)
            .join(", ")}
          .
        </p>
      )}

      {invalidCustom && (
        <p role="alert" style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-danger)" }}>
          Período personalizado inválido — mostrando os últimos {DEFAULT_DAYS} dias.
        </p>
      )}

      {error !== null && (
        <p role="alert" style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-danger)" }}>
          Não foi possível carregar as métricas: {error.message}
        </p>
      )}

      {error === null && neverComputed && (
        <p style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-text-soft)" }}>
          Nenhuma métrica calculada para este período ainda. As contas conectadas ainda estão trazendo o
          histórico (backfill) — o recálculo só materializa dias tocados pela reconciliação.
        </p>
      )}

      {error === null && summary !== null && !neverComputed && (
        <KpiStrip ancora cells={toCells(buildCards(summary, previousSummary), previousHasData)} />
      )}

      {error === null && dailySeries.length > 0 && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel
            title="Desempenho no período"
            subtitle={
              <>
                {formatBusinessDate(range.from)} a {formatBusinessDate(range.to)}
                {previousDailySeries.length > 0 ? " · comparação com o período anterior" : ""}
                {dailySeries.length < businessDateRangeLength(range.from, range.to)
                  ? ` · só ${String(dailySeries.length)} ${dailySeries.length === 1 ? "dia tem" : "dias têm"} métrica calculada`
                  : ""}
              </>
            }
          >
            <div className="sb-segmented" role="group" aria-label="Métrica do gráfico">
              {SALES_METRICS.map((option) => (
                <Link
                  key={option.key}
                  href={buildHref({ period, accountSlug, metricKey: metric.key, brand }, { metricKey: option.key })}
                  aria-current={option.key === metric.key ? "true" : undefined}
                >
                  {option.label}
                </Link>
              ))}
            </div>

            <div style={{ padding: "var(--sb-space-2) var(--sb-space-3) var(--sb-space-3)" }}>
              <SalesChart
                points={dailySeries}
                previousPoints={previousDailySeries}
                metric={metric}
                rangeFrom={range.from}
                rangeTo={range.to}
                previousRangeFrom={previousRange.from}
                previousRangeTo={previousRange.to}
              />
            </div>
          </Panel>
        </div>
      )}

      {/*
        Visão "hoje" (D-158, METRICS 5C.4): lê `orders` ao vivo e SINALIZA a
        incompletude — nunca finge que o dia fechou. Independente do período
        selecionado; respeita o filtro de conta. Zeros aqui são reais (o
        webhook traz pedidos em segundos), diferente de "nunca calculado".
      */}
      {error === null && todaySummary !== null && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel
            title="Hoje — dia em andamento"
            subtitle={
              <>
                Números parciais por construção: o dia só fecha à meia-noite (São Paulo) e não é comparável com
                períodos encerrados.{" "}
                {todaySummary.last_order_at === null
                  ? "Nenhuma venda registrada até agora."
                  : `Última venda registrada às ${formatDateTime(todaySummary.last_order_at)}.`}
              </>
            }
          >
            <KpiStrip cells={toCells(buildTodayCards(todaySummary), false)} />
          </Panel>
        </div>
      )}

      {/*
        Seção 5C (D-157) — NÃO condicionada a neverComputed: cancelamento vem
        de `orders` direto (L1) e existe mesmo quando o recálculo L3 ainda não
        tocou a janela. A nota declara a fonte, porque os números podem
        divergir ligeiramente dos números L3 acima (atraso do recálculo).
      */}
      {error === null && expanded !== null && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel
            title="Cancelamentos e taxas"
            subtitle="Calculado dos pedidos diretamente (visão operacional) — pode divergir minimamente dos números acima, que vêm do recálculo diário. Não é receita líquida: frete, taxa fixa, parcelamento e impostos não são observados."
          >
            <KpiStrip cells={toCells(buildExpandedCards(expanded, previousExpanded), previousExpanded !== null)} />
          </Panel>
        </div>
      )}

      {/*
        Margem operacional (D-166, 5C.1/5C.2): SÓ sobre pedidos cobertos,
        cobertura declarada, e o veto — não é receita líquida. Com zero
        cobertura, a seção RECUSA em vez de fingir número.
      */}
      {error === null && margin !== null && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel
            title="Margem operacional — estimativa por pedido"
            subtitle={
              margin.orders_covered === null || margin.orders_covered === 0
                ? undefined
                : `Calculada sobre ${formatCount(margin.orders_covered)} de ${formatCount(margin.orders_total ?? 0)} pedidos válidos do período (${formatPercent(margin.orders_covered / Math.max(margin.orders_total ?? 1, 1))}) — os que têm frete e desconto observados. Não é receita líquida: taxa fixa por pedido, parcelamento, custo de cobrança do Mercado Pago, impostos retidos e reembolsos posteriores não são observados.`
            }
          >
            {margin.orders_covered === null ? (
              <p style={MARGIN_NOTE_STYLE}>
                <strong>Não há margem por marca.</strong> Frete e desconto do vendedor são do PEDIDO — um pedido
                tem um frete, não um frete por item —, então não existe cota de marca para descontar. Mostrar a
                receita da marca menos o custo da operação inteira seria número errado com cara de preciso. Tire
                o recorte de marca para ver a margem.
              </p>
            ) : margin.orders_covered === 0 ? (
              <p style={MARGIN_NOTE_STYLE}>
                Nenhum dos {formatCount(margin.orders_total ?? 0)} pedidos válidos do período tem frete e
                desconto capturados ainda — a captura diária de custos começou em 31/08/2026 e a margem só é
                exibida sobre pedidos cobertos, nunca estimada por cima.
              </p>
            ) : (
              <KpiStrip
                cells={toCells(
                  buildMarginCards(margin, previousMargin),
                  previousMargin !== null && (previousMargin.orders_covered ?? 0) > 0,
                )}
              />
            )}
          </Panel>
        </div>
      )}
    </Shell>
  );
}
