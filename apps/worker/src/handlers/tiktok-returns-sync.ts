import { tiktokReturnsSyncPayloadSchema } from "@sb/contracts";
import { projectTikTokReturn, type ProjectedTikTokReturn } from "@sb/domain";
import { RETURN_SEARCH_MAX_PAGE_SIZE, searchReturnsPage } from "@sb/tiktok-shop";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { falhaDoTikTok, lerLojaTikTokConectada, type TikTokJobDeps } from "./tiktok-comum.js";
import type { TikTokSyncRepository } from "./tiktok-repository.js";
import { ensureTikTokAccessToken } from "./tiktok-token.js";

/**
 * Handler `tiktok.returns.sync` (D-834, `M04`): consulta devoluções da janela
 * recente de 30 dias no TikTok Shop, projeta via `projectTikTokReturn`
 * (normalizando `_CANCEL`/`_CANCELLED` e descartando PII) e grava de forma
 * idempotente.
 */

const JANELA_DEVOLUCOES_S = 30 * 24 * 60 * 60;
const MAX_PAGINAS_DEVOLUCOES = 100;

export interface TikTokReturnsSyncDeps extends Pick<TikTokJobDeps, "db" | "client" | "encryptionKey" | "now"> {
  repository: Pick<TikTokSyncRepository, "upsertReturns">;
}

export function createTikTokReturnsSyncHandler(deps: TikTokReturnsSyncDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = tiktokReturnsSyncPayloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload inválido para tiktok.returns.sync" };
    }

    const aberta = await lerLojaTikTokConectada(deps, context, "tiktok_returns_sync_skipped", envelope.organizationId);

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const now = deps.now?.() ?? new Date();
    const token = await ensureTikTokAccessToken(deps, loja.id, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    const nowS = Math.floor(now.getTime() / 1000);
    const fromS = Math.max(1, nowS - JANELA_DEVOLUCOES_S);
    const shop = { accessToken: token.accessToken, shopCipher: token.shopCipher };

    try {
      const projected: ProjectedTikTokReturn[] = [];
      let pageToken: string | undefined;
      let exhausted = false;

      for (let page = 0; page < MAX_PAGINAS_DEVOLUCOES; page += 1) {
        const res = await searchReturnsPage(deps.client, shop, {
          pageSize: RETURN_SEARCH_MAX_PAGE_SIZE,
          ...(pageToken === undefined ? {} : { pageToken }),
          updateTimeGe: fromS,
          updateTimeLt: nowS,
        });

        for (const item of res.returns) {
          projected.push(
            projectTikTokReturn({
              return_id: item.return_id,
              order_id: item.order_id,
              return_type: item.return_type ?? null,
              return_status: item.return_status,
              create_time: item.create_time ?? null,
              update_time: item.update_time ?? null,
              refund_amount:
                item.refund_amount === null || item.refund_amount === undefined
                  ? null
                  : {
                      currency: item.refund_amount.currency ?? null,
                      refund_total: item.refund_amount.refund_total ?? null,
                      refund_subtotal: item.refund_amount.refund_subtotal ?? null,
                      refund_shipping_fee: item.refund_amount.refund_shipping_fee ?? null,
                      refund_tax: item.refund_amount.refund_tax ?? null,
                    },
              return_line_items: (item.return_line_items ?? []).map((line) => ({
                product_id: line.product_id ?? null,
                sku_id: line.sku_id ?? null,
                seller_sku: line.seller_sku ?? null,
              })),
            }),
          );
        }

        if (res.nextPageToken === null) {
          exhausted = true;
          break;
        }

        pageToken = res.nextPageToken;
      }

      if (!exhausted) {
        return {
          status: "failed",
          retryable: false,
          reason: `devoluções do TikTok Shop excederam o teto de ${String(MAX_PAGINAS_DEVOLUCOES)} páginas`,
        };
      }

      if (projected.length === 0) {
        return { status: "done", processed: 0 };
      }

      const saved = await deps.repository.upsertReturns(loja.organization_id, loja.id, projected);

      if (saved.error !== null) {
        return { status: "failed", retryable: true, reason: `falha ao gravar devoluções TikTok: ${saved.error}` };
      }

      return { status: "done", processed: projected.length };
    } catch (error) {
      return falhaDoTikTok(error, "erro ao sincronizar devoluções do TikTok Shop");
    }
  };
}
