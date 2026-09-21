import { z } from "zod";

import { MercadoLivreApiError } from "./errors.js";
import type { MercadoLivreClient } from "./http-client.js";

/**
 * Descrição de um item — `GET /items/{item_id}/description`. Fica FORA do
 * recurso `/items` (confirmado ao vivo em 2026-09-21 contra a conta
 * "Speedbikers (loja 1)" do Dev, item MLB1384467402): o multiget de
 * `ml-listings-fetch.ts` não tem como trazê-la via `attributes=`, e é por
 * isso que ela precisa de uma chamada própria, uma por item — o mesmo motivo
 * que a promoção (D-389) virou chamada separada.
 *
 * Exemplo real da resposta:
 *
 * ```json
 * {
 *   "text": "",
 *   "plain_text": "A Polia Traseira Completa da TMAC ...",
 *   "last_updated": "2024-09-20T19:39:32.999Z",
 *   "date_created": "2019-12-09T13:13:47.000Z",
 *   "snapshot": { "url": "...", "width": 0, "height": 0, "status": "" }
 * }
 * ```
 *
 * `text` veio vazio nos três itens testados — `plain_text` é o campo com o
 * conteúdo real, e é o único usado aqui.
 */
export const itemDescriptionSchema = z.object({
  plain_text: z.string(),
});

export interface GetItemDescriptionOptions {
  client: MercadoLivreClient;
  itemId: string;
  accessToken: string;
}

/**
 * `null` quando o item não tem descrição própria (404) — não é falha, é
 * ausência. Nem todo anúncio tem descrição preenchida.
 */
export async function getItemDescription(options: GetItemDescriptionOptions): Promise<string | null> {
  try {
    const description = await options.client.request({
      method: "GET",
      path: `/items/${options.itemId}/description`,
      accessToken: options.accessToken,
      schema: itemDescriptionSchema,
    });

    return description.plain_text;
  } catch (error) {
    if (error instanceof MercadoLivreApiError && error.status === 404) {
      return null;
    }

    throw error;
  }
}
