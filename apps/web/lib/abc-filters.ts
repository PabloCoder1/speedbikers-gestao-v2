/**
 * Filtros da Curva ABC (D-140, D-424), puros e testáveis sem React nem banco.
 *
 * A mecânica compartilhada (href, página, janela) vive em `./filters` desde
 * D-141; aqui fica o vocabulário próprio: critério, período, recortes e os
 * filtros que valem DEPOIS da curva.
 *
 * Dois tipos de filtro, e a diferença é a curva inteira (D-424):
 * - **recortes** (marketplace, conta, marca, categoria, tipo): a curva é RECALCULADA dentro
 *   deles -- as participações somam 100% do recorte;
 * - **filtros** (classe, Full, estoque, movimento, busca): a curva é a do
 *   recorte, e o filtro só esconde linhas -- a classe de cada SKU não muda.
 */

import { shiftBusinessDate, toSalesMetricDate } from "@sb/domain";

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";
import { resolverEscopoVendas, type EscopoVendas } from "./vendas-multicanal";

/**
 * Cinquenta linhas mantêm a leitura analítica sem mandar uma tabela longa no
 * HTML de cada navegação. O total e as classes continuam vindo da janela SQL
 * sobre o recorte inteiro; só a fatia visual fica menor.
 */
export const PAGE_SIZE = 50;

export const ABC_CLASSES = ["A", "B", "C"] as const;
export type AbcClass = (typeof ABC_CLASSES)[number];

export const ABC_CRITERIA = [
  { key: "faturamento", label: "Faturamento", definitionId: "receita_bruta", format: "currency" },
  { key: "unidades", label: "Unidades", definitionId: "unidades_vendidas", format: "count" },
  { key: "pedidos", label: "Pedidos", definitionId: "pedidos", format: "count" },
  // D-448: a compra do cliente -- o pack do ML e, com a Shopee no recorte, o
  // pedido dela (C-60). É o critério que soma entre marketplaces.
  { key: "compras", label: "Compras", definitionId: "multicanal_compras", format: "count" },
] as const;

export type AbcCriterion = (typeof ABC_CRITERIA)[number];

/**
 * Os critérios que valem no recorte (D-448). "Pedidos" é do Mercado Livre: o
 * pedido do ML é uma linha de item e o da Shopee é o carrinho, e a função
 * RECUSA "pedidos" com a Shopee no recorte (C-60) -- lá o comparável é a compra.
 */
export function criteriosDoEscopo(escopo: EscopoVendas): readonly AbcCriterion[] {
  return escopo === "ml" ? ABC_CRITERIA : ABC_CRITERIA.filter((criterio) => criterio.key !== "pedidos");
}

/**
 * Presets do período. 90 continua o padrão: classificação ABC precisa de sinal
 * estável. 180 e 365 existem desde que o histórico ganhou o SKU (D-423) --
 * antes, a venda antiga sem SKU deixava a curva longa mentir.
 */
export const ABC_PERIODS = [7, 15, 30, 60, 90, 180, 365] as const;

export const DEFAULT_PERIOD = 90;

/** O teto do período personalizado: dois anos. Mais que isso é varredura que a tela não anuncia. */
export const MAX_CUSTOM_DAYS = 731;

export const ABC_KINDS = [
  { key: "produto", value: "PRODUTO", label: "Produtos" },
  { key: "kit", value: "KIT", label: "Kits" },
] as const;

export type AbcKind = (typeof ABC_KINDS)[number];

export const ABC_STOCK_STATES = [
  { key: "sem_local", label: "Sem estoque local" },
  { key: "sem_estoque", label: "Sem estoque nenhum" },
  { key: "com_estoque", label: "Com estoque" },
] as const;

export type AbcStockState = (typeof ABC_STOCK_STATES)[number];

/** O movimento de classe contra o período anterior de mesmo tamanho. */
export const ABC_MOVEMENTS = [
  { key: "subiu", label: "Subiu de classe" },
  { key: "caiu", label: "Caiu de classe" },
  { key: "manteve", label: "Manteve a classe" },
  { key: "novo", label: "Novo (sem venda antes)" },
] as const;

export type AbcMovement = (typeof ABC_MOVEMENTS)[number];

