import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * "Pedido de compra" (docs/TESTING.md) — cria um rascunho do zero pela UI.
 * Não precisa de seed: o item aceita SKU em texto livre sem cadastro prévio
 * (`apps/web/app/compras/novo/item-row.tsx`), então o próprio teste já cobre
 * o caminho mais comum na prática (fornecedor manda um código que ainda não
 * está catalogado).
 *
 * A asserção de "Itens: 1" e do valor estimado na tela de detalhe é
 * deliberada: D-067 (Nível 1) corrigiu um bug real em que falha silenciosa
 * de leitura fazia esse resumo mostrar "0 itens, R$ 0,00" num pedido que
 * tinha itens de verdade — este teste é a guarda de regressão daquele bug.
 */
test("cria um pedido de compra com item em texto livre e mostra o resumo certo", async ({ page }) => {
  await login(page, "/compras/novo");

  await expect(page).toHaveURL(/\/compras\/novo$/);

  const row = page.locator("tbody tr").first();

  await row.getByPlaceholder("SKU ou nome…").fill("PEDIDO-E2E-001");
  await row.locator('input[type="number"]').first().fill("5");
  await row.locator('input[type="number"]').nth(1).fill("10.5");

  await page.getByRole("button", { name: "Criar pedido (rascunho)" }).click();

  await expect(page).toHaveURL(/\/compras\/[0-9a-f-]{36}$/);

  const itensValue = page.getByText("Itens", { exact: true }).locator("xpath=following-sibling::*[1]");

  await expect(itensValue).toContainText("1");

  const valorValue = page.getByText("Valor estimado", { exact: true }).locator("xpath=following-sibling::*[1]");

  await expect(valorValue).toContainText("52,50");
});
