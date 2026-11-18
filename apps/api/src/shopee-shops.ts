import { randomBytes } from "node:crypto";

import type { AdminClient } from "@sb/db";
import { encryptToken } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import {
  REFRESH_TOKEN_TTL_MS,
  buildAuthorizationUrl,
  getAccessToken,
  getShopInfo,
  shopeeEpochToIso,
  type ShopInfo,
  type ShopeeClient,
} from "@sb/shopee";

import type { Caller } from "./auth.js";

/**
 * Conexão de loja Shopee (D-425): `POST /v1/shopee/connect` +
 * `GET /oauth/shopee/callback` — o mesmo desenho de `ml-accounts.ts`, com uma
 * diferença de fluxo: a loja só é conhecida NO RETORNO da autorização. No
 * Mercado Livre a conta nasce antes, em /contas; aqui o retorno é que cria a
 * linha de `shopee_shops` — uma, ou várias quando quem autoriza é uma conta
 * principal (`main_account_id`).
 *
 * A Partner Key e a chave de cifra dos tokens nunca chegam ao navegador.
 */

const STATE_TTL_MS = 15 * 60 * 1000;

export interface ShopeeShopsDeps {
  db: AdminClient;
  logger: Logger;
  encryptionKey: Buffer;
  client: ShopeeClient;
  /** O endereço deste callback — o domínio precisa ser o declarado no Console da Shopee. */
  redirectUri: string;
  now?: () => Date;
}

export type ShopeeConnectOutcome =
  | { status: "redirect"; authorizationUrl: string }
  | { status: "rejected"; reason: string };

/** Inicia a autorização: grava o `state` (da organização, não de uma loja) e devolve o link. */
export async function startShopeeConnect(deps: ShopeeShopsDeps, caller: Caller): Promise<ShopeeConnectOutcome> {
  const now = deps.now?.() ?? new Date();
  // 32 bytes de entropia, sem caracteres que precisem de escape em querystring.
  const state = randomBytes(32).toString("base64url");

  const inserted = await deps.db.from("shopee_oauth_states").insert({
    state,
    organization_id: caller.organizationId,
    environment: deps.client.environment,
    created_by: caller.userId,
    expires_at: new Date(now.getTime() + STATE_TTL_MS).toISOString(),
  });

  if (inserted.error !== null) {
    deps.logger.error("shopee_oauth_state_not_created", { reason: inserted.error.message });

    return { status: "rejected", reason: "não foi possível iniciar a autorização" };
  }

  deps.logger.info("shopee_oauth_connect_started", { environment: deps.client.environment });

  return {
    status: "redirect",
    authorizationUrl: buildAuthorizationUrl({
      environment: deps.client.environment,
      partnerId: deps.client.partnerId,
      redirectUri: deps.redirectUri,
      state,
    }),
  };
}

export interface ShopeeCallbackParams {
  state: string;
  code?: string;
  shopId?: number;
  mainAccountId?: number;
}

export type ShopeeCallbackOutcome =
  | { status: "connected"; shops: { shopId: number; shopName: string | null }[] }
  | { status: "invalid_state" }
  | { status: "rejected"; reason: string };

/**
 * Conclui a autorização: consome o `state`, troca o `code`, lê cada loja e
 * grava loja e tokens (cifrados). Chamada pelo redirecionamento da própria
 * Shopee — sem JWT; a única defesa é o `state`.
 */
