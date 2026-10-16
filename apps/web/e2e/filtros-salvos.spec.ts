import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers.js";

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
