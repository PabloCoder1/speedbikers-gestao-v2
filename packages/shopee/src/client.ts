import { createHmac } from "node:crypto";

import type { z } from "zod";

/**
 * Cliente da Shopee Open API v2 (D-425).
 *
 * Contrato conferido na documentação oficial em 13/10/2026
 * (`docs/SHOPEE.md`; open.shopee.com/developer-guide/16 e /20):
 *
 * - toda chamada leva `partner_id`, `timestamp` (válido por 5 minutos) e `sign`
 *   na query; a de loja leva também `access_token` e `shop_id`;
 * - `sign` = HMAC-SHA256, em hexadecimal minúsculo, da concatenação
 *   `partner_id + caminho + timestamp` (API pública) ou
 *   `partner_id + caminho + timestamp + access_token + shop_id` (API de loja),
 *   com a Partner Key como chave;
 * - a resposta vem com `error` (vazio no sucesso), `message` e `request_id`,
 *   mesmo com HTTP 200 — erro de negócio não muda o status.
 */

export type ShopeeEnvironment = "sandbox" | "live";

/**
 * Os endereços do BRASIL. No sandbox a API é a global (a documentação não tem
 * sandbox de API brasileiro), mas a página de autorização é a brasileira — a
 * loja de teste é criada no mercado Brasil.
 */
export const SHOPEE_HOSTS: Record<ShopeeEnvironment, { api: string; auth: string }> = {
  sandbox: {
    api: "https://openplatform.sandbox.test-stable.shopee.sg",
    // A tabela oficial lista open.sandbox.test-stable.shopee.com.br para o
    // Brasil, mas o host NAO EXISTE no DNS (conferido em 13/10/2026). O
    // sandbox e global: esta pagina aceita o partner_id de teste e leva ao
    // login da conta de teste (account.sandbox.test-stable.shopee.com).
    auth: "https://open.sandbox.test-stable.shopee.com/auth",
  },
  live: {
    api: "https://openplatform.shopee.com.br",
    auth: "https://open.shopee.com.br/auth",
  },
};

export type ShopeeErrorClass = "retryable" | "not_retryable";

/**
 * Códigos de erro da Shopee que pedem só "tente depois" (referência das APIs
 * de pedido, financeiro e catálogo, conferida em 13/10/2026). Vêm com HTTP 200.
 */
const CODIGOS_PASSAGEIROS = new Set(["error_server", "error_network", "error_inner", "error_system_busy", "error_rate_limit"]);

/** Erro da Shopee: HTTP fora de 2xx, ou `error` preenchido no corpo. Nunca carrega token nem assinatura. */
export class ShopeeApiError extends Error {
  readonly status: number;
  /** O código de erro da Shopee (`error_auth`, `error_param`...), ou `null` sem corpo legível. */
  readonly code: string | null;
  /**
   * O código sem o prefixo de módulo: a Shopee manda às vezes
   * `product.error_item_not_found` no lugar de `error_item_not_found` (D-428).
   */
  readonly baseCode: string | null;
  readonly requestId: string | null;
  readonly errorClass: ShopeeErrorClass;

  constructor(message: string, options: { status: number; code: string | null; requestId: string | null }) {
    super(message);
    this.name = "ShopeeApiError";
    this.status = options.status;
    this.code = options.code;
    this.baseCode = options.code === null ? null : options.code.replace(/^[a-z_]+\./, "");
    this.requestId = options.requestId;
    // `error_network` é a chamada interna da Shopee que falhou (D-427);
    // `error_inner`, `error_system_busy` e `error_rate_limit` pedem "tente
    // depois" nas páginas do catálogo (D-428). Todos passageiros.
    const passageiro =
      options.status === 429 ||
      options.status >= 500 ||
      (this.baseCode !== null && CODIGOS_PASSAGEIROS.has(this.baseCode));

    this.errorClass = passageiro ? "retryable" : "not_retryable";
  }
}

export interface ShopeeClientConfig {
  environment: ShopeeEnvironment;
  partnerId: number;
  partnerKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** Teto por chamada; o padrão é o mesmo do cliente do Mercado Livre. */
  requestTimeoutMs?: number;
}

export interface ShopeeRequest<T> {
  method: "GET" | "POST";
  path: string;
  /** Chamada de LOJA: os dois juntos entram na assinatura e na query. */
  shop?: { accessToken: string; shopId: number };
  /** Lista vira parâmetro REPETIDO (`item_status=NORMAL&item_status=UNLIST`), como pede `get_item_list`. */
  query?: Record<string, string | readonly string[]>;
  body?: unknown;
  schema: z.ZodType<T>;
}

export interface ShopeeClient {
  readonly environment: ShopeeEnvironment;
  readonly partnerId: number;
  request<T>(request: ShopeeRequest<T>): Promise<T>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** A base da assinatura, na ordem exata da documentação. */
export function signBaseString(
  partnerId: number,
  path: string,
  timestamp: number,
  shop?: { accessToken: string; shopId: number },
): string {
  const base = `${String(partnerId)}${path}${String(timestamp)}`;

  return shop === undefined ? base : `${base}${shop.accessToken}${String(shop.shopId)}`;
}

export function sign(partnerKey: string, baseString: string): string {
  return createHmac("sha256", partnerKey).update(baseString).digest("hex");
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor !== "" ? valor : null;
}

export function createShopeeClient(config: ShopeeClientConfig): ShopeeClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  const host = SHOPEE_HOSTS[config.environment].api;

  return {
    environment: config.environment,
    partnerId: config.partnerId,
    async request<T>(request: ShopeeRequest<T>): Promise<T> {
      const timestamp = Math.floor((config.now?.() ?? new Date()).getTime() / 1000);
      const url = new URL(`${host}${request.path}`);

      url.searchParams.set("partner_id", String(config.partnerId));
      url.searchParams.set("timestamp", String(timestamp));

      if (request.shop !== undefined) {
        url.searchParams.set("access_token", request.shop.accessToken);
        url.searchParams.set("shop_id", String(request.shop.shopId));
      }

      url.searchParams.set(
        "sign",
        sign(config.partnerKey, signBaseString(config.partnerId, request.path, timestamp, request.shop)),
      );

      for (const [chave, valor] of Object.entries(request.query ?? {})) {
        if (typeof valor === "string") {
          url.searchParams.set(chave, valor);
        } else {
          for (const item of valor) url.searchParams.append(chave, item);
        }
      }

      const response = await fetchImpl(url, {
        method: request.method,
        headers: { "content-type": "application/json" },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      });

      const corpo: unknown = await response.json().catch(() => null);
      const envelope = corpo !== null && typeof corpo === "object" ? (corpo as Record<string, unknown>) : {};
      const code = texto(envelope.error);

      // A mensagem leva o método e o CAMINHO, nunca a URL: a query carrega o
      // token e a assinatura.
      if (!response.ok || code !== null) {
        const detalhe = texto(envelope.message);

        throw new ShopeeApiError(
          `Shopee respondeu ${String(response.status)}${code === null ? "" : ` (${code})`} para ${request.method} ${request.path}${detalhe === null ? "." : `: ${detalhe}`}`,
          { status: response.status, code, requestId: texto(envelope.request_id) },
        );
      }

      return request.schema.parse(corpo);
    },
  };
}
