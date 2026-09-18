/**
 * Filtros da Central Full (D-173) — mesma divisão de D-167/D-172: a MECÂNICA
 * (href, página, resumo da janela) vem de `./filters`; aqui vive só o
 * vocabulário desta tela.
 *
 * `situacao` é conjunto FECHADO, espelho exato do `case` da RPC: valor
 * desconhecido na URL cai para "sem filtro" antes de tocar o banco.
 */

import { buildFilterHref, resolvePageParam, resolvePageSize, summarizePagedWindow, type PageSize } from "./filters";
import type { Tom } from "../components/tone";

export const PAGE_SIZE: PageSize = 50;

/**
 * Cobertura (D-380): dias que o saldo do Full dura no ritmo de venda da janela.
 * Abaixo de `LOW_COVERAGE_DAYS` o SKU "está acabando" — é o limiar que a RPC
 * recebe, e a tela escreve o mesmo número. Abaixo de `CRITICAL_COVERAGE_DAYS`
 * a barra fica vermelha. São limiares de LEITURA, não política de envio:
 * prazo de coleta e lote mínimo não estão no sistema.
 */
export const LOW_COVERAGE_DAYS = 15;
export const CRITICAL_COVERAGE_DAYS = 7;

/**
 * Focos (D-380): recortes que cruzam situação e cobertura, e por isso só o SQL
 * faz — a página tem 50 linhas. Conjunto FECHADO, espelho do `p_focus`.
 */
export const FULL_FOCUSES = ["acabando", "enviavel"] as const;

export type FullFocus = (typeof FULL_FOCUSES)[number];

export function fullFocusLabel(value: FullFocus): string {
  return value === "acabando" ? "Acabando" : "Pode enviar hoje";
}

export function fullFocusCriterion(value: FullFocus): string {
  return value === "acabando"
    ? `tem saldo no Full, vendeu na janela e a cobertura é menor que ${String(LOW_COVERAGE_DAYS)} dias`
    : `em ruptura ou acabando, e com saldo no estoque local para mandar`;
}

/** Ordens (D-380), espelho do `p_sort`. A primeira é o padrão da tela e fica fora da URL. */
export const FULL_SORTS = ["prioridade", "cobertura", "vendas", "full", "local", "sku"] as const;

export type FullSort = (typeof FULL_SORTS)[number];

export function fullSortLabel(value: FullSort): string {
  switch (value) {
    case "prioridade":
      return "Prioridade de envio";
    case "cobertura":
      return "Menor cobertura";
    case "vendas":
      return "Mais vendidos";
    case "full":
      return "Maior saldo no Full";
    case "local":
      return "Maior saldo local";
    case "sku":
      return "SKU (A–Z)";
  }
}

/**
 * Tom da cobertura: sem venda não há o que medir (neutro); zero é ruptura;
 * abaixo do crítico é perigo; abaixo do limiar é atenção.
 */
export function coverageTom(days: number | null): Tom {
  if (days === null) return "neutro";
  if (days < CRITICAL_COVERAGE_DAYS) return "perigo";
  if (days < LOW_COVERAGE_DAYS) return "atencao";

  return "ok";
}

/** "0 dias", "3,5 dias", "+90 dias" — acima de 90 a precisão não diz nada. */
export function formatCoverage(days: number | null): string {
  if (days === null) return "sem venda";
  if (days > 90) return "+90 dias";

  const texto = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: days < 10 ? 1 : 0 }).format(days);

  return `${texto} ${days === 1 ? "dia" : "dias"}`;
}

export const FULL_SITUATIONS = ["saudavel", "parado", "ruptura", "ausente"] as const;

export type FullSituation = (typeof FULL_SITUATIONS)[number];

/**
 * Rótulo e explicação de cada situação. O critério aparece na tela junto do
 * nome — "ruptura" sem a regra ao lado é um julgamento sem base declarada.
 * Função TOTAL: situação desconhecida degrada para o valor cru.
 */
/**
 * Tom do chip de situação do Full — o vocabulário desta tela mapeado nos cinco
 * tons do Figma (`components/tone.ts`). Ruptura é perigo; parado pede atenção;
 * "fora do Full" é ausência, não problema, e fica neutro.
 */
export function fullSituationTom(value: string): Tom {
  switch (value) {
    case "saudavel":
      return "ok";
    case "ruptura":
      return "perigo";
    case "parado":
      return "atencao";
    default:
      return "neutro";
  }
}

export function fullSituationLabel(value: string): string {
  switch (value) {
    case "saudavel":
      return "Saudável";
    case "parado":
      return "Parado";
    case "ruptura":
      return "Ruptura";
    case "ausente":
      return "Fora do Full";
    default:
      return value;
  }
}

