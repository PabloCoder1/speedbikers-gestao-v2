/**
 * Vocabulário de `/anuncios/shopee` (D-428, fatia 4a da trilha Shopee; o
 * vínculo manual, D-429, mora em `./shopee-link`).
 *
 * A MECÂNICA (href, página, janela) vem de `./filters`; aqui vive só o que é
 * desta tela: os quatro estados do vínculo (manual, que vence, ou pelo SKU do
 * anúncio), o estado do item na Shopee e o preço na moeda da própria linha.
 * Toda contagem e todo filtro moram nas RPCs `get_shopee_listings` e
 * `get_shopee_listings_summary` — nada aqui soma linha.
 */

import { SHOPEE_IMAGE_HOSTS } from "./csp";
import { buildFilterHref, resolvePageParam, summarizePagedWindow, type PagedWindow } from "./filters";
import { formatCount } from "./format";
import { DEFAULT_PERIOD_DAYS, resolvePeriodRange, type PeriodRange } from "./period";
import type { Tom } from "../components/tone";

export const SHOPEE_LISTINGS_PATH = "/anuncios/shopee";

/** 50 por página, fixo — a RPC aceita até 200. */
export const SHOPEE_PAGE_SIZE = 50;

/**
 * Os quatro estados de `shopee_listing_units.estado`, na ordem da faixa.
 * Conjunto FECHADO, espelho do `case` da view: um valor desconhecido na URL cai
 * para "sem filtro" antes de tocar o banco, em vez de virar uma lista vazia
 * indistinguível de um filtro legítimo sem resultado.
 */
export const SHOPEE_LINK_STATES = [
  {
    slug: "vinculado",
    codigo: "VINCULADO",
    // D-429: conta o vínculo MANUAL e o pelo SKU do anúncio — a view já
    // contava os dois; o rótulo deixou de dizer "pelo SKU".
    rotulo: "Vinculados",
    explicacao: "manual ou pelo SKU do anúncio",
    criterio:
      "Tem vínculo manual (gravado aqui, e ele vence) ou, sem ele, o SKU do anúncio (o da variação; o do item sem variação), em maiúsculas e sem espaços nas pontas, é um SKU do catálogo.",
    tom: "ok",
  },
  {
    slug: "sem-sku",
    codigo: "SEM_SKU_NO_ANUNCIO",
    rotulo: "Sem SKU no anúncio",
    explicacao: "o anúncio não tem SKU do vendedor",
    criterio: "O anúncio foi lido e não tem SKU do vendedor: não há o que comparar com o catálogo.",
    tom: "atencao",
  },
  {
    slug: "fora-do-catalogo",
    codigo: "SKU_FORA_DO_CATALOGO",
    rotulo: "SKU fora do catálogo",
    explicacao: "o SKU do anúncio não existe no catálogo",
    criterio: "O anúncio tem SKU do vendedor, mas nenhum SKU do catálogo tem esse código.",
    tom: "atencao",
  },
  {
    slug: "aguardando-leitura",
    codigo: "AGUARDANDO_LEITURA",
    rotulo: "Aguardando leitura",
    explicacao: "o detalhe ainda não foi lido",
    criterio:
      "O item está na lista da loja, mas o detalhe (nome, SKU, variações, preço) ainda não foi lido — ou a última leitura não serviu, e o worker tenta de novo em até 1 dia.",
    tom: "neutro",
  },
] as const satisfies readonly {
  slug: string;
  codigo: string;
  rotulo: string;
  explicacao: string;
  criterio: string;
  tom: Tom;
}[];

export type ShopeeLinkState = (typeof SHOPEE_LINK_STATES)[number];
export type ShopeeLinkStateSlug = ShopeeLinkState["slug"];

/**
 * A explicação de uma linha "aguardando leitura" (D-428): nunca lida, lida sem
 * as variações, ou lida sem servir (`details_error`, de novo em até 1 dia).
 * O estado nunca é final — a fila do worker sempre volta a esses itens.
 */
