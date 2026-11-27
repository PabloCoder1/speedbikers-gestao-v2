/**
 * Leitura paginada do PostgREST — a defesa contra o truncamento silencioso
 * de 1.000 linhas (D-131).
 *
 * `supabase/config.toml` fixa `max_rows = 1000`. Uma consulta que devolveria
 * mais que isso volta CORTADA, **sem erro e sem aviso**: `error` é nulo,
 * `data` tem exatamente 1.000 itens, e o código segue como se aquilo fosse o
 * conjunto inteiro. É o pior formato de defeito — não quebra, mente.
 *
 * Em D-131 isso corrompeu o saldo de estoque de produção: a reconciliação lia
 * 1.000 das 6.744 linhas do snapshot e 1.000 das 2.524 do ledger, tratava o
 * ledger ausente como zero, e reaplicava o ajuste inteiro TODO DIA. Quatro
 * dias depois havia SKU com saldo 4× o real.
 *
 * **ORDENAÇÃO ESTÁVEL É OBRIGATÓRIA.** `readPage` precisa aplicar um
 * `.order(...)` por coluna única (ou combinação única). Sem isso o Postgres
 * pode devolver a mesma linha em duas páginas e omitir outra — e, no pior
 * caso, toda página volta cheia e o laço não termina. O precedente do
 * projeto (`erp-import-apply.ts`) ordena por `id`.
 *
 * **Para conjunto grande de verdade, isto não é a resposta.** Trazer 200 mil
 * linhas para a memória do worker para somar em JavaScript viola
 * `docs/ARCHITECTURE.md` secao 15/21 ("zero agregação em JavaScript"); nesse
 * caso a conta pertence a uma RPC. Este helper existe para conjunto que o
 * worker precisa mesmo percorrer item a item — alguns milhares de linhas.
 */

export const POSTGREST_MAX_ROWS = 1000;

export interface PageResponse<T> {
  readonly data: T[] | null;
  readonly error: { readonly message: string } | null;
}

export interface ReadAllPagesOptions {
  /**
   * Tamanho da página. Nunca maior que `max_rows`: pedir 5.000 devolveria
   * 1.000, o laço veria "página incompleta" e pararia achando que acabou —
   * exatamente o defeito que este helper existe para impedir.
   */
  readonly pageSize?: number;
  /**
   * Prefixo da mensagem de erro, tipicamente o nome da tabela. Sem isto o
   * chamador perde o contexto que tinha quando tratava o erro na mão: um
   * `"boom"` solto no log não diz QUAL leitura falhou.
   */
  readonly label?: string;
}

/**
 * Lê todas as páginas de uma consulta PostgREST.
 *
 * `readPage(from, to)` deve montar a MESMA consulta com `.range(from, to)`.
 *
 * ```ts
 * const linhas = await readAllPages((from, to) =>
 *   db.from("inventory_balances").select("sku_id, quantity").order("sku_id").range(from, to),
 * );
 * ```
 */
export async function readAllPages<T>(
  readPage: (from: number, to: number) => PromiseLike<PageResponse<T>>,
  options: ReadAllPagesOptions = {},
): Promise<T[]> {
  const requested = options.pageSize ?? POSTGREST_MAX_ROWS;

  if (!Number.isFinite(requested) || requested < 1) {
    throw new Error("readAllPages: pageSize precisa ser pelo menos 1");
  }

  const pageSize = Math.min(Math.floor(requested), POSTGREST_MAX_ROWS);

  const todas: T[] = [];
  let from = 0;

  for (;;) {
    const page = await readPage(from, from + pageSize - 1);

    if (page.error !== null) {
      throw new Error(
        options.label === undefined ? page.error.message : `${options.label}: ${page.error.message}`,
      );
    }

    // `data` nulo com `error` nulo não deveria acontecer; tratar como fim é
    // melhor que estourar, porque parar cedo aqui é visível (contagem menor)
    // e continuar seria um laço infinito.
    const lote = page.data ?? [];

    todas.push(...lote);

    // Página incompleta é o fim. Página cheia pode ser o fim exato também —
    // nesse caso a próxima volta vazia e o laço encerra ali, ao custo de uma
    // requisição a mais. Preferir isso a arriscar parar antes do fim.
    if (lote.length < pageSize) {
      break;
    }

    from += pageSize;
  }

  return todas;
}

/**
 * Lê todas as páginas de uma consulta PostgREST pela chave (keyset), e não
 * pelo deslocamento.
 *
 * Cada página pede as linhas com chave MAIOR que a última vista. Com `range`,
 * o PostgREST manda `OFFSET`, e o Postgres percorre e descarta tudo o que vem
 * antes da página: a última página de uma varredura longa custa dezenas de
 * vezes a primeira, e a varredura inteira cresce com o quadrado do conjunto
 * (D-876). Pela chave, toda página custa o mesmo que a primeira.
 *
 * `readPage(depois, limite)` monta a MESMA consulta com `.gt(coluna, depois)`
 * quando `depois` não é nulo, `.order(coluna)` crescente e `.limit(limite)`.
 * A coluna precisa ser única (a PK), e `chave(linha)` devolve o valor dela.
 *
 * ```ts
 * const linhas = await readAllPagesByKey(
 *   (depois, limite) => {
 *     const q = db.from("stock_movements").select("id, sku_id").eq("organization_id", org);
 *
 *     return (depois === null ? q : q.gt("id", depois)).order("id").limit(limite);
 *   },
 *   (linha) => linha.id,
 * );
 * ```
 */
export async function readAllPagesByKey<T, K extends string | number>(
  readPage: (depois: K | null, limite: number) => PromiseLike<PageResponse<T>>,
  chave: (linha: T) => K,
  options: ReadAllPagesOptions = {},
): Promise<T[]> {
  const pageSize = Math.min(options.pageSize ?? POSTGREST_MAX_ROWS, POSTGREST_MAX_ROWS);

  if (pageSize < 1) {
    throw new Error("readAllPagesByKey: pageSize precisa ser pelo menos 1");
  }

  const todas: T[] = [];
  let depois: K | null = null;

  for (;;) {
    const page = await readPage(depois, pageSize);

    if (page.error !== null) {
      throw new Error(
        options.label === undefined ? page.error.message : `${options.label}: ${page.error.message}`,
      );
    }

    const lote = page.data ?? [];

    todas.push(...lote);

    // Mesma regra de `readAllPages`: página incompleta é o fim; página cheia
    // pede mais uma, que pode voltar vazia.
    if (lote.length < pageSize) {
      break;
    }

    const ultima = chave(lote[lote.length - 1] as T);

    // Uma consulta sem o `gt` (ou ordenada por outra coluna) devolveria a
    // mesma página para sempre. Parar alto é melhor que um laço infinito.
    if (ultima === depois) {
      throw new Error("readAllPagesByKey: a chave não avançou; a consulta precisa filtrar e ordenar pela chave");
    }

    depois = ultima;
  }

  return todas;
}
