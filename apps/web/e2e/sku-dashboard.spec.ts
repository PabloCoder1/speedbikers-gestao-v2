import { expect, test } from "@playwright/test";

import { login, statValue } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * "Página do produto" (docs/TESTING.md) — Dashboard de SKU. O saldo LOCAL
 * exibido vem de `inventory_balances`, projeção mantida por trigger sobre
 * `stock_movements` (nunca somado em JS — docs/ARCHITECTURE.md secao 21):
 * o seed grava um `ENTRADA_NFE` de 50 unidades, e este teste prova que ele
 * chega inteiro até a tela, não só até o banco.
 */
test("dashboard de SKU mostra saldo local do seed", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  await expect(page).toHaveURL(new RegExp(`/skus/${seed.skuId}$`));
  await expect(page.getByRole("heading", { level: 1, name: seed.skuCode })).toBeVisible();

  await expect(statValue(page, "Local")).toContainText("50");

  // Abas (D-169): "Anúncios" virou aba própria — navegar por ela cobre a
  // navegação junto. O locator escopa pelo nav das abas porque o menu
  // lateral também tem um link "Anúncios".
  await page.getByRole("navigation", { name: "Abas do SKU" }).getByRole("link", { name: "Anúncios" }).click();
  await expect(page.getByText("Nenhum anúncio vinculado a este SKU.")).toBeVisible();
});

/**
 * Aba Full (D-224/D-225) — a fiação, e o estado vazio HONESTO.
 *
 * O seed não cria snapshot de Full de propósito: é o estado mais comum de um
 * SKU qualquer, e é onde a tela pode mentir. A regra de D-067 é que ausência
 * de dado nunca vira zero — aqui isso significa dizer "não há snapshot", e
 * não estampar "0 no Full", que é uma afirmação diferente e falsa.
 */
test("aba Full existe e distingue ausência de snapshot de saldo zero", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  await page.getByRole("navigation", { name: "Abas do SKU" }).getByRole("link", { name: "Full" }).click();

  await expect(page).toHaveURL(/aba=full/);
  await expect(page.getByRole("heading", { name: "Full por conta" })).toBeVisible();
  await expect(page.getByText("Ausência de snapshot não é o mesmo que saldo zero")).toBeVisible();
});
