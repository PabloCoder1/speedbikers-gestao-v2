import type { AdminClient, Json } from "@sb/db";
import type {
  ProjectedTikTokListingUnit,
  ProjectedTikTokOrder,
  ProjectedTikTokReturn,
} from "@sb/domain";
import { parseTikTokDecimal, type TikTokOrderStatementTransaction, type TikTokStatement } from "@sb/tiktok-shop";

import { chunk } from "../chunk.js";
import type { RepoDataResult, RepoResult, TikTokSyncRepository } from "./tiktok-repository.js";

/**
 * Adaptador Supabase real para `TikTokSyncRepository` (D-838, `M04`),
 * operando sobre as 6 tabelas transacionais + `tiktok_orders_sync_lock`
 * criados em `20261125170000_tiktok_shop_transacional.sql`.
 *
 * Todos os upserts são fatiados em lotes de `500` registros e falham fechado
 * devolvendo `{ error: string | null }`.
 */

const UPSERT_BATCH = 500;

function epochSecondsToIso(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return new Date(value * 1000).toISOString();
}

export function createSupabaseTikTokSyncRepository(db: AdminClient): TikTokSyncRepository {
  return {
    async acquireOrdersLock(tiktokShopId: string, ttlSeconds: number): Promise<RepoDataResult<boolean>> {
      const res = await db.rpc("tiktok_orders_sync_lock", {
        p_tiktok_shop_id: tiktokShopId,
        p_ttl_seconds: ttlSeconds,
      });

      if (res.error !== null) {
        return { data: false, error: res.error.message };
      }

      return { data: res.data, error: null };
    },

    async releaseOrdersLock(tiktokShopId: string): Promise<RepoResult> {
      const res = await db
        .from("tiktok_shops")
        .update({ orders_sync_locked_until: null })
        .eq("id", tiktokShopId);

      return { error: res.error?.message ?? null };
    },

    async readOrdersCursor(tiktokShopId: string): Promise<RepoDataResult<string | null>> {
      const res = await db
        .from("tiktok_shops")
        .select("orders_synced_until")
        .eq("id", tiktokShopId)
        .maybeSingle();

      if (res.error !== null) {
        return { data: null, error: res.error.message };
      }

      return { data: res.data?.orders_synced_until ?? null, error: null };
    },

    async advanceOrdersCursor(tiktokShopId: string, syncedUntilIso: string): Promise<RepoResult> {
      const res = await db
        .from("tiktok_shops")
        .update({ orders_synced_until: syncedUntilIso })
        .eq("id", tiktokShopId);

      return { error: res.error?.message ?? null };
    },

    async upsertOrders(
      organizationId: string,
      tiktokShopId: string,
      orders: readonly ProjectedTikTokOrder[],
    ): Promise<RepoResult> {
      if (orders.length === 0) return { error: null };

      const orderRows = orders.map((order) => ({
        organization_id: organizationId,
        tiktok_shop_id: tiktokShopId,
        order_id: order.orderId,
        raw_status: order.rawStatus,
        lifecycle: order.lifecycle,
        fulfillment_channel: order.fulfillmentChannel,
        business_date: order.businessDate,
        created_at_remote: order.createdAt.toISOString(),
        updated_at_remote: order.updatedAt.toISOString(),
        paid_at_remote: order.paidAt === null ? null : order.paidAt.toISOString(),
        currency: order.currency,
        sub_total_brl: order.subtotalAmount,
        shipping_fee_brl: order.shippingFeeAmount,
        total_amount_brl: order.grossAmount,
      }));

      for (const batch of chunk(orderRows, UPSERT_BATCH)) {
        const res = await db
          .from("tiktok_orders")
          .upsert(batch, { onConflict: "tiktok_shop_id,order_id" });

        if (res.error !== null) {
          return { error: res.error.message };
        }
      }

      const itemRows = orders.flatMap((order) =>
        order.items.map((item) => ({
          organization_id: organizationId,
          tiktok_shop_id: tiktokShopId,
          order_id: order.orderId,
          position: item.position,
          sku_id: item.skuId,
          seller_sku: item.sellerSku,
          product_id: item.productId,
          is_gift: item.isGift,
          quantity: item.quantity,
          line_item_ids: item.lineItemIds,
          sale_price_total: item.salePriceTotal,
          original_price_total: item.originalPriceTotal,
          seller_discount_total: item.sellerDiscountTotal,
          platform_discount_total: item.platformDiscountTotal,
          combined_listing_skus: item.combinedListingSkus as unknown as Json,
        })),
      );

      for (const batch of chunk(itemRows, UPSERT_BATCH)) {
        const res = await db
          .from("tiktok_order_items")
          .upsert(batch, { onConflict: "tiktok_shop_id,order_id,position" });

        if (res.error !== null) {
          return { error: res.error.message };
        }
      }

      return { error: null };
    },

    async upsertCatalogUnits(
      organizationId: string,
      tiktokShopId: string,
      units: readonly ProjectedTikTokListingUnit[],
    ): Promise<RepoResult> {
      if (units.length === 0) return { error: null };

      const rows = units.map((unit) => ({
        organization_id: organizationId,
        tiktok_shop_id: tiktokShopId,
        product_id: unit.productId,
        sku_key: unit.skuId ?? "__PRODUCT__",
        sku_id: unit.skuId,
        seller_sku: unit.sellerSku,
        seller_sku_key: unit.sellerSkuKey,
        title: unit.title,
        raw_status: unit.rawStatus,
        lifecycle: unit.lifecycle,
        currency: unit.currency,
        original_price_brl: unit.originalPriceBrl,
        sale_price_brl: unit.salePriceBrl,
        available_stock: unit.availableStock,
        committed_stock: unit.committedStock,
        created_at_remote: unit.createdAtIso,
        updated_at_remote: unit.updatedAtIso,
      }));

      for (const batch of chunk(rows, UPSERT_BATCH)) {
        const res = await db
          .from("tiktok_catalog_units")
          .upsert(batch, { onConflict: "tiktok_shop_id,product_id,sku_key" });

        if (res.error !== null) {
          return { error: res.error.message };
        }
      }

      return { error: null };
    },

    async upsertReturns(
      organizationId: string,
      tiktokShopId: string,
      returns: readonly ProjectedTikTokReturn[],
    ): Promise<RepoResult> {
      if (returns.length === 0) return { error: null };

      const rows = returns.map((ret) => ({
        organization_id: organizationId,
        tiktok_shop_id: tiktokShopId,
        return_id: ret.returnId,
        order_id: ret.orderId,
        normalized_status: ret.normalizedStatus,
        kind: ret.kind,
        completed: ret.completed,
        business_date: ret.businessDate,
        currency: ret.currency,
        refund_total_brl: ret.refundTotalBrl,
        refund_subtotal_brl: ret.refundSubtotalBrl,
        refund_shipping_brl: ret.refundShippingBrl,
        items: ret.items as unknown as Json,
        created_at_remote: ret.createdAtIso,
        updated_at_remote: ret.updatedAtIso,
      }));

      for (const batch of chunk(rows, UPSERT_BATCH)) {
        const res = await db
          .from("tiktok_returns")
          .upsert(batch, { onConflict: "tiktok_shop_id,return_id" });

        if (res.error !== null) {
          return { error: res.error.message };
        }
      }

      return { error: null };
    },

    async upsertOrderFinancials(
      organizationId: string,
      tiktokShopId: string,
      orderId: string,
      transaction: TikTokOrderStatementTransaction,
    ): Promise<RepoResult> {
      const res = await db.from("tiktok_order_financials").upsert(
        {
          organization_id: organizationId,
          tiktok_shop_id: tiktokShopId,
          order_id: orderId,
          currency: transaction.currency ?? null,
          revenue_amount: parseTikTokDecimal(transaction.revenue_amount),
          settlement_amount: parseTikTokDecimal(transaction.settlement_amount),
          fee_and_tax_amount: parseTikTokDecimal(transaction.fee_and_tax_amount),
          shipping_cost_amount: parseTikTokDecimal(transaction.shipping_cost_amount),
          sku_transactions: (transaction.sku_transactions ?? []) as unknown as Json,
          raw_summary: transaction as unknown as Json,
        },
        { onConflict: "tiktok_shop_id,order_id" },
      );

      return { error: res.error?.message ?? null };
    },

    async upsertStatements(
      organizationId: string,
      tiktokShopId: string,
      statements: readonly TikTokStatement[],
    ): Promise<RepoResult> {
      if (statements.length === 0) return { error: null };

      const rows = statements.map((st) => ({
        organization_id: organizationId,
        tiktok_shop_id: tiktokShopId,
        statement_id: st.id,
        statement_time: epochSecondsToIso(st.statement_time),
        payment_status: st.payment_status ?? null,
        currency: st.currency ?? null,
        revenue_amount: parseTikTokDecimal(st.revenue_amount),
        settlement_amount: parseTikTokDecimal(st.settlement_amount),
        fee_amount: parseTikTokDecimal(st.fee_amount),
        adjustment_amount: parseTikTokDecimal(st.adjustment_amount),
        shipping_fee_amount: parseTikTokDecimal(st.shipping_cost_amount),
        net_sales_amount: parseTikTokDecimal(st.net_sales_amount),
      }));

      for (const batch of chunk(rows, UPSERT_BATCH)) {
        const res = await db
          .from("tiktok_statements")
          .upsert(batch, { onConflict: "tiktok_shop_id,statement_id" });

        if (res.error !== null) {
          return { error: res.error.message };
        }
      }

      return { error: null };
    },
  };
}
