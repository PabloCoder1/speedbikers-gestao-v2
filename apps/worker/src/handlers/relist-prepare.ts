import type { AdminClient, Json } from "@sb/db";
import { canTransitionRelist, evaluateRelistPreflight } from "@sb/domain";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { getItemsBatch } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";

/**
 * `relist.prepare` (Fase 9, D-161) — o segundo elo do fio: captura o
 * snapshot do pai e roda o preflight. A operação nasce REQUESTED com o
 * `parent_snapshot` da hora (D-159: capturado na criação, nunca
 * sobrescrito) e, se o preflight reprovar, morre PREFLIGHT_FAILED com os
 * motivos — SEM ter tocado o Mercado Livre além de um GET.
 *
 * **Nada destrutivo acontece aqui.** O fechamento do pai e o POST /relist
 * são a fatia seguinte, atrás de confirmação própria. Este handler é
 * deliberadamente só-leitura no remoto.
 *
 * Idempotência: o índice único parcial `listing_relists_one_live_per_parent`
 * (D-159) é a garantia — um retry do Cloud Tasks que chegue depois do
 * insert cai em 23505 e termina em paz, sem segunda operação.
 */

const payloadSchema = z.object({
  mlAccountId: z.uuid(),
  itemId: z.string().regex(/^MLB\d+$/),
  requestedBy: z.uuid(),
});

export interface RelistPrepareDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
}

export function createRelistPrepareHandler(deps: RelistPrepareDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload inválido para relist.prepare" };
    }

    const { mlAccountId, itemId, requestedBy } = parsed.data;
    const now = deps.now?.() ?? new Date();

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler a conta: ${account.error.message}` };
    }

    if (account.data?.status !== "CONNECTED") {
      context.logger.warn("relist_prepare_account_unavailable", { ml_account_id: mlAccountId, item_id: itemId });

      return { status: "done", processed: 0 };
    }

    const organizationId = account.data.organization_id;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    const entries = await getItemsBatch({
      client: deps.mercadoLivre,
      ids: [itemId],
      accessToken: tokenResult.accessToken,
    });

    const entry = entries[0];

    if (entry?.code !== 200) {
      // Item que o ML não devolve (removido, banido) não vira operação: não
      // há snapshot para auditar nem pai para fechar. Retry não muda isso.
      context.logger.warn("relist_prepare_item_unavailable", {
        ml_account_id: mlAccountId,
        item_id: itemId,
        code: entry?.code ?? null,
      });

      return { status: "done", processed: 0 };
    }

    const snapshot = entry.body;

    // O corpo precisa ser DO item pedido — um multiget que devolvesse outro
    // id gravaria snapshot do anúncio errado e o preflight aprovaria/reprovaria
    // com base em outro anúncio. Isso é defeito, não condição de retry.
    if (typeof snapshot !== "object" || snapshot === null || (snapshot as { id?: unknown }).id !== itemId) {
      return { status: "failed", retryable: false, reason: "o corpo devolvido não corresponde ao item pedido" };
    }

    const inserted = await deps.db
      .from("listing_relists")
      .insert({
        organization_id: organizationId,
        ml_account_id: mlAccountId,
        parent_item_id: itemId,
        status: "REQUESTED",
        // O corpo veio de `response.json()` do multiget — é JSON por
        // construção; o guard acima já fixou objeto com o id certo.
        parent_snapshot: snapshot as Json,
        requested_by: requestedBy,
      })
      .select("id")
      .single();

    if (inserted.error !== null) {
      // 23505 = já existe operação viva/concluída para este pai (índice
      // parcial de D-159). É o retry do Cloud Tasks, ou um segundo pedido
      // legítimo que a constraint existe para conter — termina em paz.
      if (inserted.error.code === "23505") {
        context.logger.info("relist_prepare_duplicate", { ml_account_id: mlAccountId, item_id: itemId });

        return { status: "done", processed: 0 };
      }

      return { status: "failed", retryable: true, reason: `falha ao criar a operação: ${inserted.error.message}` };
    }

    const relistId = inserted.data.id;

    // Evento de criação com o ATOR humano (D-159). Falhar aqui não desfaz a
    // operação (a linha carrega requested_by/created_at); logar e seguir —
    // falhar o job inteiro repetiria o insert e cairia no 23505 SEM o evento.
    const createdEvent = await deps.db.from("listing_relist_events").insert({
      organization_id: organizationId,
      ml_account_id: mlAccountId,
      relist_id: relistId,
      from_status: null,
      to_status: "REQUESTED",
      actor_user_id: requestedBy,
    });

    if (createdEvent.error !== null) {
      context.logger.error("relist_event_not_recorded", {
        relist_id: relistId,
        to_status: "REQUESTED",
        reason: createdEvent.error.message,
      });
    }

    const preflight = evaluateRelistPreflight(snapshot);

    if (!preflight.approved && canTransitionRelist("REQUESTED", "PREFLIGHT_FAILED")) {
      const failureReason = preflight.blocks.map((block) => block.descricao).join(" ");

      const updated = await deps.db
        .from("listing_relists")
        .update({ status: "PREFLIGHT_FAILED", failure_reason: failureReason })
        .eq("id", relistId);

      if (updated.error !== null) {
        // Sem a transição gravada, a operação ficaria REQUESTED aprovável —
        // o oposto do veredito. Isso é falha do job, com retry (o update é
        // idempotente).
        return {
          status: "failed",
          retryable: true,
          reason: `falha ao registrar o preflight reprovado: ${updated.error.message}`,
        };
      }

      const failedEvent = await deps.db.from("listing_relist_events").insert({
        organization_id: organizationId,
        ml_account_id: mlAccountId,
        relist_id: relistId,
        from_status: "REQUESTED",
        to_status: "PREFLIGHT_FAILED",
        actor_user_id: null,
        reason: preflight.blocks.map((block) => block.code).join(","),
      });

      if (failedEvent.error !== null) {
        context.logger.error("relist_event_not_recorded", {
          relist_id: relistId,
          to_status: "PREFLIGHT_FAILED",
          reason: failedEvent.error.message,
        });
      }
    }

    context.logger.info("relist_prepare_done", {
      relist_id: relistId,
      ml_account_id: mlAccountId,
      item_id: itemId,
      approved: preflight.approved,
      blocks: preflight.blocks.map((block) => block.code),
      warnings: preflight.warnings.map((warning) => warning.code),
    });

    return { status: "done", processed: 1 };
  };
}
