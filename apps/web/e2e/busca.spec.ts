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

  const gatilho = page.locator(".sb-search");
  const rotulo = page.locator(".sb-search-label");

  await expect(gatilho).toBeVisible();
  await expect(rotulo).not.toContainText("ação");

  for (const largura of [1440, 1100, 900]) {
    await page.setViewportSize({ width: largura, height: 900 });

    const cortado = await rotulo.evaluate((elemento) => elemento.scrollWidth > elemento.clientWidth);

    expect(cortado, `rótulo da busca a ${String(largura)}px`).toBe(false);
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await gatilho.click();

  const caixa = page.getByRole("dialog", { name: "Buscar na Speed Bikers" });

  await expect(caixa).toBeVisible();
  await expect(caixa.getByText(/A busca alcança/)).toHaveText(
    "Digite ao menos duas letras. A busca alcança SKU, anúncio, conta, fornecedor, pedido de compra, atendimento e NF-e.",
  );

  await caixa.getByRole("textbox", { name: "Buscar" }).fill(E2E_SKU_CODE);
  await expect(caixa.getByRole("button", { name: new RegExp(E2E_SKU_CODE) }).first()).toBeVisible();
});
