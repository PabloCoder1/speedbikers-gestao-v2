/*
 * Relatório avulso de validação de /compras — NÃO faz parte de `npm
 * test`. Roda uma vez para produzir evidência (auditoria/RELATORIO.md,
 * relatório final da ETAPA 32), não é um gate de CI.
 *
 * Uso:
 *   npx tsx --env-file=.env.local scripts/validate-purchase-planning.ts
 *
 * Busca uma amostra ampla via get_purchase_planning_validation_sample
 * (que só seleciona linhas de private.get_purchase_planning_signals —
 * nenhuma fórmula é reimplementada aqui), recalcula cada linha com
 * calculatePurchaseRecommendation() e reporta qualquer divergência
 * entre o SQL e a função pura testada, além dos outliers.
 */
import { createClient } from "@supabase/supabase-js";

import { calculatePurchaseRecommendation } from "../src/features/stock/stock-domain";

const SAMPLE_SIZE = 200;

type ValidationSampleItem = {
  sourceSku: string;
  sourceSkuKey: string;
  title: string | null;
  brand: string | null;
  category: string;
  physicalAvailable: number | null;
  physicalCurrent: number | null;
  purchaseInTransit: number | null;
  transferInTransit: number | null;
  lowStockThreshold: number | null;
  directUnitsSold30: number | null;
  kitUnitsConsumed30: number | null;
  physicalUnitsConsumed30: number | null;
  avgDailySales30: number | null;
  salesVelocityReady: boolean;
  leadTimeDays: number;
  demandDuringLeadTime: number | null;
  targetReserve: number | null;
  projectedStockAtArrival: number | null;
  suggestedPurchaseQuantity: number | null;
  status: string;
  planningIssue: string | null;
  sourceProductsCount: number;
  unitCost: number | null;
  estimatedPurchaseValue: number | null;
};

function createAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL não está configurada.");
  }
  if (!supabaseSecretKey) {
    throw new Error("SUPABASE_SECRET_KEY não está configurada.");
  }

  return createClient(supabaseUrl, supabaseSecretKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

async function main() {
  const admin = createAdminClient();

  const { data: organization, error: organizationError } = await admin
    .from("organizations")
    .select("id, name, slug")
    .eq("slug", "speed-bikers")
    .single();

  if (organizationError || !organization) {
    throw new Error(
      `Não foi possível localizar a organização Speed Bikers: ${organizationError?.message ?? "organização não encontrada"}`,
    );
  }

  const { data, error } = await admin.rpc("get_purchase_planning_validation_sample", {
    target_organization_id: organization.id,
    sample_size: SAMPLE_SIZE,
  });

  if (error) {
    throw new Error(`get_purchase_planning_validation_sample falhou: ${error.message}`);
  }

  const items = (data?.items ?? []) as ValidationSampleItem[];

  console.log("");
  console.log("Speed Bikers Gestão V2 — Validação de /compras (ETAPA 32)");
  console.log("============================================================");
  console.log(`Organização: ${organization.name}`);
  console.log(`Linhas verificadas: ${items.length}`);
  console.log("");

  let divergences = 0;

  for (const item of items) {
    const recomputed = calculatePurchaseRecommendation({
      physicalAvailable: item.physicalAvailable,
      purchaseInTransit: item.purchaseInTransit,
      lowStockThreshold: item.lowStockThreshold,
      avgDailySales30: item.avgDailySales30,
      salesVelocityReady: item.salesVelocityReady,
      leadTimeDays: item.leadTimeDays,
      mappingReliable: item.planningIssue ? false : true,
    });

    const sqlSuggested = item.suggestedPurchaseQuantity ?? null;
    const tsSuggested = recomputed.suggestedPurchaseQuantity;
    const suggestedMatches =
      sqlSuggested === tsSuggested ||
      (sqlSuggested !== null &&
        tsSuggested !== null &&
        Math.abs(sqlSuggested - tsSuggested) < 1e-6);
    const statusMatches = item.status === recomputed.status;

    if (!suggestedMatches || !statusMatches) {
      divergences += 1;
      console.log(
        `DIVERGÊNCIA — ${item.sourceSku} (${item.category}): SQL suggested=${sqlSuggested} status=${item.status} | TS suggested=${tsSuggested} status=${recomputed.status}`,
      );
    }
  }

  console.log("");
  console.log(
    divergences === 0
      ? `Nenhuma divergência SQL × TS em ${items.length} linhas.`
      : `${divergences} divergência(s) encontrada(s) em ${items.length} linhas — BLOQUEADOR, ver instruções.`,
  );

  const sku13014 = items.find((item) => item.sourceSku === "13014");
  console.log("");
  console.log("SKU 13014:", sku13014 ? JSON.stringify(sku13014, null, 2) : "não presente na amostra/planejamento atual.");

  const topBySuggested = [...items]
    .filter((item) => item.suggestedPurchaseQuantity !== null)
    .sort((a, b) => (b.suggestedPurchaseQuantity ?? 0) - (a.suggestedPurchaseQuantity ?? 0))
    .slice(0, 20);

  const topByValue = [...items]
    .filter((item) => item.estimatedPurchaseValue !== null)
    .sort((a, b) => (b.estimatedPurchaseValue ?? 0) - (a.estimatedPurchaseValue ?? 0))
    .slice(0, 20);

  console.log("");
  console.log(`Top ${topBySuggested.length} por quantidade sugerida:`);
  for (const item of topBySuggested) {
    console.log(`  ${item.sourceSku.padEnd(16)} suggested=${item.suggestedPurchaseQuantity} status=${item.status}`);
  }

  console.log("");
  console.log(`Top ${topByValue.length} por valor estimado:`);
  for (const item of topByValue) {
    console.log(
      `  ${item.sourceSku.padEnd(16)} value=R$ ${(item.estimatedPurchaseValue ?? 0).toFixed(2)} suggested=${item.suggestedPurchaseQuantity}`,
    );
  }

  console.log("");

  if (divergences > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("");
  console.error("Falha na validação de /compras.");
  console.error(error);
  console.error("");
  process.exit(1);
});