export const ABC_ORDERS = [
  { key: "curva", label: "Posição na curva" },
  { key: "faturamento", label: "Maior faturamento" },
  { key: "unidades", label: "Mais unidades" },
  { key: "pedidos", label: "Mais pedidos" },
  { key: "compras", label: "Mais compras" },
  { key: "crescimento", label: "Maior crescimento" },
  { key: "queda", label: "Maior queda" },
  { key: "estoque", label: "Mais estoque" },
  { key: "cobertura", label: "Menor cobertura" },
  { key: "nome", label: "Nome (A–Z)" },
] as const;

export type AbcOrder = (typeof ABC_ORDERS)[number];

/**
 * As ordens que valem no recorte (D-448). Com a Shopee, o pedido do ML não
 * soma (vem nulo) e a cobertura também (o estoque da Shopee é a fatia 5): ordenar
 * por elas seria ordenar por nada.
 */
export function ordensDoEscopo(escopo: EscopoVendas): readonly AbcOrder[] {
  return escopo === "ml" ? ABC_ORDERS : ABC_ORDERS.filter((ordem) => ordem.key !== "pedidos" && ordem.key !== "cobertura");
}

/** A busca vai ao banco como texto puro (`strpos`); o teto evita URL de um parágrafo. */
const MAX_SEARCH = 80;

export interface AbcCustomRange {
  from: string;
  to: string;
}

export interface AbcFilters {
  /** O recorte de marketplace (`marketplace=todos|shopee`, D-448); `ml` é a curva de sempre. */
  escopo: EscopoVendas;
  /** Só no recorte ML: a conta pelo slug (`conta=`), como sempre. */
  accountSlug: string | null;
  /**
   * Fora do ML: as contas e lojas da URL (`contas=a,b`, ids de
   * `marketplace_accounts`), num valor só, como em `/vendas`. A página confere
   * contra as que a pessoa alcança e descarta as demais.
   */
  contas: readonly string[] | null;
  /**
   * `skus.supplier_brand`, NUNCA `skus.brand` (D-129/D-235): a segunda guarda
   * a categoria do UpSeller e diverge da marca real em 2.320 dos 3.554 SKUs.
   */
  brand: string | null;
  /** `skus.brand` -- a coluna "Categorias" do UpSeller (D-129). */
  category: string | null;
  kind: AbcKind | null;
  criterion: AbcCriterion;
  days: number;
  /** Período personalizado; quando existe, vence `days`. */
  custom: AbcCustomRange | null;
  /** A URL pediu um período personalizado que não vale (formato, ordem, futuro ou longo demais). */
  invalidCustom: boolean;
  onlyWithoutFull: boolean;
  abcClass: AbcClass | null;
  stock: AbcStockState | null;
  movement: AbcMovement | null;
  search: string | null;
  order: AbcOrder;
  page: number;
}

/** Mesma leitura de `stock-filters`: vazio e só-espaço viram nulo. */
function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function porChave<T extends { key: string }>(lista: readonly T[], raw: unknown): T | null {
  return typeof raw === "string" ? (lista.find((item) => item.key === raw) ?? null) : null;
}

export function resolveAbcCriterion(raw: unknown, escopo: EscopoVendas = "ml"): AbcCriterion {
  const criterio = porChave(ABC_CRITERIA, raw) ?? ABC_CRITERIA[0];

  return escopo === "ml" ? criterio : paraOMulticanal(criterio);
}

/** "Pedidos" fora do ML vira "Compras": é o que a própria função manda usar (C-60). */
function paraOMulticanal(criterio: AbcCriterion): AbcCriterion {
  return criterio.key === "pedidos" ? (ABC_CRITERIA.find((c) => c.key === "compras") ?? ABC_CRITERIA[0]) : criterio;
}

function ordemNoEscopo(ordem: AbcOrder, escopo: EscopoVendas): AbcOrder {
  if (escopo === "ml") return ordem;
  if (ordem.key === "pedidos") return ABC_ORDERS.find((o) => o.key === "compras") ?? ABC_ORDERS[0];
  if (ordem.key === "cobertura") return ABC_ORDERS[0];

  return ordem;
}

function lerContas(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;

  const ids = [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id !== ""))];

  return ids.length === 0 ? null : ids;
}

/**
 * Período fora da lista cai no default. Aceitar um número arbitrário deixaria
 * a tela anunciar "últimos 4.000 dias" com uma curva que não tem esse dado.
 */
