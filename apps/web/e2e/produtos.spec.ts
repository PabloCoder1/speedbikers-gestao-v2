import { expect, test } from "@playwright/test";

import {
  E2E_LISTING_FULL,
  E2E_SKU_CODE,
  E2E_SKU_SALES,
  E2E_USER_EMAIL,
  E2E_USER_PASSWORD,
} from "./constants.js";

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

  // As três decisões de estoque moram no menu "Classificar estoque" (o
  // "Classificar Estoque ⌄" do frame da curadoria); abrir o menu é parte do
  // caminho que o operador percorre.
  const menu = page.locator("details.sb-menu", { hasText: "Classificar estoque" });
  const virtual = menu.getByRole("button", { name: "É virtual", exact: true });

  // 1. Sem seleção, a ação não existe como possibilidade.
  await menu.locator("summary").click();
  await expect(virtual).toBeDisabled();
  await expect(page.getByText("0 selecionado(s)")).toBeVisible();

  /*
    2. Selecionar habilita e o contador acompanha.

    A linha é escolhida pelo SKU, não por `.first()`: a ordem da curadoria é
    `decision_diverges_from_signature desc` antes do código, então "a primeira"
    muda quando o catálogo muda. Foi o que aconteceu em D22 — um SKU novo,
    classificado como virtual e sem assinatura sentinela, passou a divergir e
    subiu para o topo; o teste marcava ELE, a classificação virava no-op e o
    "Desfazer" nunca aparecia.
  */
  await page
    .locator("tbody tr", { hasText: E2E_SKU_CODE })
    .locator("input[type=checkbox]")
    .check();
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

  /*
    5. E DESFAZER desfaz — clicar aqui não é limpeza de cortesia.

    `stock_is_virtual` é estado GLOBAL do SKU: deixar E2E-SKU-001 virtual ao
    sair daqui apaga a cobertura em dias dele em toda tela que roda depois
    nesta suíte (foi assim que `reposicao.spec.ts` nasceu vermelho, D-288).
    Clicar também fecha o passo 4: um "Desfazer" que aparece e não volta é
    pior do que não existir.
  */
  await page.getByRole("button", { name: "Desfazer" }).click();
  await expect(page.getByText("não classificado", { exact: true }).first()).toBeVisible({ timeout: 15000 });
});

/**
 * A gaveta "Inspeção Rápida" (D38) — a primeira das cinco do Figma.
 *
 * **O que este teste protege é a RECUSA.** Os números da gaveta vêm de quatro
 * fontes que já são donas deles em outras telas, e o risco de uma gaveta de
 * resumo não é errar a soma: é preencher o que não sabe. O SKU do seed **não
 * tem política de reposição**, então "Cobertura alvo" tem de sair `—` com o
 * motivo escrito — se um dia alguém puser um default ali, o valor aparece e
 * este teste fica vermelho.
 *
 * Os dois números afirmados são DERIVADOS do seed (mesma regra de
 * `E2E_SKU_SALES` nos specs de vendas): mudar o fixture muda os dois lados
 * juntos, nunca só um.
 */
test("/produtos: a Inspeção Rápida mostra o retrato real e recusa o que não tem fonte", async ({ page }) => {
  await page.goto("/login?next=%2Fprodutos%3Festado%3Dtodos");
  await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/produtos/);

  await page.locator("tbody tr", { hasText: E2E_SKU_CODE }).getByRole("button", { name: "Inspecionar" }).click();

  const gaveta = page.getByRole("dialog");

  await expect(gaveta).toBeVisible();
  await expect(gaveta.getByText(`SKU ${E2E_SKU_CODE}`)).toBeVisible();

  const vendas30d = E2E_SKU_SALES.reduce((total, dia) => total + dia.units, 0);

  await expect(gaveta.getByText(`${String(vendas30d)} un`, { exact: true })).toBeVisible();
  await expect(gaveta.getByText(`${String(E2E_LISTING_FULL)} un`, { exact: true })).toBeVisible();

  // A RECUSA: sem política aplicável, o alvo não é chutado (D-144).
  await expect(gaveta.getByText("nenhuma política de reposição alcança este SKU")).toBeVisible();

  // E a gaveta leva à tela cheia, que é o destino que o frame dá a ela.
  await expect(gaveta.getByRole("link", { name: /Abrir página completa/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
