import { expect, test } from "@playwright/test";

import {
  E2E_LISTING_FULL,
  E2E_LOCAL_STOCK,
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

  /*
    A COBERTURA É A MESMA DO DASHBOARD DE SKU E DA /reposicao (D-314). A gaveta
    imprimia `local ÷ venda média`, a conta que D-288 aposentou — e as três
    superfícies agora passam pelo mesmo módulo.
  */
  const vendaDiaria = vendas30d / 30;
  const aproveitavel = E2E_LOCAL_STOCK + E2E_LISTING_FULL;
  const pelaReposicao = Math.round((aproveitavel / vendaDiaria) * 10) / 10;
  const peloEstoqueLocal = Math.round((E2E_LOCAL_STOCK / vendaDiaria) * 10) / 10;

  expect(pelaReposicao).not.toBe(peloEstoqueLocal);

  await expect(gaveta).toContainText(`${pelaReposicao.toFixed(1).replace(".", ",")} dias`);
  await expect(gaveta).not.toContainText(peloEstoqueLocal.toFixed(1).replace(".", ","));

  // A RECUSA: sem política aplicável, o alvo não é chutado (D-144).
  await expect(gaveta.getByText("nenhuma política de reposição alcança este SKU")).toBeVisible();

  // E a gaveta leva à tela cheia, que é o destino que o frame dá a ela.
  await expect(gaveta.getByRole("link", { name: /Abrir página completa/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});


/**
 * As opcoes que o UpSeller da e esta tela nao tinha (D-315): quantos itens por
 * pagina, e em que ordem.
 *
 * **O que este caso protege e a URL.** Tamanho e ordem sao recorte, e recorte
 * desta casa mora na URL -- se um dia virarem estado React, o Filtro Salvo e o
 * link colado no WhatsApp param de significar a mesma coisa, e nada na tela
 * denuncia isso. Ele afirma tambem o que o teste unitario nao alcanca: que a
 * ESCOLHA chega ao banco, porque e o `p_limit` que muda o numero de linhas.
 */
test("/produtos: da para escolher quantos por pagina e em que ordem, e o recorte vive na URL", async ({
  page,
}) => {
  await page.goto("/login?next=%2Fprodutos%3Festado%3Dtodos");
  await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();

  await expect(page).toHaveURL(/\/produtos/);

  /*
    `FilterMenu` e `<details>`/`<summary>` nativo, e o painel nasce FECHADO --
    o menu abre pelo `summary`, nunca por `role: button` (o mapeamento de
    <summary> para papel e detalhe do navegador, licao de /compras).
  */
  const menus = page.locator("details.sb-menu");

  // O padrao e 50, e ele fica FORA da URL: /produtos limpo continua igual.
  await expect(menus.filter({ hasText: "50 por página" })).toBeVisible();

  const linhas = page.locator("tbody tr");
  const quantasNoPadrao = await linhas.count();

  // A ordem padrao e a FILA DE CURADORIA, nao uma data -- e ela e o motivo de a
  // tela existir: poe na frente o que precisa de decisao.
  const menuOrdem = menus.filter({ hasText: "Fila de curadoria" });
  await expect(menuOrdem).toBeVisible();

  await menuOrdem.locator("summary").click();
  await menuOrdem.getByRole("link", { name: "Atualizados primeiro" }).click();

  await expect(page).toHaveURL(/ordem=atualizado/);
  // Trocar a ordem NAO descarta o estado que ja estava no recorte.
  await expect(page).toHaveURL(/estado=todos/);

  const menuTamanho = menus.filter({ hasText: "por página" }).last();
  await menuTamanho.locator("summary").click();
  await menuTamanho.getByRole("link", { name: "20 por página" }).click();

  await expect(page).toHaveURL(/tamanho=20/);
  await expect(page).toHaveURL(/ordem=atualizado/);
  await expect(menus.filter({ hasText: "20 por página" })).toBeVisible();

  // O limite chegou ao banco: com 20 a lista nao pode ter mais linhas que isso.
  const quantasCom20 = await linhas.count();
  expect(quantasCom20).toBeLessThanOrEqual(20);
  expect(quantasCom20).toBeLessThanOrEqual(quantasNoPadrao);

  // A coluna que as duas ordens de data usam: ordenar por uma data invisivel
  // seria pedir fe.
  await expect(page.getByRole("columnheader", { name: /Criado\s+Atualizado/ })).toBeVisible();

  // Buscar NAO pode descartar o que ja estava escolhido -- o GET manda so o que
  // esta no formulario, e e por isso que os campos ocultos existem.
  // Escopado ao formulario da tela: o shell tem a busca global, e "Buscar"
  // sozinho casa com as duas.
  const buscaDaTela = page.locator('form[action="/produtos"]');
  await buscaDaTela.getByRole("searchbox", { name: "Buscar SKU ou título" }).fill(E2E_SKU_CODE);
  await buscaDaTela.getByRole("button", { name: "Buscar" }).click();

  await expect(page).toHaveURL(/tamanho=20/);
  await expect(page).toHaveURL(/ordem=atualizado/);
  await expect(page).toHaveURL(new RegExp(`busca=${E2E_SKU_CODE}`));
});
