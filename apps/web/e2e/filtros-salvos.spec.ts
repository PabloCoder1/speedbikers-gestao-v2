import { expect, test, type Page } from "@playwright/test";

import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * D-494: as visões salvas nas duas telas da Shopee -- e o primeiro e2e dos
 * filtros salvos, que usam o MESMO componente de `/vendas`, `/anuncios` e
 * `/curva-abc` (`components/saved-filters.tsx`).
 *
 * Salvar guarda a URL inteira; a visão aparece só na tela em que foi salva (a
 * tabela é por usuário e por tela, `screen`); abri-la volta ao recorte; apagar
 * some com ela. Cada caso apaga o que cria: os filtros salvos ficam no banco, e
 * o nome fixo faz uma rodada interrompida ser sobrescrita na seguinte (a RPC
 * faz upsert por usuário, tela e nome).
 */

async function entrar(page: Page, rota: string): Promise<void> {
  await login(page, rota);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

/** O menu "Visões salvas" -- só existe quando a tela tem alguma. */
function menuDasVisoes(page: Page) {
  return page.locator("summary", { hasText: "Visões salvas" });
}

async function salvarVisao(page: Page, nome: string, parametro: string): Promise<void> {
  await page.getByRole("button", { name: "Salvar visão", exact: true }).click();

  const janela = page.getByRole("dialog", { name: "Salvar visão" });

  // A janela diz O QUE será salvo antes de pedir o nome.
  await expect(janela).toContainText(parametro);
  await janela.getByRole("textbox", { name: "Nome da visão" }).fill(nome);
  await janela.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(janela).toHaveCount(0);
  await expect(menuDasVisoes(page)).toBeVisible();
}

async function abrirVisao(page: Page, nome: string): Promise<void> {
  await menuDasVisoes(page).click();
  await page.getByRole("link", { name: nome, exact: true }).click();
}

async function apagarVisao(page: Page, nome: string): Promise<void> {
  await menuDasVisoes(page).click();
  await page.getByRole("button", { name: `Apagar filtro ${nome}`, exact: true }).click();
  await expect(page.getByText(nome, { exact: true })).toHaveCount(0);
}

test("filtros salvos: falha de conexão ao salvar conserva o nome e permite nova tentativa", async ({ page }) => {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const nome = "E2E visão com falha de conexão";
  const screen = "/anuncios/shopee";
  const lista = () => db.from("saved_filters").select("name,params").eq("created_by", seed.userId).eq("screen", screen).eq("name", nome);

  try {
    await entrar(page, screen + "?estado=vinculado");
    await page.getByRole("button", { name: "Salvar visão", exact: true }).click();
    const janela = page.getByRole("dialog", { name: "Salvar visão" });
    await janela.getByRole("textbox", { name: "Nome da visão" }).fill(nome);
    const salvar = janela.getByRole("button", { name: "Salvar", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await salvar.click();
    await expect(janela.getByRole("alert")).toContainText("Não foi possível confirmar");
    await expect(salvar).toBeEnabled();
    await expect(janela.getByRole("button", { name: "Cancelar", exact: true })).toBeEnabled();
    await expect(janela.getByRole("textbox", { name: "Nome da visão" })).toHaveValue(nome);
    expect(caiu()).toBe(true);
    const antes = await lista();
    expect(antes.error).toBeNull();
    expect(antes.data).toEqual([]);

    await salvar.click();
    await expect(janela).toHaveCount(0);
    const depois = await lista();
    expect(depois.error).toBeNull();
    expect(depois.data).toEqual([{ name: nome, params: { estado: "vinculado" } }]);
  } finally {
    const limpeza = await db.from("saved_filters").delete().eq("created_by", seed.userId).eq("screen", screen).eq("name", nome);
    expect.soft(limpeza.error).toBeNull();
  }
});

test("filtros salvos: falha de conexão ao apagar mantém a visão e permite nova tentativa", async ({ page }) => {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const nome = "E2E apagar visão após falha de conexão";
  const screen = "/anuncios/shopee";
  const lista = () => db.from("saved_filters").select("id,name,params").eq("created_by", seed.userId).eq("screen", screen).eq("name", nome);

  try {
    const inserida = await db.from("saved_filters").insert({
      organization_id: seed.organizationId, created_by: seed.userId, screen, name: nome, params: { estado: "vinculado" },
    });
    if (inserida.error !== null) throw new Error(inserida.error.message);
    const antes = await lista();
    expect(antes.error).toBeNull();
    await entrar(page, screen);
    await menuDasVisoes(page).click();
    const apagar = page.getByRole("button", { name: `Apagar filtro ${nome}`, exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await apagar.click();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível confirmar" })).toBeVisible();
    await expect(apagar).toBeEnabled();
    expect(caiu()).toBe(true);
    const depoisDaFalha = await lista();
    expect(depoisDaFalha.error).toBeNull();
    expect(depoisDaFalha.data).toEqual(antes.data);

    await apagar.click();
    await expect(page.getByRole("link", { name: nome, exact: true })).toHaveCount(0);
    const depois = await lista();
    expect(depois.error).toBeNull();
    expect(depois.data).toEqual([]);
  } finally {
    const limpeza = await db.from("saved_filters").delete().eq("created_by", seed.userId).eq("screen", screen).eq("name", nome);
    expect.soft(limpeza.error).toBeNull();
  }
});

test("filtros salvos: recusa do nome aparece dentro do diálogo e permite corrigir", async ({ page }) => {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const nome = "E2E visão após recusa de nome";
  const screen = "/anuncios/shopee";

  try {
    await entrar(page, screen + "?estado=vinculado");
    await page.getByRole("button", { name: "Salvar visão", exact: true }).click();
    const janela = page.getByRole("dialog", { name: "Salvar visão" });
    const campo = janela.getByRole("textbox", { name: "Nome da visão" });
    await campo.fill("x".repeat(81));
    const salvar = janela.getByRole("button", { name: "Salvar", exact: true });
    await salvar.click();
    await expect(janela.getByRole("alert")).toHaveText("Não foi possível salvar o filtro.");
    await expect(salvar).toBeEnabled();
    await expect(campo).toHaveValue("x".repeat(81));
    await campo.fill(nome);
    await salvar.click();
    await expect(janela).toHaveCount(0);
    const depois = await db.from("saved_filters").select("params").eq("created_by", seed.userId).eq("screen", screen).eq("name", nome);
    expect(depois.error).toBeNull();
    expect(depois.data).toEqual([{ params: { estado: "vinculado" } }]);
  } finally {
    const limpeza = await db.from("saved_filters").delete().eq("created_by", seed.userId).eq("screen", screen).eq("name", nome);
    expect.soft(limpeza.error).toBeNull();
  }
});

test("/anuncios/shopee: a visão salva guarda o recorte, fica só nesta tela e sai quando apagada (D-494)", async ({ page }) => {
  const nome = "E2E vinculados da Shopee (D-494)";

  await entrar(page, "/anuncios/shopee?estado=vinculado");
  await salvarVisao(page, nome, "estado=vinculado");

  // Aberta da tela sem recorte, a visão volta ao recorte salvo.
  await page.goto("/anuncios/shopee");
  await abrirVisao(page, nome);
  await expect(page).toHaveURL(/\/anuncios\/shopee\?estado=vinculado$/u);

  // A tela do Mercado Livre não a lista: `screen` é por tela.
  await page.goto("/anuncios");
  await expect(page.getByText(nome, { exact: true })).toHaveCount(0);

  await page.goto("/anuncios/shopee");
  await apagarVisao(page, nome);
});

test("/vendas/shopee: a visão salva guarda o período, fica só nesta tela e sai quando apagada (D-494)", async ({ page }) => {
  const nome = "E2E Shopee em 7 dias (D-494)";

  await entrar(page, "/vendas/shopee?days=7");
  await salvarVisao(page, nome, "days=7");

  await page.goto("/vendas/shopee");
  await abrirVisao(page, nome);
  await expect(page).toHaveURL(/\/vendas\/shopee\?days=7$/u);

  // O consolidado de `/vendas` tem as visões dele, e esta não está lá.
  await page.goto("/vendas?marketplace=shopee");
  await expect(page.getByText(nome, { exact: true })).toHaveCount(0);

  await page.goto("/vendas/shopee");
  await apagarVisao(page, nome);
});
