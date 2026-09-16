import { expect, test } from "@playwright/test";

import { E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";

/**
 * A BUSCA DO SHELL (A15, D-323) — e é o primeiro caso que olha para ela.
 *
 * O texto do gatilho dizia cinco entidades desde que D-216 levou
 * `search_entities` a sete, e o campo do placeholder prometia "pedido" sem dizer
 * que é de compra. Nada disso tinha asserção, e por isso envelheceu em silêncio.
 *
 * O caso afirma as três metades da fatia:
 *
 * 1. o gatilho **não é cortado** nas larguras de tela larga (medido antes: o
 *    texto antigo era cortado a partir de 1100px) e não promete "ação";
 * 2. a caixa aberta diz **a frase inteira** do que se busca — o texto EXATO, que
 *    é o que reprova quando a oitava entidade chegar sem ninguém ler a frase;
 * 3. a busca continua **achando**: o código do SKU do seed leva à linha dele.
 */
test("busca do shell: o gatilho cabe sem cortar a promessa, e a caixa diz tudo o que se busca", async ({ page }) => {
  await login(page, "/");

  /*
    O GATILHO É PEGO PELO PAPEL, NÃO PELA CLASSE. `components/carregando.tsx`
    desenha o esqueleto do shell com as MESMAS classes — um
    `<div class="sb-search" aria-hidden="true">` sem `onClick` —, e `login()`
    devolve logo depois de clicar em "Entrar", sem esperar a navegação. Enquanto
    o esqueleto está na tela, `.sb-search` casa com ele: o clique cai num `div`
    morto, a caixa nunca abre, e como os dois nunca coexistem não há violação de
    strict mode que denuncie a troca. O sintoma era esta falha só quando o caso
    NÃO era o primeiro do worker (medido em D-356: passa sozinho, reprova depois
    de qualquer outro spec).

    `getByRole` não enxerga o `aria-hidden`, então ele só casa com o `<button>`
    de verdade — e a espera automática do Playwright passa a ser a espera pelo
    shell carregado.
  */
  const gatilho = page.getByRole("button", { name: /Buscar SKU, anúncio, NF-e/ });
  const rotulo = gatilho.locator(".sb-search-label");

  await expect(gatilho).toBeVisible();
  await expect(rotulo).not.toContainText("ação");

  for (const largura of [1440, 1100, 900]) {
    await page.setViewportSize({ width: largura, height: 900 });

    const cortado = await rotulo.evaluate((elemento) => elemento.scrollWidth > elemento.clientWidth);

    expect(cortado, `rótulo da busca a ${String(largura)}px`).toBe(false);
  }

  await page.setViewportSize({ width: 1440, height: 900 });

  const perfilAntes = await page.locator(".sb-profile").boundingBox();

  await gatilho.click();

  const caixa = page.getByRole("dialog", { name: "Buscar na Speed Bikers" });

  await expect(caixa).toBeVisible();

  /*
    O CAMPO NÃO SAI DA BARRA AO ABRIR (D-326). O componente devolvia a caixa no
    lugar do gatilho, e o bloco do perfil escorregava para a esquerda por trás do
    fundo escurecido. As duas metades juntas: o gatilho continua lá, e o perfil
    não muda de posição.
  */
  await expect(gatilho).toBeVisible();

  const perfilDepois = await page.locator(".sb-profile").boundingBox();

  expect(perfilAntes).not.toBeNull();
  expect(perfilDepois?.x, "o bloco do perfil não se desloca ao abrir a busca").toBe(perfilAntes?.x);
  await expect(caixa.getByText(/A busca alcança/)).toHaveText(
    "Digite ao menos duas letras. A busca alcança SKU, anúncio, conta, fornecedor, pedido de compra, atendimento e NF-e.",
  );

  await caixa.getByRole("textbox", { name: "Buscar" }).fill(E2E_SKU_CODE);
  await expect(caixa.getByRole("button", { name: new RegExp(E2E_SKU_CODE) }).first()).toBeVisible();
});
