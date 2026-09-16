import type { FreshnessLevel } from "@sb/domain";
import { businessDateRangeLength, classifySyncFreshness, previousBusinessDateRange, toSalesMetricDate } from "@sb/domain";
import { Suspense, type ReactNode } from "react";

import { CarregandoBloco, CarregandoConteudo } from "../../components/carregando";
import type { SavedFilter } from "../../components/saved-filters";
import Link from "next/link";
import { SavedFilters } from "../../components/saved-filters";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime, formatPercent } from "../../lib/format";
import { DEFAULT_PERIOD_DAYS, PERIOD_PRESETS, resolvePeriodRange } from "../../lib/period";
import { createClient } from "../../lib/supabase/server";
import { DEFAULT_SALES_METRIC, SALES_METRICS, resolveSalesMetric } from "../../lib/sales-metric";
import { LegendaDoGrafico, mostraComparacao, SalesChart } from "./sales-chart";
import { FilterMenu } from "../../components/filter-menu";
import { currentMembership } from "../../lib/request-membership";

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

/*
  A LISTA VEIO PARA CÁ EM D-308 E SAIU EM D-311. Ela era a segunda cópia dos
  mesmos cinco presets; com a Home querendo a terceira, o vocabulário ganhou
  dono próprio (`lib/period.ts`). Os aliases locais ficam para não reescrever
  as sete referências desta tela — o valor é o mesmo objeto importado.
*/
const PRESET_DAYS = PERIOD_PRESETS;
const DEFAULT_DAYS = DEFAULT_PERIOD_DAYS;

/**
 * O SELO MEDE A CONFERÊNCIA, NÃO A MUDANÇA (D-304).
 *
 * Ele lia `last_computed_at`, que desde D-199 é o carimbo de quando a LINHA
 * NASCEU: uma linha de métrica só é reescrita quando algum número dela muda, e
 * o carimbo não acompanhava a reescrita. Resultado medido em produção — todo
 * dia, em todas as contas, a linha nascia ~00:0x e o selo virava "Cálculo
 * desatualizado" ao meio-dia seguinte, com o recálculo rodando de hora em hora
 * o tempo todo.
 *
 * Agora ele lê `last_refreshed_at`, que anda a cada passada do recálculo tenha
 * ela escrito ou não. É a diferença entre "este número mudou faz tempo" (o que
 * pode ser um dia tranquilo) e "ninguém confere este número faz tempo" (o que
 * é sempre defeito).
 */
