import { z } from "zod";

import type { ShopeeClient } from "./client.js";

/**
 * `GET /api/v2/shop/get_shop_info` — nome, região, estado da loja e as datas
 * da autorização (D-425). Os campos que a V3 usa; os demais (SIP, Full,
 * outlet) ficam de fora até alguém precisar.
 */
export const shopInfoSchema = z.object({
  shop_name: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  // NORMAL, BANNED ou FROZEN.
  status: z.string().nullable().optional(),
  // Epoch em segundos.
  auth_time: z.number().int().nullable().optional(),
  expire_time: z.number().int().nullable().optional(),
});

export type ShopInfo = z.infer<typeof shopInfoSchema>;

export function getShopInfo(client: ShopeeClient, shop: { accessToken: string; shopId: number }): Promise<ShopInfo> {
  return client.request({ method: "GET", path: "/api/v2/shop/get_shop_info", shop, schema: shopInfoSchema });
}

/** Epoch da Shopee (segundos) para ISO; ausente ou zero vira `null`, nunca 1970. */
export function shopeeEpochToIso(valor: number | null | undefined): string | null {
  return typeof valor === "number" && valor > 0 ? new Date(valor * 1000).toISOString() : null;
}
