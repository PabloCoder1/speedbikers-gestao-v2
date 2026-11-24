import { TIKTOK_ITEMS_DELAY_S, TIKTOK_JOB_TYPES, tiktokScheduleDedupeKey } from "@sb/contracts";
import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";

import type { Enqueuer } from "./enqueue.js";

/**
 * Gatilho periódico do TikTok Shop (D-810, contratos compartilhados D-812, `M04`) —
 * espelha `shopee-orders-schedule.ts` (D-426/D-428) com paginação por chave
 * (`> 1.000` lojas seguro) e isolamento de falha de enqueue por loja
 * (D-793/D-794/D-882).
 *
 * Para cada loja `CONNECTED` em `tiktok_shops`, enfileira:
 * - `tiktok.orders.sync` imediato (renova o token primeiro);
 * - `tiktok.items.sync` com atraso de `TIKTOK_ITEMS_DELAY_S` (300 s), evitando
 *   disputa pela trava de renovação do token.
 */

export { TIKTOK_ITEMS_DELAY_S };
export const TIKTOK_SHOPS_PAGE_SIZE = 500;
const MAX_SHOPS_PAGES = 100;

export interface TikTokOrdersScheduleDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export interface TikTokOrdersScheduleOutcome {
  failed?: true;
  shopsScanned: number;
  enqueued: number;
  deduplicated: number;
}

async function listConnectedTikTokShops(
  db: AdminClient,
): Promise<{ shops: { id: string; organization_id: string }[]; error: string | null }> {
  const shops: { id: string; organization_id: string }[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_SHOPS_PAGES; page += 1) {
    let query = db
      .from("tiktok_shops")
      .select("id, organization_id")
      .eq("status", "CONNECTED")
      .order("id", { ascending: true });

    if (cursor !== undefined) {
      query = query.gt("id", cursor);
    }

    const result = await query.limit(TIKTOK_SHOPS_PAGE_SIZE);

    if (result.error !== null) {
      return { shops: [], error: result.error.message };
    }

    const batch = result.data;

    shops.push(...batch);

    if (batch.length < TIKTOK_SHOPS_PAGE_SIZE) {
      return { shops, error: null };
    }

    const last = batch.at(-1);

    if (last === undefined) {
      return { shops, error: null };
    }

    cursor = last.id;
  }

  return { shops: [], error: "limite máximo de páginas excedido ao listar lojas TikTok Shop" };
}

export async function triggerTikTokOrdersSync(deps: TikTokOrdersScheduleDeps): Promise<TikTokOrdersScheduleOutcome> {
  const now = deps.now?.() ?? new Date();
  const nowMs = now.getTime();
  const hora = (Number.isFinite(nowMs) ? now : new Date()).toISOString().slice(0, 13);

  const listed = await listConnectedTikTokShops(deps.db);

  if (listed.error !== null) {
    deps.logger.error("tiktok_orders_schedule_shops_not_listed", { reason: listed.error });

    return { shopsScanned: 0, enqueued: 0, deduplicated: 0, failed: true };
  }

  let enqueued = 0;
  let deduplicated = 0;
  let enqueueFailed = false;

  for (const loja of listed.shops) {
    for (const [jobType, atraso] of [
      [TIKTOK_JOB_TYPES.ordersSync, undefined],
      [TIKTOK_JOB_TYPES.itemsSync, TIKTOK_ITEMS_DELAY_S],
    ] as const) {
      try {
        const result = await deps.enqueuer.enqueue({
          jobType,
          organizationId: loja.organization_id,
          dedupeKey: tiktokScheduleDedupeKey(jobType, loja.id, hora),
          queue: "backfill",
          payload: { tiktokShopId: loja.id },
          ...(atraso === undefined ? {} : { delaySeconds: atraso }),
        });

        if (result.deduplicated) {
          deduplicated += 1;
        } else {
          enqueued += 1;
        }
      } catch (error) {
        enqueueFailed = true;
        deps.logger.error("tiktok_orders_schedule_enqueue_failed", {
          tiktok_shop_id: loja.id,
          job_type: jobType,
          reason: error instanceof Error ? error.message : "falha ao enfileirar tarefa TikTok Shop",
        });
      }
    }
  }

  deps.logger.info("tiktok_orders_schedule_triggered", {
    shops_scanned: listed.shops.length,
    enqueued,
    deduplicated,
    ...(enqueueFailed ? { failed: true } : {}),
  });

  return {
    shopsScanned: listed.shops.length,
    enqueued,
    deduplicated,
    ...(enqueueFailed ? { failed: true as const } : {}),
  };
}
