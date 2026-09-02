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
  // As duas metades do que ERA um tipo só (D-135). O mesmo `event_type`
  // carregava significados opostos e a severidade mentia para um deles:
  //
  // `stock.balance.adjusted` — reconciliação contra o UpSeller (D-029). A
  // divergência é ESPERADA aqui: o ERP é operado por gente, diverge por
  // processo, e a própria reconciliação JÁ CORRIGE o saldo na mesma
  // execução. Um fato consumado e rotineiro não é emergência —
  // `informativo`. Medido antes de trocar: 657 a 896 eventos/dia neste
  // caminho, todos `critico`, num universo em que `stock.balance.diverged`
  // era 59,3% de TODOS os domain_events de 7 dias.
  //
  // `stock.balance.diverged` — vigia de integridade ledger×projeção
  // (D-056). Aqui as duas fontes são internas e não deveriam divergir
  // NUNCA, por construção; uma divergência é bug, e o job só detecta,
  // nunca corrige. Continua `critico`, e agora o nível volta a significar
  // alguma coisa: com o truncamento de D-131 corrigido, este caminho
  // emite ZERO (medido em 2026-08-29: 3.472 chaves comparadas, 0
  // divergências).
  "stock.balance.adjusted": "informativo",
  "stock.balance.diverged": "critico",
  "order.cancelled": "importante",
  "order.returned": "importante",
  // A devolucao que NAO pode ser revertida por falta da linha de
  // `order_items` (D-208). `critico` e medido, nao e enfase: em 338.791
  // pedidos existem DOIS sem item (2026-09-02), ambos `delivered` desde
  // julho e sem nenhuma reclamacao — o evento teria disparado ZERO vezes em
  // toda a historia da base. E o oposto do caso de D-135: aqui o nivel
  // continua significando alguma coisa porque so dispara quando estoque
  // real fica preso deduzido, sem caminho automatico de volta.
  "order.return.unreversed": "critico",
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
