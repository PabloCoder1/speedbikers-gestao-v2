import { z } from "zod";

import { sign } from "./sign.js";

/**
 * Cliente do TikTok Shop Open API (D-645), só leitura, como o da Shopee.
 *
 * Contrato conferido na documentação oficial (`docs/TIKTOK_SHOP.md` §2, §3 e
 * §5):
 *
 * - a API de loja fica em `open-api.tiktokglobalshop.com` (todos os mercados);
 *   o token, em `auth.tiktok-shops.com`;
 * - toda chamada leva `app_key`, `timestamp` (em segundos) e `sign` na query, e
 *   a de loja leva também o `shop_cipher`; o access token vai no cabeçalho
 *   `x-tts-access-token`, fora da assinatura;
 * - a resposta é `{code, message, request_id, data}`, com `code` 0 no sucesso.
 *   A doc não confirma se o erro de negócio vem com HTTP 200 (§14, item 1): o
 *   cliente olha os DOIS sinais.
 */

export const TIKTOK_SHOP_HOSTS = {
  api: "https://open-api.tiktokglobalshop.com",
  // Fora dos EUA (a doc divide só em "EUA x resto do mundo"; o Brasil está no
  // resto, pela lista de regiões).
  authorize: "https://services.tiktokshop.com/open/authorize",
  token: "https://auth.tiktok-shops.com",
} as const;

export type TikTokShopErrorClass = "retryable" | "not_retryable";

/**
 * Os códigos que a doc manda repetir (P`common-errors`): o limite de taxa
 * (`36009002`, com HTTP 429) e o erro interno (`36009003`).
 */
const CODIGOS_PASSAGEIROS = new Set([36009002, 36009003]);

/** Erro do TikTok Shop: HTTP fora de 2xx, ou `code` diferente de 0. Nunca carrega token, segredo nem assinatura. */
export class TikTokShopApiError extends Error {
  readonly status: number;
  /** O `code` do envelope, ou `null` sem corpo legível. */
  readonly code: number | null;
  readonly requestId: string | null;
  readonly errorClass: TikTokShopErrorClass;

  constructor(message: string, options: { status: number; code: number | null; requestId: string | null }) {
    super(message);
    this.name = "TikTokShopApiError";
    this.status = options.status;
    this.code = options.code;
    this.requestId = options.requestId;
    const passageiro =
      options.status === 429 || options.status >= 500 || (options.code !== null && CODIGOS_PASSAGEIROS.has(options.code));

    this.errorClass = passageiro ? "retryable" : "not_retryable";
  }
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

async function lerEnvelope(response: Response): Promise<z.infer<typeof envelopeSchema>> {
  const corpo: unknown = await response.json().catch(() => null);
  const lido = envelopeSchema.safeParse(corpo);

  return lido.success ? lido.data : {};
}

function erroDe(
  response: Response,
  envelope: z.infer<typeof envelopeSchema>,
  method: string,
  path: string,
): TikTokShopApiError | null {
  const code = envelope.code ?? null;

  if (response.ok && code === 0) return null;

  // A mensagem leva o método e o CAMINHO, nunca a URL: a query carrega a
  // assinatura e, no token, o `app_secret`.
  const detalhe = envelope.message === undefined || envelope.message === "" ? "." : `: ${envelope.message}`;

  return new TikTokShopApiError(
    `TikTok Shop respondeu ${String(response.status)}${code === null ? "" : ` (${String(code)})`} para ${method} ${path}${detalhe}`,
    { status: response.status, code, requestId: envelope.request_id ?? null },
  );
}

export function createTikTokShopClient(config: TikTokShopClientConfig): TikTokShopClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const timeout = (): AbortSignal => AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

  return {
    appKey: config.appKey,
    async request<T>(request: TikTokShopRequest<T>): Promise<T> {
      const timestamp = Math.floor((config.now?.() ?? new Date()).getTime() / 1000);
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

      const envelope = await lerEnvelope(response);
      const erro = erroDe(response, envelope, request.method, request.path);

      if (erro !== null) throw erro;

      return request.schema.parse(envelope.data);
    },
    async requestToken<T>(path: string, params: Readonly<Record<string, string>>, schema: z.ZodType<T>): Promise<T> {
      const url = new URL(`${TIKTOK_SHOP_HOSTS.token}${path}`);

      url.searchParams.set("app_key", config.appKey);
      url.searchParams.set("app_secret", config.appSecret);
      for (const [chave, valor] of Object.entries(params)) url.searchParams.set(chave, valor);

      const response = await fetchImpl(url, { method: "GET", signal: timeout() });
      const envelope = await lerEnvelope(response);
      const erro = erroDe(response, envelope, "GET", path);

      if (erro !== null) throw erro;

      return schema.parse(envelope.data);
    },
  };
}
