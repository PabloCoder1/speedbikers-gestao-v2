import { EVENT_SEVERITY } from "./catalog.js";
import type { EventSeverity, EventSource } from "./catalog.js";

/**
 * Motor de diff para pedidos — a peça pura, testável sem banco, do que
 * `apps/worker/src/handlers/persist-order.ts` chama a cada order persistida.
 *
 * `docs/DECISIONS.md` D-016: um `domain_events` com `before`/`after`, sem
 * tabela de snapshot. `dedup_key` é determinístico — a MESMA transição
 * detectada duas vezes (reconciliação com sobreposição de janela, corrida
 * entre execuções) produz a MESMA chave, e o `UNIQUE` no banco absorve o
 * reenvio sem duplicar evento.
 */

export interface DomainEventDraft {
  eventType: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  severity: EventSeverity;
  source: EventSource;
  dedupKey: string;
  /** Quando a mudança aconteceu de verdade (ex.: `order.date_last_updated`), não quando o V3 notou. */
  occurredAt: Date;
}

/**
 * Confirmado na documentação oficial (`docs/MERCADO_LIVRE.md`, secao "Status
 * da order"): `cancelled` é definitivo; `pending_cancel` é "cancelada mas
 * temos dificuldade para devolver o pagamento" — já é a notícia que importa
 * para quem vende, não vale esperar o estado definitivo para avisar.
 */
const CANCELLED_STATUSES = new Set(["cancelled", "pending_cancel"]);

/**
 * Fonte única do que conta como "pedido cancelado" no domínio — usada aqui e
 * por `@sb/domain/inventory` (`computeCancellationReversals`) para decidir
 * quando reverter a dedução de estoque. Duas listas separadas divergiriam
 * cedo ou tarde; uma função exportada evita isso.
 */
export function isCancelledOrderStatus(status: string): boolean {
  return CANCELLED_STATUSES.has(status);
}

/**
 * Detecta a transição de um pedido PARA um status de cancelamento.
 *
 * Não reemite quando o pedido JÁ estava cancelado (reprocessamento
 * idempotente da mesma order não deveria nem chegar a gerar o rascunho, mas
 * a checagem aqui é a defesa de primeira linha, antes até do `UNIQUE` do
 * banco).
 *
 * `order.returned` (devolução) fica de fora de propósito: o Mercado Livre
 * modela devolução via `order_request.return`/API de reclamações, campos
 * que `orders` ainda não persiste (`docs/DATABASE.md`) — implementar
 * exigiria a API de Devoluções, fora do escopo desta etapa.
 */
export function detectOrderStatusEvents(
  previousStatus: string | null,
  order: { id: number; status: string },
  occurredAt: Date,
): DomainEventDraft[] {
  const wasCancelled = previousStatus !== null && CANCELLED_STATUSES.has(previousStatus);
  const isCancelled = CANCELLED_STATUSES.has(order.status);

  if (!isCancelled || wasCancelled) {
    return [];
  }

  const eventType = "order.cancelled";

  return [
    {
      eventType,
      entityType: "order",
      entityId: String(order.id),
      before: { status: previousStatus },
      after: { status: order.status },
      severity: EVENT_SEVERITY[eventType] ?? "importante",
      source: "sync",
      dedupKey: `${eventType}:${String(order.id)}:${order.status}`,
      occurredAt,
    },
  ];
}

export { EVENT_SEVERITY };
export type { EventSeverity, EventSource };
