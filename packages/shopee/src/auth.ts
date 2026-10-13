import { z } from "zod";

import { SHOPEE_HOSTS, ShopeeApiError, type ShopeeClient, type ShopeeEnvironment } from "./client.js";

/**
 * Autorização de loja (D-425) — open.shopee.com/developer-guide/20, conferido
 * em 13/10/2026.
 *
 * O link novo não leva assinatura: endereço fixo do ambiente + `partner_id`,
 * `auth_type=seller`, `redirect_uri`, `response_type=code` e o `state`
 * anti-CSRF, devolvido intacto no retorno. O domínio do `redirect_uri` precisa
 * ser o declarado no Console ("Test/Live Redirect URL Domain").
 *
 * O retorno traz `code` (uma vez, 10 minutos) e `shop_id` — ou
 * `main_account_id`, quando quem autoriza é uma conta principal com várias
 * lojas.
 */
export function buildAuthorizationUrl(options: {
  environment: ShopeeEnvironment;
  partnerId: number;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(SHOPEE_HOSTS[options.environment].auth);

  url.searchParams.set("partner_id", String(options.partnerId));
  url.searchParams.set("auth_type", "seller");
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", options.state);

  return url.toString();
}

/**
 * `access_token` vale 4 h (`expire_in`, em segundos); `refresh_token` vale 30
 * dias e só pode ser usado UMA vez — a renovação devolve o próximo.
 */
export const shopeeTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expire_in: z.number().int().positive(),
  // Só com `main_account_id`: as lojas autorizadas desta vez.
  shop_id_list: z.array(z.number().int().positive()).nullable().optional(),
  // Só na renovação.
  shop_id: z.number().int().positive().nullable().optional(),
});

export type ShopeeToken = z.infer<typeof shopeeTokenSchema>;

/** Validade do refresh_token (documentação: 30 dias). */
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 3_600_000;

/** Troca o `code` do retorno pelo primeiro par de tokens (`/api/v2/auth/token/get`). */
export function getAccessToken(
  client: ShopeeClient,
  options: { code: string } & ({ shopId: number } | { mainAccountId: number }),
): Promise<ShopeeToken> {
  return client.request({
    method: "POST",
    path: "/api/v2/auth/token/get",
    body: {
      code: options.code,
      partner_id: client.partnerId,
      ...("shopId" in options ? { shop_id: options.shopId } : { main_account_id: options.mainAccountId }),
    },
    schema: shopeeTokenSchema,
  });
}

/** Renova o par de uma loja (`/api/v2/auth/access_token/get`). O refresh_token usado deixa de valer. */
export function refreshAccessToken(
  client: ShopeeClient,
  options: { refreshToken: string; shopId: number },
): Promise<ShopeeToken> {
  return client.request({
    method: "POST",
    path: "/api/v2/auth/access_token/get",
    body: { refresh_token: options.refreshToken, partner_id: client.partnerId, shop_id: options.shopId },
    schema: shopeeTokenSchema,
  });
}

/**
 * Os códigos com que a Shopee RECUSA a renovação de vez (referência de
 * `v2.public.refresh_access_token`, conferida em 13/10/2026): a loja precisa
 * ser autorizada de novo. Qualquer outro erro — `error_server`,
 * `error_network`, HTTP 5xx/429, timeout — é passageiro, e a loja continua
 * conectada (a lição de D-414: só a recusa definitiva derruba a conexão).
 */
const RECUSA_DEFINITIVA = new Set([
  "refresh_token_expired",
  "shop_access_expired",
  "shop_banned",
  "shop_no_linked",
  "error_shop_refresh_token",
  "error_auth",
]);

export function isDefinitiveRefreshRefusal(error: unknown): boolean {
  return error instanceof ShopeeApiError && error.code !== null && RECUSA_DEFINITIVA.has(error.code);
}
