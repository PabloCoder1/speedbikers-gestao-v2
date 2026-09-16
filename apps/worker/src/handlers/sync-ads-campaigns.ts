import type { AdminClient } from "@sb/db";
import { shiftBusinessDate, toSalesMetricDate } from "@sb/domain";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import {
  MercadoLivreApiError,
  PRODUCT_ADS_MAX_DAYS_BACK,
  fetchProductAdsAdvertiser,
  fetchProductAdsCampaignDailyMetrics,
  fetchProductAdsCampaigns,
} from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `sync.ads.campaigns` — Mercado Ads (Product Ads) de UMA conta (D-363).
 *
 * Três passos, na ordem da doc oficial:
 *
 * 1. **anunciante** — grava o resultado em `ads_advertisers`, INCLUSIVE o
 *    "não habilitado" (404 da API). Conta sem Product Ads termina `done` com
 *    zero processados: é estado da conta, não falha do sync;
 * 2. **campanhas** — upsert em `ads_campaigns` (projeção da última leitura);
 * 3. **métricas por dia de cada campanha** — os últimos 90 dias (o máximo da
 *    doc), por upsert em `daily_ads_campaign_metrics`. Regravar a janela
 *    inteira é o que corrige o dia que o Mercado Livre ajusta depois (os números
 *    fecham às 10h, GMT-3) sem duplicar nada.
 *
 * Uma campanha que falha com erro NÃO retryable (404/403 daquela campanha)
 * vira `partial` e as outras seguem; erro retryable interrompe e devolve para
 * a fila, como os outros syncs.
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

/** Pausa entre campanhas: a API não publica limite, e o 429 já custou rodadas (D-171). */
const PAUSA_ENTRE_CAMPANHAS_MS = 150;

