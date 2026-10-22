import { z } from "zod";

import type { TikTokShopClient } from "./client.js";

/**
 * As lojas que o vendedor autorizou (D-645) — `GET /authorization/202309/shops`
 * (P`get-authorized-shops-202309`, conferida em 22/10/2026). O `cipher` vai como
 * `shop_cipher` em toda chamada de loja; o `id` é o que o webhook traz.
 */
export const tiktokShopSchema = z.object({
  id: z.string().regex(/^[0-9]+$/),
  name: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  /** LOCAL (uma loja) ou CROSS_BORDER (várias, em países diferentes). */
  seller_type: z.string().nullable().optional(),
  cipher: z.string().min(1),
  /** O código da loja, o que aparece no Seller Center. */
  code: z.string().nullable().optional(),
});

export type TikTokShop = z.infer<typeof tiktokShopSchema>;

const authorizedShopsSchema = z.object({ shops: z.array(tiktokShopSchema) });

export async function getAuthorizedShops(client: TikTokShopClient, accessToken: string): Promise<TikTokShop[]> {
  const data = await client.request({
    method: "GET",
    path: "/authorization/202309/shops",
    accessToken,
    schema: authorizedShopsSchema,
  });

  return data.shops;
}