export function explicacaoDoAguardando(detailsError: string | null, detailsSyncedAt: string | null): string {
  if (detailsError !== null) return "a Shopee não devolveu o detalhe na última leitura; nova tentativa em até 1 dia";

  if (detailsSyncedAt !== null) return "as variações ainda não foram lidas";

  return "o detalhe ainda não foi lido";
}

/** O estado pelo código do banco; `null` para um código que a tela não conhece. */
export function shopeeLinkState(codigo: string): ShopeeLinkState | null {
  return SHOPEE_LINK_STATES.find((estado) => estado.codigo === codigo) ?? null;
}

/** D-606: com ou sem venda VÁLIDA no período (o `p_vendeu` do C-67), nas palavras de `/anuncios`. */
export const SHOPEE_SOLD_FILTERS = [
  { slug: null, rotulo: "Com ou sem venda" },
  { slug: "com", rotulo: "Vendeu no período" },
  { slug: "sem", rotulo: "Sem venda no período" },
] as const;

export type ShopeeVendeu = "com" | "sem";

/** D-606: a ordem por venda (o `p_ordem` do C-67); nula = a ordem de sempre da lista. */
export type ShopeeOrdem = "vendas" | "receita";

export interface ShopeeListingsFilters {
  /** `shopee_shops.id` — só um id de loja da organização sobrevive. */
  readonly loja: string | null;
  readonly estado: ShopeeLinkStateSlug | null;
  readonly busca: string | null;
  readonly pagina: number;
  /**
   * D-606: o período das vendas por anúncio, o MESMO de `/anuncios` e
   * `/vendas` (`lib/period.ts`): `days` nulo = personalizado. Só as colunas de
   * venda dependem dele; o catálogo e o vínculo não.
   */
  readonly range: PeriodRange;
  readonly days: number | null;
  /** O personalizado pedido era inválido e caiu no padrão: a tela avisa. */
  readonly periodoInvalido: boolean;
  readonly vendeu: ShopeeVendeu | null;
  readonly ordem: ShopeeOrdem | null;
}