export interface SyncAdsCampaignsDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const dormir = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createSyncAdsCampaignsHandler(deps: SyncAdsCampaignsDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const now = deps.now?.() ?? new Date();
    const sleep = deps.sleep ?? dormir;

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null || account.data === null) {
      context.logger.warn("sync_ads_campaigns_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.status !== "CONNECTED") {
      context.logger.info("sync_ads_campaigns_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const organizationId = account.data.organization_id;
    const base = { organizationId, mlAccountId, jobId: envelope.jobId, resource: "ads" as const, channel: "reconciliation" as const };

    const falhar = async (reason: string, errorClass: "retryable" | "retryable_eventual" | "not_retryable"): Promise<JobOutcome> => {
      await recordSyncRunFailure(
        deps.db,
        { ...base, startedAt: now, finishedAt: deps.now?.() ?? new Date(), reason, errorClass },
        context.logger,
      );

      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    };

    const token = await ensureAccessToken(deps, mlAccountId, now);

    if (!token.ok) {
      return await falhar(token.reason, token.retryable ? "retryable" : "not_retryable");
    }

    const dateTo = toSalesMetricDate(now);
    const dateFrom = shiftBusinessDate(dateTo, -(PRODUCT_ADS_MAX_DAYS_BACK - 1));

    let campanhasLidas = 0;
    let diasGravados = 0;
    let campanhasComFalha = 0;

    try {
      const anunciante = await fetchProductAdsAdvertiser(deps.mercadoLivre, token.accessToken);

      const gravadoAnunciante = await deps.db.from("ads_advertisers").upsert(
        {
          ml_account_id: mlAccountId,
          organization_id: organizationId,
          status: anunciante.status,
          advertiser_id: anunciante.status === "habilitado" ? anunciante.advertiserId : null,
          site_id: anunciante.status === "habilitado" ? anunciante.siteId : null,
          checked_at: now.toISOString(),
        },
        { onConflict: "ml_account_id" },
      );

      if (gravadoAnunciante.error !== null) {
        return await falhar(`falha ao gravar o anunciante: ${gravadoAnunciante.error.message}`, "retryable");
      }

      if (anunciante.status === "nao_habilitado") {
        await recordSyncRunSuccess(
          deps.db,
          {
            ...base,
            itemsProcessed: 0,
            latestRecordAt: null,
            startedAt: now,
            finishedAt: deps.now?.() ?? new Date(),
            status: "done",
            reason: "conta sem Product Ads habilitado no Mercado Livre",
          },
          context.logger,
        );
        context.logger.info("sync_ads_campaigns_not_enabled", { ml_account_id: mlAccountId });

        return { status: "done", processed: 0 };
      }

      const campanhas = await fetchProductAdsCampaigns(
        deps.mercadoLivre,
        token.accessToken,
        anunciante.siteId,
        anunciante.advertiserId,
      );

      if (campanhas.length > 0) {
        const gravadas = await deps.db.from("ads_campaigns").upsert(
          campanhas.map((c) => ({
            organization_id: organizationId,
            ml_account_id: mlAccountId,
            campaign_id: c.id,
            name: c.name,
            status: c.status,
            strategy: c.strategy ?? null,
            budget: c.budget ?? null,
            roas_target: c.roas_target ?? null,
            acos_target: c.acos_target ?? null,
            synced_at: now.toISOString(),
          })),
          { onConflict: "ml_account_id,campaign_id" },
        );

        if (gravadas.error !== null) {
          return await falhar(`falha ao gravar campanhas: ${gravadas.error.message}`, "retryable");
        }
      }

      for (const [indice, campanha] of campanhas.entries()) {
        if (indice > 0) await sleep(PAUSA_ENTRE_CAMPANHAS_MS);

        let dias;

        try {
          dias = await fetchProductAdsCampaignDailyMetrics(
            deps.mercadoLivre,
            token.accessToken,
            anunciante.siteId,
            campanha.id,
            dateFrom,
            dateTo,
          );
        } catch (error) {
          if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
            campanhasComFalha += 1;
            context.logger.warn("sync_ads_campaigns_campaign_failed", {
              ml_account_id: mlAccountId,
              campaign_id: campanha.id,
              status: error.status,
            });
            continue;
          }

          throw error;
        }

        campanhasLidas += 1;

        if (dias.length === 0) continue;

        const gravados = await deps.db.from("daily_ads_campaign_metrics").upsert(
          dias.map((d) => ({
            organization_id: organizationId,
            ml_account_id: mlAccountId,
            campaign_id: campanha.id,
            metric_date: d.date,
            clicks: Math.round(d.clicks),
            prints: Math.round(d.prints),
            cost: d.cost,
            direct_amount: d.direct_amount,
            indirect_amount: d.indirect_amount,
            total_amount: d.total_amount,
            direct_units: Math.round(d.direct_units_quantity),
            indirect_units: Math.round(d.indirect_units_quantity),
            units: Math.round(d.units_quantity),
            organic_units: d.organic_units_quantity === undefined || d.organic_units_quantity === null ? null : Math.round(d.organic_units_quantity),
            organic_amount: d.organic_units_amount ?? null,
            synced_at: now.toISOString(),
          })),
          { onConflict: "ml_account_id,campaign_id,metric_date" },
        );

        if (gravados.error !== null) {
          return await falhar(`falha ao gravar métricas da campanha ${String(campanha.id)}: ${gravados.error.message}`, "retryable");
        }

        diasGravados += dias.length;
      }
    } catch (error) {
      const errorClass = error instanceof MercadoLivreApiError ? error.errorClass : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido ao sincronizar Mercado Ads";

      return await falhar(reason, errorClass);
    }

    const finishedAt = deps.now?.() ?? new Date();
    const partial = campanhasComFalha > 0;

    await recordSyncRunSuccess(
      deps.db,
      {
        ...base,
        itemsProcessed: diasGravados,
        latestRecordAt: finishedAt,
        startedAt: now,
        finishedAt,
        status: partial ? "partial" : "done",
        ...(partial ? { reason: `${String(campanhasComFalha)} campanha(s) recusadas pelo Mercado Livre (404/403)` } : {}),
      },
      context.logger,
    );

    context.logger.info("sync_ads_campaigns_done", {
      ml_account_id: mlAccountId,
      campaigns_read: campanhasLidas,
      campaigns_failed: campanhasComFalha,
      days_written: diasGravados,
      date_from: dateFrom,
      date_to: dateTo,
    });

    return { status: "done", processed: diasGravados };
  };
}
