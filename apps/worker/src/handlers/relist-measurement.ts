import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { Logger } from "@sb/observability";

/**
 * Medição 7/15/30 da republicação (Fase 9, D-164) — REUSO de D-065, como o
 * PRD manda: uma ação `republicacao` (nasce RESOLVIDA — é registro de ato
 * consumado, não pendência para a Central triar) + uma `action_decisions`
 * com o `baseline_snapshot` capturado NA HORA do REMAPPED. Daí em diante o
 * job diário `diagnostics.measure-decision-outcomes` mede as janelas
 * sozinho — ele enumera TODAS as decisões da organização, sem filtro de
 * status, e é exatamente por isso que nenhuma máquina nova nasce aqui.
 *
 * Linguagem de honestidade (PRD): "após a republicação", NUNCA "por causa
 * da" — a comparação é lado a lado, jamais causal.
 *
 * A decisão é atribuída ao HUMANO que pediu a republicação
 * (`listing_relists.requested_by`) — `action_decisions.created_by` exige
 * gente, e aqui ela existe de verdade.
 *
 * Idempotente por construção: `actions.dedup_key = republicacao:{relist_id}`
 * (UNIQUE por organização) e uma decisão por ação — reprocessar o job depois
 * do REMAPPED confere e completa o que faltar, nunca duplica.
 */

export interface RelistMeasurementDeps {
  db: AdminClient;
  now?: () => Date;
}

export interface RelistMeasurementOperation {
  id: string;
  organization_id: string;
  ml_account_id: string;
  parent_item_id: string;
  child_item_id: string;
  requested_by: string;
}

export async function ensureRelistMeasurement(
  deps: RelistMeasurementDeps,
  logger: Logger,
  operation: RelistMeasurementOperation,
): Promise<{ ok: boolean; message?: string }> {
  const now = deps.now?.() ?? new Date();
  const dedupKey = `republicacao:${operation.id}`;

  // SKU mensurável = o vínculo de ITEM inteiro do filho, que o remapeamento
  // de D-163 acabou de retargetar. Pai de variações não tem SKU mensurável
  // até a vinculação humana — a decisão nasce sem SKU e o baseline fica
  // vazio, a MESMA convenção do job de medição para ação sem SKU.
  const childLink = await deps.db
    .from("sku_listing_links")
    .select("sku_id")
    .eq("ml_account_id", operation.ml_account_id)
    .eq("ref_kind", "ITEM")
    .eq("item_id", operation.child_item_id)
    .is("variation_id", null)
    .maybeSingle();

  if (childLink.error !== null) {
    return { ok: false, message: `falha ao ler o vínculo do filho: ${childLink.error.message}` };
  }

  const skuId = childLink.data?.sku_id ?? null;

  let actionId: string;

  const existingAction = await deps.db
    .from("actions")
    .select("id")
    .eq("organization_id", operation.organization_id)
    .eq("dedup_key", dedupKey)
    .maybeSingle();

  if (existingAction.error !== null) {
    return { ok: false, message: `falha ao conferir a ação: ${existingAction.error.message}` };
  }

  if (existingAction.data !== null) {
    actionId = existingAction.data.id;
  } else {
    const insertedAction = await deps.db
      .from("actions")
      .insert({
        organization_id: operation.organization_id,
        kind: "republicacao",
        severity: "baixa",
        confidence: "alta",
        estimated_impact_brl: null,
        ml_account_id: operation.ml_account_id,
        sku_id: skuId,
        mlb_id: operation.child_item_id,
        evidence: {
          relist_id: operation.id,
          parent_item_id: operation.parent_item_id,
          child_item_id: operation.child_item_id,
          evidencias: [
            {
              tipo: "republicacao",
              descricao: `Anúncio ${operation.parent_item_id} republicado como ${operation.child_item_id}.`,
            },
          ],
        },
        recommendation:
          "Acompanhar as janelas de 7/15/30 dias após a republicação — comparação lado a lado, nunca causal.",
        status: "resolvido",
        created_by: "system",
        dedup_key: dedupKey,
      })
      .select("id")
      .single();

    if (insertedAction.error !== null) {
      // 23505 = corrida com outra execução — a outra criou; reler resolve.
      if (insertedAction.error.code === "23505") {
        const raced = await deps.db
          .from("actions")
          .select("id")
          .eq("organization_id", operation.organization_id)
          .eq("dedup_key", dedupKey)
          .maybeSingle();

        if (raced.error !== null || raced.data === null) {
          return { ok: false, message: "corrida ao criar a ação de republicação e releitura falhou" };
        }

        actionId = raced.data.id;
      } else {
        return { ok: false, message: `falha ao criar a ação de republicação: ${insertedAction.error.message}` };
      }
    } else {
      actionId = insertedAction.data.id;
    }
  }

  const existingDecision = await deps.db
    .from("action_decisions")
    .select("id")
    .eq("action_id", actionId)
    .maybeSingle();

  if (existingDecision.error !== null) {
    return { ok: false, message: `falha ao conferir a decisão: ${existingDecision.error.message}` };
  }

  if (existingDecision.data !== null) {
    return { ok: true };
  }

  // Baseline NA HORA (D-065): mesma função SQL das medições futuras, só
  // muda o as_of. Sem SKU, baseline vazio — mesma convenção do job.
  let baseline: unknown = {};

  if (skuId !== null) {
    const snapshot = await deps.db.rpc("get_sku_decision_snapshot", {
      p_organization_id: operation.organization_id,
      p_sku_id: skuId,
      p_as_of: toSalesMetricDate(now),
    });

    if (snapshot.error !== null) {
      return { ok: false, message: `falha ao capturar o baseline: ${snapshot.error.message}` };
    }

    baseline = snapshot.data;
  }

  const insertedDecision = await deps.db.from("action_decisions").insert({
    organization_id: operation.organization_id,
    action_id: actionId,
    decision: `Anúncio ${operation.parent_item_id} republicado como ${operation.child_item_id} (relist oficial).`,
    baseline_snapshot: baseline as never,
    created_by: operation.requested_by,
  });

  if (insertedDecision.error !== null && insertedDecision.error.code !== "23505") {
    return { ok: false, message: `falha ao registrar a decisão: ${insertedDecision.error.message}` };
  }

  logger.info("relist_measurement_recorded", {
    relist_id: operation.id,
    action_id: actionId,
    sku_id: skuId,
    child_item_id: operation.child_item_id,
  });

  return { ok: true };
}