function primeiro(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

/** A busca chega ao SQL num `ilike`; um texto sem fim pela URL não ajuda ninguém. */
const BUSCA_MAX = 100;

/**
 * `p_offset` é `integer` no banco: uma página digitada na URL que o estoure
 * viraria erro de "fora do intervalo", com um "Tentar de novo" que repetiria o
 * mesmo erro. Presa aqui, ela só passa do fim — e a tela diz isso.
 */
const PAGINA_MAX = Math.floor(2_147_483_647 / SHOPEE_PAGE_SIZE);

export function resolveShopeeListingsFilters(
  query: Record<string, string | string[] | undefined>,
  lojasDaOrganizacao: readonly string[],
  /** O dia de negócio de hoje (`toSalesMetricDate`), para o período. */
  hoje: string,
): ShopeeListingsFilters {
  const loja = primeiro(query.loja);
  const estado = primeiro(query.estado);
  const busca = primeiro(query.q)?.trim().slice(0, BUSCA_MAX) ?? "";
  const vendeu = primeiro(query.vendeu);
  const ordem = primeiro(query.ordem);
  const { range, days, invalidCustom } = resolvePeriodRange(query, hoje);

  return {
    loja: loja !== undefined && lojasDaOrganizacao.includes(loja) ? loja : null,
    estado: SHOPEE_LINK_STATES.find((e) => e.slug === estado)?.slug ?? null,
    busca: busca === "" ? null : busca,
    pagina: Math.min(resolvePageParam(primeiro(query.pagina)), PAGINA_MAX),
    range,
    days,
    periodoInvalido: invalidCustom,
    vendeu: vendeu === "com" || vendeu === "sem" ? vendeu : null,
    ordem: ordem === "vendas" || ordem === "receita" ? ordem : null,
  };
}

/**
 * A URL da tela com um recorte trocado. Trocar qualquer filtro volta à página
 * 1 — manter o offset ao mudar o CONJUNTO mostraria uma página vazia que se lê
 * como "nenhum resultado"; só a paginação passa `pagina`.
 */
export function buildShopeeListingsHref(
  filters: ShopeeListingsFilters,
  override: Partial<ShopeeListingsFilters> = {},
): string {
  const next = { ...filters, ...override };
  // O período padrão fica fora da URL, como em `/anuncios`; o personalizado leva as duas datas.
  const periodo =
    next.days === null
      ? { from: next.range.from, to: next.range.to }
      : { days: next.days === DEFAULT_PERIOD_DAYS ? null : String(next.days) };

  return buildFilterHref(
    SHOPEE_LISTINGS_PATH,
    { loja: next.loja, estado: next.estado, q: next.busca, ...periodo, vendeu: next.vendeu, ordem: next.ordem },
    override.pagina === undefined ? 1 : next.pagina,
  );
}

/**
 * D-606: os argumentos das vendas por anúncio no `get_shopee_listings` (C-67,
 * D-493). O período vai sempre -- sem ele as colunas de venda vêm nulas --, e o
 * filtro e a ordem só com valor: parâmetro nulo mandado antes da migration de
 * produção derruba a tela (PGRST202).
 */
export function argumentosDeVendasShopee(filters: ShopeeListingsFilters): {
  p_date_from: string;
  p_date_to: string;
  p_vendeu?: ShopeeVendeu;
  p_ordem?: ShopeeOrdem;
} {
  return {
    p_date_from: filters.range.from,
    p_date_to: filters.range.to,
    ...(filters.vendeu === null ? {} : { p_vendeu: filters.vendeu }),
    ...(filters.ordem === null ? {} : { p_ordem: filters.ordem }),
  };
}

/**
 * D-606: o próximo estado do cabeçalho de venda que ordena. O C-67 só ordena
 * do maior para o menor; clicar na coluna já ativa volta à ordem de sempre
 * (pelo nome do anúncio).
 */
export function proximaOrdemShopee(atual: ShopeeOrdem | null, coluna: ShopeeOrdem): ShopeeOrdem | null {
  return atual === coluna ? null : coluna;
}

/**
 * D-606: o recorte inteiro das vendas (todas as linhas do filtro, antes do
 * limite), que o C-67 repete em toda linha. Somado no SQL, nunca aqui.
 */
export interface RecorteDeVendasShopee {
  readonly unidades: number;
  /** Nula quando nenhuma linha do recorte tem receita conhecida. */
  readonly receita: number | null;
  /** Unidades de preço 0 (bundle): receita desconhecida, fora da soma. */
  readonly semReceita: number;
}

export function recorteDeVendasShopee(
  primeira:
    | {
        readonly recorte_unidades?: number | null;
        readonly recorte_receita?: number | null;
        readonly recorte_unidades_sem_receita?: number | null;
      }
    | undefined,
): RecorteDeVendasShopee | null {
  // Sem a coluna (banco anterior ao C-67) ou com toda loja do recorte nunca
  // lida, não há o que resumir -- e o resumo não vira zero (D-067).
  const unidades = primeira?.recorte_unidades;

  if (unidades === undefined || unidades === null) return null;

  return {
    unidades,
    receita: primeira?.recorte_receita ?? null,
    semReceita: primeira?.recorte_unidades_sem_receita ?? 0,
  };
}

/**
 * O "ver lista" de uma célula da faixa. A faixa conta no ESCOPO da loja —
 * `get_shopee_listings_summary` não recebe a busca —, então o link larga a
 * busca junto com o estado anterior: com ela, a célula dizendo 12 abriria uma
 * lista de 3, e a promessa da célula ("clicar mostra estes") quebraria.
 */
export function buildShopeeKpiHref(filters: ShopeeListingsFilters, estado: ShopeeLinkStateSlug | null): string {
  return buildShopeeListingsHref(filters, { estado, busca: null });
}

export function summarizeShopeeWindow(pagina: number, totalCount: number, rowsOnPage: number): PagedWindow {
  return summarizePagedWindow({
    page: pagina,
    totalCount,
    rowsOnPage,
    pageSize: SHOPEE_PAGE_SIZE,
    noun: { singular: "anúncio", plural: "anúncios" },
    emptyLabel: "Nenhum anúncio no filtro atual.",
  });
}

/**
 * O estado do ITEM na Shopee (`item_status`). Apagados não chegam aqui — a view
 * os deixa de fora. Código desconhecido aparece cru, nunca como "Ativo".
 */
export function shopeeItemStatus(status: string): { rotulo: string; tom: Tom } {
  switch (status) {
    case "NORMAL":
      return { rotulo: "Ativo", tom: "ok" };
    case "UNLIST":
      return { rotulo: "Pausado", tom: "neutro" };
    case "BANNED":
      return { rotulo: "Banido", tom: "perigo" };
    case "REVIEWING":
      return { rotulo: "Em revisão", tom: "atencao" };
    default:
      return { rotulo: status, tom: "neutro" };
  }
}

/** A variação que a Shopee marca como indisponível (`model_status`). */
export function shopeeModelUnavailable(modelStatus: string | null): boolean {
  return modelStatus === "MODEL_UNAVAILABLE";
}

const MOEDAS = new Map<string, Intl.NumberFormat>();
const NUMERO = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Preço na moeda DA LINHA (a Shopee devolve `currency` por item e variação).
 * Ausente é "—", nunca zero. Moeda ausente ou que o `Intl` não conhece mostra
 * o número com o código ao lado — em vez de supor real.
 */
export function formatShopeeMoney(valor: number | null, moeda: string | null): string {
  if (valor === null) return "—";

  const codigo = moeda?.trim().toUpperCase() ?? "";

  if (codigo === "") return NUMERO.format(valor);

  let formato = MOEDAS.get(codigo);

  if (formato === undefined) {
    try {
      formato = new Intl.NumberFormat("pt-BR", { style: "currency", currency: codigo });
    } catch {
      return `${codigo} ${NUMERO.format(valor)}`;
    }

    MOEDAS.set(codigo, formato);
  }

  return formato.format(valor);
}

/**
 * A foto do anúncio, só quando o host é um dos que a CSP abre
 * (`SHOPEE_IMAGE_HOSTS`, dono único em `lib/csp.ts`). Qualquer outro cai no
 * monograma — uma imagem bloqueada pela CSP seria um quadrado vazio na linha.
 */
export function shopeeImageUrl(url: string | null): string | null {
  if (url === null) return null;

  let host: string;

  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "https:") return null;

    host = parsed.hostname.toLowerCase();
  } catch {
    return null;
  }

  const permitido = SHOPEE_IMAGE_HOSTS.some((padrao) =>
    padrao.startsWith("*.") ? host.endsWith(padrao.slice(1)) : host === padrao,
  );

  return permitido ? url : null;
}

