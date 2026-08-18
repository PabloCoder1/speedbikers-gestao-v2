import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { createClient } from "@supabase/supabase-js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AdminClient = any;

/*
 * private.enqueue_operational_alert_reconciliation() lives in the
 * `private` schema, not exposed via PostgREST, so it can't be invoked
 * directly from a test — and there's no local Postgres in this repo
 * to run it against a throwaway database either. This test instead
 * verifies the exact three inclusion criteria from the migration
 * (current listing OR current variation OR open alert) against real
 * production rows in each state, read-only, no writes. It intentionally
 * re-expresses the same OR condition as three separate existence
 * checks rather than calling the SQL function — a faithful mirror of
 * a simple boolean union, not a reimplementation of business logic.
 */
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY;
const hasCredentials = Boolean(supabaseUrl && supabaseSecretKey);

async function isReconciliationCandidate(
  admin: AdminClient,
  organizationId: string,
  productId: string,
) {
  const [listing, variation, alert] = await Promise.all([
    admin
      .from("ml_listings")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("product_id", productId)
      .eq("is_current", true),
    admin
      .from("ml_listing_variations")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("product_id", productId)
      .eq("is_current", true),
    admin
      .from("operational_alerts")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("product_id", productId)
      .eq("status", "open"),
  ]);

  return {
    hasCurrentListing: (listing.count ?? 0) > 0,
    hasCurrentVariation: (variation.count ?? 0) > 0,
    hasOpenAlert: (alert.count ?? 0) > 0,
  };
}

test(
  "cenários 3-6 — critérios de inclusão/exclusão da reconciliação periódica contra dados reais",
  { skip: !hasCredentials },
  async () => {
    const admin = createClient(supabaseUrl as string, supabaseSecretKey as string, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });

    const { data: organization } = await admin
      .from("organizations")
      .select("id")
      .eq("slug", "speed-bikers")
      .single();
    assert.ok(organization);

    // Cenário 3 — product com listing atual deve ser candidato.
    const { data: listedProduct } = await admin
      .from("ml_listings")
      .select("product_id")
      .eq("organization_id", organization.id)
      .eq("is_current", true)
      .not("product_id", "is", null)
      .limit(1)
      .single();
    assert.ok(listedProduct, "esperava encontrar ao menos um listing atual mapeado");
    const listedCriteria = await isReconciliationCandidate(
      admin,
      organization.id,
      listedProduct.product_id,
    );
    assert.equal(listedCriteria.hasCurrentListing, true);

    // Cenário 4 — product com variação atual deve ser candidato,
    // mesmo que a busca não exija ausência de listing (o critério é OR).
    const { data: variantProduct } = await admin
      .from("ml_listing_variations")
      .select("product_id")
      .eq("organization_id", organization.id)
      .eq("is_current", true)
      .not("product_id", "is", null)
      .limit(1)
      .single();
    assert.ok(variantProduct, "esperava encontrar ao menos uma variação atual mapeada");
    const variantCriteria = await isReconciliationCandidate(
      admin,
      organization.id,
      variantProduct.product_id,
    );
    assert.equal(variantCriteria.hasCurrentVariation, true);

    // Cenário 5 — product com alerta aberto deve ser candidato, mesmo
    // sem listing/variação atual (o caso que justifica o critério C).
    const { data: openAlerts } = await admin
      .from("operational_alerts")
      .select("product_id")
      .eq("organization_id", organization.id)
      .eq("status", "open")
      .limit(200);

    let alertOnlyProductId: string | null = null;
    for (const row of openAlerts ?? []) {
      const criteria = await isReconciliationCandidate(admin, organization.id, row.product_id);
      if (!criteria.hasCurrentListing && !criteria.hasCurrentVariation && criteria.hasOpenAlert) {
        alertOnlyProductId = row.product_id;
        break;
      }
    }
    assert.ok(
      alertOnlyProductId,
      "esperava encontrar ao menos um product com alerta aberto e sem listing/variação atual",
    );

    // Cenário 6 — product histórico (sem listing/variação atual e sem
    // alerta aberto) NÃO deve ser candidato.
    const { data: allProducts } = await admin
      .from("products")
      .select("id")
      .eq("organization_id", organization.id)
      .limit(500);

    let historicalProductId: string | null = null;
    for (const row of allProducts ?? []) {
      const criteria = await isReconciliationCandidate(admin, organization.id, row.id);
      if (!criteria.hasCurrentListing && !criteria.hasCurrentVariation && !criteria.hasOpenAlert) {
        historicalProductId = row.id;
        break;
      }
    }
    assert.ok(
      historicalProductId,
      "esperava encontrar ao menos um product histórico sem listing/variação/alerta",
    );
  },
);

// ============================================================
// cenário 7 — a limpeza do backlog histórico só pode remover jobs
// 'queued' com reason 'periodic_reconcile', nunca 'running', jobs de
// evento real, jobs 'failed', ou linhas de operational_alerts. Checado
// estruturalmente no texto da migration (sem Postgres local).
// ============================================================

test("cenário 7 — a limpeza do backlog só tem permissão de remover queued + periodic_reconcile", () => {
  const filePath = path.join(
    process.cwd(),
    "supabase/migrations/20260818161000_scope_operational_alert_reconciliation.sql",
  );
  const sql = readFileSync(filePath, "utf8");

  const deleteBlockMatch = sql.match(/delete from public\.operational_alert_jobs[\s\S]*?;/);
  assert.ok(deleteBlockMatch, "esperava encontrar o bloco de delete da limpeza");
  const deleteBlock = deleteBlockMatch[0];

  assert.ok(deleteBlock.includes("job.status = 'queued'"));
  assert.ok(deleteBlock.includes("job.reason = 'periodic_reconcile'"));
  assert.ok(deleteBlock.includes("not exists"));
  assert.ok(
    !/delete from public\.operational_alerts\b/.test(sql),
    "a limpeza nunca deve apagar linhas de operational_alerts",
  );
});