export function resolveAbcPeriod(raw: unknown): number {
  if (typeof raw !== "string") return DEFAULT_PERIOD;

  const parsed = Number.parseInt(raw, 10);

  return (ABC_PERIODS as readonly number[]).includes(parsed) ? parsed : DEFAULT_PERIOD;
}

export function resolveAbcClass(raw: unknown): AbcClass | null {
  return typeof raw === "string" && (ABC_CLASSES as readonly string[]).includes(raw) ? (raw as AbcClass) : null;
}

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Dias de `from` a `to`, os dois incluídos (datas ISO de negócio). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * O período personalizado da URL (`de`, `ate`). Os dois ou nenhum; formato ISO,
 * início antes do fim, fim até hoje e no máximo dois anos. O que não passa
 * vira `invalid` -- a tela avisa e mostra o padrão, em vez de cair com 500.
 */
export function resolveAbcCustomRange(
  query: Readonly<Record<string, string | string[] | undefined>>,
  today: string,
): { custom: AbcCustomRange | null; invalid: boolean } {
  const de = typeof query.de === "string" ? query.de : null;
  const ate = typeof query.ate === "string" ? query.ate : null;

  if (de === null && ate === null) return { custom: null, invalid: false };

  if (
    de === null ||
    ate === null ||
    !DATA_ISO.test(de) ||
    !DATA_ISO.test(ate) ||
    Number.isNaN(Date.parse(`${de}T00:00:00Z`)) ||
    Number.isNaN(Date.parse(`${ate}T00:00:00Z`)) ||
    de > ate ||
    ate > today ||
    daysBetween(de, ate) > MAX_CUSTOM_DAYS
  ) {
    return { custom: null, invalid: true };
  }

  return { custom: { from: de, to: ate }, invalid: false };
}

export function resolveAbcFilters(
  query: Record<string, string | string[] | undefined>,
  today: string = toSalesMetricDate(new Date()),
): AbcFilters {
  const { custom, invalid } = resolveAbcCustomRange(query, today);
  const search = readParam(query.busca);
  // Valor desconhecido cai na curva de sempre, em silêncio -- como em /vendas.
  const escopo = resolverEscopoVendas(query.marketplace);

  return {
    escopo,
    // A conta pelo slug é do ML; fora dele, as contas vêm por id em `contas`.
    accountSlug: escopo === "ml" && typeof query.conta === "string" && query.conta !== "" ? query.conta : null,
    contas: escopo === "ml" ? null : lerContas(query.contas),
    // Marca desconhecida NÃO cai num default: ela vai ao banco e a curva volta
    // vazia, que é a resposta certa para "não há SKU dessa marca" — diferente
    // do critério e do período, onde o default é o comportamento correto.
    brand: readParam(query.marca),
    // Mesma regra da marca.
    category: readParam(query.categoria),
    kind: porChave(ABC_KINDS, query.tipo),
    criterion: resolveAbcCriterion(query.criterio, escopo),
    days: resolveAbcPeriod(query.dias),
    custom,
    invalidCustom: invalid,
    // `semFull=1` liga; qualquer outra coisa desliga. A URL antiga usava a
    // mera presença do parâmetro, o que fazia `?semFull=0` LIGAR o filtro.
    // Na Shopee não há Full: a função recusa o filtro sem o ML no recorte (C-60).
    onlyWithoutFull: escopo !== "shopee" && query.semFull === "1",
    abcClass: resolveAbcClass(query.classe),
    stock: porChave(ABC_STOCK_STATES, query.estoque),
    movement: porChave(ABC_MOVEMENTS, query.movimento),
    search: search === null ? null : search.slice(0, MAX_SEARCH),
    order: ordemNoEscopo(porChave(ABC_ORDERS, query.ordem) ?? ABC_ORDERS[0], escopo),
    page: resolvePageParam(query.pagina),
  };
}

