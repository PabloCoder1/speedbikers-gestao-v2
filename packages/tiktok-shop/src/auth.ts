import { z } from "zod";

import { TIKTOK_ERROR_CODES, TIKTOK_SHOP_HOSTS, TikTokShopApiError, type TikTokShopClient } from "./client.js";

/**
 * A autorização da loja (D-645) e renovação coordenada (D-807) —
 * P`authorization-overview-202407`, conferida em 22/10/2026 (`docs/TIKTOK_SHOP.md` §4):
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

/** Limite máximo de instante Unix em segundos suportado por `Date` (±8,64e15 ms). */
export const MAX_UNIX_EPOCH_SECONDS = 8_640_000_000_000;

/**
 * O par de tokens. As duas validades são INSTANTES Unix (em segundos), não
 * durações: o access token vale 7 dias por padrão; o refresh token, a duração
 * de autorização que o vendedor escolheu.
 */
export const tiktokShopTokenSchema = z.object({
  access_token: z.string().min(1),
  access_token_expire_in: z.number().int().positive().max(MAX_UNIX_EPOCH_SECONDS),
  refresh_token: z.string().min(1),
  refresh_token_expire_in: z.number().int().positive().max(MAX_UNIX_EPOCH_SECONDS),
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
  if (!Number.isFinite(segundos) || segundos <= 0 || segundos > MAX_UNIX_EPOCH_SECONDS) {
    throw new RangeError(`Instante Unix inválido do TikTok Shop: ${String(segundos)}`);
  }

  return new Date(segundos * 1000).toISOString();
}

/**
 * Códigos que indicam recusa DEFINITIVA da autorização/refresh no TikTok Shop:
 * a loja precisa ser reautorizada pelo vendedor. Falhas transitórias (5xx, 429,
 * rede, 36009002/36009003) ou de configuração (105005, 106001, 36009033) nunca
 * derrubam a conexão (D-414).
 */
const CODIGOS_RECUSA_DEFINITIVA = new Set<number>([
  TIKTOK_ERROR_CODES.INVALID_AUTH_CODE,
  36004005, // refresh token inválido/expirado
  36004006, // autorização revogada/expirada
  36004007, // token revogado
  105001, // autorização inválida
  105004, // autorização revogada pelo vendedor
  105006, // loja desautorizada
]);

export function isDefinitiveRefreshRefusal(error: unknown): boolean {
  return (
    error instanceof TikTokShopApiError &&
    error.errorClass === "not_retryable" &&
    error.code !== null &&
    CODIGOS_RECUSA_DEFINITIVA.has(error.code)
  );
}

/** Folga padrão para renovar o access token (vale 7 dias): 30 minutos antes. */
export const TIKTOK_REFRESH_BUFFER_MS = 30 * 60 * 1000;
/** TTL da trava de renovação concorrente, espelhando ML/Shopee (D-414/D-780). */
export const TIKTOK_REFRESH_LOCK_MS = 60 * 1000;

export interface TikTokTokenRecord {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly shopCipher: string;
  readonly accessTokenExpiresAt: Date;
}

export interface TikTokRefreshedCredentials {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessTokenExpiresAtIso: string;
  readonly refreshTokenExpiresAtIso: string;
}

export interface TikTokTokenStore<TLock> {
  read(): Promise<{ ok: true; record: TikTokTokenRecord | null } | { ok: false; reason: string }>;
  acquireLock(
    lockUntil: Date,
    now: Date,
  ): Promise<
    | { ok: true; acquired: true; handle: TLock; record: TikTokTokenRecord }
    | { ok: true; acquired: false }
    | { ok: false; reason: string }
  >;
  releaseLock(handle: TLock): Promise<void>;
  saveRefreshed(
    handle: TLock,
    credentials: TikTokRefreshedCredentials,
  ): Promise<{ ok: true; applied: boolean } | { ok: false; reason: string }>;
  markRejected(handle: TLock, reason: string): Promise<{ ok: true; applied: boolean } | { ok: false; reason: string }>;
}

export type TikTokTokenResult =
  | { ok: true; accessToken: string; shopCipher: string }
  | { ok: false; retryable: boolean; reason: string };

/**
 * Coordenador de renovação atômica do token do TikTok Shop (D-807), espelhando
 * `shopee-token.ts` (D-414/D-417/D-780):
 * - devolve o token em cache se ainda está fora da janela de folga;
 * - adquire trava exclusiva e revalida se outra execução já renovou;
 * - solta a trava em `try/catch` (TTL de 60 s protege contra queda de transporte);
 * - só marca a loja em `ERROR` diante de recusa definitiva;
 * - trata erro de persistência após consumo do refresh token como não retentável.
 */
export async function refreshTikTokTokenWithLock<TLock>(options: {
  client: TikTokShopClient;
  store: TikTokTokenStore<TLock>;
  now?: Date;
  bufferMs?: number;
  lockMs?: number;
}): Promise<TikTokTokenResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const bufferMs = options.bufferMs ?? TIKTOK_REFRESH_BUFFER_MS;
  const lockMs = options.lockMs ?? TIKTOK_REFRESH_LOCK_MS;

  if (!Number.isFinite(nowMs) || !Number.isFinite(bufferMs) || bufferMs < 0 || !Number.isFinite(lockMs) || lockMs <= 0) {
    throw new RangeError("Parâmetros temporais inválidos para renovação do token do TikTok Shop.");
  }

  const isFresh = (record: TikTokTokenRecord): boolean => {
    const expiresMs = record.accessTokenExpiresAt.getTime();

    return Number.isFinite(expiresMs) && expiresMs - nowMs > bufferMs;
  };

  const lida = await options.store.read();

  if (!lida.ok) {
    return { ok: false, retryable: true, reason: `falha ao ler a credencial do TikTok Shop: ${lida.reason}` };
  }

  if (lida.record === null) {
    return { ok: false, retryable: false, reason: "loja TikTok Shop sem credencial gravada; conecte de novo" };
  }

  if (isFresh(lida.record)) {
    return { ok: true, accessToken: lida.record.accessToken, shopCipher: lida.record.shopCipher };
  }

  const lockUntil = new Date(nowMs + lockMs);
  const travada = await options.store.acquireLock(lockUntil, now);

  if (!travada.ok) {
    return {
      ok: false,
      retryable: true,
      reason: `falha ao reservar a trava de renovação do TikTok Shop: ${travada.reason}`,
    };
  }

  if (!travada.acquired) {
    return { ok: false, retryable: true, reason: "renovação do token do TikTok Shop em andamento em outra execução" };
  }

  const { handle, record } = travada;
  const soltar = async (): Promise<void> => {
    try {
      await options.store.releaseLock(handle);
    } catch {
      // A trava expira em `lockMs` (60 s); falha de transporte ao soltar não
      // descarta token já renovado nem mascara o erro transitório original.
    }
  };

  if (isFresh(record)) {
    await soltar();

    return { ok: true, accessToken: record.accessToken, shopCipher: record.shopCipher };
  }

  let token: TikTokShopToken;

  try {
    token = await refreshAccessToken(options.client, record.refreshToken);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "erro desconhecido ao renovar o token do TikTok Shop";

    if (!isDefinitiveRefreshRefusal(error)) {
      await soltar();

      return { ok: false, retryable: true, reason };
    }

    const recusada = await options.store.markRejected(
      handle,
      `O TikTok Shop recusou a renovação do acesso: ${reason}`,
    );

    if (!recusada.ok) {
      return { ok: false, retryable: true, reason: "não foi possível registrar a recusa da renovação da loja" };
    }

    if (!recusada.applied) {
      return { ok: false, retryable: true, reason: "a trava de renovação da loja mudou; leia a credencial novamente" };
    }

    return { ok: false, retryable: false, reason };
  }

  const gravada = await options.store.saveRefreshed(handle, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accessTokenExpiresAtIso: tiktokEpochToIso(token.access_token_expire_in),
    refreshTokenExpiresAtIso: tiktokEpochToIso(token.refresh_token_expire_in),
  });

  if (!gravada.ok) {
    return {
      ok: false,
      retryable: false,
      reason: `o token renovado da loja não pôde ser gravado (${gravada.reason}); a loja precisa ser conectada de novo`,
    };
  }

  if (!gravada.applied) {
    return { ok: false, retryable: true, reason: "a trava de renovação da loja mudou; leia a credencial novamente" };
  }

  return { ok: true, accessToken: token.access_token, shopCipher: record.shopCipher };
}
