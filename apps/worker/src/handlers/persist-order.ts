import type { AdminClient } from "@sb/db";
import {
  computeCancellationReversals,
  computeSaleDeductions,
  detectOrderStatusEvents,
  isCancelledOrderStatus,
} from "@sb/domain";
import type { RecordedSaleMovement, SaleDeductionItem } from "@sb/domain";
import type { Logger } from "@sb/observability";

import { assertWritten } from "./assert-written.js";
import { recordDomainEvents } from "./domain-events.js";
import type { ParsedOrder } from "./order-schema.js";
import { recordStockMovements } from "./stock-movements.js";

/**
 * Grava um pedido e seus itens — `orders`/`order_items`
 * (`docs/DATABASE.md`, migration `20260821040000_create_orders.sql`) — roda
 * o motor de diff (`@sb/domain/events`) comparando o status anterior contra
 * o novo, emitindo `domain_events` quando cabível (D-016), e mantém
 * `stock_movements` sincronizado com o status: deduz na venda válida
 * (D-019) ou reverte no cancelamento, nunca os dois na mesma chamada
 * (`@sb/domain/inventory`).
 *
 * Não é atômico entre `orders`/`order_items`/`domain_events`/
 * `stock_movements` (várias chamadas de rede separadas). Aceito de
 * propósito, mesmo padrão de `erp-import-apply.ts`: o pedido é reprocessado
 * a cada janela de reconciliação, então uma falha no meio se autocorrige na
 * próxima varredura — não é o tipo de escrita humana única que precisa da
 * atomicidade de uma RPC `security definer` (essa é para confirmação
 * humana, como `resolve_link_candidate`).
 *
 * `order_items` não tem id próprio do Mercado Livre — o array não traz
 * identificador estável por linha. Reprocessar substitui TODAS as linhas
 * (delete + insert), mesmo padrão já usado em `erp_import_rows`.
 *
 * A reversão de cancelamento reverte os movimentos `VENDA_ML` JÁ GRAVADOS no
 * ledger (consulta antes de reverter), não recalcula a partir dos itens
 * atuais — ver `@sb/domain/inventory` (`computeCancellationReversals`) para
 * o motivo. Por isso pula o recálculo de KIT/componentes quando o pedido
 * está cancelado: essa informação já está decomposta no ledger.
 *
 * **Deliberadamente não feito aqui**: reversão por DEVOLUÇÃO — o Mercado
 * Livre modela devolução pela API de Reclamações e Devoluções, não
 * integrada (mesmo motivo já registrado para `order.returned` em
 * `@sb/domain/events`). Só cancelamento é tratado nesta etapa.
 */

export interface PersistOrderContext {
  organizationId: string;
  mlAccountId: string;
}

