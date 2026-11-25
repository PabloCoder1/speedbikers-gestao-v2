import {
  TIKTOK_JOB_TYPES,
  tiktokOrderFetchPayloadSchema,
  tiktokOrdersSyncPayloadSchema,
  tiktokScheduleDedupeKey,
} from "@sb/contracts";
import { projectTikTokOrder, type ProjectedTikTokOrder } from "@sb/domain";
import {
  getOrderDetail,
  ORDER_DETAIL_MAX_BATCH,
  ORDER_SEARCH_MAX_PAGE_SIZE,
  searchOrdersPage,
  type TikTokOrder,
  type TikTokShopAuth,
} from "@sb/tiktok-shop";

import { chunk } from "../chunk.js";
import type { EnqueueRequest } from "../enqueue.js";
import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { falhaDoTikTok, lerLojaTikTokConectada, type TikTokJobDeps } from "./tiktok-comum.js";
import type { TikTokSyncRepository } from "./tiktok-repository.js";
import { ensureTikTokAccessToken } from "./tiktok-token.js";

/**
 * Handlers `tiktok.orders.sync` e `tiktok.order.fetch` (D-834, `M04`):
 * espelham o rigor de `shopee-orders-sync.ts` (D-426/D-432/D-481/D-832) com
 * isolamento multi-tenant, trava com `finally` protegido, paginação limitada,
 * projeção sem PII (`projectTikTokOrder`), avanço de marco apenas pós-gravação
 * e enfileiramento pós-unlock protegido em `try/catch`.
 */

const JANELA_INICIAL_S = 90 * 24 * 60 * 60;
const JANELA_MAX_S = 15 * 24 * 60 * 60;
const SOBREPOSICAO_S = 10 * 60;
const TRAVA_S = 15 * 60;
const MAX_PAGINAS_PEDIDOS = 100;

export interface TikTokOrdersSyncDeps extends TikTokJobDeps {
  repository: Pick<
    TikTokSyncRepository,
    "acquireOrdersLock" | "releaseOrdersLock" | "readOrdersCursor" | "advanceOrdersCursor" | "upsertOrders"
  >;
}

export interface TikTokOrderFetchDeps extends TikTokJobDeps {
  repository: Pick<TikTokSyncRepository, "upsertOrders">;
}

function mapApiOrderToProjectionInput(order: TikTokOrder): Parameters<typeof projectTikTokOrder>[0] {
  return {
    id: order.id,
    status: order.status,
    createTime: order.create_time,
    updateTime: order.update_time,
    paidTime: order.paid_time ?? null,
    fulfillmentType: order.fulfillment_type ?? null,
    shippingType: order.shipping_type ?? null,
    payment:
      order.payment === null || order.payment === undefined
        ? null
        : {
            currency: order.payment.currency ?? null,
            subTotal: order.payment.sub_total ?? null,
            shippingFee: order.payment.shipping_fee ?? null,
            totalAmount: order.payment.total_amount ?? null,
          },
    lineItems: (order.line_items ?? []).map((item) => ({
      id: item.id,
      skuId: item.sku_id ?? null,
      sellerSku: item.seller_sku ?? null,
      productId: item.product_id ?? null,
      salePrice: item.sale_price ?? null,
      originalPrice: item.original_price ?? null,
      sellerDiscount: item.seller_discount ?? null,
      platformDiscount: item.platform_discount ?? null,
      isGift: item.is_gift ?? null,
      combinedListingSkus: (item.combined_listing_skus ?? []).map((comp) => ({
        skuId: comp.sku_id ?? null,
        sellerSku: comp.seller_sku ?? null,
        productId: comp.product_id ?? null,
        skuCount: comp.sku_count ?? null,
      })),
    })),
  };
}

