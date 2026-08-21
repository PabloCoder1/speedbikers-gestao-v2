import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import {
  decryptToken,
  encryptToken,
  MercadoLivreApiError,
  paginateOffset,
  refreshAccessToken,
} from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * Reconciliação por janela: rede de segurança do que o webhook perdeu
 * (`docs/MERCADO_LIVRE.md` secao 3, `docs/ARCHITECTURE.md` secao 10).
 *
 * Escopo desta etapa: buscar a janela no Mercado Livre e registrar o
 * resultado em `sync_runs`/`sync_errors` — a persistência estruturada dos
 * pedidos (`orders`/`order_items`, `pack_id`) é o PRÓXIMO item do checklist
 * da Fase 3, feito de propósito à parte (mesmo padrão incremental de
 * "schema primeiro, escrita depois" já usado em `sync_runs` na Fase 2).
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

const orderSearchResultSchema = z.object({
  id: z.number(),
  last_updated: z.string(),
});

const orderSearchResponseSchema = z.object({
  paging: z.object({ total: z.number(), offset: z.number(), limit: z.number() }),
  results: z.array(orderSearchResultSchema),
});

export interface SyncOrdersWindowDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

/** Buffer antes de expirar em que já vale renovar, em vez de arriscar 401 no meio da varredura. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_LOCK_MS = 60 * 1000;

/**
 * Confirmado por leitura direta (`developers.mercadolivre.com.br`, "Gerencie
 * vendas → Orders", 2026-08-21): `/orders/search` "usa até a hora e descarta
 * a informação dos minutos, segundos e milissegundos". Qualquer granularidade
 * abaixo de 1h é ilusória — a V3 nunca envia minutos não-zero.
 *
 * `from` arredonda PARA BAIXO (nunca perder um registro no limite); `to`
 * arredonda PARA CIMA (nunca depender de qual direção o Mercado Livre
 * arredondaria um valor não documentado). A sobreposição resultante é
 * aceitável — todo processamento é idempotente por natureza.
 */
function floorToHour(date: Date): Date {
  const floored = new Date(date);

  floored.setUTCMinutes(0, 0, 0);

  return floored;
}

function ceilToHour(date: Date): Date {
  const floored = floorToHour(date);

  return floored.getTime() === date.getTime() ? floored : new Date(floored.getTime() + 3_600_000);
}

function toMercadoLivreDate(date: Date): string {
  return date.toISOString().replace("Z", "+00:00");
}

type AccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; retryable: boolean; reason: string };

/**
 * Garante um `access_token` válido, renovando quando perto de expirar.
 *
 * A trava (`refresh_locked_until`) existe porque o `refresh_token` é de uso
 * único (`docs/MERCADO_LIVRE.md` secao 6): um refresh concorrente sem trava
 * invalida o token que a outra execução ainda ia usar. Reivindicação
 * ATÔMICA — um único `UPDATE ... WHERE refresh_locked_until IS NULL OR
 * refresh_locked_until < now()` — mesmo padrão do consumo de `state` em
 * `apps/api/src/ml-accounts.ts`.
 */