export async function persistOrder(
  db: AdminClient,
  context: PersistOrderContext,
  order: ParsedOrder,
  logger: Logger,
): Promise<void> {
  // D-101: o `GET /orders/{id}` real (fast path do webhook) vem SEM
  // `date_last_updated` — só o `/orders/search` (reconciliação) o traz.
  // A coluna é NOT NULL e três `occurredAt` derivam dela, então o fallback
  // fica em cascata de campos do PRÓPRIO pedido (nunca `now()`, que
  // colocaria o relógio da V3 no lugar do relógio do Mercado Livre):
  // `last_updated` é o irmão com o mesmo significado (D-048), e
  // `date_created` sempre existe.
  const lastUpdatedAt = order.date_last_updated ?? order.last_updated ?? order.date_created;

  // Lido ANTES do upsert: é o "before" do motor de diff. Ausente (order
  // nova para o V3) vira `null` — `detectOrderStatusEvents` trata os dois
  // casos.
  const existing = await db.from("orders").select("status").eq("id", order.id).maybeSingle();

  if (existing.error !== null) {
    throw new Error(`falha ao ler status anterior da order ${String(order.id)}: ${existing.error.message}`);
  }

  const previousStatus = existing.data?.status ?? null;

  // Aborta se o pedido nao gravou (D-178): tudo abaixo -- eventos de status e
  // deducao de estoque -- presume que ele existe.
  assertWritten(
    await db
    .from("orders")
    .upsert(
      {
        id: order.id,
        organization_id: context.organizationId,
        ml_account_id: context.mlAccountId,
        pack_id: order.pack_id ?? null,
        status: order.status,
        status_detail: order.status_detail ?? null,
        date_created: order.date_created,
        date_closed: order.date_closed ?? null,
        date_last_updated: lastUpdatedAt,
        last_updated: order.last_updated ?? null,
        total_amount: order.total_amount,
        paid_amount: order.paid_amount ?? null,
        currency_id: order.currency_id,
        buyer_id: order.buyer?.id ?? null,
        shipping_id: order.shipping?.id ?? null,
        tags: order.tags ?? [],
        cancel_reason: order.cancel_detail?.description ?? null,
      },
      { onConflict: "id" },
    ),
    "orders.upsert",
  );

  const events = detectOrderStatusEvents(
    previousStatus,
    { id: order.id, status: order.status },
    new Date(lastUpdatedAt),
  );

  if (events.length > 0) {
    await recordDomainEvents(db, context, events, logger);
  }

  // Delete + insert e a forma de substituir os itens: se o delete falha e o
  // insert segue, o pedido fica com itens duplicados de duas versoes.
  assertWritten(await db.from("order_items").delete().eq("order_id", order.id), "order_items.delete");

  if (order.order_items.length === 0) {
    return;
  }

  const items = await Promise.all(
    order.order_items.map(async (item, position) => {
      const variationId = item.item.variation_id != null ? String(item.item.variation_id) : null;
      const resolved = await resolveSku(db, context.mlAccountId, item.item.id, variationId);

      return {
        order_id: order.id,
        organization_id: context.organizationId,
        ml_account_id: context.mlAccountId,
        position,
        item_id: item.item.id,
        variation_id: variationId,
        title: item.item.title,
        seller_sku: item.item.seller_sku ?? null,
        quantity: item.quantity,
        unit_price: item.unit_price,
        sale_fee: item.sale_fee ?? null,
        currency_id: item.currency_id,
        sku_id: resolved?.sku_id ?? null,
        sku_listing_link_id: resolved?.id ?? null,
      };
    }),
  );

  assertWritten(await db.from("order_items").insert(items), "order_items.insert");

  if (isCancelledOrderStatus(order.status)) {
    const saleMovements = await loadSaleMovements(db, context.organizationId, order.id);
    const reversals = computeCancellationReversals(
      { id: order.id, status: order.status, occurredAt: new Date(lastUpdatedAt) },
      saleMovements,
    );

    if (reversals.length > 0) {
      await recordStockMovements(
        db,
        context,
        reversals,
        "CANCELAMENTO_ML",
        { type: "ORDER", id: String(order.id) },
        logger,
      );
    }

    return;
  }

  const deductionItems: SaleDeductionItem[] = await Promise.all(
    items.map(async (item) => {
      if (item.sku_id === null) {
        return { position: item.position, quantity: item.quantity, skuId: null, skuKind: null, components: [] };
      }

      const { kind, components } = await loadSkuKindAndComponents(db, item.sku_id);

      return { position: item.position, quantity: item.quantity, skuId: item.sku_id, skuKind: kind, components };
    }),
  );

  const deductions = computeSaleDeductions({
    id: order.id,
    status: order.status,
    occurredAt: new Date(lastUpdatedAt),
    items: deductionItems,
  });

  if (deductions.length > 0) {
    await recordStockMovements(
      db,
      context,
      deductions,
      "VENDA_ML",
      { type: "ORDER", id: String(order.id) },
      logger,
    );
  }
}

/**
 * Carrega os movimentos `VENDA_ML` já gravados para esta order — a base
 * para reverter exatamente o que foi deduzido, não o que os itens atuais
 * computariam (ver comentário no topo do arquivo).
 */
