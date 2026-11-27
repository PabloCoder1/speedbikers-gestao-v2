import { z } from "zod";

import { sign } from "./sign.js";

/**
 * Cliente do TikTok Shop Open API (D-645, D-807), só leitura, como o da Shopee.
 *
 * Contrato conferido na documentação oficial (`docs/TIKTOK_SHOP.md` §2, §3, §5
 * e §11):
 *
 * - a API de loja fica em `open-api.tiktokglobalshop.com` (todos os mercados);
 *   o token, em `auth.tiktok-shops.com`;
 * - toda chamada leva `app_key`, `timestamp` (em segundos) e `sign` na query, e
 *   a de loja leva também o `shop_cipher`; o access token vai no cabeçalho
 *   `x-tts-access-token`, fora da assinatura;
 * - a resposta é `{code, message, request_id, data}`, com `code` 0 no sucesso.
 *   A doc não confirma se o erro de negócio vem com HTTP 200 (§14, item 1): o
 *   cliente olha os DOIS sinais e extrai `Retry-After` quando presente.
 */

export const TIKTOK_SHOP_HOSTS = {
  api: "https://open-api.tiktokglobalshop.com",
  // Fora dos EUA (a doc divide só em "EUA x resto do mundo"; o Brasil está no
  // resto, pela lista de regiões).
  authorize: "https://services.tiktokshop.com/open/authorize",
  token: "https://auth.tiktok-shops.com",
} as const;

/** Códigos de erro documentados em `docs/TIKTOK_SHOP.md` §5 (`P`common-errors``). */
export const TIKTOK_ERROR_CODES = {
  RATE_LIMIT: 36009002,
  INTERNAL: 36009003,
  TOKEN_EXPIRED: 105002,
  SCOPE_MISSING: 105005,
  INVALID_SIGN: 106001,
  MISSING_CIPHER: 106013,
  WRONG_SHOP_TOKEN: 101000,
  IP_NOT_ALLOWED: 36009033,
  INVALID_AUTH_CODE: 36004004,
} as const;

export type TikTokShopErrorClass = "retryable" | "not_retryable";

/** Credenciais de loja exigidas por toda chamada escopada no TikTok Shop. */
export interface TikTokShopAuth {
  readonly accessToken: string;
  readonly shopCipher: string;
}

/**
 * Os códigos que a doc manda repetir (`P`common-errors``): o limite de taxa
 * (`36009002`, com HTTP 429) e o erro interno (`36009003`).
 */
const CODIGOS_PASSAGEIROS = new Set<number>([TIKTOK_ERROR_CODES.RATE_LIMIT, TIKTOK_ERROR_CODES.INTERNAL]);

const MAX_RETRY_AFTER_MS = 3_600_000;

/**
 * Interpreta o cabeçalho `Retry-After` (segundos inteiros ou HTTP-date) em ms,
 * limitado a `[0, 3_600_000]`. Valores ausentes ou malformados devolvem `null`.
 */
export function parseRetryAfterMs(header: string | null | undefined, now: Date = new Date()): number | null {
  if (header === null || header === undefined) return null;

  const trimmed = header.trim();

  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);

    if (!Number.isSafeInteger(seconds)) return null;

    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  // Exige texto de data HTTP (evita `Date.parse("-5")` -> ano -5 no V8).
  if (!/[A-Za-z]{3}/.test(trimmed)) return null;

  const parsedMs = Date.parse(trimmed);
  const nowMs = now.getTime();

  if (!Number.isFinite(parsedMs) || !Number.isFinite(nowMs)) return null;

  return Math.min(Math.max(parsedMs - nowMs, 0), MAX_RETRY_AFTER_MS);
}

/**
 * Converte string monetária/decimal do TikTok Shop para número finito.
 * Ausência, string vazia ou texto não numérico devolvem `null` — nunca `0`.
 */
export function parseTikTokDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;

  const trimmed = value.trim();

  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;

  const parsed = Number(trimmed);

  return Number.isFinite(parsed) ? parsed : null;
}

/** Erro do TikTok Shop: HTTP fora de 2xx, ou `code` diferente de 0. Nunca carrega token, segredo nem assinatura. */
export class TikTokShopApiError extends Error {
  readonly status: number;
  /** O `code` do envelope, ou `null` sem corpo legível. */
  readonly code: number | null;
  readonly requestId: string | null;
  readonly errorClass: TikTokShopErrorClass;
  /** Intervalo sugerido pelo cabeçalho `Retry-After`, em ms, quando presente. */
  readonly retryAfterMs: number | null;

  constructor(
    message: string,
    options: {
      status: number;
      code: number | null;
      requestId: string | null;
      errorClass?: TikTokShopErrorClass;
      retryAfterMs?: number | null;
    },
  ) {
    super(message);
    this.name = "TikTokShopApiError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    this.retryAfterMs = options.retryAfterMs ?? null;
    const passageiro =
      options.status === 429 || options.status >= 500 || (options.code !== null && CODIGOS_PASSAGEIROS.has(options.code));

    this.errorClass = options.errorClass ?? (passageiro ? "retryable" : "not_retryable");
  }
}

export function isRateLimitError(error: unknown): boolean {
  return (
    error instanceof TikTokShopApiError &&
    (error.status === 429 || error.code === TIKTOK_ERROR_CODES.RATE_LIMIT)
  );
}

export function isTokenExpiredError(error: unknown): boolean {
  return error instanceof TikTokShopApiError && error.code === TIKTOK_ERROR_CODES.TOKEN_EXPIRED;
}

export function isScopeMissingError(error: unknown): boolean {
  return error instanceof TikTokShopApiError && error.code === TIKTOK_ERROR_CODES.SCOPE_MISSING;
}

