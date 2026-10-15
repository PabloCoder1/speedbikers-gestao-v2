import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * A ATUALIZAÇÃO NO LUGAR (D-500, D-501): filtro, busca, ordenação e menu que
 * ficam na mesma tela são navegação SUAVE — a URL muda, o documento não
 * recarrega e o `aria-busy` do conteúdo tem início e FIM.
 *
 * `check:navegacao-suave` reprova o `<form method="get">` e o `<a href>`
 * interno no código; este arquivo prova o comportamento no navegador, que é o
 * que a guarda não vê: um `FormularioFiltro` que deixasse de interceptar o
 * envio, ou um pendente que nunca terminasse, passariam nela.
 *
 * "Não recarregou" é medido por uma marca posta no `window` antes do clique:
 * uma recarga cria outro `window`, e a marca some.
 */

async function marcar(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __semRecarga?: boolean }).__semRecarga = true;
  });
}

async function naoRecarregou(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __semRecarga?: boolean }).__semRecarga === true)).toBe(
    true,
  );
}

/** O pendente terminou: nenhum `aria-busy` sobrou e a barra saiu. */
async function terminou(page: Page): Promise<void> {
  await expect(page.locator(".sb-content[aria-busy]")).toHaveCount(0);
  await expect(page.locator(".sb-atualizando-barra")).toHaveCount(0);
}

test("busca por Enter: troca a URL sem recarregar e devolve o foco ao campo", async ({ page }) => {
  await login(page, "/estoque");

  const campo = page.getByRole("searchbox", { name: "Buscar por SKU ou nome do produto" });

  await campo.waitFor();
  await marcar(page);
  await campo.fill("E2E");
  await campo.press("Enter");

  await expect(page).toHaveURL(/\/estoque\?busca=E2E$/);
  await expect(page.getByRole("link", { name: "Limpar filtros" })).toBeVisible();
  await terminou(page);
  await naoRecarregou(page);
  await expect(campo).toBeFocused();

  // "Limpar filtros" esvazia a URL E o campo: o formulário renasce com o que o
  // servidor mandou, como na recarga.
  await page.getByRole("link", { name: "Limpar filtros" }).click();
  await expect(page).toHaveURL(/\/estoque$/);
  await terminou(page);
  await expect(campo).toHaveValue("");
  await naoRecarregou(page);
});

test("ordenação da tabela de anúncios: era <a>, agora não recarrega", async ({ page }) => {
  await login(page, "/anuncios");

  // Pelo cabeçalho da coluna: "Preços" também é item do menu lateral.
  const preco = page.getByRole("columnheader", { name: /^Preço/ }).getByRole("link");

  await preco.waitFor();
  await marcar(page);
  await preco.click();

  await expect(page).toHaveURL(/[?&]ordem=price/);
  await terminou(page);
  await naoRecarregou(page);
});

test("opção do menu de filtro: navega sem recarregar e o menu fecha", async ({ page }) => {
  await login(page, "/estoque");

  const resumo = page.locator(".sb-stock-workspace summary.sb-button").first();

  await resumo.waitFor();
  await marcar(page);
  await resumo.click();
  await page.locator(".sb-stock-workspace .sb-menu-panel").getByRole("link").first().click();

  await expect(page.locator(".sb-stock-workspace details.sb-menu").first()).not.toHaveAttribute("open", "");
  await terminou(page);
  await naoRecarregou(page);
});
