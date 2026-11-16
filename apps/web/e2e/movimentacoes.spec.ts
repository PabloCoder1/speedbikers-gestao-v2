import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * `/estoque/movimentacoes` — os destinos de cada linha só são consultados no
 * clique (D-701). O seed tem uma entrada de nota fiscal do SKU de teste.
 */
test("/estoque/movimentacoes: o SKU da linha carrega ao clicar e a volta preserva a lista", async ({ page }) => {
  const { skuId } = await readSeedOutput();
  const destino = `/skus/${skuId}`;
  const prefetches: string[] = [];

  page.on("request", (request) => {
    const headers = request.headers();
    const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;
    const { pathname } = new URL(request.url());

    if (prefetch && /^\/(skus|compras|notas-fiscais)\//u.test(pathname)) prefetches.push(pathname);
  });

  await login(page, "/estoque/movimentacoes");

  const titulo = "Produto de teste E2E";
  const produto = page.getByRole("table").getByRole("link", { name: titulo, exact: true }).first();

  await expect(produto).toHaveAttribute("href", destino);
  await produto.scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle");
  expect(prefetches).toEqual([]);

  await produto.click();
  await expect(page).toHaveURL((url) => url.pathname === destino);
  await expect(page.getByRole("heading", { level: 2, name: titulo, exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === "/estoque/movimentacoes");
  await expect(produto).toBeVisible();
});
