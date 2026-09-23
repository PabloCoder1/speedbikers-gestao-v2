import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * A ROLAGEM DA SIDEBAR não pode voltar ao topo quando a tela muda.
 *
 * O `Shell` mora dentro de cada página (e o esqueleto de `carregando.tsx`
 * redesenha a mesma moldura), então toda navegação desmonta o `<nav>` e monta
 * outro. Quem clicava num item do fim do menu chegava na tela certa com o menu
 * no começo — e, se a tela era a errada, tinha que descer tudo de novo para
 * corrigir. `components/nav.tsx` guarda a posição fora do componente.
 *
 * Os dois casos separam as duas causas: o fim da lista pega a poda do navegador
 * quando o menu do esqueleto encurta (ele não conhece o papel, e os itens de
 * ADMIN ficam de fora por um instante), e o meio pega a montagem crua.
 */
const MENU = "nav.sb-nav";

test.describe("rolagem do menu lateral", () => {
  test("clicar num item do FIM do menu não sobe a lista", async ({ page }) => {
    await login(page, "/vendas");

    const menu = page.locator(MENU);
    await menu.waitFor();

    await menu.evaluate((elemento) => {
      elemento.scrollTop = elemento.scrollHeight;
    });
    const antes = await menu.evaluate((elemento) => elemento.scrollTop);

    // Sem rolagem não há o que testar: se o menu couber inteiro na tela do
    // teste, a afirmação seguinte passaria por acidente.
    expect(antes).toBeGreaterThan(0);

    await menu.locator('a[href="/configuracoes"]').click();
    await page.waitForURL("**/configuracoes");
    await page.locator(MENU).waitFor();

    await expect
      .poll(async () => page.locator(MENU).evaluate((elemento) => elemento.scrollTop))
      .toBe(antes);
  });

  test("posição no MEIO do menu se mantém, e o recarregamento volta ao topo", async ({ page }) => {
    await login(page, "/vendas");

    const menu = page.locator(MENU);
    await menu.waitFor();

    await menu.evaluate((elemento) => {
      elemento.scrollTop = 300;
    });

    await menu.locator('a[href="/fornecedores"]').click();
    await page.waitForURL("**/fornecedores");

    await expect
      .poll(async () => page.locator(MENU).evaluate((elemento) => elemento.scrollTop))
      .toBe(300);

    // Carregar a página do zero começa do topo — é o que o navegador faz com
    // qualquer barra de rolagem, e guardar isso seria memória, não continuidade.
    await page.reload();
    // Enquanto o carregamento flui, o esqueleto e a página convivem por um
    // instante e há mais de um `<nav>` no documento: a medição espera sobrar um.
    await expect.poll(async () => page.locator(MENU).count()).toBe(1);

    await expect
      .poll(async () => page.locator(MENU).evaluate((elemento) => elemento.scrollTop))
      .toBe(0);
  });
});
