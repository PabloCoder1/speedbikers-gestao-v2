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

  await expect(page.getByText("Nenhum anúncio vinculado a este SKU.")).toBeVisible();
});