export function fullSituationCriterion(value: string): string {
  switch (value) {
    case "saudavel":
      return "tem saldo no Full e vendeu na janela";
    case "parado":
      return "tem saldo no Full e não vendeu nada na janela";
    case "ruptura":
      return "vendeu na janela e está com saldo ZERO no Full";
    case "ausente":
      return "sem saldo no Full e sem venda na janela";
    default:
      return "";
  }
}

export interface FullFilters {
  search: string | null;
  situation: string | null;
  account: string | null;
  focus: FullFocus | null;
  sort: FullSort;
  pageSize: PageSize;
  page: number;
}

function readParam(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
}

function readMember(raw: unknown, allowed: readonly string[]): string | null {
  const value = readParam(raw);

  return value !== null && allowed.includes(value) ? value : null;
}

export function resolveFullFilters(query: Record<string, string | string[] | undefined>): FullFilters {
  return {
    search: readParam(query.busca),
    situation: readMember(query.situacao, FULL_SITUATIONS),
    // A conta não é conjunto fechado aqui: os ids vêm do banco, e a página
    // descarta um id que não pertença à organização antes de chamar a RPC.
    account: readParam(query.conta),
    focus: readMember(query.foco, FULL_FOCUSES) as FullFocus | null,
    sort: (readMember(query.ordem, FULL_SORTS) as FullSort | null) ?? "prioridade",
    pageSize: resolvePageSize(query.tamanho, PAGE_SIZE),
    page: resolvePageParam(query.pagina),
  };
}

/** Preserva as outras dimensões; conjunto novo volta à página 1 (regra de D-138/D-139). */
export function buildFullHref(current: FullFilters, override: Partial<FullFilters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/full",
    {
      busca: next.search,
      situacao: next.situation,
      conta: next.account,
      foco: next.focus,
      // Os padrões ficam fora da URL: `/full` limpo continua sendo `/full`.
      ordem: next.sort === "prioridade" ? null : next.sort,
      tamanho: next.pageSize === PAGE_SIZE ? null : String(next.pageSize),
    },
    override.page === undefined ? 1 : next.page,
  );
}

/** As colunas que uma linha REAL de `get_fulfillment_overview` sempre tem. */
interface LinhaFullPreenchida {
  ml_account_id: string;
  account_label: string;
  sku_id: string;
  sku: string;
  situation: string;
  full_quantity: number;
  buckets: number;
  captured_at: string;
  local_quantity: number;
  units_sold: number;
}

/**
 * Descarta a LINHA-SENTINELA de D-265 **e estreita o tipo**.
 *
 * `get_fulfillment_overview` faz `facetas left join pagina`, então uma página
 * vazia ainda devolve uma linha — com todas as colunas do SKU em `null` — só
 * para carregar `facet_situation`. Sem isso, escolher uma situação sem
 * resultado apagaria as contagens da faixa, que são a navegação da tela.
 *
 * **Por que conferir UM campo licencia estreitar TODOS.** A nulidade não vem do
 * schema: vem do `left join`, e ele preenche ou zera a linha inteira de uma vez.
 * Numa linha real, `situation` sai de um `case` que sempre devolve valor, `sku`
 * e `account_label` vêm de `join` (não `left`), e os números são `coalesce`. O
 * único anulável de verdade é `sku_title`, e ele fica de fora deste contrato.
 *
 * O guarda existe para essa regra morar em UM lugar: os três consumidores da
 * função a aplicam, e `sku_title` continua sendo tratado como anulável onde é.
 */
export function isFullRow<T extends { sku_id: string | null }>(
  row: T,
): row is T & LinhaFullPreenchida {
  return row.sku_id !== null;
}

export { summarizePagedWindow };

/**
 * A fórmula da cobertura (D-380), a MESMA da RPC: média diária sobre os dias
 * da janela e saldo do Full dividido por ela. Existe no TypeScript só para o
 * caminho de degradação da tela, quando a RPC nova ainda não chegou ao banco.
 */
export function coverageOf(
  fullQuantity: number,
  unitsSold: number,
  windowDays: number,
): { daily_rate: number | null; coverage_days: number | null } {
  if (unitsSold <= 0 || windowDays <= 0) return { daily_rate: null, coverage_days: null };

  return {
    daily_rate: Math.round((unitsSold / windowDays) * 100) / 100,
    coverage_days: Math.round(((Math.max(fullQuantity, 0) * windowDays) / unitsSold) * 10) / 10,
  };
}
