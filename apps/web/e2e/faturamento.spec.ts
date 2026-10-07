import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * `/faturamento` (D-356) — o dinheiro de cada venda, e o caminho entre ele e
 * `/vendas`.
 *
 * **O que este teste protege é a VIAGEM do recorte.** As duas telas trocam uma
 * pela outra — o botão "Dashboard de vendas" de lá, o atalho da linha "Hoje" de
 * cá —, e um `href` montado sem a conta ou sem o período leva a pessoa para a
 * mesma tela com o recorte errado, sem erro nenhum.
 *
 * Os números não são afirmados: o seed não tem custo cadastrado, e a cascata
 * recusa por falta de cobertura — que é justamente um estado legítimo. O que se
 * afirma é que os blocos existem e que nenhuma leitura falhou.
 */
test("/faturamento: conta e período viajam entre Faturamento e Vendas", async ({ page }) => {
  await login(page, "/faturamento");

  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Faturamento" }),
  ).toBeVisible();

  await expect(page.getByRole("region", { name: "Para onde vai o dinheiro" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Custos da venda" })).toBeVisible();
  await expect(page.getByRole("region", { name: "O que estes números cobrem" })).toBeVisible();
  await expect(page.getByText("Não foi possível carregar o faturamento")).toHaveCount(0);
  await expect(page.getByText(/formato que esta tela não reconhece/)).toHaveCount(0);

  const menus = page.locator("details.sb-menu");

  await menus.nth(0).locator("summary").click();
  await menus.nth(0).getByRole("link", { name: "Loja E2E" }).click();
  await expect(page).toHaveURL(/account=e2e-loja/);

  await menus.nth(1).locator("summary").click();
  await menus.nth(1).getByRole("link", { name: "Últimos 7 dias" }).click();
  await expect(page).toHaveURL(/days=7/);
  await expect(page).toHaveURL(/account=e2e-loja/);

  // Para /vendas, com os dois.
  await page.getByRole("link", { name: "Dashboard de vendas" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();
  await expect(page).toHaveURL(/\/vendas\?/);
  await expect(page).toHaveURL(/days=7/);
  await expect(page).toHaveURL(/account=e2e-loja/);

  // E de volta, pelo atalho da linha "Hoje".
  await page.getByRole("link", { name: /margem em Faturamento/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();
  await expect(page).toHaveURL(/\/faturamento\?/);
  await expect(page).toHaveURL(/days=7/);
  await expect(page).toHaveURL(/account=e2e-loja/);
});

/**
 * `/vendas` enxuto (D-356): a faixa responde volume, e o dinheiro de cada venda
 * saiu para o Faturamento. Os painéis que saíram não podem voltar por engano —
 * eles repetiam, em pedaços e com outra cobertura, o que a outra tela mostra
 * inteiro.
 */
test("/vendas: a faixa é de volume, e comissão e margem moram no Faturamento", async ({ page }) => {
  await login(page, "/vendas");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  const faixa = page.locator(".sb-kpi-strip-ancora");

  await expect(faixa.locator(".sb-kpi-label")).toHaveText([
    "Receita bruta",
    "Pedidos do Mercado Livre",
    "Unidades vendidas",
    "Ticket médio",
    "Taxa de cancelamento",
  ]);

  await expect(page.getByRole("region", { name: "Mais sobre o período" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: /Margem operacional/ })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /margem em Faturamento/ })).toBeVisible();
});

/**
 * A CALCULADORA DE PREÇO (D-359).
 *
 * Shopee inteira de verdade: faixa R$ 100–199,99 = 14% + R$ 20. Mercado Livre
 * com a cotação da `api` INTERCEPTADA — a suíte não tem conta conectada nem
 * API de pé, e o que se prova aqui é a conta da tela sobre um frete conhecido:
 * a chamada certa sai (tipo, medidas) e a margem usa o frete que voltou.
 */
test("/faturamento: a calculadora dá a margem na Shopee e no Mercado Livre", async ({ page }) => {
  let pedidoDeFrete: Record<string, unknown> | null = null;

  // A cotação interceptada responde como a real (D-421): abaixo de R$ 79, sem
  // frete grátis vem só o custo de envio por unidade; oferecendo, o frete inteiro.
  await page.route("**/v1/pricing/ml-shipping-quote", async (route) => {
    pedidoDeFrete = route.request().postDataJSON() as Record<string, unknown>;
    const preco = Number(pedidoDeFrete.preco);
    const custoVendedor = preco >= 79 ? 21.9 : pedidoDeFrete.ofereceFreteGratis === true ? 13.85 : 8.25;

    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        cotacao: { custoVendedor, moeda: "BRL", pesoFaturavelG: 600, custoSemDesconto: null, descontoPercentual: null },
        tarifaFixa: 0,
        freteGratis: preco >= 79 || pedidoDeFrete.ofereceFreteGratis === true,
      }),
    });
  });

  await login(page, "/faturamento");

  const calc = page.getByRole("region", { name: "Calculadora de preço" });

  await calc.getByRole("radio", { name: "Shopee" }).click();
  await calc.getByLabel("Custo do produto").fill("62,50");
  await calc.getByLabel("Preço de venda").fill("149,90");

  // 149,90 − (14% = 20,99) − 20 − 62,50 = 46,41 → 30,96%
  await expect(calc.locator(".sb-calc-margem")).toHaveText("31,0%");
  await expect(calc.locator(".sb-calc-total")).toContainText("46,41");

  await calc.getByRole("radio", { name: "Mercado Livre" }).click();

  // Sem medidas, NÃO há margem: frete zero fingido daria um número falso.
  await expect(calc.locator(".sb-calc-margem")).toHaveCount(0);
  await expect(calc.getByText(/cote o frete pelas medidas/i)).toBeVisible();

  await calc.getByRole("radio", { name: /Premium/ }).click();
  await calc.getByLabel("Altura").fill("12");
  await calc.getByLabel("Largura").fill("18");
  await calc.getByLabel("Comprimento").fill("25");
  await calc.getByLabel("Peso").fill("800");

  // 149,90 − (17% = 25,48) − 21,90 − 62,50 = 40,02 → 26,70%
  await expect(calc.locator(".sb-calc-margem")).toHaveText("26,7%");
  await expect(calc.locator(".sb-calc-total")).toContainText("40,02");
  expect(pedidoDeFrete).toMatchObject({ tipoAnuncio: "premium", alturaCm: 12, larguraCm: 18, comprimentoCm: 25, pesoG: 800, preco: 149.9 });

  // A partir de R$ 79 o frete grátis é obrigatório: a escolha fica travada.
  const freteGratis = calc.getByRole("radiogroup", { name: "Frete grátis" });

  await expect(freteGratis.getByRole("radio", { name: "Ofereço" })).toHaveAttribute("aria-checked", "true");
  await expect(freteGratis.getByRole("radio", { name: "Não ofereço" })).toBeDisabled();

  // Abaixo de R$ 79, sem oferecer (o padrão): só o custo de envio por unidade.
  await calc.getByLabel("Preço de venda").fill("50");
  await calc.getByLabel("Custo do produto").fill("5");
  await expect(calc.locator(".sb-calc-frete")).toContainText("Sem frete grátis");
  // 50 − (17% = 8,50) − 8,25 − 5 = 28,25 → 56,5%
  await expect(calc.locator(".sb-calc-margem")).toHaveText("56,5%");
  expect(pedidoDeFrete).toMatchObject({ preco: 50, ofereceFreteGratis: false });

  // Oferecendo, o frete inteiro: 50 − 8,50 − 13,85 − 5 = 22,65 → 45,3%
  await freteGratis.getByRole("radio", { name: "Ofereço" }).click();
  await expect(calc.locator(".sb-calc-margem")).toHaveText("45,3%");
  expect(pedidoDeFrete).toMatchObject({ preco: 50, ofereceFreteGratis: true });
});
