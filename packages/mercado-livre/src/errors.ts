/**
 * As três classes de erro previstas em `docs/API.md` secao 6, espelhadas
 * literalmente pela constraint `sync_errors.error_class` (migration
 * `20260821010000_create_sync_observability.sql`). Usar estes três valores
 * exatos em qualquer lugar que grave em `sync_errors`.
 */
export type MercadoLivreErrorClass = "retryable" | "retryable_eventual" | "not_retryable";

export interface MercadoLivreApiErrorOptions {
  status: number;
  errorClass: MercadoLivreErrorClass;
  url: string;
  /** Corpo de erro devolvido pelo Mercado Livre (pode ser `undefined` se não veio JSON). */
  body?: unknown;
  cause?: unknown;
}

/**
 * Erro lançado por qualquer chamada ao Mercado Livre que não pôde (ou não
 * deveria mais) ser repetida.
 *
 * Nunca inclui `access_token`, `client_secret` nem `refresh_token`: só carrega
 * a URL chamada (sem query string sensível — tokens vão no header) e o corpo
 * de erro que o próprio Mercado Livre devolveu.
 */
export class MercadoLivreApiError extends Error {
  readonly status: number;
  readonly errorClass: MercadoLivreErrorClass;
  readonly url: string;
  readonly body: unknown;

  constructor(message: string, options: MercadoLivreApiErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "MercadoLivreApiError";
    this.status = options.status;
    this.errorClass = options.errorClass;
    this.url = options.url;
    this.body = options.body;
  }
}
