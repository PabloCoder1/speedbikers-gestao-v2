/**
 * Formato `paging` comum a `/orders/search` e `/users/{id}/items/search`
 * (`docs/MERCADO_LIVRE.md` secao 2).
 */
export interface PagingInfo {
  total: number;
  offset: number;
  limit: number;
}

export interface OffsetPage<T> {
  results: T[];
  paging: PagingInfo;
}

export interface PaginateOffsetOptions<T> {
  limit?: number;
  fetchPage: (params: { offset: number; limit: number }) => Promise<OffsetPage<T>>;
}

const DEFAULT_PAGE_LIMIT = 50;

/**
 * Percorre um endpoint paginado por offset/limit até `paging.total`.
 *
 * Isto é o mecanismo de UMA chamada de listagem — não é a estratégia de
 * retomada da sincronização. `docs/MERCADO_LIVRE.md` secao 4 é explícita:
 * "paginação por cursor, nunca por offset" fala do CHECKPOINT entre
 * execuções (a V2 quebrou guardando um offset cru, que um pedido novo
 * deslocava no meio da varredura). O checkpoint real do motor de sync
 * (Fase 3) deve ser uma marca de tempo/`date_last_updated`, usada para
 * escolher POR ONDE começar a próxima varredura — nunca um offset salvo de
 * uma execução anterior.
 */
export async function* paginateOffset<T>(
  options: PaginateOffsetOptions<T>,
): AsyncGenerator<T[], void, void> {
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  let offset = 0;

  for (;;) {
    const page = await options.fetchPage({ offset, limit });

    if (page.results.length === 0) {
      return;
    }

    yield page.results;

    offset += page.results.length;

    if (offset >= page.paging.total) {
      return;
    }
  }
}
