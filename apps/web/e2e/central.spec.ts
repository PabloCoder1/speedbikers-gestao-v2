import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * `/central` (D-394) — os indicadores contra o período anterior e o resumo.
 *
 * Os números não são afirmados: o seed não tem custo cadastrado nem Ads, e
 * resultado, margem e Ads saem SEM comparação, com o motivo — que é justamente
 * um estado legítimo (METRICS 5I). O que se afirma é que os blocos existem,
 * que nenhuma leitura falhou, e que conta e período viajam pela URL e até o
 * `/faturamento`.
 */
test("/central: blocos, recorte na URL e o caminho para o faturamento", async ({ page }) => {
  await login(page, "/central");

  await expect(page.getByRole("heading", { level: 1, name: "Central do negócio" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Central do negócio" }),
  ).toBeVisible();

  for (const regiao of ["Resumo do período", "Vendas", "Rentabilidade", "Mercado Ads", "Comparação completa"]) {
    await expect(page.getByRole("region", { name: regiao })).toBeVisible();
  }

  await expect(page.getByText("Não foi possível carregar o período")).toHaveCount(0);
  await expect(page.getByText(/formato que esta tela não reconhece/)).toHaveCount(0);
  await expect(page.getByText("O período anterior não carregou")).toHaveCount(0);

  await expect(page.locator(".sb-kpi-strip-ancora .sb-kpi-label")).toHaveText([
    "Faturamento",
    "Pedidos",
    "Ticket médio",
    "Unidades vendidas",
  ]);

  // O padrão são 30 dias COMPLETOS: o subtítulo diz que terminam ontem.
  await expect(page.getByText(/Dias completos, até ontem\./)).toBeVisible();

  const menus = page.locator("details.sb-menu");

  await menus.nth(0).locator("summary").click();
  await menus.nth(0).getByRole("link", { name: "Loja E2E" }).click();
  await expect(page).toHaveURL(/account=e2e-loja/);

  await menus.nth(1).locator("summary").click();
  await menus.nth(1).getByRole("link", { name: "Hoje" }).click();
  await expect(page).toHaveURL(/p=hoje/);
  await expect(page).toHaveURL(/account=e2e-loja/);
  await expect(page.getByText(/Hoje ainda está em andamento\./)).toBeVisible();

  await menus.nth(1).locator("summary").click();
  await menus.nth(1).getByRole("link", { name: "Mês anterior" }).click();
  await expect(page).toHaveURL(/p=mes-anterior/);
  await expect(page).toHaveURL(/account=e2e-loja/);

  await page.getByRole("link", { name: "Faturamento detalhado" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();
  await expect(page).toHaveURL(/account=e2e-loja/);
});

test("/central: personalizado inválido avisa e cai no padrão", async ({ page }) => {
  await login(page, "/central?from=2026-09-10&to=2026-09-01");

  await expect(page.getByRole("alert").filter({ hasText: "Período personalizado inválido" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Central do negócio" })).toBeVisible();
});
