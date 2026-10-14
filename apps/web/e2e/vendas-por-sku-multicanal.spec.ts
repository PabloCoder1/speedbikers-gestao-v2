import { type Page, expect, test } from "@playwright/test";

import { E2E_SHOPEE_ITEMS, E2E_SHOPEE_SHOP, E2E_SKU_SALES } from "./constants.js";
import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * Vendas POR SKU entre os marketplaces (D-444, etapa T6a), sobre o C-59 (D-439).
 *
 * O seed tem uma conta do Mercado Livre e uma loja Shopee de TESTE. Isso faz
 * deste spec a prova de equivalência: como a loja de teste nunca soma, os
 * números ENTRE marketplaces têm de ser exatamente os do Mercado Livre — lidos
 * de outra RPC. Se a loja de teste vazar para o total, ou o ML for somado
 * diferente, os números divergem.
 */

/** O valor de uma célula de faixa, pelo id da métrica que ela mostra. */
async function valorDaFaixa(page: Page, metricId: string): Promise<string> {
  const celula = page
    .locator(".sb-kpi")
    .filter({ has: page.locator(".sb-kpi-id", { hasText: new RegExp(`^${metricId}$`) }) });

  return (await celula.locator(".sb-kpi-value").innerText()).trim();
}

test("aba Vendas do SKU: entre marketplaces, com só a loja de teste, o total é o do Mercado Livre", async ({ page }) => {
  const seed = await readSeedOutput();
  const unidades = E2E_SKU_SALES.reduce((acc, v) => acc + v.units, 0);

  await login(page, `/skus/${seed.skuId}?aba=vendas`);

  await expect(page.getByText("Entre marketplaces", { exact: true })).toBeVisible();
  await expect(page.getByText("No Mercado Livre", { exact: true })).toBeVisible();

  // A faixa do ML (ids de sempre) e a de entre marketplaces (ids multicanal_*),
  // lidas de RPCs diferentes, dizem o mesmo.
  expect(await valorDaFaixa(page, "multicanal_receita_bruta")).toBe(await valorDaFaixa(page, "receita_bruta"));
  expect(await valorDaFaixa(page, "multicanal_unidades")).toBe(await valorDaFaixa(page, "unidades_vendidas"));
  expect(await valorDaFaixa(page, "multicanal_unidades")).toBe(String(unidades));

  // A conta do ML aparece na tabela por marketplace, conta e loja.
  const tabela = page.getByRole("table", { name: "Vendas do produto por marketplace, conta e loja" });
  const conta = tabela.getByRole("row").filter({ hasText: seed.mlAccountLabel });

  await expect(conta).toContainText("Mercado Livre");
  await expect(conta.getByRole("cell").nth(2)).toHaveText(String(unidades));
});

test("painel Shopee do SKU: a loja de sandbox leva o selo Teste", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}?aba=anuncios`);

  const linha = page
    .getByRole("region", { name: "Anúncios da Shopee" })
    .getByRole("row", { name: new RegExp(E2E_SHOPEE_ITEMS.skuNoItem.nome) });

  await expect(linha).toContainText(E2E_SHOPEE_SHOP.name);
  await expect(linha).toContainText("Teste");
});

test("/vendas?marketplace=todos: o ranking de produtos dá ao SKU a receita do ranking do ML", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, "/vendas");

  const rankingMl = page.getByRole("region", { name: "Produtos que mais contribuíram" });
  const linhaMl = rankingMl.getByRole("row").filter({ has: page.locator(`a[href="/skus/${seed.skuId}"]`) });

  // Coluna "Faturamento" do ranking do ML (a 4ª: produto, marca, unidades, faturamento).
  const receitaMl = (await linhaMl.getByRole("cell").nth(3).innerText()).trim();

  expect(receitaMl).not.toBe("—");

  await page.goto("/vendas?marketplace=todos");

  const ranking = page.getByRole("table", { name: "Produtos que mais venderam" });
  const linha = ranking.getByRole("row").filter({ has: page.locator(`a[href="/skus/${seed.skuId}"]`) });

  await expect(linha.getByRole("cell").nth(1)).toHaveText(receitaMl);
  // No "Todos" a parte de cada canal vem ao lado: a do ML é a receita inteira,
  // e a Shopee (só a loja de teste) não tem venda somável.
  await expect(linha.getByRole("cell").nth(4)).toContainText(receitaMl);
  await expect(linha.getByRole("cell").nth(5)).toContainText("—");
});
