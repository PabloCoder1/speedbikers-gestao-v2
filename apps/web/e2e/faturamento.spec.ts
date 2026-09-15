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