async function loadSaleMovements(
  db: AdminClient,
  organizationId: string,
  orderId: number,
): Promise<RecordedSaleMovement[]> {
  const result = await db
    .from("stock_movements")
    .select("sku_id, qty_delta, idempotency_key")
    .eq("organization_id", organizationId)
    .eq("source_type", "ORDER")
    .eq("source_id", String(orderId))
    .eq("movement_type", "VENDA_ML");

  if (result.error !== null) {
    // Não tratar como "nenhum movimento": numa order cancelada, isso faria
    // computeCancellationReversals reverter zero — a dedução original da
    // venda ficaria de pé, estoque silenciosamente incorreto.
    throw new Error(`falha ao ler stock_movements da order ${String(orderId)}: ${result.error.message}`);
  }

  return result.data.map((row) => ({
    skuId: row.sku_id,
    qtyDelta: row.qty_delta,
    idempotencyKey: row.idempotency_key,
  }));
}

/**
 * Resolve `sku_id` pelo vínculo vigente (D-020) — congelado na linha do
 * item, nunca recalculado por join na leitura. Mesma forma de índice parcial
 * de `sku_listing_links` (`docs/DATABASE.md` secao 4): `variation_id` nulo
 * precisa de `.is()`, não `.eq()`.
 */
async function resolveSku(
  db: AdminClient,
  mlAccountId: string,
  itemId: string,
  variationId: string | null,
): Promise<{ id: string; sku_id: string } | null> {
  const query = db
    .from("sku_listing_links")
    .select("id, sku_id")
    .eq("ml_account_id", mlAccountId)
    .eq("ref_kind", "ITEM")
    .eq("item_id", itemId);

  const filtered = variationId === null ? query.is("variation_id", null) : query.eq("variation_id", variationId);

  const result = await filtered.maybeSingle();

  if (result.error !== null) {
    // Não tratar como "sem vínculo": isso gravaria sku_id null numa venda
    // real e puparia a dedução de estoque inteira — overselling silencioso.
    throw new Error(
      `falha ao resolver sku_listing_link (item ${itemId}, variation ${variationId ?? "null"}): ${result.error.message}`,
    );
  }

  return result.data;
}

/**
 * `kind` decide se a dedução vai para o próprio SKU (PRODUTO) ou para os
 * componentes (KIT, `docs/DATABASE.md` secao 4 — kit não tem saldo
 * próprio). SKU não encontrado (não deveria acontecer: `sku_listing_links`
 * referencia `skus` com FK) cai em PRODUTO sem componentes — a inserção
 * seguinte falha por violação de FK em vez de deduzir contra um SKU
 * inexistente, e `recordStockMovements` loga o que não é conflito de
 * idempotência.
 */
async function loadSkuKindAndComponents(
  db: AdminClient,
  skuId: string,
): Promise<{ kind: "PRODUTO" | "KIT"; components: { componentSkuId: string; quantity: number }[] }> {
  const sku = await db.from("skus").select("kind").eq("id", skuId).maybeSingle();

  if (sku.error !== null) {
    // Não tratar como PRODUTO sem componentes: um KIT real cairia sem
    // decompor, deduzindo contra a própria linha do kit (sem saldo) em vez
    // dos componentes — estoque dos componentes nunca seria reduzido.
    throw new Error(`falha ao ler kind do sku ${skuId}: ${sku.error.message}`);
  }

  if (sku.data?.kind !== "KIT") {
    return { kind: "PRODUTO", components: [] };
  }

  const componentsResult = await db
    .from("sku_components")
    .select("component_sku_id, quantity")
    .eq("kit_sku_id", skuId);

  if (componentsResult.error !== null) {
    throw new Error(`falha ao ler componentes do kit ${skuId}: ${componentsResult.error.message}`);
  }

  const components = componentsResult.data.map((row) => ({
    componentSkuId: row.component_sku_id,
    quantity: row.quantity,
  }));

  return { kind: "KIT", components };
}