export function buildAbcHref(current: AbcFilters, override: Partial<AbcFilters>): string {
  // Escolher um preset descarta o período personalizado: os dois juntos na URL
  // deixariam o botão dizendo um e a curva mostrando o outro.
  const merged = { ...current, ...(override.days !== undefined ? { custom: null } : {}), ...override };
  const next = override.escopo === undefined || override.escopo === current.escopo ? merged : trocarEscopo(merged);

  return buildFilterHref(
    "/curva-abc",
    {
      marketplace: next.escopo === "ml" ? null : next.escopo,
      conta: next.escopo === "ml" ? next.accountSlug : null,
      contas: next.escopo === "ml" || next.contas === null || next.contas.length === 0 ? null : next.contas.join(","),
      marca: next.brand,
      categoria: next.category,
      tipo: next.kind?.key ?? null,
      // Defaults ficam FORA da URL: `/curva-abc` limpo continua sendo a mesma
      // página de sempre, e o link compartilhado só carrega o que foi escolhido.
      criterio: next.criterion.key === ABC_CRITERIA[0].key ? null : next.criterion.key,
      dias: next.custom !== null || next.days === DEFAULT_PERIOD ? null : String(next.days),
      de: next.custom?.from ?? null,
      ate: next.custom?.to ?? null,
      semFull: next.onlyWithoutFull ? "1" : null,
      classe: next.abcClass,
      estoque: next.stock?.key ?? null,
      movimento: next.movement?.key ?? null,
      busca: next.search,
      ordem: next.order.key === ABC_ORDERS[0].key ? null : next.order.key,
    },
    override.page === undefined ? 1 : next.page,
  );
}

/**
 * Trocar de marketplace (D-448) leva o período, a marca, a categoria, o tipo e
 * os filtros de linha; a conta não atravessa (a do ML é slug, a de fora é id),
 * e o que não existe do outro lado volta ao equivalente: "Pedidos" vira
 * "Compras", a ordem por cobertura volta à curva, e "sem Full" sai na Shopee.
 */
function trocarEscopo(f: AbcFilters): AbcFilters {
  return {
    ...f,
    accountSlug: null,
    contas: null,
    criterion: f.escopo === "ml" ? f.criterion : paraOMulticanal(f.criterion),
    order: ordemNoEscopo(f.order, f.escopo),
    onlyWithoutFull: f.escopo === "shopee" ? false : f.onlyWithoutFull,
  };
}

/** Quantos filtros/recortes fora do padrão estão ligados -- o botão "Limpar filtros". */
export function countActiveAbcFilters(filters: AbcFilters): number {
  return [
    filters.escopo !== "ml",
    filters.accountSlug !== null,
    filters.contas !== null,
    filters.brand !== null,
    filters.category !== null,
    filters.kind !== null,
    filters.criterion.key !== ABC_CRITERIA[0].key,
    filters.custom !== null || filters.days !== DEFAULT_PERIOD,
    filters.onlyWithoutFull,
    filters.abcClass !== null,
    filters.stock !== null,
    filters.movement !== null,
    filters.search !== null,
    filters.order.key !== ABC_ORDERS[0].key,
  ].filter(Boolean).length;
}

export interface AbcWindow {
  from: string;
  to: string;
  /** O período anterior de MESMO tamanho, logo antes de `from`: a base do movimento de classe. */
  prevFrom: string;
  prevTo: string;
  dayCount: number;
}

/** A janela que a RPC recebe, e a de comparação. `today` é o dia de negócio (D-050). */
export function resolveAbcWindow(filters: AbcFilters, today: string): AbcWindow {
  const from = filters.custom?.from ?? shiftBusinessDate(today, -(filters.days - 1));
  const to = filters.custom?.to ?? today;
  const dayCount = daysBetween(from, to);
  const prevTo = shiftBusinessDate(from, -1);

  return { from, to, prevFrom: shiftBusinessDate(prevTo, -(dayCount - 1)), prevTo, dayCount };
}

export interface AbcSummary {
  label: string;
  totalPages: number;
}

/**
 * A frase que impede o defeito de D-140 de voltar: a tela somava as classes em
 * JavaScript sobre um resultado truncado em 1.000 de 1.492 e exibia classe C =
 * 298 quando o real era 790. As contagens agora vêm do Postgres, e esta frase
 * sempre diz quantos SKUs estão fora da página.
 */
export function summarizeAbcWindow(page: number, totalCount: number, rowsOnPage: number): AbcSummary {
  return summarizePagedWindow({
    page,
    totalCount,
    rowsOnPage,
    pageSize: PAGE_SIZE,
    noun: { singular: "SKU na curva", plural: "SKUs na curva" },
    emptyLabel: "Nenhum SKU com venda no período e escopo escolhidos.",
  });
}
