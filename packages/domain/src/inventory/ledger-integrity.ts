import { EVENT_SEVERITY } from "../events/catalog.js";
import type { DomainEventDraft } from "../events/order-events.js";

/**
 * Conferência automática ledger × projeção (D-056, `docs/ROADMAP.md` Fase 4)
 * — a peça pura de `apps/worker/src/handlers/verify-ledger-integrity.ts`
 * (job `maintenance.verify-ledger-integrity`).
 *
 * Diferente de `computeReconciliationAdjustments` (D-029, UpSeller × ledger):
 * ali a divergência é ESPERADA (o ERP externo diverge por processo humano) e
 * o ajuste TRAZ o ledger para bater com a fonte externa. Aqui as duas fontes
 * são internas — `stock_movements` (verdade) e `inventory_balances`
 * (projeção mantida por `private.apply_stock_movement`, um trigger na MESMA
 * transação de cada INSERT) — e não deveriam DIVERGIR NUNCA, por construção.
 * Uma divergência aqui é bug (trigger pulado, escrita direta em
 * `inventory_balances`), não drift de processo — por isso este código só
 * DETECTA e alerta (evento crítico), nunca escreve `stock_movements` para
 * "corrigir": adicionar uma linha ao ledger não repara um bug na projeção,
 * só empilha mais uma fonte para desconfiar.
 *
 * Reaproveita o mesmo `event_type` (`stock.balance.diverged`) da
 * reconciliação contra o UpSeller — o catálogo (`docs/API.md` secao 4) já
 * documentava a fonte como "job de conferência" antes de qualquer um dos
 * dois jobs existir; `before`/`after` carregam `checkedAgainst` para quem
 * for investigar distinguir as duas origens sem precisar de um evento novo.
 */

export interface LedgerBalance {
  readonly skuId: string;
  readonly locationKind: "LOCAL" | "RESERVADO" | "TRANSITO";
  readonly quantity: number;
}

/**
 * `businessDate` decide a janela do `dedup_key` — a mesma divergência
 * persistindo dia após dia gera um NOVO evento a cada rodada (mesmo
 * raciocínio de D-029: silenciar depois do primeiro alerta esconderia um bug
 * que continua ativo). Compara a UNIÃO das chaves dos dois lados: uma linha
 * ausente de um lado só (ledger tem, projeção não — ou o contrário) também é
 * divergência, tratada como quantidade zero do lado que falta.
 */
export function computeLedgerIntegrityDivergences(
  ledgerBalances: readonly LedgerBalance[],
  projectedBalances: readonly LedgerBalance[],
  businessDate: string,
  occurredAt: Date,
): DomainEventDraft[] {
  const ledgerByKey = new Map(ledgerBalances.map((b) => [`${b.skuId}:${b.locationKind}`, b.quantity]));
  const projectedByKey = new Map(projectedBalances.map((b) => [`${b.skuId}:${b.locationKind}`, b.quantity]));

  const keys = new Set([...ledgerByKey.keys(), ...projectedByKey.keys()]);
  const events: DomainEventDraft[] = [];

  for (const key of keys) {
    const [skuId, locationKind] = key.split(":") as [string, LedgerBalance["locationKind"]];
    const ledgerQuantity = ledgerByKey.get(key) ?? 0;
    const projectedQuantity = projectedByKey.get(key) ?? 0;

    if (ledgerQuantity === projectedQuantity) {
      continue;
    }

    const eventType = "stock.balance.diverged";
    const dedupKey = `integridade-ledger:${businessDate}:${skuId}:${locationKind}`;

    events.push({
      eventType,
      entityType: "sku",
      entityId: skuId,
      before: { locationKind, quantity: projectedQuantity, checkedAgainst: "ledger_vs_projection" },
      after: { locationKind, quantity: ledgerQuantity, checkedAgainst: "ledger_vs_projection" },
      severity: EVENT_SEVERITY[eventType] ?? "critico",
      source: "system",
      dedupKey,
      occurredAt,
    });
  }

  return events;
}
