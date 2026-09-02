import type { AdminClient, Json } from "@sb/db";
import { detectSupportPatterns } from "@sb/domain";
import type { SkuClaimAggregate, SupportPatternFinding } from "@sb/domain";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";

/**
 * `diagnostics.detect-support-patterns` (Fase 7B, D-116) — SAC virando
 * item da Central de Ações, SEMPRE por padrão agregado, nunca por
 * atendimento individual (regra literal do requisito).
 *
 * Mesmo molde de `detect-sales-anomaly-actions`: por ORGANIZAÇÃO, escreve
 * direto em `actions` via `service_role`, `ON CONFLICT (organization_id,
 * dedup_key) DO UPDATE` preservando status/responsável — uma ação que um
 * humano resolveu não reabre sozinha enquanto a condição persistir.
 *
 * O impacto NÃO é estimado por fórmula: é a soma de `orders.total_amount`
 * dos pedidos VINCULADOS aos claims — dinheiro em risco de reembolso
 * observado, não projetado.
 */

const payloadSchema = z.object({ organizationId: z.uuid() });

export interface DetectSupportPatternActionsDeps {
  db: AdminClient;
}



function toEvidence(finding: SupportPatternFinding): Json {
  return { evidencias: finding.evidencias, reclamacoes_abertas: finding.openClaims } as unknown as Json;
}

export function createDetectSupportPatternActionsHandler(
  deps: DetectSupportPatternActionsDeps,
): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem organizationId" };
    }

    const { organizationId } = parsed.data;

    // Vínculos de SKU cujos cases são CLAIM aberto. O `!inner` no embed
    // filtra pelo pai — sem ele, o filtro de canal viraria "link com case
    // nulo" em vez de "sem linha".
    const skuLinks = await deps.db
      .from("support_case_links")
      .select("support_case_id, sku_id, skus(sku, title), support_cases!inner(internal_status, channel, is_mediation)")
      .eq("organization_id", organizationId)
      .not("sku_id", "is", null)
      .eq("support_cases.channel", "CLAIM")
      .neq("support_cases.internal_status", "RESOLVIDO");

    if (skuLinks.error !== null) {
      return { status: "failed", retryable: true, reason: skuLinks.error.message };
    }

    const rows = skuLinks.data;

    if (rows.length === 0) {
      context.logger.info("detect_support_pattern_actions_done", {
        organization_id: organizationId,
        actions: 0,
      });

      return { status: "done", processed: 0 };
    }

    // Pedidos vinculados aos MESMOS cases — link de pedido e link de SKU são
    // linhas distintas (`exactly_one_target`), daí a segunda consulta.
    const caseIds = [...new Set(rows.map((row) => row.support_case_id))];

    const orderLinks = await deps.db
      .from("support_case_links")
      .select("support_case_id, orders(total_amount)")
      .eq("organization_id", organizationId)
      .in("support_case_id", caseIds)
      .not("order_id", "is", null);

    if (orderLinks.error !== null) {
      return { status: "failed", retryable: true, reason: orderLinks.error.message };
    }

    const orderTotalByCase = new Map<string, number>();

    for (const link of orderLinks.data) {
      const amount = link.orders?.total_amount;

      if (amount != null) {
        orderTotalByCase.set(link.support_case_id, (orderTotalByCase.get(link.support_case_id) ?? 0) + amount);
      }
    }

    // Agrega por SKU. Um case com dois SKUs vinculados conta nos dois — a
    // reclamação é evidência para cada produto envolvido.
    const bySkuCases = new Map<string, { sku: string; title: string | null; cases: Set<string>; mediations: Set<string> }>();

    // Dos TRES guardas de nulo que moravam aqui, dois eram mortos e um NAO
    // era — e sem o cast o compilador separa os dois casos sozinho (D-200):
    //
    // - `sku_id` e anulavel no banco, mas o `.not("sku_id", "is", null)` da
    //   consulta acima estreita o tipo. Guarda morto.
    // - `support_cases` vem com `!inner`. Guarda morto.
    // - `skus` NAO tem `!inner`, e o embed continua anulavel. **Este fica.**
    //
    // Tentei remover os tres de uma vez e o `tsc` recusou na hora, apontando
    // exatamente o terceiro. E o que o cast escondia: com ele, os tres pareciam
    // igualmente necessarios (ou igualmente dispensaveis) e nada distinguia.
    for (const row of rows) {
      if (row.skus === null) {
        continue;
      }


      const entry = bySkuCases.get(row.sku_id) ?? {
        sku: row.skus.sku,
        title: row.skus.title,
        cases: new Set<string>(),
        mediations: new Set<string>(),
      };

      entry.cases.add(row.support_case_id);

      if (row.support_cases.is_mediation) {
        entry.mediations.add(row.support_case_id);
      }

      bySkuCases.set(row.sku_id, entry);
    }

    const aggregates: SkuClaimAggregate[] = [...bySkuCases.entries()].map(([skuId, entry]) => {
      const linkedTotal = [...entry.cases].reduce(
        (sum, caseId) => sum + (orderTotalByCase.get(caseId) ?? 0),
        0,
      );

      return {
        skuId,
        sku: entry.sku,
        title: entry.title,
        openClaims: entry.cases.size,
        openMediations: entry.mediations.size,
        linkedOrdersTotalBrl: linkedTotal > 0 ? Math.round(linkedTotal * 100) / 100 : null,
      };
    });

    const findings = detectSupportPatterns(aggregates);

    if (findings.length > 0) {
      const actionRows = findings.map((finding) => ({
        organization_id: organizationId,
        kind: "reclamacoes_recorrentes",
        // Mediação envolvida sobe a severidade — dinheiro e reputação já em
        // disputa; sem mediação é 'media', o alerta padrão de padrão.
        severity: finding.openMediations > 0 ? "alta" : "media",
        confidence: "alta",
        estimated_impact_brl: finding.impactBrl,
        sku_id: finding.skuId,
        evidence: toEvidence(finding),
        recommendation: finding.recomendacao,
        created_by: "system",
        dedup_key: finding.dedupKey,
      }));

      const upsertResult = await deps.db.from("actions").upsert(actionRows, {
        onConflict: "organization_id,dedup_key",
      });

      if (upsertResult.error !== null) {
        return { status: "failed", retryable: true, reason: upsertResult.error.message };
      }
    }

    context.logger.info("detect_support_pattern_actions_done", {
      organization_id: organizationId,
      skus_with_open_claims: bySkuCases.size,
      actions: findings.length,
    });

    return { status: "done", processed: findings.length };
  };
}
