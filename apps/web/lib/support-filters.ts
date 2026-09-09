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

export interface SupportFilters {
  /** Slug da conta ML. Não é conjunto fechado: os slugs vêm do banco, e a
   *  página descarta o que não pertencer à organização ao montar a chamada. */
  account: string | null;
  channel: Channel | null;
  status: StatusFilter;
  /** Prazo ATIVO vencendo nas próximas 24h — ou já vencido (D-115). */
  prazo: boolean;
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

export function resolveSupportFilters(query: Record<string, string | string[] | undefined>): SupportFilters {
  return {
    account: readParam(query.account),
    channel: resolveChannel(readParam(query.canal)),
    status: resolveStatus(readParam(query.status)),
    prazo: readParam(query.prazo) === "risco",
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
      prazo: next.prazo ? "risco" : null,
    },
    override.page === undefined ? 1 : next.page,
  );
}

export { summarizePagedWindow };
