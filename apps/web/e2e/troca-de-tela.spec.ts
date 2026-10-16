import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * A TROCA DE TELA SEM ESQUELETO (D-512, D-513): com o `Shell` no layout e sem
 * `loading.tsx` no grupo `(app)`, trocar de tela mantém a tela anterior até a
 * nova chegar — e o que diz "o clique pegou" é o sinal da atualização no lugar
 * (D-500): o `aria-busy` do conteúdo e a barra da moldura.
 *
 * No banco local a tela nova chega antes de qualquer `expect` ver a espera.
 * Por isso cada teste SEGURA a resposta da tela de destino: a navegação suave
 * pede o conteúdo dela com `?_rsc=`, e o `page.route` atrasa só esse pedido.
 * Sem o sinal, a tela ficaria parada pelo atraso inteiro — o defeito que a
 * D-513 achou na paleta de busca, que navega por código e não por `<a>`.
 */

const ESPERA_MS = 1_500;

async function segurarTela(page: Page, caminho: string): Promise<void> {
  await page.route(
    (url) => url.pathname === caminho && url.searchParams.has("_rsc"),
    async (route) => {
      await new Promise((pronto) => setTimeout(pronto, ESPERA_MS));
      await route.continue();
    },
  );
}

/** A Home inteira, com a "Atenção necessária" (que chega num `Suspense`, D-504) e a página hidratada. */
async function abrirHome(page: Page): Promise<string> {
  await login(page, "/");
  await page.waitForURL((url) => url.pathname === "/");
  await page.getByRole("region", { name: "Atenção necessária" }).locator("a[href='/notificacoes']").waitFor();
  await page.waitForLoadState("networkidle");

  return (await page.locator("h1").first().textContent()) ?? "";
}

/** A tela anterior continua, com UM sinal (sem barra dobrada) e o conteúdo marcado como ocupado. */
async function esperandoNaTelaAnterior(page: Page, titulo: string): Promise<void> {
  await expect(page.locator(".sb-content[aria-busy='true']")).toHaveCount(1);
  await expect(page.locator(".sb-atualizando-barra")).toHaveCount(1);
  await expect(page.locator("h1").first()).toHaveText(titulo);
}

/** A tela nova chegou e o sinal saiu. */
async function chegou(page: Page, titulo: RegExp): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: titulo })).toBeVisible();
  await expect(page.locator(".sb-content[aria-busy]")).toHaveCount(0);
  await expect(page.locator(".sb-atualizando-barra")).toHaveCount(0);
}

test("link da sidebar: a tela anterior fica, com o sinal, até a nova chegar", async ({ page }) => {
  const titulo = await abrirHome(page);

  await segurarTela(page, "/estoque");
  await page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Estoque", exact: true }).click();

  await esperandoNaTelaAnterior(page, titulo);
  await chegou(page, /^Visão de estoque$/);
  await expect(page).toHaveURL(/\/estoque$/);
});

test("link no conteúdo: o IndicadorDeNavegacao dá o sinal até a tela nova chegar", async ({ page }) => {
  const titulo = await abrirHome(page);

  await segurarTela(page, "/notificacoes");
  await page.getByRole("region", { name: "Atenção necessária" }).locator("a[href='/notificacoes']").click();

  await esperandoNaTelaAnterior(page, titulo);
  await chegou(page, /^Central de Notificações$/);
  await expect(page).toHaveURL(/\/notificacoes$/);
});

test("paleta de busca: a escolha navega por código e também tem o sinal (D-513)", async ({ page }) => {
  const titulo = await abrirHome(page);

  await page.getByRole("button", { name: /Buscar SKU, anúncio, NF-e/ }).click();

  const caixa = page.getByRole("dialog", { name: "Buscar na Speed Bikers" });
  const campo = caixa.getByRole("combobox", { name: "Buscar" });

  await campo.fill("movimentacoes");
  await expect(caixa.getByRole("option", { name: /Movimentações/ })).toHaveAttribute("aria-selected", "true");

  await segurarTela(page, "/estoque/movimentacoes");
  await campo.press("Enter");

  await expect(caixa).toHaveCount(0);
  await esperandoNaTelaAnterior(page, titulo);
  await chegou(page, /^Movimentações$/);
  await expect(page).toHaveURL(/\/estoque\/movimentacoes$/);
});
