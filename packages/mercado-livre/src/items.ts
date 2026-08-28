import { z } from "zod";

import type { MercadoLivreClient } from "./http-client.js";

/**
 * Enumeração do catálogo COMPLETO de um vendedor e hidratação em lote.
 *
 * Contrato confirmado por leitura oficial ao vivo em 2026-08-28
 * (`docs/MERCADO_LIVRE.md` secao 2.14). Três fatos da doc decidem este
 * arquivo inteiro:
 *
 * 1. **`results` traz só IDs**, nunca objetos — enumerar é obrigatoriamente
 *    duas fases: descobrir e depois hidratar.
 * 2. **O teto de 1.000 é real** e confirmado em três lugares da doc. A maior
 *    conta desta organização já teve 2.675 itens distintos observados, então
 *    `search_type=scan` **não é otimização, é obrigatório**.
 * 3. **Não existe filtro por data.** Este endpoint é reconciliação/backfill;
 *    o incremental continua sendo o webhook `items` — posicionamento que a
 *    própria doc afirma ("não substitui o uso das notificações de itens").
 *
 * Armadilha registrada: o parâmetro de ordenação aqui é **`orders`**, não
 * `sort` — `sort` pertence a `/sites/{site}/search`. Confundir os dois é o
 * erro que custou D-109; por isso este módulo **não envia ordenação nenhuma**,
 * já que a varredura completa não depende de ordem.
 */

/** Máximo documentado do multiget `/items?ids=`. Não é escolha nossa. */
export const ITEMS_MULTIGET_MAX_IDS = 20;

/** Máximo documentado de `limit` na busca (o ES desambigua o PT). */
export const SELLER_ITEMS_MAX_LIMIT = 100;

const itemIdSchema = z.string().min(1);

/**
 * `scroll_id` é opcional e nullable: a doc diz que "no fim da lista será
 * null" **sem dizer qual campo** vira null. Aceitar as três formas (string,
 * null, ausente) é o único jeito de não quebrar no último ciclo — e o laço
 * abaixo para por `results` vazio, que é observável com certeza.
 */
export const sellerItemsScanPageSchema = z.object({
  results: z.array(itemIdSchema),
  scroll_id: z.string().nullish(),
});

export type SellerItemsScanPage = z.infer<typeof sellerItemsScanPageSchema>;

export interface ScanSellerItemsOptions {
  client: MercadoLivreClient;
  sellerId: number | string;
  accessToken: string;
  /** Só a PRIMEIRA chamada leva `limit` — ver o comentário do laço. */
  limit?: number;
  /** Teto de segurança contra scroll que nunca termina. */
  maxPages?: number;
}

const DEFAULT_MAX_PAGES = 500;

/**
 * Percorre o catálogo inteiro por `search_type=scan`, devolvendo lotes de IDs.
 *
 * **Não pode ser pausado nem paralelizado.** A FAQ oficial de rate limit é
 * explícita: o `scroll_id` expira em 5 minutos e "o consumo repetido ou
 * deixado aberto por muito tempo gera 429". Quem consome este gerador tem de
 * drenar continuamente — gravar em lote no meio do laço é o caminho para
 * scroll expirado.
 *
 * **`limit` só na primeira chamada, de propósito.** Duas páginas oficiais se
 * contradizem: a FAQ (05/05/2026) diz que `scroll_id` junto com
 * `offset`/`limit` causa erro; a página de itens (07/04/2025) põe a nota do
 * `limit` máximo dentro da seção do scan. A FAQ é mais recente. Este é o
 * recorte conservador — e está marcado para MEDIR na primeira execução real.
 */
export async function* scanSellerItems(
  options: ScanSellerItemsOptions,
): AsyncGenerator<string[], void, void> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  let scrollId: string | undefined;
  let pages = 0;

  for (;;) {
    const page = await options.client.request({
      method: "GET",
      path: `/users/${String(options.sellerId)}/items/search`,
      accessToken: options.accessToken,
      searchParams:
        scrollId === undefined
          ? { search_type: "scan", limit: options.limit }
          : { search_type: "scan", scroll_id: scrollId },
      schema: sellerItemsScanPageSchema,
    });

    if (page.results.length === 0) {
      return;
    }

    yield page.results;

    pages += 1;

    // Sem `scroll_id` na resposta não há como pedir a próxima página. Parar
    // é correto: repetir a primeira chamada faria a varredura girar em falso
    // sobre o mesmo lote para sempre.
    if (typeof page.scroll_id !== "string" || page.scroll_id === "") {
      return;
    }

    if (pages >= maxPages) {
      return;
    }

    scrollId = page.scroll_id;
  }
}

/**
 * Envelope VERBOSE do multiget: cada item traz o próprio `code`, então uma
 * falha é por item e não da chamada inteira. `body` é deliberadamente
 * `unknown` — quem chama valida com o schema do seu próprio caso de uso.
 */
export const itemsMultigetEntrySchema = z.object({
  code: z.number().int(),
  body: z.unknown(),
});

export const itemsMultigetSchema = z.array(itemsMultigetEntrySchema);

export type ItemsMultigetEntry = z.infer<typeof itemsMultigetEntrySchema>;

export function chunkItemIds(ids: readonly string[], size = ITEMS_MULTIGET_MAX_IDS): string[][] {
  if (size < 1) {
    throw new Error("tamanho de lote inválido");
  }

  const chunks: string[][] = [];

  for (let index = 0; index < ids.length; index += size) {
    chunks.push([...ids.slice(index, index + size)]);
  }

  return chunks;
}

export interface GetItemsBatchOptions {
  client: MercadoLivreClient;
  ids: readonly string[];
  accessToken: string;
  /** Projeção de campos (`attributes=`). Omitir traz o item inteiro. */
  attributes?: readonly string[];
}

/**
 * Busca até 20 itens numa chamada. **Não fatia sozinho**: passar mais de 20
 * é erro do chamador, e a doc não diz o que a API faz nesse caso (erro 400?
 * truncamento silencioso?). Falhar aqui é melhor que descobrir depois que
 * metade do catálogo sumiu em silêncio — use `chunkItemIds`.
 */
export async function getItemsBatch(options: GetItemsBatchOptions): Promise<ItemsMultigetEntry[]> {
  if (options.ids.length === 0) {
    return [];
  }

  if (options.ids.length > ITEMS_MULTIGET_MAX_IDS) {
    throw new Error(
      `multiget aceita no máximo ${String(ITEMS_MULTIGET_MAX_IDS)} ids — recebeu ${String(options.ids.length)}`,
    );
  }

  return await options.client.request({
    method: "GET",
    path: "/items",
    accessToken: options.accessToken,
    searchParams: {
      ids: options.ids.join(","),
      attributes: options.attributes === undefined ? undefined : options.attributes.join(","),
    },
    schema: itemsMultigetSchema,
  });
}