const FRESHNESS_TONE: Record<FreshnessLevel, { color: string; label: string }> = {
  ok: { color: "var(--sb-secondary)", label: "Cálculo em dia" },
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
  /**
   * Quando o recálculo PASSOU por último — diferente de `last_computed_at`,
   * que é quando o número mudou (D-304). Numa madrugada sem venda os dois
   * divergem, e é o segundo que diz se o cálculo está vivo.
   */
  last_refreshed_at: string | null;
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
 * Os construtores (`buildCards` e `buildExpandedCards`) não mudaram uma linha: eles são verdade funcional —
 * fórmula canônica, id catalogado e ressalva de METRICS 5C.2. O que mudou é
 * para onde eles vão. Este adaptador é a fronteira entre as duas coisas.
 *
 * `showPrevious` continua sendo decisão de CADA bloco: a seção "hoje" não
 * compara (o dia não fechou), e a margem só compara quando o período anterior
 * teve pedido coberto.
 */
function toCells(cards: readonly MetricCardSpec[], showPrevious: boolean, indisponivel?: string): KpiCellData[] {
  return cards.map((card) => ({
    metricId: card.metricId,
    label: card.label,
    formula: card.formula,
    // Com `indisponivel` a COMPOSIÇÃO fica e o número vira "—": a faixa e o
    // gráfico são incondicionais no frame, e "nunca calculado" é um estado
    // declarado na célula, não uma tela diferente (D-023 continua valendo —
    // nada aqui vira zero).
    value: indisponivel === undefined ? card.format(card.current) : "—",
    previous: showPrevious && indisponivel === undefined ? (card.previous === null ? "sem dado" : card.format(card.previous)) : null,
    // `exactOptionalPropertyTypes`: a propriedade opcional não aceita
    // `undefined` explícito — ou ela existe, ou não está no objeto.
    ...(indisponivel !== undefined
      ? { ressalva: indisponivel }
      : card.ressalva === undefined
        ? {}
        : { ressalva: card.ressalva }),
  }));
}

/**
 * A faixa âncora (D-356): as cinco perguntas de VOLUME — quanto entrou, em
 * quantos pedidos e unidades, a quanto cada compra, e quanto voltou. O frame
 * punha "Taxas Mercado Livre" aqui; comissão, frete, custo e margem moram agora
 * em `/faturamento`, com a cascata inteira e a cobertura ao lado, e esta tela
 * deixou de repetir pedaços soltos deles.
 */
function pick(cards: readonly MetricCardSpec[], ids: readonly string[]): MetricCardSpec[] {
  return ids.flatMap((id) => {
    const card = cards.find((c) => c.metricId === id);

    return card === undefined ? [] : [card];
  });
}

const ANCORA_IDS = ["receita_bruta", "pedidos", "unidades_vendidas", "ticket_medio", "taxa_cancelamento"] as const;

/** Linha da tabela "Produtos que mais contribuíram" (D-244). */
interface TopSkuRow {
  sku_id: string;
  sku: string;
  title: string | null;
  supplier_brand: string | null;
  units_sold: number;
  gross_revenue: number;
  orders_count: number;
  purchases_count: number;
  average_selling_price: number | null;
  share: number | null;
}

/** A coluna do ranking segue a métrica do segmentado do gráfico. */
const ORDEM_POR_METRICA: Record<string, string> = {
  faturamento: "receita",
  unidades: "unidades",
  pedidos: "pedidos",
  packs: "compras",
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
 * Métricas 5C de vendas (D-157) — cancelamentos e taxas vêm de `orders`
 * direto (L1): não existem no rollup L3 por construção, e a taxa de
 * cancelamento usa os dois lados da MESMA leitura (misturar L1 com L3
 * embutiria o atraso do recálculo na razão — 0,1% medido). Por isso podem
 * divergir ligeiramente dos cards L3 acima, e a seção declara a fonte.
 */
function buildExpandedCards(current: ExpandedSummary, previous: ExpandedSummary | null): MetricCardSpec[] {
  return [
    {
      metricId: "taxa_cancelamento",
      label: "Taxa de cancelamento",
      formula: "cancelados ÷ elegíveis (válidos + cancelados)",
      format: formatPercent,
      current: current.taxa_cancelamento,
      previous: previous?.taxa_cancelamento ?? null,
      ressalva: "Denominador: pedidos elegíveis, os dois lados da mesma leitura de orders.",
    },
  ];
}

type Period = { days: number } | { from: string; to: string };

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

export default function VendasPage(props: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): ReactNode {
  return <Shell><Suspense fallback={<CarregandoConteudo rotulo="Carregando vendas" />}><VendasContent {...props} /></Suspense></Shell>;
}

async function VendasContent({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const now = new Date();
  const today = toSalesMetricDate(now);

  const { range, days, invalidCustom } = resolvePeriodRange(query, today);
  const previousRange = previousBusinessDateRange(range.from, range.to);
  const isCustom = days === null;
  const period: Period = isCustom ? range : { days };

  const [accountsResult, membershipResult, savedFiltersResult] = await Promise.all([
    supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true }),
    currentMembership(),
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

  const topPromise = Promise.resolve(supabase.rpc("get_sales_top_skus", {
      p_date_from: range.from,
      p_date_to: range.to,
      ...accountFilter,
      ...brandFilter,
      p_order_by: ORDEM_POR_METRICA[metric.key] ?? "receita",
      p_limit: 10,
    }));

  const [
    currentResult,
    previousResult,
    seriesResult,
    previousSeriesResult,
    expandedResult,
    previousExpandedResult,
    todayResult,
    brandsResult,
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
    // Décima primeira (D-244): os produtos que mais contribuíram — a tabela
    // que fecha o frame `Sales`. Mesmo recorte de conta e marca; a coluna do
    // ranking é a métrica do segmentado.

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
    null;

  const expanded: ExpandedSummary | null = expandedResult.data ?? null;
  const previousExpanded: ExpandedSummary | null = previousExpandedResult.data ?? null;
  const todaySummary: TodaySummary | null = todayResult.data ?? null;
  // Falha aqui NÃO derruba a tela: a tabela recusa sozinha, com o aviso, e o
  // resto continua — o ranking é leitura própria, não parte do resumo.


  const lastComputedAt = summary?.last_computed_at ?? null;
  /*
    O FRESCOR VEM DA PASSADA DO RECÁLCULO (D-304), não do carimbo da linha.
    `lastComputedAt` continua vivo logo abaixo, para a outra pergunta: se ele é
    nulo, a janela nunca foi calculada — e isso não é o mesmo que "calculada e
    deu zero".
  */
  const lastRefreshedAt = summary?.last_refreshed_at ?? null;
  const freshness = classifySyncFreshness(lastRefreshedAt === null ? null : new Date(lastRefreshedAt), now);
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
    <>
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
              <FilterMenu
                rotulo={contaLabel}
                opcoes={[
                  {
                    href: buildHref({ period, accountSlug, metricKey: metric.key, brand }, { accountSlug: null }),
                    ativo: selectedAccount === null,
                    label: "Todas as contas",
                  },
                  ...accounts.map((account) => ({
                    href: buildHref({ period, accountSlug, metricKey: metric.key, brand }, { accountSlug: account.slug }),
                    ativo: selectedAccount?.id === account.id,
                    label: account.label,
                  })),
                ]}
              />
            )}

            {/*
              "Sem marca" NÃO é ausência de filtro: é a venda que nenhuma marca
              alcança — item sem SKU vinculado, 23,2% da receita. Sem essa
              opção, somar as marcas não chegaria ao total e um quarto do
              faturamento sumiria sem explicação (D-237).
            */}
            <FilterMenu
              rotulo={marcaLabel}
              opcoes={[
                {
                  href: buildHref({ period, accountSlug, metricKey: metric.key, brand }, { brand: { kind: "todas" } }),
                  ativo: brand.kind === "todas",
                  label: "Todas as marcas",
                },
                {
                  href: buildHref({ period, accountSlug, metricKey: metric.key, brand }, { brand: { kind: "sem_marca" } }),
                  ativo: brand.kind === "sem_marca",
                  label: "Sem marca",
                },
                ...brands.map((nome) => ({
                  href: buildHref({ period, accountSlug, metricKey: metric.key, brand }, { brand: { kind: "marca", value: nome } }),
                  ativo: brand.kind === "marca" && brand.value === nome,
                  label: nome,
                })),
              ]}
            />

            <FilterMenu
              rotulo={periodoLabel}
              opcoes={PRESET_DAYS.map((preset) => ({
                href: buildHref({ period, accountSlug, metricKey: metric.key, brand }, { period: { days: preset } }),
                ativo: !isCustom && days === preset,
                label: `Últimos ${String(preset)} dias`,
              }))}
            >
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
                    className="sb-input"
                  />
                  <input
                    type="date"
                    name="to"
                    defaultValue={isCustom ? range.to : undefined}
                    aria-label="Data final"
                    className="sb-input"
                  />
                  <button type="submit" className="sb-button sb-button-primary" style={{ justifyContent: "center" }}>
                    Aplicar período
                  </button>
                </form>
            </FilterMenu>

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
                {/*
                  "conferido" e não "até": a data é a da última passada do
                  recálculo. "até" prometia cobertura de período, que é outra
                  coisa e nunca foi o que este número dizia.
                */}
                {lastRefreshedAt !== null && ` · conferido ${formatDateTime(lastRefreshedAt)}`}
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

      {/*
        A faixa âncora é INCONDICIONAL, como no frame. "Nunca calculado" não
        troca a tela: cada célula mostra "—" com a ressalva, e a composição
        continua a mesma que o operador vai reconhecer quando o recálculo
        alcançar a janela (D-023: nada aqui vira zero).
      */}
      {error === null && summary !== null && expanded !== null && (
        <KpiStrip
          ancora
          cells={toCells(
            pick([...buildCards(summary, previousSummary), ...buildExpandedCards(expanded, previousExpanded)], ANCORA_IDS),
            previousHasData,
            neverComputed ? "não calculado para este período — o recálculo só materializa dias tocados pela reconciliação" : undefined,
          )}
        />
      )}

      {/*
        HOJE, EM UMA LINHA (D-356). Era um painel com quatro células repetindo a
        faixa de cima; ficou o que responde "como está o dia": receita, pedidos,
        unidades e a hora da última venda — parciais por construção, e o selo
        diz isso. Ao lado, o atalho para o dinheiro de cada venda, que saiu
        desta tela.
      */}
      {error === null && (
        <div className="sb-hoje">
          {todaySummary === null ? (
            <span />
          ) : (
            <div
              className="sb-hoje-numeros"
              title="Números parciais: o dia só fecha à meia-noite (São Paulo) e não é comparável com períodos encerrados. Lidos ao vivo dos pedidos."
            >
              <span className="sb-hoje-rotulo">
                Hoje <span className="sb-hoje-parcial">parcial</span>
              </span>
              <span>
                <strong>{formatCurrency(todaySummary.gross_revenue)}</strong> receita
              </span>
              <span>
                <strong>{formatCount(todaySummary.orders_count)}</strong> pedidos
              </span>
              <span>
                <strong>{formatCount(todaySummary.units_sold)}</strong> unidades
              </span>
              <span>
                {todaySummary.last_order_at === null
                  ? "nenhuma venda até agora"
                  : `última venda ${formatDateTime(todaySummary.last_order_at)}`}
              </span>
            </div>
          )}

          <Link
            className="sb-hoje-atalho"
            href={buildHref({ period, accountSlug, metricKey: DEFAULT_SALES_METRIC.key, brand: { kind: "todas" } }, {}).replace(/^\/vendas/, "/faturamento")}
          >
            Comissão, frete, custo e margem em Faturamento →
          </Link>
        </div>
      )}

      {error === null && summary !== null && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel
            title="Desempenho no período"
            /*
              A LEGENDA NO CABEÇALHO, COMO NO FRAME (A18, D-327). Ela morava no
              rodapé do gráfico; agora é o `aside` do painel, e a condição é a
              mesma função que decide se há comparação para desenhar — inclusive
              sob a recusa de marca, onde não há gráfico nenhum.
            */
            aside={
              mostraComparacao(dailySeries, previousDailySeries, metric) ? (
                <LegendaDoGrafico previousRangeFrom={previousRange.from} previousRangeTo={previousRange.to} />
              ) : undefined
            }
            subtitle={
              <>
                {formatBusinessDate(range.from)} a {formatBusinessDate(range.to)}
                {mostraComparacao(dailySeries, previousDailySeries, metric) ? " · comparação com o período anterior" : ""}
                {dailySeries.length > 0 && dailySeries.length < businessDateRangeLength(range.from, range.to)
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

            {dailySeries.length === 0 ? (
              <p className="sb-empty">
                Nenhum dia com métrica calculada neste período — o recálculo só materializa dias tocados pela
                reconciliação, e não fabrica zero.
              </p>
            ) : (
              <div style={{ padding: "var(--sb-space-2) var(--sb-space-3) var(--sb-space-3)" }}>
                <SalesChart
                  points={dailySeries}
                  previousPoints={previousDailySeries}
                  metric={metric}
                  rangeFrom={range.from}
                  rangeTo={range.to}
                  previousRangeFrom={previousRange.from}
                />
              </div>
            )}
          </Panel>
        </div>
      )}

      {/*
        A tabela que fecha o frame `Sales` (D-244): os produtos que mais
        contribuíram, no MESMO recorte da faixa, ordenados pela métrica do
        segmentado. Itens vendidos sem vínculo de SKU ficam de fora — não há
        produto a nomear —, e o total deles continua na faixa acima.
      */}
      {error === null && summary !== null && (
        <Suspense fallback={<CarregandoBloco rotulo="ranking" />}>
          <SalesRanking result={topPromise} metricLabel={metric.label} contaLabel={contaLabel} marcaLabel={marcaLabel} />
        </Suspense>
      )}

    </>
  );
}


async function SalesRanking({ result, metricLabel, contaLabel, marcaLabel }: {
  result: Promise<{ data: TopSkuRow[] | null; error: { message: string } | null }>;
  metricLabel: string;
  contaLabel: string;
  marcaLabel: string;
}): Promise<ReactNode> {
  const topResult = await result;
  const topSkus = topResult.error === null ? topResult.data ?? [] : [];
  return (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
          <Panel
            title="Produtos que mais contribuíram"
            subtitle={`top ${String(topSkus.length === 0 ? 10 : topSkus.length)} por ${metricLabel.toLowerCase()} · ${contaLabel.toLowerCase()}, ${marcaLabel.toLowerCase()} · itens vendidos sem vínculo de SKU ficam de fora`}
            aside={
              <Link href="/curva-abc" style={{ color: "var(--sb-secondary)", textDecoration: "none", fontSize: "0.6875rem" }}>
                Curva ABC →
              </Link>
            }
          >
            {topResult.error !== null ? (
              <p role="alert" className="sb-empty" style={{ color: "var(--sb-danger)" }}>
                Não foi possível carregar o ranking: {topResult.error.message}
              </p>
            ) : topSkus.length === 0 ? (
              <p className="sb-empty">Nenhum SKU com venda calculada neste recorte.</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Produto</th>
                      <th>Marca</th>
                      <th className="sb-num">Unidades</th>
                      <th className="sb-num">Faturamento</th>
                      <th className="sb-num">Pedidos</th>
                      <th className="sb-num">Compras</th>
                      <th className="sb-num">Preço médio</th>
                      <th className="sb-num">Participação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {topSkus.map((linha) => (
                      <tr key={linha.sku_id}>
                        <td>
                          <Link className="sb-entity" href={`/skus/${linha.sku_id}`}>
                            {linha.title ?? linha.sku}
                          </Link>
                          <span style={{ display: "block", fontFamily: "var(--sb-mono)", fontSize: "0.625rem", color: "var(--sb-text-soft)" }}>
                            SKU {linha.sku}
                          </span>
                        </td>
                        <td style={{ color: "var(--sb-text-soft)" }}>{linha.supplier_brand ?? "—"}</td>
                        <td className="sb-num">{formatCount(linha.units_sold)}</td>
                        <td className="sb-num">{formatCurrency(linha.gross_revenue)}</td>
                        <td className="sb-num">{formatCount(linha.orders_count)}</td>
                        <td className="sb-num">{formatCount(linha.purchases_count)}</td>
                        <td className="sb-num">{formatCurrency(linha.average_selling_price)}</td>
                        <td className="sb-num">{formatPercent(linha.share)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
  );
}