async function fetchOrdersInWindow(
  deps: TikTokOrdersSyncDeps,
  shop: TikTokShopAuth,
  fromEpochS: number,
  toEpochS: number,
): Promise<{ ok: true; orders: ProjectedTikTokOrder[] } | { ok: false; outcome: JobOutcome }> {
  const orderIds: string[] = [];
  const seenIds = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_PAGINAS_PEDIDOS; page += 1) {
    const res = await searchOrdersPage(deps.client, shop, {
      pageSize: ORDER_SEARCH_MAX_PAGE_SIZE,
      ...(pageToken === undefined ? {} : { pageToken }),
      updateTimeGe: fromEpochS,
      updateTimeLt: toEpochS,
      sortOrder: "ASC",
      sortField: "update_time",
    });

    for (const order of res.orders) {
      if (!seenIds.has(order.id)) {
        seenIds.add(order.id);
        orderIds.push(order.id);
      }
    }

    if (res.nextPageToken === null) {
      const projected: ProjectedTikTokOrder[] = [];

      for (const batch of chunk(orderIds, ORDER_DETAIL_MAX_BATCH)) {
        const detailed = await getOrderDetail(deps.client, shop, batch);

        for (const order of detailed) {
          projected.push(projectTikTokOrder(mapApiOrderToProjectionInput(order)));
        }
      }

      return { ok: true, orders: projected };
    }

    pageToken = res.nextPageToken;
  }

  return {
    ok: false,
    outcome: {
      status: "failed",
      retryable: false,
      reason: `janela de pedidos do TikTok Shop excedeu o teto de ${String(MAX_PAGINAS_PEDIDOS)} páginas`,
    },
  };
}

