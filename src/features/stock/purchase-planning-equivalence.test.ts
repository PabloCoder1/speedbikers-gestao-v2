import assert from "node:assert/strict";
import { test } from "node:test";

import { createClient } from "@supabase/supabase-js";

import { calculatePurchaseRecommendation } from "@/features/stock/stock-domain";

/*
 * Diferente de todo outro teste deste arquivo de suíte: este precisa
 * de credenciais reais do Supabase, porque compara o
 * suggested_purchase_quantity/status calculado em SQL
 * (get_purchase_planning_validation_sample, item 15 da ETAPA 32)
 * contra calculatePurchaseRecommendation(). Não há Postgres local
 * neste repositório. Pula silenciosamente sem essas variáveis — não é
 * um gate de CI, é a evidência de que os dois lados concordam quando
 * rodado contra produção (ver scripts/validate-purchase-planning.ts
 * para o relatório completo com outliers).
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

test(
  "get_purchase_planning_validation_sample bate com calculatePurchaseRecommendation() linha a linha",
  { skip: !hasCredentials },
  async () => {
    const admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const { data: organization, error: organizationError } = await admin
      .from("organizations")
      .select("id")
      .eq("slug", "speed-bikers")
      .single();

    assert.equal(organizationError, null);
    assert.ok(organization);

    const { data, error } = await admin.rpc("get_purchase_planning_validation_sample", {
      target_organization_id: organization.id,
      sample_size: 30,
    });

    assert.equal(error, null);

    const items = (data?.items ?? []) as Array<{
      sourceSku: string;
      physicalAvailable: number | null;
      purchaseInTransit: number | null;
      lowStockThreshold: number | null;
      avgDailySales30: number | null;
      salesVelocityReady: boolean;
      leadTimeDays: number;
      status: string;
      planningIssue: string | null;
      suggestedPurchaseQuantity: number | null;
    }>;

    assert.ok(items.length > 0, "amostra de validação de compras veio vazia");

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

      assert.equal(
        recomputed.status,
        item.status,
        `status divergente para ${item.sourceSku}: SQL=${item.status} TS=${recomputed.status}`,
      );
      assert.equal(
        recomputed.suggestedPurchaseQuantity,
        item.suggestedPurchaseQuantity,
        `suggestedPurchaseQuantity divergente para ${item.sourceSku}`,
      );
    }
  },
);
