/**
 * Filtros da Caixa de Entrada (D-289) — mesma divisão de D-141/D-167/D-172: a
 * MECÂNICA (href, página, resumo da janela) vem de `./filters`; aqui vive só o
 * vocabulário desta tela.
 *
 * O arquivo nasceu da paginação, e não por antecipação: enquanto a tela
 * mostrava 100 linhas e ponto, `buildHref` local dava conta. Paginar acrescenta
 * uma dimensão que TODAS as outras precisam respeitar (trocar filtro volta à
 * página 1) e uma que precisa sobreviver à ida ao caso (a volta tem de trazer a
 * página junto) — e essas duas regras já estavam escritas e testadas em
 * `./filters`, usadas por oito telas.
 *
 * As duas listas fechadas continuam sendo a defesa contra valor forjado na URL:
 * `canal=DROP` e `status=qualquer` caem no default em silêncio, nunca chegam ao
 * `eq()`.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";

/**
 * Cem por página, não cinquenta. É o teto que a tela já mostrava antes de
 * paginar (`ROW_LIMIT`), e mantê-lo significa que ninguém passa a ver MENOS
 * fila do que via ontem — a fatia acrescenta as páginas 2 em diante, não
 * encolhe a primeira. Com 929 abertos no Dev são 10 páginas; a 50 seriam 19.
 */
export const PAGE_SIZE = 100;

/** `internal_status` é fechado em cinco valores (D-084). */
export const INTERNAL_STATUSES = [
  "NOVO",
  "EM_ATENDIMENTO",
  "AGUARDANDO_CLIENTE",
  "AGUARDANDO_MERCADO_LIVRE",
  "RESOLVIDO",
] as const;

export const CHANNELS = ["QUESTION", "POST_SALE_MESSAGE", "CLAIM"] as const;

export type Channel = (typeof CHANNELS)[number];
export type InternalStatus = (typeof INTERNAL_STATUSES)[number];

/**
 * `abertos` é o padrão porque é a pergunta que a tela responde ("o que precisa
 * de mim agora?") e porque bate com o índice parcial
 * `support_cases_open_inbox_idx`, que existe justamente para essa consulta.
 */
export type StatusFilter = "abertos" | "todos" | InternalStatus;

/**
 * Recortes de prazo (lote 2 do pente fino, 18/09). `risco` é o de sempre
 * (D-115: vence nas próximas 24h OU já venceu) e continua valendo para os
 * Filtros Salvos; `vencido` e `24h` separam as duas metades, que são as duas
 * contagens de `get_support_metrics` — clicar no número abre a mesma fila.
 */
export const PRAZO_FILTERS = ["risco", "vencido", "24h"] as const;

export type PrazoFilter = (typeof PRAZO_FILTERS)[number];

export interface SupportFilters {
  /** Slug da conta ML. Não é conjunto fechado: os slugs vêm do banco, e a
   *  página descarta o que não pertencer à organização ao montar a chamada. */
  account: string | null;
  channel: Channel | null;
  status: StatusFilter;
  /** Recorte por prazo ATIVO; `null` é sem recorte. */
  prazo: PrazoFilter | null;
  /** Só os casos atribuídos a quem está vendo (`assignee_id`). */
  mine: boolean;
  /** Só reclamações em mediação (`is_mediation`, faceta do claim — D-084). */
  mediation: boolean;
  /** Número do caso, do pedido, MLB do anúncio ou código do SKU. */
  search: string | null;
  page: number;
}

function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;

  return value ?? null;
}

function resolveStatus(raw: string | null): StatusFilter {
  if (raw === "todos") return "todos";

  if (raw !== null && (INTERNAL_STATUSES as readonly string[]).includes(raw)) {
    return raw as InternalStatus;
  }

  return "abertos";
}

function resolveChannel(raw: string | null): Channel | null {
  if (raw !== null && (CHANNELS as readonly string[]).includes(raw)) {
    return raw as Channel;
  }

  return null;
}

function resolvePrazo(raw: string | null): PrazoFilter | null {
  return raw !== null && (PRAZO_FILTERS as readonly string[]).includes(raw) ? (raw as PrazoFilter) : null;
}

/** Busca em branco é ausência de busca; o teto de 80 caracteres protege o `ilike`. */
function resolveSearch(raw: string | null): string | null {
  const texto = raw?.trim() ?? "";

  return texto === "" ? null : texto.slice(0, 80);
}

export function resolveSupportFilters(query: Record<string, string | string[] | undefined>): SupportFilters {
  return {
    account: readParam(query.account),
    channel: resolveChannel(readParam(query.canal)),
    status: resolveStatus(readParam(query.status)),
    prazo: resolvePrazo(readParam(query.prazo)),
    mine: readParam(query.meus) === "1",
    mediation: readParam(query.mediacao) === "1",
    search: resolveSearch(readParam(query.busca)),
    page: resolvePageParam(query.pagina),
  };
}

/**
 * Preserva as outras dimensões ao trocar uma.
 *
 * **Trocar filtro volta à página 1** (regra de D-138/D-139, aqui herdada de
 * `buildFilterHref`): manter o offset ao mudar o CONJUNTO mostraria uma página
 * vazia que o operador lê como "nenhum atendimento com estes filtros" — e nesta
 * tela isso é pior do que em outras, porque a leitura errada é "a fila
 * esvaziou".
 *
 * Quem quer a página PRESERVADA precisa dizer: `{ page: filtros.page }`. É o
 * caso do `?volta=` que viaja com cada caso (D-286) — voltar da página 7 para a
 * 1 seria perder o lugar na fila, que é exatamente o que aquele parâmetro
 * existe para não deixar acontecer.
 */
export function buildSupportHref(current: SupportFilters, override: Partial<SupportFilters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/atendimento",
    {
      account: next.account,
      canal: next.channel,
      status: next.status === "abertos" ? null : next.status,
      prazo: next.prazo,
      meus: next.mine ? "1" : null,
      mediacao: next.mediation ? "1" : null,
      busca: next.search,
    },
    override.page === undefined ? 1 : next.page,
  );
}

export { summarizePagedWindow };

/**
 * Como a busca da Caixa de Entrada interpreta o texto (lote 2 do pente fino).
 * Função pura para o critério ter teste: só dígitos pode ser o número do caso
 * OU do pedido; `MLB...` é anúncio; o resto é código de SKU.
 */
export type SupportSearchKind =
  | { kind: "numero"; value: string }
  | { kind: "anuncio"; value: string }
  | { kind: "sku"; value: string };

export function classifySupportSearch(search: string): SupportSearchKind {
  const texto = search.trim();

  if (/^\d+$/.test(texto)) return { kind: "numero", value: texto };

  if (/^mlb\d+$/i.test(texto)) return { kind: "anuncio", value: texto.toUpperCase() };

  return { kind: "sku", value: texto };
}
