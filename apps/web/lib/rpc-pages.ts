/**
 * Leitura em páginas de uma RPC que devolve linhas (`returns table`), até um
 * teto — a defesa das exportações contra o `max_rows = 1000` do PostgREST
 * (D-131).
 *
 * Pedir `p_limit: 5000` numa ida só devolve MIL linhas, sem erro e sem aviso.
 * As exportações de `/anuncios` e `/full` faziam exatamente isso: com ~4,5 mil
 * anúncios, o CSV saía com mil e o nome do arquivo não dizia nada, porque o
 * total ficava abaixo do teto de 5 mil (auditoria de 2026-09-28). A de
 * `/precos` já paginava (`app/precos/export/load.ts`).
 *
 * `lerPagina(offset, limite)` precisa chamar a RPC com ORDEM ESTÁVEL (as duas
 * têm desempate por chave) e devolver só as linhas de dado — a linha-sentinela
 * de `get_fulfillment_overview` sai antes, senão uma página vazia pareceria
 * ter conteúdo, e o laço nunca pararia. O offset avança pelo que chegou, e não
 * pelo que se pediu: se o servidor devolver menos que o pedido, nada é pulado.
 */

export const PAGINA_DO_POSTGREST = 1000;

export interface PaginaDaRpc<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export async function lerPaginasDaRpc<T>(
  lerPagina: (offset: number, limite: number) => PromiseLike<PaginaDaRpc<T>>,
  teto: number,
): Promise<{ linhas: T[]; error: { message: string } | null }> {
  const linhas: T[] = [];

  while (linhas.length < teto) {
    const limite = Math.min(PAGINA_DO_POSTGREST, teto - linhas.length);
    const pagina = await lerPagina(linhas.length, limite);

    if (pagina.error !== null) {
      return { linhas: [], error: pagina.error };
    }

    const lote = pagina.data ?? [];
    linhas.push(...lote);

    // Só a página VAZIA é o fim. Tratar a incompleta como fim truncaria em
    // silêncio se o `max_rows` do servidor for menor que a página pedida — o
    // mesmo defeito, um nível abaixo. Custa uma ida a mais no fim.
    if (lote.length === 0) {
      break;
    }
  }

  return { linhas, error: null };
}
