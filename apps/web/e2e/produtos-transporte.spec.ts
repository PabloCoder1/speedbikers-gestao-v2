import { expect, test, type Page } from "@playwright/test";

import { E2E_ANOMALIA } from "./constants.js";
import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

const COLUNAS = "stock_is_virtual,stock_is_virtual_set_at,stock_is_virtual_set_by,supplier_brand,supplier_brand_source,supplier_brand_set_at,supplier_brand_set_by";

async function curadoriaLocal() {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const ler = () => db.from("skus").select(COLUNAS).eq("organization_id", seed.organizationId).eq("id", seed.skuId).single();
  const original = await ler();
  if (original.error !== null) throw new Error(original.error.message);
  const restaurar = async () => {
    const volta = await db.from("skus").update(original.data).eq("id", seed.skuId);
    expect.soft(volta.error).toBeNull();
  };
  return { db, seed, ler, original: original.data, restaurar };
}

async function escolherVirtual(page: Page): Promise<void> {
  const menu = page.locator("details.sb-menu", { hasText: "Classificar estoque" });
  await menu.locator("summary").click();
  await menu.getByRole("button", { name: "É virtual", exact: true }).click();
}

const aviso = (page: Page) => page.getByRole("alert").filter({ hasText: "Não foi possível confirmar a ação" });

