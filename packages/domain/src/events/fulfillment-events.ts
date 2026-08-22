import { EVENT_SEVERITY } from "./catalog.js";
import type { DomainEventDraft } from "./order-events.js";

/**
 * Detector de eventos por diff entre duas capturas consecutivas de
 * `fulfillment_stock_snapshots` (`docs/DATABASE.md`, migration
 * `20260822122526`) — a peça pura que o job de captura do Full (próxima
 * etapa) vai chamar uma vez por `inventory_id`.
 *
 * Full é espelho do Mercado Livre, não ledger (D-018): não há um "antes" e
 * "depois" gravados no ato de um movimento — só duas fotografias no tempo.
 * O evento nasce do DIFF entre a fotografia anterior e a atual, mesmo
 * princípio de `docs/API.md` secao 4 ("origem: diff").
 *
 * **Deliberadamente não feito aqui**: `listing.fulfillment.exited`. Detectar
 * saída exigiria saber se o Mercado Livre PARA de retornar `inventory_id`
 * para um item que saiu do Full, ou se continua retornando com saldo zero —
 * comportamento não confirmado contra a API real (REGRA ABSOLUTA,
 * `docs/MERCADO_LIVRE.md`). Fica para quando isso for confirmado; até lá,
 * saída indistinguível de "zerou o estoque" é coberta por `stock.depleted`.
 */

export interface FulfillmentCapture {
  readonly inventoryId: string;
  readonly skuId: string;
  readonly quantity: number;
  /** Quando o Mercado Livre reportou o saldo — `fulfillment_stock_snapshots.captured_at`. */
  readonly capturedAt: Date;
}

/**
 * `previous` é a captura anterior deste MESMO `inventory_id`, ou `null`
 * quando esta é a primeira captura já vista (entrou no Full agora, ou o V3
 * nunca tinha capturado antes).
 */
export function detectFulfillmentEvents(
  previous: FulfillmentCapture | null,
  current: FulfillmentCapture,
): DomainEventDraft[] {
  const events: DomainEventDraft[] = [];
  const capturedAtKey = current.capturedAt.toISOString();

  if (previous === null) {
    events.push({
      eventType: "listing.fulfillment.entered",
      entityType: "listing",
      entityId: current.inventoryId,
      before: null,
      after: { quantity: current.quantity },
      severity: EVENT_SEVERITY["listing.fulfillment.entered"] ?? "importante",
      source: "sync",
      dedupKey: `listing.fulfillment.entered:${current.inventoryId}:${capturedAtKey}`,
      occurredAt: current.capturedAt,
    });
  }

  const wasDepleted = previous !== null && previous.quantity === 0;
  const isDepleted = current.quantity === 0;

  if (isDepleted && !wasDepleted) {
    events.push({
      eventType: "stock.depleted",
      entityType: "sku",
      entityId: current.skuId,
      before: { quantity: previous?.quantity ?? null },
      after: { quantity: 0 },
      severity: EVENT_SEVERITY["stock.depleted"] ?? "critico",
      source: "sync",
      dedupKey: `stock.depleted:full:${current.inventoryId}:${capturedAtKey}`,
      occurredAt: current.capturedAt,
    });
  }

  if (!isDepleted && wasDepleted) {
    events.push({
      eventType: "stock.replenished",
      entityType: "sku",
      entityId: current.skuId,
      before: { quantity: 0 },
      after: { quantity: current.quantity },
      severity: EVENT_SEVERITY["stock.replenished"] ?? "informativo",
      source: "sync",
      dedupKey: `stock.replenished:full:${current.inventoryId}:${capturedAtKey}`,
      occurredAt: current.capturedAt,
    });
  }

  return events;
}
