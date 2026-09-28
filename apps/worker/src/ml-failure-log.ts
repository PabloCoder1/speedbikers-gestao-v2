import type { MercadoLivreFailure } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

/**
 * O registro da resposta de erro FINAL do Mercado Livre (`onFailure` do
 * cliente HTTP), criado no incidente de 25/09 (D-362, D-414): um 403 sem o
 * corpo gravado não dizia de onde vinha a recusa.
 *
 * O 404 fica de fora. O corpo dele só diz "não encontrado", e ele é a resposta
 * NORMAL de caminhos que o worker já trata -- `/orders/{id}/discounts` de
 * pedido sem desconto devolve `discount_not_found` a quase todo pedido, e isso
 * enchia o log de avisos que não são problema. Quando um 404 derruba um job,
 * o `job_failed` já registra o motivo.
 */
export function registrarFalhaDoMl(logger: Logger, falha: MercadoLivreFailure): void {
  if (falha.status === 404) {
    return;
  }

  logger.warn("ml_http_failure", {
    status: falha.status,
    method: falha.method,
    path: falha.path,
    error_class: falha.errorClass,
    body: falha.body === undefined ? null : JSON.stringify(falha.body).slice(0, 600),
  });
}
