import type { MercadoLivreErrorClass } from "./errors.js";

export interface ClassifyStatusOptions {
  /**
   * Alguns 404 são consistência eventual (ex.: pedido consultado logo após a
   * notificação do webhook, antes do Mercado Livre terminar de propagar). Só
   * o chamador sabe se É esse caso — tratar TODO 404 como eventual esconderia
   * um id genuinamente errado atrás de retries inúteis.
   */
  eventualConsistencyTolerant?: boolean;
}

/**
 * Classifica uma resposta HTTP conforme `docs/API.md` secao 6 e
 * `docs/MERCADO_LIVRE.md` secao 2.3: 429 e 5xx são retryable; 404 tolerado
 * pelo chamador é retryable_eventual; o resto não é retryable.
 */
export function classifyStatus(
  status: number,
  options: ClassifyStatusOptions = {},
): MercadoLivreErrorClass {
  if (status === 429 || status >= 500) {
    return "retryable";
  }

  if (status === 404 && options.eventualConsistencyTolerant === true) {
    return "retryable_eventual";
  }

  return "not_retryable";
}

export interface BackoffOptions {
  /** Número da tentativa que está prestes a ser feita, começando em 1. */
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Valor já convertido em milissegundos de um `Retry-After` recebido. */
  retryAfterMs?: number | undefined;
  /** Injetável para teste determinístico — produção usa `Math.random`. */
  random?: () => number;
}

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Atraso antes da próxima tentativa: "full jitter" exponencial (um valor
 * aleatório entre 0 e o teto exponencial), no mínimo o `Retry-After` quando o
 * Mercado Livre mandar um.
 *
 * A documentação oficial não confirma que o Mercado Livre envia `Retry-After`
 * nem cabeçalhos `X-RateLimit-*` (`docs/MERCADO_LIVRE.md` secao 2.3, D-042) —
 * por isso o cabeçalho é honrado quando presente, mas o backoff nunca depende
 * dele para existir.
 */
export function computeBackoffDelayMs(options: BackoffOptions): number {
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;

  const exponentialCeilingMs = Math.min(baseDelayMs * 2 ** (options.attempt - 1), maxDelayMs);
  const jitteredMs = random() * exponentialCeilingMs;

  if (options.retryAfterMs !== undefined) {
    return Math.max(jitteredMs, options.retryAfterMs);
  }

  return jitteredMs;
}

/**
 * Interpreta um cabeçalho `Retry-After`: segundos (`"120"`) ou data HTTP
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`), como definido na RFC 9110. Devolve
 * `undefined` quando ausente ou malformado — um cabeçalho ruim não deve
 * travar a chamada, só faz o backoff cair no valor calculado por jitter.
 */
export function parseRetryAfterMs(
  headerValue: string | null,
  now: () => Date = () => new Date(),
): number | undefined {
  if (headerValue === null || headerValue.trim().length === 0) {
    return undefined;
  }

  const seconds = Number(headerValue);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(headerValue);

  if (Number.isNaN(dateMs)) {
    return undefined;
  }

  const deltaMs = dateMs - now().getTime();

  return deltaMs > 0 ? deltaMs : 0;
}