export interface TikTokShopClientConfig {
  appKey: string;
  appSecret: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Teto por chamada; o padrão é o mesmo dos clientes do Mercado Livre e da Shopee. */
  requestTimeoutMs?: number;
}

export interface TikTokShopRequest<T> {
  method: "GET" | "POST";
  /** O caminho com a versão, como vai depois do host (`/authorization/202309/shops`). */
  path: string;
  /** O token do vendedor; vai no cabeçalho, fora da assinatura. */
  accessToken?: string;
  /** A chamada de LOJA: o `shop_cipher` entra na query e na assinatura. */
  shopCipher?: string;
  query?: Readonly<Record<string, string>>;
  body?: unknown;
  /** O schema de `data`. */
  schema: z.ZodType<T>;
}

export interface TikTokShopClient {
  readonly appKey: string;
  request<T>(request: TikTokShopRequest<T>): Promise<T>;
  /**
   * As chamadas do TOKEN (`/api/v2/token/get` e `/refresh`): o `app_secret` vai
   * na query, por contrato. A URL dessas chamadas nunca entra em mensagem nem
   * log.
   */
  requestToken<T>(path: string, params: Readonly<Record<string, string>>, schema: z.ZodType<T>): Promise<T>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

const envelopeSchema = z.object({
  code: z.number().int().optional(),
  message: z.string().optional(),
  request_id: z.string().optional(),
  data: z.unknown().optional(),
});

function assertRelativePath(path: string): void {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new RangeError(`Caminho inválido para chamada do TikTok Shop: ${path}`);
  }
}

async function lerEnvelope(response: Response): Promise<{ envelope: z.infer<typeof envelopeSchema>; jsonValido: boolean }> {
  let corpo: unknown;

  try {
    corpo = await response.json();
  } catch {
    return { envelope: {}, jsonValido: false };
  }

  const lido = envelopeSchema.safeParse(corpo);

  return { envelope: lido.success ? lido.data : {}, jsonValido: true };
}

function erroDe(
  response: Response,
  leitura: { envelope: z.infer<typeof envelopeSchema>; jsonValido: boolean },
  method: string,
  path: string,
  now: Date,
): TikTokShopApiError | null {
  const { envelope, jsonValido } = leitura;
  const code = envelope.code ?? null;

  if (response.ok && code === 0) return null;

  // A mensagem leva o método e o CAMINHO, nunca a URL: a query carrega a
  // assinatura e, no token, o `app_secret`.
  const detalhe = envelope.message === undefined || envelope.message === "" ? "." : `: ${envelope.message}`;
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), now);

  if (response.ok && !jsonValido) {
    return new TikTokShopApiError(
      `TikTok Shop respondeu ${String(response.status)} com corpo não-JSON para ${method} ${path}.`,
      { status: response.status, code: null, requestId: null, errorClass: "retryable", retryAfterMs },
    );
  }

  return new TikTokShopApiError(
    `TikTok Shop respondeu ${String(response.status)}${code === null ? "" : ` (${String(code)})`} para ${method} ${path}${detalhe}`,
    { status: response.status, code, requestId: envelope.request_id ?? null, retryAfterMs },
  );
}

export function createTikTokShopClient(config: TikTokShopClientConfig): TikTokShopClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeout = (): AbortSignal => AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  return {
    appKey: config.appKey,
    async request<T>(request: TikTokShopRequest<T>): Promise<T> {
      assertRelativePath(request.path);

      const now = config.now?.() ?? new Date();
      const nowMs = now.getTime();

      if (!Number.isFinite(nowMs)) {
        throw new RangeError("Relógio inválido ao assinar chamada do TikTok Shop.");
      }

      const timestamp = Math.floor(nowMs / 1000);
      const query: Record<string, string> = {
        ...(request.query ?? {}),
        app_key: config.appKey,
        timestamp: String(timestamp),
        ...(request.shopCipher === undefined ? {} : { shop_cipher: request.shopCipher }),
      };
      // A MESMA string assinada e enviada: re-serializar o JSON entre as duas
      // mudaria a assinatura (a doc avisa).
      const body = request.body === undefined ? undefined : JSON.stringify(request.body);
      const url = new URL(`${TIKTOK_SHOP_HOSTS.api}${request.path}`);

      for (const [chave, valor] of Object.entries(query)) url.searchParams.set(chave, valor);
      url.searchParams.set("sign", sign(config.appSecret, request.path, query, body));

      const response = await fetchImpl(url, {
        method: request.method,
        headers: {
          "content-type": "application/json",
          ...(request.accessToken === undefined ? {} : { "x-tts-access-token": request.accessToken }),
        },
        ...(body === undefined ? {} : { body }),
        signal: timeout(),
      });

      const leitura = await lerEnvelope(response);
      const erro = erroDe(response, leitura, request.method, request.path, now);

      if (erro !== null) throw erro;

      return request.schema.parse(leitura.envelope.data);
    },
    async requestToken<T>(path: string, params: Readonly<Record<string, string>>, schema: z.ZodType<T>): Promise<T> {
      assertRelativePath(path);

      const now = config.now?.() ?? new Date();
      const url = new URL(`${TIKTOK_SHOP_HOSTS.token}${path}`);

      for (const [chave, valor] of Object.entries(params)) url.searchParams.set(chave, valor);
      // Credenciais do app prevalecem sobre qualquer chave vinda de `params`.
      url.searchParams.set("app_key", config.appKey);
      url.searchParams.set("app_secret", config.appSecret);

      const response = await fetchImpl(url, { method: "GET", signal: timeout() });
      const leitura = await lerEnvelope(response);
      const erro = erroDe(response, leitura, "GET", path, now);

      if (erro !== null) throw erro;

      return schema.parse(leitura.envelope.data);
    },
  };
}
