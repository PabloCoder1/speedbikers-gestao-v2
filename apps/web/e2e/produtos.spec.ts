import { expect, test } from "@playwright/test";

import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./constants.js";

/**
 * `/produtos` — a curadoria, depois da migração da composição para o Figma.
 *
 * **O que este teste protege é a ESCRITA.** `/vendas` e a Home são leitura: uma
 * migração visual que quebre algo lá mostra número errado, e isso é grave. Aqui
 * é diferente — a tela é o único lugar onde `stock_is_virtual` e
 * `supplier_brand` são decididos (D-127, D-129), e uma seleção que deixa de
 * chegar ao Server Action não mostra nada errado: ela simplesmente não escreve,
 * e o operador acha que classificou.
 *
 * O caminho inteiro, na ordem em que a tela o impõe:
 *
 *  1. a ação nasce **desabilitada** — nada selecionado, nada a fazer;
 *  2. selecionar habilita, e o contador diz quantos;
 *  3. a confirmação mostra a **CONSEQUÊNCIA**, não só a contagem — é a regra
 *     que separa "aplicar em lote" de "aplicar em lote às cegas";
 *  4. confirmar escreve e oferece **desfazer**.
 *
 * O passo 3 é o que mais importa: sem ele, um clique em "É virtual" apaga da
 * Cobertura o cálculo de dias de 2.306 SKUs sem que ninguém tenha lido o que
 * isso significa.
 */
test("/produtos: a curadoria em lote só escreve depois de dizer a consequência", async ({ page }) => {
  await page.goto("/login?next=%2Fprodutos%3Festado%3Dtodos");
  await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/produtos/);
  await expect(page.getByRole("heading", { level: 1, name: "Curadoria de produtos" })).toBeVisible();

  const virtual = page.getByRole("button", { name: "É virtual", exact: true });

  // 1. Sem seleção, a ação não existe como possibilidade.
  await expect(virtual).toBeDisabled();
  await expect(page.getByText("0 selecionado(s)")).toBeVisible();

  // 2. Selecionar habilita e o contador acompanha.
  await page.locator("tbody tr input[type=checkbox]").first().check();
  await expect(page.getByText("1 selecionado(s)")).toBeVisible();
  await expect(virtual).toBeEnabled();

  // 3. A confirmação diz o que a decisão CAUSA.
  await virtual.click();
  await expect(page.getByText(/Cobertura deixará de calcular dias/)).toBeVisible();

  // 4. Confirmar escreve — e o resultado oferece desfazer, porque decisão
  //    humana em lote precisa de volta.
  await page.getByRole("button", { name: "Confirmar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Desfazer" })).toBeVisible({ timeout: 15000 });

  // E a tela reflete a escrita: o SKU deixou de estar "não classificado".
  await expect(page.getByText("não classificado", { exact: true })).toHaveCount(0);
});
