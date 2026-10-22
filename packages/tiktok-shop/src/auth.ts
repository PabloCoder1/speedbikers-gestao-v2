import { z } from "zod";

import { TIKTOK_SHOP_HOSTS, type TikTokShopClient } from "./client.js";

/**
 * A autorização da loja (D-645) — P`authorization-overview-202407`, conferida
 * em 22/10/2026 (`docs/TIKTOK_SHOP.md` §4):
 *
 * - o link do vendedor é `services.tiktokshop.com/open/authorize?service_id&state`,
 *   SEM `app_key`; há uma Redirect URL só por app, cadastrada no Partner Center;
 * - o retorno traz `code` (30 minutos, uma vez) e o `state`, ou
 *   `error=auth_denied` na recusa;
 * - o token sai de `GET /api/v2/token/get` com `grant_type=authorized_code` —
 *   e NÃO o `authorization_code` do OAuth (a doc avisa que "corrigir" quebra).
 */
export function buildAuthorizationUrl(options: { serviceId: string; state: string }): string {
  const url = new URL(TIKTOK_SHOP_HOSTS.authorize);

  url.searchParams.set("service_id", options.serviceId);
  url.searchParams.set("state", options.state);

  return url.toString();
}

/**
 * O par de tokens. As duas validades são INSTANTES Unix (em segundos), não
 * durações: o access token vale 7 dias por padrão; o refresh token, a duração
 * de autorização que o vendedor escolheu.
 */
export const tiktokShopTokenSchema = z.object({
  access_token: z.string().min(1),
  access_token_expire_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expire_in: z.number().int().positive(),
  open_id: z.string().min(1),
  seller_name: z.string().nullable().optional(),
  seller_base_region: z.string().nullable().optional(),
  /** 0 = vendedor (a enumeração da doc); outro valor é outro tipo de app. */
  user_type: z.number().int(),
  granted_scopes: z.array(z.string()).nullable().optional(),
});

export type TikTokShopToken = z.infer<typeof tiktokShopTokenSchema>;

/** Troca o `code` do retorno pelo primeiro par de tokens. */
export function getAccessToken(client: TikTokShopClient, authCode: string): Promise<TikTokShopToken> {
  return client.requestToken(
    "/api/v2/token/get",
    { auth_code: authCode, grant_type: "authorized_code" },
    tiktokShopTokenSchema,
  );
}

/** Renova o par (mesma resposta do `token/get`). */
export function refreshAccessToken(client: TikTokShopClient, refreshToken: string): Promise<TikTokShopToken> {
  return client.requestToken(
    "/api/v2/token/refresh",
    { refresh_token: refreshToken, grant_type: "refresh_token" },
    tiktokShopTokenSchema,
  );
}

/** O instante Unix (segundos) da doc como ISO. */
export function tiktokEpochToIso(segundos: number): string {
  return new Date(segundos * 1000).toISOString();
}