async function ensureAccessToken(
  deps: SyncOrdersWindowDeps,
  mlAccountId: string,
  now: Date,
): Promise<AccessTokenResult> {
  const credentials = await deps.db
    .from("ml_credentials")
    .select("access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at")
    .eq("ml_account_id", mlAccountId)
    .maybeSingle();

  if (credentials.error !== null || credentials.data === null) {
    return { ok: false, retryable: false, reason: "conta CONNECTED sem credenciais gravadas" };
  }

  const expiresAt = new Date(credentials.data.access_token_expires_at);

  if (expiresAt.getTime() - now.getTime() > REFRESH_BUFFER_MS) {
    return { ok: true, accessToken: decryptToken(credentials.data.access_token_ciphertext, deps.encryptionKey) };
  }

  const claimed = await deps.db
    .from("ml_credentials")
    .update({ refresh_locked_until: new Date(now.getTime() + REFRESH_LOCK_MS).toISOString() })
    .eq("ml_account_id", mlAccountId)
    .or(`refresh_locked_until.is.null,refresh_locked_until.lt.${now.toISOString()}`)
    .select("ml_account_id")
    .maybeSingle();

  if (claimed.error !== null || claimed.data === null) {
    return { ok: false, retryable: true, reason: "refresh do token em andamento por outra execução" };
  }

  let token;

  try {
    token = await refreshAccessToken(
      deps.oauth,
      decryptToken(credentials.data.refresh_token_ciphertext, deps.encryptionKey),
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : "falha ao renovar o token";

    await deps.db
      .from("ml_credentials")
      .update({ refresh_locked_until: null })
      .eq("ml_account_id", mlAccountId);
    await deps.db
      .from("ml_accounts")
      .update({ status: "ERROR", last_error: reason.slice(0, 2000) })
      .eq("id", mlAccountId);

    return { ok: false, retryable: false, reason };
  }

  const newExpiresAt = new Date(now.getTime() + token.expires_in * 1000);

  await deps.db
    .from("ml_credentials")
    .update({
      access_token_ciphertext: encryptToken(token.access_token, deps.encryptionKey),
      refresh_token_ciphertext: encryptToken(token.refresh_token, deps.encryptionKey),
      access_token_expires_at: newExpiresAt.toISOString(),
      refresh_locked_until: null,
    })
    .eq("ml_account_id", mlAccountId);

  return { ok: true, accessToken: token.access_token };
}

/**
 * Checkpoint entre execuções: `latest_record_at` (ou, se a última execução
 * não trouxe nada novo, `started_at` dela — perder zero é seguro) da última
 * `sync_run` bem-sucedida deste recurso e canal. Primeira execução usa
 * `connected_at` como piso. Nunca offset persistido (`docs/MERCADO_LIVRE.md`
 * secao 4).
 */
async function resolveWindowFrom(
  db: AdminClient,
  mlAccountId: string,
  connectedAt: string | null,
  now: Date,
): Promise<Date> {
  const lastRun = await db
    .from("sync_runs")
    .select("latest_record_at, started_at")
    .eq("ml_account_id", mlAccountId)
    .eq("resource", "orders")
    .eq("channel", "reconciliation")
    .in("status", ["done", "partial"])
    .order("finished_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lastRun.data !== null) {
    return floorToHour(new Date(lastRun.data.latest_record_at ?? lastRun.data.started_at));
  }

  const fallback = connectedAt ?? new Date(now.getTime() - 24 * 3_600_000).toISOString();

  return floorToHour(new Date(fallback));
}

export function createSyncOrdersWindowHandler(deps: SyncOrdersWindowDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, seller_id, status, connected_at")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null || account.data === null) {
      context.logger.warn("sync_orders_window_account_missing", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    if (account.data.status !== "CONNECTED" || account.data.seller_id === null) {
      // Desconectada entre o enfileiramento e a execução — corrida benigna,
      // não erro. A próxima janela, se a conta reconectar, cobre o intervalo.
      context.logger.info("sync_orders_window_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    // Copiados para variáveis locais logo após a guarda: acesso repetido a
    // `account.data.seller_id` dentro do closure de `fetchPage`, abaixo, não
    // preserva o estreitamento de tipo do `if` acima.
    const { organization_id: organizationId, seller_id: sellerId, connected_at: connectedAt } = account.data;

    const started = now;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      await recordFailure(deps, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        startedAt: started,
        finishedAt: deps.now?.() ?? new Date(),
        reason: tokenResult.reason,
        errorClass: tokenResult.retryable ? "retryable" : "not_retryable",
      });

      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    const windowFrom = await resolveWindowFrom(deps.db, mlAccountId, connectedAt, now);
    const windowTo = ceilToHour(now);

    let itemsProcessed = 0;
    let latestRecordAt: Date | null = null;

    try {
      const pages = paginateOffset({
        fetchPage: ({ offset, limit }) =>
          deps.mercadoLivre.request({
            method: "GET",
            path: "/orders/search",
            accessToken: tokenResult.accessToken,
            searchParams: {
              seller: sellerId,
              "order.date_last_updated.from": toMercadoLivreDate(windowFrom),
              "order.date_last_updated.to": toMercadoLivreDate(windowTo),
              offset,
              limit,
            },
            schema: orderSearchResponseSchema,
          }),
      });

      for await (const page of pages) {
        itemsProcessed += page.length;

        for (const item of page) {
          const updatedAt = new Date(item.last_updated);

          if (latestRecordAt === null || updatedAt > latestRecordAt) {
            latestRecordAt = updatedAt;
          }
        }
      }
    } catch (error) {
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass =
        error instanceof MercadoLivreApiError
          ? error.errorClass
          : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido ao buscar pedidos";

      await recordFailure(deps, {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        startedAt: started,
        finishedAt,
        reason,
        errorClass,
      });

      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    const finishedAt = deps.now?.() ?? new Date();

    await deps.db.from("sync_runs").insert({
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      job_id: envelope.jobId,
      resource: "orders",
      channel: "reconciliation",
      status: "done",
      items_processed: itemsProcessed,
      latest_record_at: latestRecordAt?.toISOString() ?? null,
      started_at: started.toISOString(),
      finished_at: finishedAt.toISOString(),
    });

    context.logger.info("sync_orders_window_done", {
      ml_account_id: mlAccountId,
      window_from: windowFrom.toISOString(),
      window_to: windowTo.toISOString(),
      items_processed: itemsProcessed,
    });

    return { status: "done", processed: itemsProcessed };
  };
}

async function recordFailure(
  deps: SyncOrdersWindowDeps,
  params: {
    organizationId: string;
    mlAccountId: string;
    jobId: string;
    startedAt: Date;
    finishedAt: Date;
    reason: string;
    errorClass: "retryable" | "retryable_eventual" | "not_retryable";
  },
): Promise<void> {
  const run = await deps.db
    .from("sync_runs")
    .insert({
      organization_id: params.organizationId,
      ml_account_id: params.mlAccountId,
      job_id: params.jobId,
      resource: "orders",
      channel: "reconciliation",
      status: "failed",
      reason: params.reason.slice(0, 2000),
      started_at: params.startedAt.toISOString(),
      finished_at: params.finishedAt.toISOString(),
    })
    .select("id")
    .maybeSingle();

  await deps.db.from("sync_errors").insert({
    organization_id: params.organizationId,
    ml_account_id: params.mlAccountId,
    sync_run_id: run.data?.id ?? null,
    resource: "orders",
    error_class: params.errorClass,
    message: params.reason.slice(0, 2000),
    occurred_at: params.finishedAt.toISOString(),
  });
}
