import { formatCurrency } from "./format";
import { listingStatusLabel } from "./labels";

/**
 * Leitura de `domain_events.before`/`after` compartilhada entre a Central de
 * Notificações (`app/notificacoes/notification-row.tsx`, D-074) e os toasts
 * em tempo real (`components/notification-toasts.tsx`, D-075) — mesmo
 * evento, mesma leitura, sem duas implementações divergindo cedo ou tarde.
 */

/** `unknown` vira string só quando já é string/number — nunca `String(objeto)`, que gera "[object Object]" ilegível. */
export function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);

  return "—";
}

/**
 * Diff legível só para os tipos de evento cujo formato de `before`/`after` já
 * está documentado (`packages/domain/src/events/listing-events.ts`). Os
 * demais tipos não têm diff aqui de propósito — mostrar chave/valor bruto de
 * um `before`/`after` cujo formato não foi conferido seria inventar leitura
 * (REGRA ABSOLUTA equivalente à de `docs/MERCADO_LIVRE.md`).
 */
export function formatEventDiff(
  eventType: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string | null {
  const b = before ?? {};
  const a = after ?? {};

  switch (eventType) {
    case "listing.price.changed": {
      const beforePrice = typeof b.price === "number" ? b.price : null;
      const afterPrice = typeof a.price === "number" ? a.price : null;

      return `${formatCurrency(beforePrice)} → ${formatCurrency(afterPrice)}`;
    }
    case "listing.title.changed":
      return `"${scalar(b.title)}" → "${scalar(a.title)}"`;
    case "listing.available_quantity.changed":
      return `${scalar(b.availableQuantity)} → ${scalar(a.availableQuantity)}`;
    case "listing.status.paused":
    case "listing.status.reactivated":
      return `${listingStatusLabel(scalar(b.status))} → ${listingStatusLabel(scalar(a.status))}`;
    default:
      return null;
  }
}

/**
 * Link pra entidade afetada (docs/NOTIFICATIONS.md secao 7) só quando a rota
 * existe de verdade: `/skus/[skuId]` usa o UUID de `skus.id` diretamente, o
 * mesmo valor que `entity_id` carrega pra `entity_type = "sku"`
 * (`packages/domain/src/events/fulfillment-events.ts`). Anúncio e pedido
 * ainda não têm tela própria — mostrar só o texto em vez de um link morto.
 */
export function entityHref(entityType: string, entityId: string): string | null {
  if (entityType === "sku") return `/skus/${entityId}`;
  // D-110: primeiro evento cujo destino tem tela de detalhe própria (D-095).
  // `entity_id` é o `support_cases.id`, o mesmo UUID da rota.
  if (entityType === "support_case") return `/atendimento/${entityId}`;

  return null;
}

export function entityLabel(entityType: string): string {
  if (entityType === "sku") return "SKU";
  if (entityType === "listing") return "Anúncio";
  if (entityType === "order") return "Pedido";
  if (entityType === "support_case") return "Atendimento";

  return entityType;
}
