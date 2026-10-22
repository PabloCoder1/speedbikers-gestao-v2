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

  // A MESMA ORGANIZAÇÃO. Uma loja já ligada a outra organização não muda de
  // dono por uma nova autorização. Confere TODAS antes de gravar qualquer uma.
  const existentes = await deps.db
    .from("tiktok_shops")
    .select("shop_id, organization_id")
    .in(
      "shop_id",
      shops.map((shop) => shop.id),
    );

  if (existentes.error !== null) {
    deps.logger.error("tiktok_shop_owner_check_failed", { reason: existentes.error.message });

    return { status: "rejected", reason: "não foi possível conferir as lojas; tente de novo" };
  }

  const deOutra = existentes.data.filter((linha) => linha.organization_id !== organizationId);

  if (deOutra.length > 0) {
    deps.logger.warn("tiktok_shop_other_organization", { shop_ids: deOutra.map((linha) => linha.shop_id) });

    return { status: "rejected", reason: "uma das lojas autorizadas já está ligada a outra organização" };
  }

  const conectadas: { shopId: string; shopName: string | null }[] = [];

  for (const shop of shops) {
    const loja = await deps.db
      .from("tiktok_shops")
      .upsert(
        {
          organization_id: organizationId,
          shop_id: shop.id,
          shop_name: shop.name ?? null,
          region: shop.region ?? null,
          seller_type: shop.seller_type ?? null,
          shop_code: shop.code ?? null,
          open_id: token.open_id,
          seller_name: token.seller_name ?? null,
          granted_scopes: token.granted_scopes ?? null,
          status: "CONNECTED",
          authorized_at: now.toISOString(),
          auth_expires_at: tiktokEpochToIso(token.refresh_token_expire_in),
          connected_at: now.toISOString(),
          last_error: null,
          created_by: createdBy,
        },
        { onConflict: "shop_id" },
      )
      .select("id")
      .single();

    if (loja.error !== null) {
      deps.logger.error("tiktok_shop_not_stored", { shop_id: shop.id, reason: loja.error.message });

      return { status: "rejected", reason: "não foi possível gravar a loja" };
    }

    // O mesmo par vale para as lojas que o vendedor autorizou (a do Brasil é
    // LOCAL, uma loja só); o `cipher` é de cada uma.
    const credenciais = await deps.db.from("tiktok_credentials").upsert(
      {
        tiktok_shop_id: loja.data.id,
        shop_cipher: shop.cipher,
        access_token_ciphertext: encryptToken(token.access_token, deps.encryptionKey),
        refresh_token_ciphertext: encryptToken(token.refresh_token, deps.encryptionKey),
        access_token_expires_at: tiktokEpochToIso(token.access_token_expire_in),
        refresh_token_expires_at: tiktokEpochToIso(token.refresh_token_expire_in),
        refresh_locked_until: null,
      },
      { onConflict: "tiktok_shop_id" },
    );

    if (credenciais.error !== null) {
      deps.logger.error("tiktok_credentials_not_stored", { shop_id: shop.id, reason: credenciais.error.message });

      return { status: "rejected", reason: "não foi possível gravar as credenciais da loja" };
    }

    conectadas.push({ shopId: shop.id, shopName: shop.name ?? null });
  }

  deps.logger.info("tiktok_shops_connected", { shops: conectadas.length, scopes: token.granted_scopes?.length ?? 0 });

  return { status: "connected", shops: conectadas };
}
