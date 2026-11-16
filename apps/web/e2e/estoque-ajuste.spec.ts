import { expect, test } from "@playwright/test";

import { E2E_LOCAL_STOCK, E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

test("/estoque: abre o detalhe e o ajuste do SKU sob demanda", async ({ page }) => {
  const seed = await readSeedOutput();
  const detalhe = `/skus/${seed.skuId}`;
  const ajuste = `/estoque/${seed.skuId}/ajuste`;
  const estoque = `/estoque?busca=${E2E_SKU_CODE}`;
  const prefetches: string[] = [];

  page.on("request", (request) => {
    const headers = request.headers();
    const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;
    const { pathname } = new URL(request.url());

    if (prefetch && (pathname === detalhe || pathname === ajuste)) prefetches.push(pathname);
  });

  await login(page, estoque);

  const linha = page.getByRole("row").filter({ hasText: E2E_SKU_CODE });
  const produto = linha.getByRole("link", { name: "Produto de teste E2E", exact: true });
  await produto.scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle");
  expect(prefetches).toEqual([]);
  await expect(produto).toHaveAttribute("href", detalhe);
  await expect(linha.getByRole("link", { name: "Ver SKU" })).toHaveAttribute("href", detalhe);

  await linha.getByRole("link", { name: "Ver SKU" }).click();
  await expect(page).toHaveURL((url) => url.pathname === detalhe);
  await expect(page.getByRole("heading", { level: 2, name: "Produto de teste E2E" })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL((url) => `${url.pathname}${url.search}` === estoque);
  await linha.getByRole("link", { name: "Ajustar" }).click();
  await expect(page).toHaveURL((url) => url.pathname === ajuste);
  await expect(page.getByRole("heading", { level: 1, name: "Ajuste de estoque" })).toBeVisible();
});

test("/estoque/[skuId]/ajuste: deixa operação, saldo final e autoria claros antes de gravar", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/estoque/${seed.skuId}/ajuste`);

  await expect(page.getByRole("heading", { level: 1, name: "Ajuste de estoque" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Produto de teste E2E" })).toBeVisible();
  await expect(page.locator(".sb-adjust-location", { hasText: "Local" })).toContainText(String(E2E_LOCAL_STOCK));

  await page.getByText("Saída", { exact: true }).click();
  await page.getByLabel("Quantidade que sai").fill("5");
  await page.getByText("Avaria", { exact: true }).click();

  const preview = page.locator(".sb-adjust-preview");
  await expect(preview).toContainText(`Saldo atual · Local${String(E2E_LOCAL_STOCK)}`);
  await expect(preview).toContainText("−5");
  await expect(preview).toContainText(`Saldo após o ajuste${String(E2E_LOCAL_STOCK - 5)}`);
  await expect(page.getByRole("button", { name: "Registrar saída de 5 un." })).toBeEnabled();
  const autoria = page.locator(".sb-adjust-author");
  await expect(autoria).toContainText("Registrado por");
  await expect(autoria).toContainText("E2E");
});

test("/estoque/[skuId]/ajuste: não cria rolagem horizontal no viewport móvel", async ({ page }) => {
  const seed = await readSeedOutput();
  await page.setViewportSize({ width: 390, height: 844 });

  await login(page, `/estoque/${seed.skuId}/ajuste`);

  await expect(page.getByText("Entrada", { exact: true })).toBeVisible();
  await expect(page.getByText("Saída", { exact: true })).toBeVisible();
  await expect(page.getByText("Balanço", { exact: true })).toBeVisible();

  const sizes = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }));

  expect(sizes.content).toBe(sizes.viewport);
});
