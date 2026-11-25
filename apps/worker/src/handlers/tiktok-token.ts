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
 * Renovação concorrente de access token do TikTok Shop no worker (D-833, `M04`),
 * operando exclusivamente sobre o schema já versionado em
 * `20261022170000_lojas_tiktok_shop.sql` (`tiktok_credentials` e `tiktok_shops`).
 *
 * Espelha `apps/api/src/tiktok-token-store.ts` (D-810) e `shopee-token.ts`
 * (D-426/D-780/D-831): CAS otimista em `(refresh_locked_until, refresh_token_ciphertext)`,
 * `decryptToken` fail-closed (`retryable: false` sem vazar detalhes criptográficos)
 * e liberação segura da trava em `try/catch`.
 */

export interface TikTokTokenDeps {
  db: AdminClient;
  client: TikTokShopClient;
  encryptionKey: Buffer;
}

interface TikTokLockHandle {
  readonly lockUntilIso: string;
  readonly previousRefreshCiphertext: string;
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

export function createWorkerTikTokTokenStore(
  deps: Pick<TikTokTokenDeps, "db" | "encryptionKey">,
  tiktokShopId: string,
  onCorruptedCiphertext?: () => void,
): TikTokTokenStore<TikTokLockHandle> {
  return {
    async read() {
      const lida = await deps.db
        .from("tiktok_credentials")
        .select("shop_cipher, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at")
        .eq("tiktok_shop_id", tiktokShopId)
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
        .eq("tiktok_shop_id", tiktokShopId)
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

        try {
          await deps.db
            .from("tiktok_credentials")
            .update({ refresh_locked_until: null })
            .eq("tiktok_shop_id", tiktokShopId)
            .eq("refresh_locked_until", lockUntilIso);
        } catch {
          // A trava tem TTL curto (60 s); não mascarar o erro definitivo.
        }

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
      try {
        await deps.db
          .from("tiktok_credentials")
          .update({ refresh_locked_until: null })
          .eq("tiktok_shop_id", tiktokShopId)
          .eq("refresh_locked_until", handle.lockUntilIso);
      } catch {
        // Trava expira por TTL; evita mascarar erro original do refresh.
      }
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
        .eq("tiktok_shop_id", tiktokShopId)
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
      try {
        const liberada = await deps.db
          .from("tiktok_credentials")
          .update({ refresh_locked_until: null })
          .eq("tiktok_shop_id", tiktokShopId)
          .eq("refresh_locked_until", handle.lockUntilIso)
          .eq("refresh_token_ciphertext", handle.previousRefreshCiphertext)
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
          .update({ status: "ERROR", last_error: reason })
          .eq("id", tiktokShopId);

        if (marcada.error !== null) {
          return { ok: false, reason: marcada.error.message };
        }

        return { ok: true, applied: true };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : "falha ao marcar loja TikTok em erro",
        };
      }
    },
  };
}

export async function ensureTikTokAccessToken(
  deps: TikTokTokenDeps,
  tiktokShopId: string,
  now: Date = new Date(),
): Promise<TikTokTokenResult> {
  const state = { corrupted: false };
  const store = createWorkerTikTokTokenStore(deps, tiktokShopId, () => {
    state.corrupted = true;
  });

  const result = await refreshTikTokTokenWithLock({
    client: deps.client,
    store,
    now,
  });

  if (!result.ok && state.corrupted) {
    return {
      ok: false,
      retryable: false,
      reason: "credencial cifrada do TikTok Shop inválida ou corrompida",
    };
  }

  return result;
}
