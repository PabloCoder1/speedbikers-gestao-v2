/**
 * Leitura em páginas de uma RPC que devolve linhas (`returns table`), até um
 * teto — a defesa das exportações contra o `max_rows = 1000` do PostgREST
 * (D-131).
 *
 * Pedir `p_limit: 5000` numa ida só devolve MIL linhas, sem erro e sem aviso.
 * As exportações de `/anuncios` e `/full` faziam exatamente isso: com ~4,5 mil
 * anúncios, o CSV saía com mil e o nome do arquivo não dizia nada, porque o
 * total ficava abaixo do teto de 5 mil (auditoria de 2026-09-28). A de
 * `/precos` já paginava (`app/(app)/precos/export/load.ts`).
 *
 * `lerPagina(offset, limite)` precisa chamar a RPC com ORDEM ESTÁVEL (as duas
 * têm desempate por chave) e devolver só as linhas de dado — a linha-sentinela
 * de `get_fulfillment_overview` sai antes, senão uma página vazia pareceria
 * ter conteúdo, e o laço nunca pararia. O offset avança pelo que chegou, e não
 * pelo que se pediu: se o servidor devolver menos que o pedido, nada é pulado.
 *
 * `teto = Number.POSITIVE_INFINITY` é o contrato explícito de telas que leem
 * todas as páginas até esgotar o cursor (ex.: `skus/[skuId]/page.tsx`, D-714/D-715).
 * Para evitar laço infinito diante de servidor defeituoso que nunca esvazia,
 * há uma guarda de segurança por número máximo de páginas (`MAX_PAGINAS_SEM_TETO`).
 */

export const PAGINA_DO_POSTGREST = 1000;

/** Guarda contra laço infinito quando `teto === Number.POSITIVE_INFINITY` (até 500 mil linhas). */
export const MAX_PAGINAS_SEM_TETO = 500;

export interface PaginaDaRpc<T> {
  data: T[] | null;
  error: { message: string; code?: string } | null;
  count?: number | null;
}

export async function lerPaginasDaRpc<T>(
  lerPagina: (offset: number, limite: number) => PromiseLike<PaginaDaRpc<T>>,
  teto: number,
): Promise<{ linhas: T[]; error: PaginaDaRpc<T>["error"] }> {
  const semTeto = teto === Number.POSITIVE_INFINITY;
  const limiteMaximo = semTeto ? Number.POSITIVE_INFINITY : Number.isFinite(teto) ? Math.floor(teto) : 0;

  if (limiteMaximo <= 0) {
    return { linhas: [], error: null };
  }

  const linhas: T[] = [];
  let paginasLidas = 0;

  while (linhas.length < limiteMaximo && (!semTeto || paginasLidas < MAX_PAGINAS_SEM_TETO)) {
    const restante = semTeto ? PAGINA_DO_POSTGREST : limiteMaximo - linhas.length;
    const limite = Math.min(PAGINA_DO_POSTGREST, restante);
    const pagina = await lerPagina(linhas.length, limite);

    paginasLidas += 1;

    if (pagina.error !== null) {
      return { linhas: [], error: pagina.error };
    }

    const lote = pagina.data ?? [];
    const primeiraPaginaCompleta = linhas.length === 0 && pagina.count === lote.length;

    linhas.push(...(!semTeto && lote.length > restante ? lote.slice(0, restante) : lote));

    // Sem total exato, só a página vazia confirma o fim. Uma página curta
    // também pode ser efeito do limite do servidor.
    if (primeiraPaginaCompleta || lote.length === 0) {
      break;
    }
  }

  return { linhas, error: null };
}