export function createTikTokOrdersSyncHandler(deps: TikTokOrdersSyncDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = tiktokOrdersSyncPayloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload inválido para tiktok.orders.sync" };
    }

    const aberta = await lerLojaTikTokConectada(deps, context, "tiktok_orders_sync_skipped", envelope.organizationId);

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const trava = await deps.repository.acquireOrdersLock(loja.id, TRAVA_S);

    if (trava.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao travar leitura TikTok: ${trava.error}` };
    }

    if (!trava.data) {
      context.logger.info("tiktok_orders_sync_skipped", { tiktok_shop_id: loja.id, motivo: "outra leitura em andamento" });

      return { status: "done", processed: 0 };
    }

    const seguintes: EnqueueRequest[] = [];
    let outcome: JobOutcome;

    try {
      const now = deps.now?.() ?? new Date();
      const token = await ensureTikTokAccessToken(deps, loja.id, now);

      if (!token.ok) {
        outcome = { status: "failed", retryable: token.retryable, reason: token.reason };
      } else {
        const cursorRead = await deps.repository.readOrdersCursor(loja.id);

        if (cursorRead.error !== null) {
          outcome = { status: "failed", retryable: true, reason: `falha ao ler marco de pedidos TikTok: ${cursorRead.error}` };
        } else {
          const nowS = Math.floor(now.getTime() / 1000);
          const cursorMs = cursorRead.data === null ? Number.NaN : Date.parse(cursorRead.data);
          const baseS = Number.isFinite(cursorMs)
            ? Math.max(1, Math.floor(cursorMs / 1000) - SOBREPOSICAO_S)
            : Math.max(1, nowS - JANELA_INICIAL_S);
          const fimS = Math.min(nowS, baseS + JANELA_MAX_S);

          if (fimS <= baseS) {
            outcome = { status: "done", processed: 0 };
          } else {
            try {
              const fetched = await fetchOrdersInWindow(
                deps,
                { accessToken: token.accessToken, shopCipher: token.shopCipher },
                baseS,
                fimS,
              );

              if (!fetched.ok) {
                outcome = fetched.outcome;
              } else {
                if (fetched.orders.length > 0) {
                  const saved = await deps.repository.upsertOrders(loja.organization_id, loja.id, fetched.orders);

                  if (saved.error !== null) {
                    outcome = { status: "failed", retryable: true, reason: `falha ao gravar pedidos TikTok: ${saved.error}` };
                  } else {
                    const advanced = await deps.repository.advanceOrdersCursor(loja.id, new Date(fimS * 1000).toISOString());

                    if (advanced.error !== null) {
                      outcome = { status: "failed", retryable: true, reason: `falha ao avançar marco TikTok: ${advanced.error}` };
                    } else {
                      outcome = { status: "done", processed: fetched.orders.length };
                    }
                  }
                } else {
                  const advanced = await deps.repository.advanceOrdersCursor(loja.id, new Date(fimS * 1000).toISOString());

                  if (advanced.error !== null) {
                    outcome = { status: "failed", retryable: true, reason: `falha ao avançar marco TikTok: ${advanced.error}` };
                  } else {
                    outcome = { status: "done", processed: 0 };
                  }
                }

                if (outcome.status === "done") {
                  const hora = now.toISOString().slice(0, 13);

                  if (fimS < nowS) {
                    seguintes.push({
                      jobType: TIKTOK_JOB_TYPES.ordersSync,
                      organizationId: loja.organization_id,
                      dedupeKey: `${TIKTOK_JOB_TYPES.ordersSync}:${loja.id}:cont:${String(fimS)}`,
                      queue: "backfill",
                      payload: { tiktokShopId: loja.id },
                    });
                  } else {
                    seguintes.push(
                      {
                        jobType: TIKTOK_JOB_TYPES.financialsSync,
                        organizationId: loja.organization_id,
                        dedupeKey: tiktokScheduleDedupeKey(TIKTOK_JOB_TYPES.financialsSync, loja.id, hora),
                        queue: "backfill",
                        payload: { tiktokShopId: loja.id },
                      },
                      {
                        jobType: TIKTOK_JOB_TYPES.returnsSync,
                        organizationId: loja.organization_id,
                        dedupeKey: tiktokScheduleDedupeKey(TIKTOK_JOB_TYPES.returnsSync, loja.id, hora),
                        queue: "backfill",
                        payload: { tiktokShopId: loja.id },
                      },
                    );
                  }
                }
              }
            } catch (error) {
              outcome = falhaDoTikTok(error, "erro ao sincronizar pedidos do TikTok Shop");
            }
          }
        }
      }
    } finally {
      try {
        const solta = await deps.repository.releaseOrdersLock(loja.id);

        if (solta.error !== null) {
          context.logger.warn("tiktok_orders_sync_unlock_failed", { tiktok_shop_id: loja.id, reason: solta.error });
        }
      } catch (error) {
        context.logger.warn("tiktok_orders_sync_unlock_failed", {
          tiktok_shop_id: loja.id,
          reason: error instanceof Error ? error.message : "erro desconhecido",
        });
      }
    }

    for (const pedido of seguintes) {
      try {
        await deps.enqueuer.enqueue(pedido);
      } catch (error) {
        context.logger.warn("tiktok_orders_sync_enqueue_failed", {
          tiktok_shop_id: loja.id,
          job_type: pedido.jobType,
          reason: error instanceof Error ? error.message : "erro desconhecido",
        });
      }
    }

    return outcome;
  };
}

export function createTikTokOrderFetchHandler(deps: TikTokOrderFetchDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = tiktokOrderFetchPayloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload inválido para tiktok.order.fetch" };
    }

    const aberta = await lerLojaTikTokConectada(deps, context, "tiktok_order_fetch_skipped", envelope.organizationId);

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const now = deps.now?.() ?? new Date();
    const token = await ensureTikTokAccessToken(deps, loja.id, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    try {
      const detailed = await getOrderDetail(
        deps.client,
        { accessToken: token.accessToken, shopCipher: token.shopCipher },
        [parsed.data.orderId],
      );

      if (detailed.length === 0) {
        return { status: "done", processed: 0 };
      }

      const projected = detailed.map((order) => projectTikTokOrder(mapApiOrderToProjectionInput(order)));
      const saved = await deps.repository.upsertOrders(loja.organization_id, loja.id, projected);

      if (saved.error !== null) {
        return { status: "failed", retryable: true, reason: `falha ao gravar pedido TikTok: ${saved.error}` };
      }

      try {
        await deps.enqueuer.enqueue({
          jobType: TIKTOK_JOB_TYPES.financialsSync,
          organizationId: loja.organization_id,
          dedupeKey: `${TIKTOK_JOB_TYPES.financialsSync}:${loja.id}:order:${parsed.data.orderId}`,
          queue: "backfill",
          payload: { tiktokShopId: loja.id, orderId: parsed.data.orderId },
        });
      } catch (error) {
        context.logger.warn("tiktok_order_fetch_enqueue_financials_failed", {
          tiktok_shop_id: loja.id,
          order_id: parsed.data.orderId,
          reason: error instanceof Error ? error.message : "erro desconhecido",
        });
      }

      return { status: "done", processed: projected.length };
    } catch (error) {
      return falhaDoTikTok(error, "erro ao ler detalhe de pedido do TikTok Shop");
    }
  };
}
