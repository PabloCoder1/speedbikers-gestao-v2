import { z } from "zod";

import type { MercadoLivreClient } from "./http-client.js";

/**
 * O modelo de user products da CONTA (D-369).
 *
 * A doc oficial de User Products (`developers.mercadolivre.com.br/pt_br/user-products`,
 * perguntas frequentes, atualizada em 17/06/2026) identifica o vendedor que já
 * está no modelo de "Preço por Variação" pela tag `user_product_seller` na API
 * `/users`, e diz que, depois da ativação, o array `variations` não pode mais
 * ser enviado. O relist de item com variações dessa conta volta 400
 * `item.variations.relist.invalid` (resposta real de 17/09/2026).
 *
 * Medido em 17/09/2026 (só GET em `/users/me`): as quatro contas da
 * organização têm a tag.
 */

export const USER_PRODUCT_SELLER_TAG = "user_product_seller";

/** Só o que a decisão usa. `tags` é obrigatório: sem ele, não há como afirmar nada sobre a conta. */
export const userTagsSchema = z.object({ tags: z.array(z.string()) });

export interface FetchUserProductSellerOptions {
  client: MercadoLivreClient;
  /** O token da CONTA que se quer conferir: `/users/me` responde pelo dono do token. */
  accessToken: string;
}

/**
 * `true` quando a conta do token tem a tag `user_product_seller`; `false`
 * quando `tags` veio sem ela. Qualquer falha (HTTP ou forma) LANÇA: decidir o
 * que fazer sem a leitura é do chamador, e a regra de D-369 é bloquear.
 */
export async function fetchIsUserProductSeller(options: FetchUserProductSellerOptions): Promise<boolean> {
  const user = await options.client.request({
    method: "GET",
    path: "/users/me",
    accessToken: options.accessToken,
    schema: userTagsSchema,
  });

  return user.tags.includes(USER_PRODUCT_SELLER_TAG);
}