/**
 * O tamanho do catálogo de uma loja, na coluna "Anúncios" de `/contas`
 * (D-429): "5 anúncios · 2 vinculados", com os números que
 * `get_shopee_shop_catalog_counts` contou no SQL. Catálogo NUNCA lido chega
 * nulo e vira `null` — a tela diz "—", nunca "0 anúncios", que afirmaria uma
 * loja vazia que ninguém olhou.
 */
export function resumoDoCatalogoShopee(anuncios: number | null, vinculados: number | null): string | null {
  if (anuncios === null || vinculados === null) return null;

  return `${formatCount(anuncios)} ${anuncios === 1 ? "anúncio" : "anúncios"} · ${formatCount(vinculados)} ${
    vinculados === 1 ? "vinculado" : "vinculados"
  }`;
}

/**
 * Tabela, coluna ou função que o banco ainda não tem: a migration chega por um
 * caminho (workflow com aprovação) e a web por outro (merge). Como em
 * `/contas`, a tela diz que a novidade ainda não chegou em vez de virar erro.
 */
export function isShopeeSchemaMissing(error: { code?: string } | null): boolean {
  return (
    error !== null &&
    (error.code === "PGRST205" ||
      error.code === "42P01" ||
      error.code === "PGRST202" ||
      error.code === "42883" ||
      error.code === "42703")
  );
}