test("curadoria: falha ao classificar conserva seleção e confirmação para nova tentativa", async ({ page }) => {
  const f = await curadoriaLocal();
  try {
    await login(page, "/produtos?estado=todos");
    const selecionar = page.getByRole("checkbox", { name: `Selecionar ${f.seed.skuCode}`, exact: true });
    await selecionar.check();
    await page.getByRole("combobox", { name: "Marca do fornecedor", exact: true }).fill("marca pendente");
    await escolherVirtual(page);
    const painel = page.getByRole("dialog", { name: "Confirmar", exact: true });
    const confirmar = painel.getByRole("button", { name: "Confirmar", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await confirmar.click();
    await expect(aviso(page)).toBeVisible();
    await expect(confirmar).toBeEnabled();
    await expect(painel.getByRole("button", { name: "Cancelar" })).toBeEnabled();
    await expect(selecionar).toBeChecked();
    await expect(page.getByRole("combobox", { name: "Marca do fornecedor", exact: true })).toHaveValue("marca pendente");
    expect(caiu()).toBe(true);
    const falha = await f.ler();
    expect(falha.error).toBeNull();
    expect(falha.data).toEqual(f.original);
    await confirmar.click();
    await expect(page.getByRole("status").filter({ hasText: "1 aplicado(s)" })).toBeVisible();
    const depois = await f.ler();
    expect(depois.error).toBeNull();
    expect(depois.data).toMatchObject({ stock_is_virtual: true, stock_is_virtual_set_by: f.seed.userId });
    expect(depois.data?.stock_is_virtual_set_at).not.toBeNull();
    await expect(selecionar).not.toBeChecked();
  } finally {
    await f.restaurar();
  }
});

for (const limpar of [false, true]) {
  test(`curadoria: falha ao ${limpar ? "limpar" : "aplicar"} marca conserva a seleção e permite nova tentativa`, async ({ page }) => {
    const f = await curadoriaLocal();
    try {
      if (limpar) {
        const prepara = await f.db.from("skus").update({ supplier_brand: "E2E MARCA ORIGINAL", supplier_brand_source: "MANUAL", supplier_brand_set_at: new Date().toISOString(), supplier_brand_set_by: f.seed.userId }).eq("id", f.seed.skuId);
        expect(prepara.error).toBeNull();
      }
      const antes = await f.ler();
      expect(antes.error).toBeNull();
      await login(page, "/produtos?estado=todos");
      const selecionar = page.getByRole("checkbox", { name: `Selecionar ${f.seed.skuCode}`, exact: true });
      await selecionar.check();
      const marca = page.getByRole("combobox", { name: "Marca do fornecedor", exact: true });
      await marca.fill("  marca   de teste  ");
      const acao = limpar ? page.getByRole("button", { name: "Limpar marca", exact: true }) : page.getByRole("dialog", { name: "Confirmar", exact: true }).getByRole("button", { name: "Confirmar", exact: true });
      if (!limpar) await page.getByRole("button", { name: "Aplicar marca", exact: true }).click();
      if (limpar) page.once("dialog", (dialogo) => dialogo.accept());
      const caiu = await derrubarPrimeiraAcao(page);
      await acao.click();
      await expect(aviso(page)).toBeVisible();
      await expect(acao).toBeEnabled();
      await expect(selecionar).toBeChecked();
      await expect(marca).toHaveValue("  marca   de teste  ");
      expect(caiu()).toBe(true);
      const falha = await f.ler();
      expect(falha.error).toBeNull();
      expect(falha.data).toEqual(antes.data);
      if (limpar) page.once("dialog", (dialogo) => dialogo.accept());
      await acao.click();
      await expect(page.getByRole("status").filter({ hasText: "1 aplicado(s)" })).toBeVisible();
      const depois = await f.ler();
      expect(depois.error).toBeNull();
      expect(depois.data).toMatchObject({ supplier_brand: limpar ? null : "MARCA DE TESTE", supplier_brand_source: limpar ? null : "MANUAL", supplier_brand_set_by: limpar ? null : f.seed.userId });
      if (limpar) expect(depois.data?.supplier_brand_set_at).toBeNull();
      else expect(depois.data?.supplier_brand_set_at).not.toBeNull();
      await expect(selecionar).not.toBeChecked();
    } finally {
      await f.restaurar();
    }
  });
}

test("curadoria: falha ao desfazer mantém somente os SKUs alterados para a nova tentativa", async ({ page }) => {
  const f = await curadoriaLocal();
  const outro = await f.db.from("skus").select(`id,${COLUNAS}`).eq("organization_id", f.seed.organizationId).eq("sku", E2E_ANOMALIA.sku).single();
  if (outro.error !== null) throw new Error(outro.error.message);
  const { id: outroId, ...outroOriginal } = outro.data;
  try {
    await login(page, "/produtos?estado=todos");
    await page.getByRole("checkbox", { name: `Selecionar ${f.seed.skuCode}`, exact: true }).check();
    await page.getByRole("checkbox", { name: `Selecionar ${E2E_ANOMALIA.sku}`, exact: true }).check();
    await escolherVirtual(page);
    await page.getByRole("dialog", { name: "Confirmar", exact: true }).getByRole("button", { name: "Confirmar", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "1 aplicado(s) · 1 já estava(m) assim" })).toBeVisible();
    const antes = await f.ler();
    expect(antes.error).toBeNull();
    const desfazer = page.getByRole("button", { name: "Desfazer", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await desfazer.click();
    await expect(aviso(page)).toBeVisible();
    await expect(desfazer).toBeEnabled();
    expect(caiu()).toBe(true);
    const falha = await f.ler();
    expect(falha.error).toBeNull();
    expect(falha.data).toEqual(antes.data);
    await desfazer.click();
    await expect(page.getByRole("status").filter({ hasText: "1 aplicado(s)" })).toBeVisible();
    const depois = await f.ler();
    expect(depois.error).toBeNull();
    expect(depois.data).toMatchObject({ stock_is_virtual: false, stock_is_virtual_set_at: null, stock_is_virtual_set_by: null });
    const preservado = await f.db.from("skus").select(COLUNAS).eq("id", outroId).single();
    expect(preservado.error).toBeNull();
    expect(preservado.data).toEqual(outroOriginal);
  } finally {
    await f.restaurar();
    const volta = await f.db.from("skus").update(outroOriginal).eq("id", outroId);
    expect.soft(volta.error).toBeNull();
  }
});

test("curadoria: aguarda a ação com confirmação, seleção e marca bloqueadas", async ({ page }) => {
  const f = await curadoriaLocal();
  let liberar: () => void = () => undefined;
  const pausa = new Promise<void>((resolve) => { liberar = resolve; });
  let interceptada = false;
  try {
    await login(page, "/produtos?estado=todos");
    const selecionar = page.getByRole("checkbox", { name: `Selecionar ${f.seed.skuCode}`, exact: true });
    await selecionar.check();
    await escolherVirtual(page);
    await page.route("**/*", async (rota) => {
      if (!interceptada && rota.request().method() === "POST" && rota.request().headers()["next-action"] !== undefined) {
        interceptada = true;
        await pausa;
        await rota.abort("failed");
      } else await rota.continue();
    });
    const pedido = page.waitForRequest((r) => r.method() === "POST" && r.headers()["next-action"] !== undefined);
    await page.getByRole("dialog", { name: "Confirmar", exact: true }).getByRole("button", { name: "Confirmar", exact: true }).click();
    await pedido;
    await expect(page.getByRole("button", { name: "Aplicando…", exact: true })).toBeDisabled();
    await expect(selecionar).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "Selecionar esta página", exact: true })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Marca do fornecedor", exact: true })).toBeDisabled();
    await expect(page.getByRole("dialog", { name: "Confirmar", exact: true }).getByRole("button", { name: "Cancelar" })).toBeDisabled();
    liberar();
    await expect(aviso(page)).toBeVisible();
    await expect(selecionar).toBeEnabled();
    const depois = await f.ler();
    expect(depois.error).toBeNull();
    expect(depois.data).toEqual(f.original);
  } finally {
    liberar();
    await f.restaurar();
  }
});
