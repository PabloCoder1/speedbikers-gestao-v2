import { randomBytes } from "node:crypto";

import type { AdminClient } from "@sb/db";
import { encryptToken } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import {
  buildAuthorizationUrl,
  getAccessToken,
  getAuthorizedShops,
  tiktokEpochToIso,
  type TikTokShop,
  type TikTokShopClient,
} from "@sb/tiktok-shop";

import type { Caller } from "./auth.js";

/**
 * Conexão de loja do TikTok Shop (D-645, fatia 1): `POST /v1/tiktok-shop/connect`
 * + `GET /oauth/tiktok-shop/callback` — o desenho da Shopee (`shopee-shops.ts`):
 * a loja só é conhecida NO RETORNO da autorização, e o `state` aponta para a
 * organização.
 *
 * O App Secret e a chave de cifra dos tokens nunca chegam ao navegador. A
 * Redirect URL não vai no link: é uma só por app, cadastrada no Partner Center.
 */

const STATE_TTL_MS = 15 * 60 * 1000;

/** `user_type` 0 = vendedor (a enumeração da doc). O app da Speed Bikers é de seller developer. */
const USER_TYPE_SELLER = 0;

export interface TikTokShopsDeps {
  db: AdminClient;
  logger: Logger;
  encryptionKey: Buffer;
  client: TikTokShopClient;
  /** O `service_id` do app (App & Service > Basic Information); não é segredo. */
  serviceId: string;
  now?: () => Date;
}

export type TikTokConnectOutcome =
  | { status: "redirect"; authorizationUrl: string }
  | { status: "rejected"; reason: string };

/** Inicia a autorização: grava o `state` (da organização, não de uma loja) e devolve o link. */
export async function startTikTokConnect(deps: TikTokShopsDeps, caller: Caller): Promise<TikTokConnectOutcome> {
  const now = deps.now?.() ?? new Date();
  // 32 bytes de entropia, sem caracteres que precisem de escape em querystring.
  const state = randomBytes(32).toString("base64url");

  const inserted = await deps.db.from("tiktok_oauth_states").insert({
    state,
    organization_id: caller.organizationId,
    created_by: caller.userId,
    expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  });

  if (inserted.error !== null) {
    deps.logger.error("tiktok_oauth_state_not_created", { reason: inserted.error.message });

    return { status: "rejected", reason: "não foi possível iniciar a autorização" };
  }

  deps.logger.info("tiktok_oauth_connect_started", {});

  return { status: "redirect", authorizationUrl: buildAuthorizationUrl({ serviceId: deps.serviceId, state }) };
}

export interface TikTokCallbackParams {
  state: string;
  code?: string;
  /** `auth_denied` quando o vendedor recusa (a doc). */
  error?: string;
}

export type TikTokCallbackOutcome =
  | { status: "connected"; shops: { shopId: string; shopName: string | null }[] }
  | { status: "invalid_state" }
  | { status: "rejected"; reason: string };

/**
 * Conclui a autorização: consome o `state`, troca o `code`, lê as lojas
 * autorizadas e grava loja, token (cifrado) e `shop_cipher`. Chamada pelo
 * redirecionamento do próprio TikTok — sem JWT; a única defesa é o `state`.
 */
export async function completeTikTokConnect(
  deps: TikTokShopsDeps,
  params: TikTokCallbackParams,
): Promise<TikTokCallbackOutcome> {
  const now = deps.now?.() ?? new Date();

  // Consumo ATÔMICO, como na Shopee: duas chamadas com o mesmo `state` (aba
  // duplicada, retry do navegador) só deixam uma passar.
  const claimed = await deps.db
    .from("tiktok_oauth_states")
    .update({ consumed_at: now.toISOString() })
    .eq("state", params.state)
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString())
    .select("organization_id, created_by")
    .maybeSingle();

  if (claimed.error !== null || claimed.data === null) {
    return { status: "invalid_state" };
  }

  const { organization_id: organizationId, created_by: createdBy } = claimed.data;

  if (params.error !== undefined || params.code === undefined) {
    deps.logger.info("tiktok_oauth_not_authorized", { error: params.error ?? null });

    return { status: "rejected", reason: "a autorização não foi concluída no TikTok Shop" };
  }

  let token;

  try {
    token = await getAccessToken(deps.client, params.code);
  } catch (error) {
    deps.logger.error("tiktok_oauth_exchange_failed", {
      reason: error instanceof Error ? error.message : "erro desconhecido",
    });

    return { status: "rejected", reason: "não foi possível concluir a autorização com o TikTok Shop" };
  }

  if (token.user_type !== USER_TYPE_SELLER) {
    deps.logger.warn("tiktok_oauth_not_seller", { user_type: token.user_type });

    return { status: "rejected", reason: "a autorização não veio de uma conta de vendedor" };
  }

  let shops: TikTokShop[];

  try {
    shops = await getAuthorizedShops(deps.client, token.access_token);
  } catch (error) {
    deps.logger.error("tiktok_authorized_shops_failed", {
      reason: error instanceof Error ? error.message : "erro desconhecido",
    });

    return { status: "rejected", reason: "não foi possível ler as lojas autorizadas no TikTok Shop" };
  }

  if (shops.length === 0) {
    return { status: "rejected", reason: "o TikTok Shop não devolveu nenhuma loja autorizada" };
  }

  // Um vendedor pode autorizar várias lojas. O par é compartilhado, e o
  // cipher de cada loja é gravado com ela no mesmo lote.
  const lojas = [...new Map(shops.map((shop) => [shop.id, shop])).values()].map((shop) => ({
    shop_id: shop.id,
    shop_name: shop.name ?? null,
    region: shop.region ?? null,
    seller_type: shop.seller_type ?? null,
    shop_code: shop.code ?? null,
    shop_cipher: shop.cipher,
  }));
  const { error } = await deps.db.rpc("tiktok_connect_shops", {
    p_organization_id: organizationId,
    p_created_by: createdBy,
    p_connected_at: now.toISOString(),
    p_shops: lojas,
    p_open_id: token.open_id,
    p_seller_name: token.seller_name ?? null,
    p_granted_scopes: token.granted_scopes ?? null,
    p_access_token_ciphertext: encryptToken(token.access_token, deps.encryptionKey),
    p_refresh_token_ciphertext: encryptToken(token.refresh_token, deps.encryptionKey),
    p_access_token_expires_at: tiktokEpochToIso(token.access_token_expire_in),
    p_refresh_token_expires_at: tiktokEpochToIso(token.refresh_token_expire_in),
  });

  if (error?.code === "PT409") {
    deps.logger.warn("tiktok_shop_other_organization", { shop_ids: lojas.map((loja) => loja.shop_id) });

    return { status: "rejected", reason: "uma das lojas autorizadas já está ligada a outra organização" };
  }

  if (error !== null) {
    deps.logger.error("tiktok_shops_not_stored", { code: error.code });

    return { status: "rejected", reason: "não foi possível gravar as lojas autorizadas" };
  }

  const conectadas = lojas.map((loja) => ({ shopId: loja.shop_id, shopName: loja.shop_name }));

  deps.logger.info("tiktok_shops_connected", { shops: conectadas.length, scopes: token.granted_scopes?.length ?? 0 });

  return { status: "connected", shops: conectadas };
}
