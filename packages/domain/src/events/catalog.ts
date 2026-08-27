/**
 * Catálogo de `event_type`, espelhando `docs/API.md` secao 4 — a tabela ali
 * é a fonte; isto é o espelho executável. Divergência entre os dois é bug
 * (mesma regra já aplicada a `docs/METRICS.md`/`metric_definitions`).
 *
 * `docs/ARCHITECTURE.md`: "a severidade final é calculada por regra
 * versionada em `@sb/domain/events`, não fixada na interface" — por isso
 * este mapa mora aqui, não em `apps/worker` nem na UI.
 */

export type EventSeverity = "informativo" | "importante" | "critico";
export type EventSource = "webhook" | "sync" | "user" | "system";

/**
 * `listing.price.changed` fica de fora de propósito: `docs/API.md` marca a
 * severidade como "informativo / importante" — condicional à magnitude da
 * mudança, uma regra ainda não definida. Não adivinhar aqui (REGRA ABSOLUTA
 * equivalente à de `docs/MERCADO_LIVRE.md`, aplicada ao domínio, não só à
 * API externa).
 */
export const EVENT_SEVERITY: Readonly<Record<string, EventSeverity>> = {
  "listing.title.changed": "informativo",
  "listing.picture.changed": "informativo",
  "listing.description.changed": "informativo",
  "listing.available_quantity.changed": "informativo",
  "listing.status.paused": "importante",
  "listing.status.reactivated": "informativo",
  "listing.promotion.started": "importante",
  "listing.promotion.ended": "importante",
  "listing.catalog.won": "importante",
  "listing.catalog.lost": "critico",
  "listing.fulfillment.entered": "importante",
  "listing.fulfillment.exited": "importante",
  "stock.depleted": "critico",
  "stock.replenished": "informativo",
  "stock.balance.diverged": "critico",
  "order.cancelled": "importante",
  "order.returned": "importante",
  "sync.delayed": "importante",
  "sync.failed": "critico",
  // "Avisa, não bloqueia" (D-082/D-100): ultrapassar o teto não interrompe
  // nada — "importante" alerta sem o peso de "critico", reservado para
  // dado errado ou sincronização morta.
  "ai.budget.exceeded": "importante",
  // MEDIDO antes de calibrar (D-110): 17 mediações NOVAS por dia nesta
  // operação. O requisito propunha "critico" como regra conceitual a
  // calibrar com dado real — 17 críticos/dia esvaziaria o nível na primeira
  // semana. `critico` de atendimento fica reservado para prazo estourando
  // (`sla_at_risk`), que exige o job com relógio que D-107 deixou pendente.
  "support.claim.disputed": "importante",
};
