import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import type { ParsedClaim } from "./claim-schema.js";
import { claimDetailSchema, claimMessagesSchema } from "./claim-schema.js";
import {
  mapClaimDeadlinesToProjection,
  mapClaimMessagesToProjection,
  mapClaimToSupportProjection,
} from "./claim-support-projection.js";
import { persistSupportClaim } from "./persist-support-claim.js";

/**
 * Ingestão COMPLETA de um claim já em mãos: envelope (D-104) + transcript
 * (D-106) + prazos (D-107).
 *
 * Extraída de `claim-return.ts` em D-108 para ser compartilhada com a
 * reconciliação. Duplicar a cadeia nos dois caminhos garantiria que um dia
 * eles divergissem — e a divergência apareceria como "o claim que veio pelo
 * webhook tem transcript, o que veio pela varredura não".
 *
 * **Nunca lança.** Os dois chamadores têm trabalho próprio que não pode ser
 * derrubado por uma falha de projeção de leitura: no webhook é a reversão de
 * ESTOQUE (dado financeiro em produção desde D-057); na varredura são os
 * outros claims da mesma página. A persistência é idempotente, então a
 * próxima passada reconverge.
 */

export interface IngestSupportClaimDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
}

export interface IngestSupportClaimContext {
  organizationId: string;
  mlAccountId: string;
  source: "WEBHOOK" | "RECONCILIATION";
}

export async function ingestSupportClaim(
  deps: IngestSupportClaimDeps,
  context: IngestSupportClaimContext,
  accessToken: string,
  claimId: string,
  claim: ParsedClaim,
  logger: Logger,
): Promise<boolean> {
  const projection = mapClaimToSupportProjection(claim);

  if (projection === null) {
    logger.warn("claim_support_projection_skipped_without_timestamp", {
      claim_id: String(claim.id),
      reason: "claim sem date_created nem last_updated",
    });

    return false;
  }

  // O transcript é UMA chamada a mais contra uma API limitada, e falhar nela
  // não pode custar o envelope: um case sem transcript ainda é um atendimento
  // visível e triável na Caixa de Entrada.
  let messages: ReturnType<typeof mapClaimMessagesToProjection> = [];

  try {
    const remote = await deps.mercadoLivre.request({
      method: "GET",
      path: `/post-purchase/v1/claims/${claimId}/messages`,
      accessToken,
      schema: claimMessagesSchema,
    });

    messages = mapClaimMessagesToProjection(claim, remote);
  } catch (error) {
    logger.warn("claim_transcript_fetch_failed", {
      claim_id: String(claim.id),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Mesma degradação: sem o detalhe, o case fica sem prazo remoto — melhor
  // que prazo inventado (D-084) e melhor que perder o atendimento inteiro.
  let deadlines: ReturnType<typeof mapClaimDeadlinesToProjection>;

  try {
    const detail = await deps.mercadoLivre.request({
      method: "GET",
      path: `/post-purchase/v1/claims/${claimId}/detail`,
      accessToken,
      schema: claimDetailSchema,
    });

    deadlines = mapClaimDeadlinesToProjection(claim, detail);
  } catch (error) {
    logger.warn("claim_detail_fetch_failed", {
      claim_id: String(claim.id),
      error: error instanceof Error ? error.message : String(error),
    });

    // As ações disponíveis vêm do claim que JÁ está em mãos, então elas
    // continuam virando prazo mesmo sem o detalhe.
    deadlines = mapClaimDeadlinesToProjection(claim, null);
  }

  try {
    const result = await persistSupportClaim(deps.db, context, projection, messages, deadlines);

    logger.info("claim_support_case_persisted", {
      claim_id: String(claim.id),
      support_case_id: result.supportCaseId,
      source: context.source,
      link_mode: result.linkMode,
      transition_applied: result.transitionApplied,
      messages_upserted: result.messagesUpserted,
      deadlines_upserted: result.deadlinesUpserted,
      is_mediation: projection.case.isMediation,
      has_return: projection.case.hasReturn,
    });

    return true;
  } catch (error) {
    logger.error("claim_support_projection_failed", {
      claim_id: String(claim.id),
      source: context.source,
      error: error instanceof Error ? error.message : String(error),
    });

    return false;
  }
}
