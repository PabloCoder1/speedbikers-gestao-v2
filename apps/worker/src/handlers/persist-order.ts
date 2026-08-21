import type { AdminClient } from "@sb/db";

import type { ParsedOrder } from "./order-schema.js";

/**
 * Grava um pedido e seus itens — `orders`/`order_items`
 * (`docs/DATABASE.md`, migration `20260821040000_create_orders.sql`).
 *
 * Não é atômico entre as duas tabelas (upsert de `orders`, depois delete +
 * insert de `order_items` — três chamadas de rede separadas). Aceito de
 * propósito, mesmo padrão de `erp-import-apply.ts`: o pedido é reprocessado
 * a cada janela de reconciliação, então uma falha no meio se autocorrige na
 * próxima varredura — não é o tipo de escrita humana única que precisa da
 * atomicidade de uma RPC `security definer` (essa é para confirmação
 * humana, como `resolve_link_candidate`).
 *
 * `order_items` não tem id próprio do Mercado Livre — o array não traz
 * identificador estável por linha. Reprocessar substitui TODAS as linhas
 * (delete + insert), mesmo padrão já usado em `erp_import_rows`.
 */

export interface PersistOrderContext {
  organizationId: string;
  mlAccountId: string;
}

export async function persistOrder(
  db: AdminClient,
  context: PersistOrderContext,
  order: ParsedOrder,
): Promise<void> {
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
        date_last_updated: order.date_last_updated,
        last_updated: order.last_updated ?? null,
        total_amount: order.total_amount,
        paid_amount: order.paid_amount ?? null,
        currency_id: order.currency_id,
        buyer_id: order.buyer?.id ?? null,
        tags: order.tags ?? [],
        cancel_reason: order.cancel_detail?.description ?? null,
      },
      { onConflict: "id" },
    );

  await db.from("order_items").delete().eq("order_id", order.id);

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

  await db.from("order_items").insert(items);
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

  return result.data;
}
