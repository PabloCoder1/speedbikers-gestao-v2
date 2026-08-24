import { EVENT_SEVERITY } from "./catalog.js";
import type { DomainEventDraft } from "./order-events.js";

/**
 * Motor de diff para `listings` — a peça pura que `ml-listings-fetch.ts`
 * chama a cada item sincronizado, antes do upsert sobrescrever a linha
 * anterior (`docs/DATABASE.md`: `listings` é projeção MUTÁVEL, não ledger —
 * o "antes" só existe até o upsert seguinte).
 *
 * Pré-requisito crítico da Fase 7 (`docs/HANDOFF.md`): cobre os quatro
 * primeiros eventos candidatos — preço, título, status e quantidade
 * disponível. `dedup_key` leva `syncedAt` (quando o V3 observou, não um
 * timestamp do Mercado Livre — `listingItemSchema` não captura um campo de
 * "última modificação" hoje), mesmo padrão de `fulfillment-events.ts`: os
 * quatro campos oscilam livremente ao longo da vida do anúncio (preço sobe e
 * desce, status pausa/reativa repetidas vezes), diferente de
 * `order.cancelled`, que é uma transição essencialmente terminal — uma chave
 * só por valor (sem tempo) colidiria e suprimiria uma segunda mudança real
 * para o mesmo valor.
 *
 * **`status` — só as duas transições já catalogadas** (`listing.status.paused`/
 * `.reactivated`, desde a Fase 0). Outras transições de status (para
 * `closed`, `under_review`, etc.) não têm evento próprio ainda — não
 * inventado aqui (REGRA ABSOLUTA). Valores confirmados ao vivo em
 * 2026-08-24 (`docs/MERCADO_LIVRE.md` secao 2.13): `active` · `paused`
 * (substatus `out_of_stock`/`paused_by_seller`, não capturado em `listings`
 * hoje) · `under_review` · `closed` · `payment_required` · `inactive`.
 *
 * **`available_quantity` chegar a zero PAUSA o anúncio sozinho no Mercado
 * Livre** (mesma seção 2.13) — os dois eventos podem disparar juntos para a
 * mesma causa raiz, sem ser duplicidade: cada um responde uma pergunta
 * diferente ("quanto mudou" vs. "o anúncio saiu do ar"), mesmo raciocínio já
 * aceito para `stock.depleted` + `listing.fulfillment.entered`.
 */

export interface ListingSnapshot {
  readonly itemId: string;
  readonly title: string;
  readonly status: string;
  readonly price: number;
  readonly availableQuantity: number;
}

/**
 * `listing.price.changed` usa severidade fixa "informativo" nesta primeira
 * versão. `docs/API.md` marca "informativo / importante" como severidade
 * padrão, condicional à magnitude da mudança — mas a regra de limiar ainda
 * não foi definida, e não adivinhar aqui é a mesma REGRA ABSOLUTA já
 * aplicada à API externa. "Informativo" é o lado conservador: mesma
 * categoria de `title.changed`/`picture.changed`/`description.changed`,
 * evita alarme para uma correção de centavos enquanto o limiar de
 * magnitude não existir (`docs/NOTIFICATIONS.md`: avalanche de alerta
 * pequeno é como a funcionalidade nasce morta).
 */
const PRICE_CHANGED_SEVERITY = "informativo" as const;

/**
 * `previous` é o que a linha de `listings` tinha ANTES deste sync (lida
 * pelo chamador antes do upsert), ou `null` quando este item nunca foi
 * sincronizado — primeira aparição não gera evento: não existe "mudou" sem
 * um estado anterior para comparar, e não há evento catalogado de "anúncio
 * descoberto" (diferente de Full, onde `listing.fulfillment.entered` já era
 * um evento aprovado desde a Fase 0).
 */
export function detectListingEvents(
  previous: ListingSnapshot | null,
  current: ListingSnapshot,
  syncedAt: Date,
): DomainEventDraft[] {
  if (previous === null) {
    return [];
  }

  const events: DomainEventDraft[] = [];
  const syncedAtKey = syncedAt.toISOString();

  if (current.price !== previous.price) {
    events.push({
      eventType: "listing.price.changed",
      entityType: "listing",
      entityId: current.itemId,
      before: { price: previous.price },
      after: { price: current.price },
      severity: PRICE_CHANGED_SEVERITY,
      source: "sync",
      dedupKey: `listing.price.changed:${current.itemId}:${syncedAtKey}`,
      occurredAt: syncedAt,
    });
  }

  if (current.title !== previous.title) {
    const eventType = "listing.title.changed";

    events.push({
      eventType,
      entityType: "listing",
      entityId: current.itemId,
      before: { title: previous.title },
      after: { title: current.title },
      severity: EVENT_SEVERITY[eventType] ?? "informativo",
      source: "sync",
      dedupKey: `${eventType}:${current.itemId}:${syncedAtKey}`,
      occurredAt: syncedAt,
    });
  }

  if (current.availableQuantity !== previous.availableQuantity) {
    const eventType = "listing.available_quantity.changed";

    events.push({
      eventType,
      entityType: "listing",
      entityId: current.itemId,
      before: { availableQuantity: previous.availableQuantity },
      after: { availableQuantity: current.availableQuantity },
      severity: EVENT_SEVERITY[eventType] ?? "informativo",
      source: "sync",
      dedupKey: `${eventType}:${current.itemId}:${syncedAtKey}`,
      occurredAt: syncedAt,
    });
  }

  if (current.status !== previous.status) {
    if (current.status === "paused" && previous.status !== "paused") {
      const eventType = "listing.status.paused";

      events.push({
        eventType,
        entityType: "listing",
        entityId: current.itemId,
        before: { status: previous.status },
        after: { status: current.status },
        severity: EVENT_SEVERITY[eventType] ?? "importante",
        source: "sync",
        dedupKey: `${eventType}:${current.itemId}:${syncedAtKey}`,
        occurredAt: syncedAt,
      });
    }

    if (previous.status === "paused" && current.status === "active") {
      const eventType = "listing.status.reactivated";

      events.push({
        eventType,
        entityType: "listing",
        entityId: current.itemId,
        before: { status: previous.status },
        after: { status: current.status },
        severity: EVENT_SEVERITY[eventType] ?? "informativo",
        source: "sync",
        dedupKey: `${eventType}:${current.itemId}:${syncedAtKey}`,
        occurredAt: syncedAt,
      });
    }
  }

  return events;
}
