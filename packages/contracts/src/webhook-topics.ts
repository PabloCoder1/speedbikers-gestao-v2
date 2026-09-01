/**
 * Quais tópicos de webhook do Mercado Livre têm consumidor de verdade
 * (D-179).
 *
 * Esta lista mora em `@sb/contracts` porque as DUAS pontas dependem dela e
 * não podem divergir: a `api` decide se enfileira, o `worker` decide se
 * processa. Enquanto a decisão estava duplicada, a `api` enfileirava tudo e
 * o `worker` devolvia `done / processed: 0` — e a diferença entre as duas
 * visões custava uma Cloud Task, uma invocação de Cloud Run e uma linha de
 * `job_runs` por notificação.
 *
 * MEDIDO no Dev em 2026-09-01, sobre 243.944 execuções de
 * `sync.webhook.received`:
 *
 * | tópico              | execuções | com trabalho |
 * |---------------------|-----------|--------------|
 * | shipments           |    54.727 |            0 |
 * | user-products       |    46.597 |            0 |
 * | collections         |    33.893 |            0 |
 * | seller-promotions   |    25.850 |            0 |
 * | items               |    21.742 |            0 |
 * | items (price)       |    16.398 |            0 |
 * | users               |     9.952 |            0 |
 * | stock-location      |     7.835 |            0 |
 * | suggestions         |     1.656 |            0 |
 * | sites / flex / …    |       100 |            0 |
 * | **orders_v2**       |    20.799 |       20.376 |
 * | **post_purchase**   |     5.520 |          669 |
 *
 * 218.750 execuções — 90% do caminho genérico — existiram para não fazer
 * nada.
 *
 * **Quando um tópico ganhar consumidor, acrescente-o aqui** e o caminho
 * inteiro volta a funcionar: a `api` passa a enfileirar de novo, sem mais
 * nenhuma mudança na borda.
 *
 * Tópicos com job PRÓPRIO (`questions`, `messages`) não entram nesta lista:
 * eles nem chegam ao caminho genérico.
 */
export const WEBHOOK_TOPICS_WITH_CONSUMER = ["orders_v2", "post_purchase"] as const;

export type WebhookTopicWithConsumer = (typeof WEBHOOK_TOPICS_WITH_CONSUMER)[number];

/**
 * Função TOTAL: tópico desconhecido responde `false`, que é o caminho
 * seguro — ACK sem trabalho em vez de fila com trabalho vazio.
 */
export function hasWebhookConsumer(topic: string): topic is WebhookTopicWithConsumer {
  return (WEBHOOK_TOPICS_WITH_CONSUMER as readonly string[]).includes(topic);
}