export async function completeShopeeConnect(
  deps: ShopeeShopsDeps,
  params: ShopeeCallbackParams,
): Promise<ShopeeCallbackOutcome> {
  const now = deps.now?.() ?? new Date();

  // Consumo ATÔMICO, como em `ml-accounts.ts`: duas chamadas com o mesmo
  // `state` (aba duplicada, retry do navegador) só deixam uma passar.
  const claimed = await deps.db
    .from("shopee_oauth_states")
    .update({ consumed_at: now.toISOString() })
    .eq("state", params.state)
    .is("consumed_at", null)
    .gt("expires_at", now.toISOString())
    .select("organization_id, environment, created_by")
    .maybeSingle();

  if (claimed.error !== null || claimed.data === null) {
    return { status: "invalid_state" };
  }

  const { organization_id: organizationId, environment, created_by: createdBy } = claimed.data;

  // Um `state` do sandbox não conclui no ambiente de produção, nem o contrário:
  // o partner_id de teste só autoriza loja de teste.
  if (environment !== deps.client.environment) {
    deps.logger.warn("shopee_oauth_environment_mismatch", { state_environment: environment });

    return { status: "rejected", reason: "autorização iniciada em outro ambiente; inicie a conexão novamente" };
  }

  if (params.code === undefined || (params.shopId === undefined && params.mainAccountId === undefined)) {
    return { status: "rejected", reason: "autorização não concluída na Shopee" };
  }

  let token;

  try {
    token = await getAccessToken(
      deps.client,
      params.shopId === undefined
        ? { code: params.code, mainAccountId: params.mainAccountId ?? 0 }
        : { code: params.code, shopId: params.shopId },
    );
  } catch (error) {
    deps.logger.error("shopee_oauth_exchange_failed", {
      reason: error instanceof Error ? error.message : "erro desconhecido",
    });

    return { status: "rejected", reason: "não foi possível concluir a autorização com a Shopee" };
  }

  const shopIds = params.shopId === undefined ? [...new Set(token.shop_id_list ?? [])] : [params.shopId];

  if (shopIds.length === 0) {
    return { status: "rejected", reason: "a Shopee não devolveu nenhuma loja autorizada" };
  }

  const lojas = [];

  for (const shopId of shopIds) {
    // A leitura da loja dá o nome e o vencimento da autorização. Falhar nela
    // não desfaz a conexão: a loja entra sem nome, e a próxima leitura completa.
    let info: ShopInfo | null = null;

    try {
      info = await getShopInfo(deps.client, { accessToken: token.access_token, shopId });
    } catch (error) {
      deps.logger.warn("shopee_shop_info_failed", {
        shop_id: shopId,
        reason: error instanceof Error ? error.message : "erro desconhecido",
      });
    }

    lojas.push({
      shop_id: shopId,
      shop_name: info?.shop_name ?? null,
      region: info?.region ?? null,
      shop_status: info?.status ?? null,
      authorized_at: shopeeEpochToIso(info?.auth_time) ?? now.toISOString(),
      auth_expires_at: shopeeEpochToIso(info?.expire_time),
    });
  }

  // O par inicial é compartilhado pelas lojas de uma conta principal.
  // A RPC verifica o dono na gravação e confirma o lote inteiro numa transação.
  const { error } = await deps.db.rpc("shopee_connect_shops", {
    p_organization_id: organizationId,
    p_created_by: createdBy,
    p_environment: environment,
    p_connected_at: now.toISOString(),
    p_shops: lojas,
    p_access_token_ciphertext: encryptToken(token.access_token, deps.encryptionKey),
    p_refresh_token_ciphertext: encryptToken(token.refresh_token, deps.encryptionKey),
    p_access_token_expires_at: new Date(now.getTime() + token.expire_in * 1000).toISOString(),
    p_refresh_token_expires_at: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
  });

  if (error?.code === "PT409") {
    deps.logger.warn("shopee_shop_other_organization", { shop_ids: shopIds });

    return { status: "rejected", reason: "uma das lojas autorizadas já está ligada a outra organização" };
  }

  if (error !== null) {
    deps.logger.error("shopee_shops_not_stored", { code: error.code });

    return { status: "rejected", reason: "não foi possível gravar as lojas autorizadas" };
  }

  const conectadas = lojas.map((loja) => ({ shopId: loja.shop_id, shopName: loja.shop_name }));

  deps.logger.info("shopee_shops_connected", {
    environment,
    shops: conectadas.length,
    main_account: params.shopId === undefined,
  });

  return { status: "connected", shops: conectadas };
}
