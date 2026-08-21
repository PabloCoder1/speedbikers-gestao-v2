import type { ZodType } from "zod";

import { MercadoLivreApiError } from "./errors.js";
import { classifyStatus, computeBackoffDelayMs, parseRetryAfterMs } from "./retry.js";

const DEFAULT_BASE_URL = "https://api.mercadolibre.com";
const DEFAULT_MAX_ATTEMPTS = 4;
/** Docs/API.md: "retryable com tolerância" tem retry limitado, não o mesmo teto do resto. */
const DEFAULT_EVENTUAL_MAX_ATTEMPTS = 3;

export interface MercadoLivreClientConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  eventualMaxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

export interface RequestOptions<T> {
  method: HttpMethod;
  /** Caminho relativo, ex.: `"/orders/search"`. */
  path: string;
  /** Ausente para chamadas públicas (ex.: `/products/search`). */
  accessToken?: string;
  searchParams?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Valida e tipa a resposta — nenhum campo chega ao chamador sem passar pelo schema. */
  schema: ZodType<T>;
  eventualConsistencyTolerant?: boolean;
}

export interface MercadoLivreClient {
  request: <T>(options: RequestOptions<T>) => Promise<T>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildUrl(
  baseUrl: string,
  path: string,
  searchParams: RequestOptions<unknown>["searchParams"],
): string {
  const url = new URL(path, baseUrl);

  if (searchParams !== undefined) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  return url.toString();
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * Cliente HTTP autenticado para a API do Mercado Livre.
 *
 * Um único cliente atende TODAS as contas — o token é passado por chamada
 * (`RequestOptions.accessToken`), nunca preso na instância, porque o worker
 * itera várias contas com o mesmo cliente. Backoff+jitter e classificação de
 * erro seguem `docs/API.md` secao 6 e `docs/MERCADO_LIVRE.md` secao 2.3
 * (D-042: sem número oficial de rate limit — os tetos abaixo são
 * conservadores, ajustáveis por `429` observado em produção).
 */
export function createMercadoLivreClient(
  config: MercadoLivreClientConfig = {},
): MercadoLivreClient {
  const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = config.fetchImpl ?? fetch;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const eventualMaxAttempts = config.eventualMaxAttempts ?? DEFAULT_EVENTUAL_MAX_ATTEMPTS;
  const sleep = config.sleep ?? defaultSleep;

  async function request<T>(options: RequestOptions<T>): Promise<T> {
    const url = buildUrl(baseUrl, options.path, options.searchParams);
    const headers: Record<string, string> = { accept: "application/json" };

    if (options.accessToken !== undefined) {
      headers.authorization = `Bearer ${options.accessToken}`;
    }

    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    let attempt = 1;

    for (;;) {
      const response = await fetchImpl(url, {
        method: options.method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });

      if (response.ok) {
        const json: unknown = response.status === 204 ? undefined : await response.json();
        return options.schema.parse(json);
      }

      const errorClass = classifyStatus(response.status, {
        ...(options.eventualConsistencyTolerant !== undefined
          ? { eventualConsistencyTolerant: options.eventualConsistencyTolerant }
          : {}),
      });

      const attemptsAllowed = errorClass === "retryable_eventual" ? eventualMaxAttempts : maxAttempts;
      const canRetry = errorClass !== "not_retryable" && attempt < attemptsAllowed;

      if (!canRetry) {
        const body = await safeReadJson(response);
        throw new MercadoLivreApiError(
          `Mercado Livre respondeu ${String(response.status)} para ${options.method} ${options.path}.`,
          { status: response.status, errorClass, url, body },
        );
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      await sleep(computeBackoffDelayMs({ attempt, retryAfterMs }));
      attempt += 1;
    }
  }

  return { request };
}
