import type { AdminClient } from "@sb/db";
import { decryptToken, encryptToken } from "@sb/mercado-livre";
import { REFRESH_TOKEN_TTL_MS, isDefinitiveRefreshRefusal, refreshAccessToken, type ShopeeClient } from "@sb/shopee";

/**
 * O access_token de uma loja Shopee, renovado quando falta pouco (D-426).
 *
 * O desenho é o de `ml-token.ts` depois de D-414/D-417:
 *
 * - a TRAVA devolve a credencial, e só ela vale dali em diante — duas
 *   execuções que leram o mesmo refresh_token não renovam as duas (na Shopee
 *   o refresh_token é de USO ÚNICO: a segunda renovação com ele seria
 *   recusada e derrubaria a loja);
 * - credencial que outra execução já renovou volta sem chamar a Shopee;
 * - só a RECUSA DEFINITIVA (`isDefinitiveRefreshRefusal`) marca a loja como
 *   ERROR; rede, 5xx, 429 e timeout são passageiros e a loja segue conectada.
 *   A renovação só pode gravar ou soltar a trava que adquiriu (D-659).
 */

export interface ShopeeTokenDeps {
  db: AdminClient;
  client: ShopeeClient;
  encryptionKey: Buffer;
}

export type ShopeeTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; retryable: boolean; reason: string };

/** Renova com folga: o access_token vale 4 h. */
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const REFRESH_LOCK_MS = 60 * 1000;

export async function ensureShopeeAccessToken(
  deps: ShopeeTokenDeps,
  loja: { id: string; shopId: number },
  now: Date,
): Promise<ShopeeTokenResult> {
  const lida = await deps.db
    .from("shopee_credentials")
    .select("access_token_ciphertext, access_token_expires_at")
    .eq("shopee_shop_id", loja.id)
    .maybeSingle();

  if (lida.error !== null) {
    return { ok: false, retryable: true, reason: `falha ao ler a credencial da loja: ${lida.error.message}` };
  }

  if (lida.data === null) {
    return { ok: false, retryable: false, reason: "loja Shopee sem credencial gravada; conecte de novo" };
  }

  if (new Date(lida.data.access_token_expires_at).getTime() - now.getTime() > REFRESH_BUFFER_MS) {
    return { ok: true, accessToken: decryptToken(lida.data.access_token_ciphertext, deps.encryptionKey) };
  }

  // A trava, atômica, devolvendo a credencial do MOMENTO da trava.
  const travadaAte = new Date(now.getTime() + REFRESH_LOCK_MS).toISOString();
  const travada = await deps.db
    .from("shopee_credentials")
    .update({ refresh_locked_until: travadaAte })
    .eq("shopee_shop_id", loja.id)
    .or(`refresh_locked_until.is.null,refresh_locked_until.lt.${now.toISOString()}`)
    .select("access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at")
    .maybeSingle();

  if (travada.error !== null || travada.data === null) {
    return { ok: false, retryable: true, reason: "renovação do token da loja em andamento em outra execução" };
  }

  const soltar = async (): Promise<void> => {
    await deps.db
      .from("shopee_credentials")
      .update({ refresh_locked_until: null })
      .eq("shopee_shop_id", loja.id)
      .eq("refresh_locked_until", travadaAte);
  };

  // Outra execução renovou entre a leitura e a trava: usa o que ela gravou.
  if (new Date(travada.data.access_token_expires_at).getTime() - now.getTime() > REFRESH_BUFFER_MS) {
    await soltar();

    return { ok: true, accessToken: decryptToken(travada.data.access_token_ciphertext, deps.encryptionKey) };
  }

  let token;

  try {
    token = await refreshAccessToken(deps.client, {
      refreshToken: decryptToken(travada.data.refresh_token_ciphertext, deps.encryptionKey),
      shopId: loja.shopId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "erro desconhecido ao renovar o token da loja";

    if (!isDefinitiveRefreshRefusal(error)) {
      await soltar();

      return { ok: false, retryable: true, reason };
    }

    const recusada = await deps.db.rpc("shopee_reject_token_refresh", {
      p_shopee_shop_id: loja.id,
      p_locked_until: travadaAte,
      p_error: `A Shopee recusou a renovação do acesso: ${reason}`,
    });

    if (recusada.error !== null) {
      return { ok: false, retryable: true, reason: "não foi possível registrar a recusa da renovação da loja" };
    }

    if (!recusada.data) {
      return { ok: false, retryable: true, reason: "a trava de renovação da loja mudou; leia a credencial novamente" };
    }

    return { ok: false, retryable: false, reason };
  }

  const gravada = await deps.db
    .from("shopee_credentials")
    .update({
      access_token_ciphertext: encryptToken(token.access_token, deps.encryptionKey),
      refresh_token_ciphertext: encryptToken(token.refresh_token, deps.encryptionKey),
      access_token_expires_at: new Date(now.getTime() + token.expire_in * 1000).toISOString(),
      refresh_token_expires_at: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      refresh_locked_until: null,
    })
    .eq("shopee_shop_id", loja.id)
    .eq("refresh_locked_until", travadaAte)
    .select("shopee_shop_id")
    .maybeSingle();

  if (gravada.error !== null) {
    // O refresh_token antigo já foi consumido e o novo não ficou gravado: sem
    // nova tentativa, com o motivo dito (mesma regra de D-417 §1).
    return {
      ok: false,
      retryable: false,
      reason: `o token renovado da loja não pôde ser gravado (${gravada.error.message}); a loja precisa ser conectada de novo`,
    };
  }

  if (gravada.data === null) {
    return { ok: false, retryable: true, reason: "a trava de renovação da loja mudou; leia a credencial novamente" };
  }

  return { ok: true, accessToken: token.access_token };
}
