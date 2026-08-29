import { EVENT_SEVERITY } from "../events/catalog.js";
import type { DomainEventDraft } from "../events/order-events.js";
import type { StockMovementDraft } from "./sale-deduction.js";

/**
 * Reconciliação de estoque contra o snapshot do UpSeller (D-029) — a peça
 * pura de `apps/worker/src/handlers/reconcile-balances.ts` (job
 * `maintenance.reconcile-balances`, `docs/ROADMAP.md` Fase 4).
 *
 * **Esta é, hoje, a ÚNICA fonte de movimento para `location_kind =
 * 'RESERVADO'`** — nenhum outro código grava ali (venda/cancelamento/NF-e são
 * sempre LOCAL, `docs/UPSELLER.md` secao 6: "Ocupado" no ERP é o reservado da
 * V3). Por isso "Reservado e em trânsito" e "Reconciliação contra o UpSeller"
 * são a MESMA implementação (`docs/HANDOFF.md`), não dois itens separados.
 *
 * `TRANSITO` fica de fora DE PROPÓSITO: "Em Trânsito (Compra)" e "Em
 * Trânsito (Transferência)" vêm zerados em 100% das linhas do export real do
 * UpSeller (`docs/UPSELLER.md` secao 6, "o recurso existe no ERP e não é
 * usado") — reconciliar contra uma fonte que estruturalmente nunca reporta
 * esse valor zeraria qualquer TRANSITO real que a V3 vier a ter quando
 * Pedidos de Compra existir. Fica pendente até essa fonte própria nascer.
 *
 * O UpSeller VENCE em divergência (D-029): o ajuste sempre traz o ledger da
 * V3 para bater com o snapshot, nunca o contrário.
 */

export interface ReconciliationBalance {
  readonly skuId: string;
  readonly locationKind: "LOCAL" | "RESERVADO";
  readonly quantity: number;
}

export interface ReconciliationAdjustment {
  readonly movement: StockMovementDraft;
  readonly event: DomainEventDraft;
}

/**
 * `businessDate` (`YYYY-MM-DD`) decide a chave de idempotência — a mesma
 * divergência persistindo dia após dia gera um NOVO ajuste a cada rodada
 * (D-029: "ajuste grande e recorrente indica processo humano falhando"),
 * nunca colide com o `UNIQUE` de `idempotency_key`/`dedup_key`.
 *
 * SKU sem linha em `snapshotBalances` não é comparado — sem opinião do
 * UpSeller sobre ele, não há o que reconciliar (mesmo raciocínio de "item
 * sem vínculo não deduz nada" já usado em `computeSaleDeductions`). Por
 * construção, quem chama só deve passar SKUs que o snapshot mais recente do
 * UpSeller efetivamente reportou.
 */
export function computeReconciliationAdjustments(
  snapshotBalances: readonly ReconciliationBalance[],
  ledgerBalances: readonly ReconciliationBalance[],
  businessDate: string,
  occurredAt: Date,
): ReconciliationAdjustment[] {
  const ledgerByKey = new Map(ledgerBalances.map((b) => [`${b.skuId}:${b.locationKind}`, b.quantity]));
  const adjustments: ReconciliationAdjustment[] = [];

  for (const snapshot of snapshotBalances) {
    const ledgerQuantity = ledgerByKey.get(`${snapshot.skuId}:${snapshot.locationKind}`) ?? 0;
    const delta = snapshot.quantity - ledgerQuantity;

    if (delta === 0) {
      continue;
    }

    const key = `reconciliacao:${businessDate}:${snapshot.skuId}:${snapshot.locationKind}`;

    adjustments.push({
      movement: {
        skuId: snapshot.skuId,
        qtyDelta: delta,
        idempotencyKey: key,
        occurredAt,
        locationKind: snapshot.locationKind,
      },
      event: {
        // `adjusted`, não `diverged`, desde D-135 — e o nome descreve o que
        // de fato aconteceu: o ajuste sai NA MESMA estrutura (`movement`
        // acima), então quando este evento existe o saldo JÁ foi corrigido.
        // Chamar isso de "divergência crítica" alarmava sobre um problema
        // que a própria linha resolvia. `stock.balance.diverged` ficou
        // reservado ao vigia de integridade (D-056), onde divergir é bug.
        //
        // `dedupKey` inalterado de propósito: continua `reconciliacao:...`,
        // então as 6.201 linhas históricas seguem legíveis pelo prefixo e
        // nada precisa de backfill — `domain_events` é append-only (L2), e
        // reescrever história para uniformizar nomenclatura seria pior que
        // conviver com os dois nomes.
        eventType: "stock.balance.adjusted",
        entityType: "sku",
        entityId: snapshot.skuId,
        before: { locationKind: snapshot.locationKind, quantity: ledgerQuantity },
        after: { locationKind: snapshot.locationKind, quantity: snapshot.quantity },
        severity: EVENT_SEVERITY["stock.balance.adjusted"] ?? "informativo",
        source: "system",
        dedupKey: key,
        occurredAt,
      },
    });
  }

  return adjustments;
}
