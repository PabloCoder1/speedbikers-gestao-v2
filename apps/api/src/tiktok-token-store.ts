import type { AdminClient } from "@sb/db";
import { decryptToken, encryptToken } from "@sb/mercado-livre";
import {
  refreshTikTokTokenWithLock,
  type TikTokRefreshedCredentials,
  type TikTokShopClient,
  type TikTokTokenRecord,
  type TikTokTokenResult,
  type TikTokTokenStore,
} from "@sb/tiktok-shop";

/**
 * Adaptador Supabase para renovação atômica de tokens do TikTok Shop (D-810),
 * operando exclusivamente sobre o schema já versionado em
 * `20261022170000_lojas_tiktok_shop.sql` (`tiktok_credentials` e `tiktok_shops`,
 * sem migrations novas).
 *
 * Usa CAS otimista em `(refresh_locked_until, refresh_token_ciphertext)` para
 * garantir que duas execuções concorrentes não soltem ou sobrescrevam a trava
 * uma da outra, cifra tokens com AES-256-GCM e falha fechado sem vazar detalhes
 * criptográficos quando o ciphertext está corrompido.
 */

export interface TikTokLockHandle {
  readonly lockUntilIso: string;
  readonly previousRefreshCiphertext: string;
}

export interface TikTokTokenStoreDeps {
  readonly db: AdminClient;
  readonly encryptionKey: Buffer;
  readonly tiktokShopId: string;
}

interface RawCredentialRow {
  shop_cipher: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  access_token_expires_at: string;
}

function decodeRow(row: RawCredentialRow, encryptionKey: Buffer): TikTokTokenRecord | null {
  try {
    const accessToken = decryptToken(row.access_token_ciphertext, encryptionKey);
    const refreshToken = decryptToken(row.refresh_token_ciphertext, encryptionKey);
    const accessTokenExpiresAt = new Date(row.access_token_expires_at);

    return {
      accessToken,
      refreshToken,
      shopCipher: row.shop_cipher,
      accessTokenExpiresAt,
    };
  } catch {
    return null;
  }
}

export function createSupabaseTikTokTokenStore(
  deps: TikTokTokenStoreDeps,
  onCorruptedCiphertext?: () => void,
): TikTokTokenStore<TikTokLockHandle> {
  return {
    async read() {
      const lida = await deps.db
        .from("tiktok_credentials")
        .select("shop_cipher, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at")
        .eq("tiktok_shop_id", deps.tiktokShopId)
        .maybeSingle();

      if (lida.error !== null) {
        return { ok: false, reason: lida.error.message };
      }

      if (lida.data === null) {
        return { ok: true, record: null };
      }

      const decoded = decodeRow(lida.data, deps.encryptionKey);

      if (decoded === null) {
        onCorruptedCiphertext?.();

        return { ok: false, reason: "credencial cifrada inválida" };
      }

      return { ok: true, record: decoded };
    },

    async acquireLock(lockUntil: Date, now: Date) {
      const lockUntilIso = lockUntil.toISOString();
      const travada = await deps.db
        .from("tiktok_credentials")
        .update({ refresh_locked_until: lockUntilIso })
        .eq("tiktok_shop_id", deps.tiktokShopId)
        .or(`refresh_locked_until.is.null,refresh_locked_until.lt.${now.toISOString()}`)
        .select("shop_cipher, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at")
        .maybeSingle();

      if (travada.error !== null) {
        return { ok: false, reason: travada.error.message };
      }

      if (travada.data === null) {
        return { ok: true, acquired: false };
      }

      const decoded = decodeRow(travada.data, deps.encryptionKey);

      if (decoded === null) {
        onCorruptedCiphertext?.();

        return { ok: false, reason: "credencial cifrada inválida" };
      }

      return {
        ok: true,
        acquired: true,
        handle: {
          lockUntilIso,
          previousRefreshCiphertext: travada.data.refresh_token_ciphertext,
        },
        record: decoded,
      };
    },

    async releaseLock(handle: TikTokLockHandle) {
      await deps.db
        .from("tiktok_credentials")
        .update({ refresh_locked_until: null })
        .eq("tiktok_shop_id", deps.tiktokShopId)
        .eq("refresh_locked_until", handle.lockUntilIso);
    },

    async saveRefreshed(handle: TikTokLockHandle, credentials: TikTokRefreshedCredentials) {
      const gravada = await deps.db
        .from("tiktok_credentials")
        .update({
          access_token_ciphertext: encryptToken(credentials.accessToken, deps.encryptionKey),
          refresh_token_ciphertext: encryptToken(credentials.refreshToken, deps.encryptionKey),
          access_token_expires_at: credentials.accessTokenExpiresAtIso,
          refresh_token_expires_at: credentials.refreshTokenExpiresAtIso,
          refresh_locked_until: null,
        })
        .eq("tiktok_shop_id", deps.tiktokShopId)
        .eq("refresh_locked_until", handle.lockUntilIso)
        .eq("refresh_token_ciphertext", handle.previousRefreshCiphertext)
        .select("tiktok_shop_id")
        .maybeSingle();

      if (gravada.error !== null) {
        return { ok: false, reason: gravada.error.message };
      }

      return { ok: true, applied: gravada.data !== null };
    },

    async markRejected(handle: TikTokLockHandle, reason: string) {
      const liberada = await deps.db
        .from("tiktok_credentials")
        .update({ refresh_locked_until: null })
        .eq("tiktok_shop_id", deps.tiktokShopId)
        .eq("refresh_locked_until", handle.lockUntilIso)
        .select("tiktok_shop_id")
        .maybeSingle();

      if (liberada.error !== null) {
        return { ok: false, reason: liberada.error.message };
      }

      if (liberada.data === null) {
        return { ok: true, applied: false };
      }

      const marcada = await deps.db
        .from("tiktok_shops")
        .update({ status: "ERROR", last_error: reason.slice(0, 500) })
        .eq("id", deps.tiktokShopId);

      if (marcada.error !== null) {
        return { ok: false, reason: marcada.error.message };
      }

      return { ok: true, applied: true };
    },
  };
}

/**
 * Obtém um `accessToken` + `shopCipher` válidos para uma loja TikTok Shop,
 * renovando com trava atômica quando próximo do vencimento.
 */
export async function ensureTikTokShopAccessToken(options: {
  readonly db: AdminClient;
  readonly client: TikTokShopClient;
  readonly encryptionKey: Buffer;
  readonly tiktokShopId: string;
  readonly now?: Date;
}): Promise<TikTokTokenResult> {
  const state = { corrupted: false };
  const store = createSupabaseTikTokTokenStore(
    {
      db: options.db,
      encryptionKey: options.encryptionKey,
      tiktokShopId: options.tiktokShopId,
    },
    () => {
      state.corrupted = true;
    },
  );

  const result = await refreshTikTokTokenWithLock({
    client: options.client,
    store,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  if (!result.ok && state.corrupted) {
    return {
      ok: false,
      retryable: false,
      reason: "credencial cifrada da loja TikTok Shop inválida; conecte a loja novamente",
    };
  }

  return result;
}
