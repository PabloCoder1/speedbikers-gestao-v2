import { expect, test } from "@playwright/test";

import { E2E_LOCAL_STOCK, E2E_SKU_CODE } from "./constants.js";
import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
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

test("ajuste: falha de conexão conserva os campos e permite registrar uma única saída", async ({ page }) => {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const referencia = `e2e-ajuste-${crypto.randomUUID()}`;
  const observacao = "Caixa avariada na conferência E2E";
  const motivo = `Saída · Avaria · Ref. ${referencia} · ${observacao}`;
  const saldo = () => db.from("inventory_balances").select("quantity")
    .eq("organization_id", seed.organizationId).eq("sku_id", seed.skuId).eq("location_kind", "LOCAL").single();
  const movimento = () => db.from("stock_movements").select("id,qty_delta,movement_type,location_kind,created_by,reason")
    .eq("organization_id", seed.organizationId).eq("sku_id", seed.skuId).eq("reason", motivo).maybeSingle();
  const antes = await saldo();
  if (antes.error !== null) throw new Error(antes.error.message);

  try {
    await login(page, `/estoque/${seed.skuId}/ajuste`);
    await page.getByText("Saída", { exact: true }).click();
    await page.getByLabel("Quantidade que sai").fill("5");
    await page.getByText("Avaria", { exact: true }).click();
    await page.getByLabel(/Documento ou referência/u).fill(referencia);
    await page.getByLabel(/Observação/u).fill(observacao);
    const registrar = page.getByRole("button", { name: "Registrar saída de 5 un.", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await registrar.click();

    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível confirmar o ajuste" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Ajuste de estoque" })).toBeVisible();
    await expect(registrar).toBeEnabled();
    await expect(page.getByRole("radio", { name: /Saída/u })).toBeChecked();
    await expect(page.getByRole("radio", { name: /^Local/u })).toBeChecked();
    await expect(page.getByRole("radio", { name: "Avaria", exact: true })).toBeChecked();
    await expect(page.getByLabel("Quantidade que sai")).toHaveValue("5");
    await expect(page.getByLabel(/Documento ou referência/u)).toHaveValue(referencia);
    await expect(page.getByLabel(/Observação/u)).toHaveValue(observacao);
    expect(caiu()).toBe(true);
    const falha = await movimento();
    expect(falha.error).toBeNull();
    expect(falha.data).toBeNull();
    const saldoNaFalha = await saldo();
    expect(saldoNaFalha.error).toBeNull();
    expect(saldoNaFalha.data).toEqual(antes.data);

    await registrar.click();
    await expect(page.getByRole("status").filter({ hasText: "Ajuste registrado: −5 un. em Local." })).toBeVisible();
    const gravado = await movimento();
    expect(gravado.error).toBeNull();
    expect(gravado.data).toMatchObject({ qty_delta: -5, movement_type: "AJUSTE_MANUAL", location_kind: "LOCAL", created_by: seed.userId, reason: motivo });
    const depois = await saldo();
    expect(depois.error).toBeNull();
    expect(depois.data?.quantity).toBe(antes.data.quantity - 5);
    await expect(page.getByLabel("Quantidade que sai")).toHaveValue("");
    await expect(page.getByLabel(/Documento ou referência/u)).toHaveValue("");
    await expect(page.getByLabel(/Observação/u)).toHaveValue("");
  } finally {
    const gravado = await movimento();
    expect.soft(gravado.error).toBeNull();
    if (gravado.data !== null) {
      // O ledger é histórico: desfazer a fixture cria a contrapartida, sem apagar o ajuste.
      const volta = await db.from("stock_movements").insert({
        organization_id: seed.organizationId,
        sku_id: seed.skuId,
        location_kind: "LOCAL",
        qty_delta: -gravado.data.qty_delta,
        movement_type: "AJUSTE_MANUAL",
        created_by: seed.userId,
        reason: `Compensação da fixture ${referencia}`,
        idempotency_key: `e2e:compensar:${gravado.data.id}`,
        occurred_at: new Date().toISOString(),
      });
      expect.soft(volta.error).toBeNull();
    }
    const restaurado = await saldo();
    expect.soft(restaurado.error).toBeNull();
    expect.soft(restaurado.data).toEqual(antes.data);
  }
});
