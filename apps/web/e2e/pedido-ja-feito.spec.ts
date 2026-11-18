import type { Database } from "@sb/db";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Locator } from "@playwright/test";

import { E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * "Já fiz o pedido" na reposição (D-760 a D-763), de ponta a ponta:
 * registrar → a sugestão cai pelo que foi pedido (uma vez só) → a linha diz
 * quanto falta → o filtro de compra acha o SKU → a mesma referência não vira
 * outro pedido → cancelar devolve a necessidade inteira.
 *
 * O seed não tem regra de reposição nem 84 dias de histórico (e
 * `reposicao.spec.ts` conta com isso). O caso grava uma regra SÓ do SKU do
 * seed e os dias de venda que faltam, e apaga os dois no fim; o pedido é
 * cancelado pela própria tela, o que zera o trânsito que ele criou.
 */

const REFERENCIA = `E2E-PJF-${String(Date.now()).slice(-6)}`;

function banco(): ReturnType<typeof createClient<Database>> {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");

  return createClient<Database>(url.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
}

let regraId: string | null = null;
let metricasCriadas: string[] = [];

test.beforeAll(async () => {
  const seed = await readSeedOutput();
  const db = banco();
  const conta = await db.from("ml_accounts").select("id").eq("organization_id", seed.organizationId).order("created_at").limit(1).single();

  if (conta.error !== null) throw new Error(conta.error.message);

  const regra = await db
    .from("replenishment_settings")
    .insert({ organization_id: seed.organizationId, sku_id: seed.skuId, lead_time_days: 30, target_coverage_days: 30, safety_stock_days: 0 })
    .select("id")
    .single();

  if (regra.error !== null) throw new Error(regra.error.message);
  regraId = regra.data.id;

  const existentes = await db.from("daily_sku_metrics").select("metric_date").eq("sku_id", seed.skuId).eq("ml_account_id", conta.data.id);
  const ja = new Set((existentes.data ?? []).map((m) => m.metric_date));
  const hoje = new Date();
  const novas = Array.from({ length: 90 }, (_, i) => {
    const d = new Date(hoje.getTime() - i * 86_400_000);

    return d.toISOString().slice(0, 10);
  })
    .filter((dia) => !ja.has(dia))
    .map((dia) => ({
      organization_id: seed.organizationId,
      ml_account_id: conta.data.id,
      sku_id: seed.skuId,
      metric_date: dia,
      units_sold: 20,
      gross_revenue: 400,
      orders_count: 1,
      purchases_count: 1,
    }));
  const inseridas = await db.from("daily_sku_metrics").insert(novas).select("id");

  if (inseridas.error !== null) throw new Error(inseridas.error.message);
  metricasCriadas = inseridas.data.map((m) => m.id);
});

test.afterAll(async () => {
  const db = banco();

  for (let i = 0; i < metricasCriadas.length; i += 200) {
    await db.from("daily_sku_metrics").delete().in("id", metricasCriadas.slice(i, i + 200));
  }

  if (regraId !== null) await db.from("replenishment_settings").delete().eq("id", regraId);
});

async function sugestaoDaLinha(linha: Locator): Promise<number> {
  const texto = await linha.locator(".sb-rep-sugestao").innerText();

  return Number(texto.replace(/\D/g, ""));
}

test("já fiz o pedido: a sugestão desconta uma vez, a referência não duplica e cancelar devolve a necessidade", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, `/reposicao?busca=${E2E_SKU_CODE}`);

  const linha = page.locator("tbody tr", { hasText: E2E_SKU_CODE }).first();
  const antes = await sugestaoDaLinha(linha);

  expect(antes).toBeGreaterThan(20);

  const pedido = antes - 10;

  await linha.getByRole("button", { name: "Já fiz o pedido" }).click();

  const dialogo = page.getByRole("dialog");

  await dialogo.getByLabel(/Quantidade encomendada/).fill(String(pedido));
  await dialogo.getByLabel("Nº ou referência do pedido").fill(REFERENCIA);
  await dialogo.getByRole("button", { name: "Registrar pedido" }).click();
  // Outro pedido em aberto do mesmo SKU (de outro spec) faz o banco perguntar antes: é outra compra.
  const outro = dialogo.getByRole("button", { name: "É outro pedido: registrar" });
  const feito = dialogo.getByText(/registrado\. As .* un entram como pendentes de chegada/);

  await expect(outro.or(feito)).toBeVisible();
  if (await outro.isVisible()) await outro.click();
  await expect(feito).toBeVisible();
  await dialogo.getByRole("button", { name: "Fechar" }).click();

  // Necessidade adicional = a sugestão de antes menos o que foi pedido: o trânsito entrou uma vez.
  await expect(linha.locator(".sb-pjf-resumo summary")).toContainText(/un já pedidas\. Necessidade adicional: 10 un\./);
  await expect(linha.locator(".sb-rep-sugestao")).toContainText("10");
  await linha.locator(".sb-pjf-resumo summary").click();
  await expect(linha.locator(".sb-pjf-pedidos")).toContainText(`ref. ${REFERENCIA}`);

  // O filtro de compra acha o SKU entre os encomendados e o tira de "sem pedido".
  await page.goto(`/reposicao?busca=${E2E_SKU_CODE}&compra=ENCOMENDADO`);
  await expect(page.locator("tbody tr", { hasText: E2E_SKU_CODE })).toHaveCount(1);
  await page.goto(`/reposicao?busca=${E2E_SKU_CODE}&compra=SEM_PEDIDO`);
  await expect(page.locator("tbody tr", { hasText: E2E_SKU_CODE })).toHaveCount(0);

  // A mesma referência de novo: o banco devolve o pedido existente, nada é criado.
  await page.goto(`/reposicao?busca=${E2E_SKU_CODE}`);
  await linha.getByRole("button", { name: "Já fiz o pedido" }).click();
  await dialogo.getByLabel(/Quantidade encomendada/).fill("5");
  await dialogo.getByLabel("Nº ou referência do pedido").fill(REFERENCIA.toLowerCase());
  await dialogo.getByRole("button", { name: "Registrar pedido" }).click();
  await expect(dialogo.getByText(/Já existe um pedido com esta referência/)).toBeVisible();
  await expect(dialogo.getByRole("button", { name: "É outro pedido: registrar" })).toHaveCount(0);

  const verPedido = dialogo.getByRole("link", { name: /Pedido nº/ }).first();
  const href = await verPedido.getAttribute("href");

  await dialogo.getByRole("button", { name: "Voltar" }).click();
  await dialogo.getByRole("button", { name: "Cancelar" }).click();

  // Cancelar o pedido: a quantidade deixa de reduzir a necessidade.
  await page.goto(href ?? "/compras");
  await page.getByRole("button", { name: "Cancelar pedido" }).click();
  await page.getByLabel("Motivo do cancelamento (opcional)").fill("teste e2e");
  await page.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect(page.getByText(/Cancelado:/)).toBeVisible();

  await page.goto(`/reposicao?busca=${E2E_SKU_CODE}`);
  await expect(linha.locator(".sb-rep-sugestao")).toContainText(new Intl.NumberFormat("pt-BR").format(antes));
  await expect(linha.locator(".sb-pjf-resumo")).toHaveCount(0);
});
