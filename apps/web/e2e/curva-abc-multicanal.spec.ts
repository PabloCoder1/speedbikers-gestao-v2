import { type Page, expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * `/curva-abc` com MAIS DE UM MARKETPLACE (D-448, etapa T6b), sobre o C-60
 * (D-441).
 *
 * O seed tem uma conta do Mercado Livre e uma loja Shopee de TESTE. Isso faz
 * deste spec a prova de equivalência: a loja de teste nunca entra na curva,
 * então a curva de "Todos" tem de ser a do Mercado Livre — os mesmos totais e o
 * mesmo primeiro SKU, lidos com outros parâmetros da função. E o recorte só
 * Shopee, sem loja real, não inventa SKU.
 *
 * É também o primeiro e2e da Curva ABC: localizadores por papel e texto.
 */

function seletorDeMarketplace(page: Page) {
  return page.locator("details.sb-menu").filter({ has: page.locator('summary[aria-label^="Marketplace:"]') });
}

/** As pílulas de um grupo de filtro ("Critério", "Classe ABC"…), pelo rótulo do grupo. */
function grupo(page: Page, rotulo: string) {
  return page.locator(".sb-abc-filter-grid > div").filter({ has: page.getByText(rotulo, { exact: true }) });
}

async function valorDaFaixa(page: Page, rotulo: string): Promise<string> {
  const celula = page
    .locator(".sb-kpi")
    .filter({ has: page.locator(".sb-kpi-label", { hasText: new RegExp(`^${rotulo}$`) }) });

  return (await celula.locator(".sb-kpi-value").innerText()).trim();
}

function tabela(page: Page) {
  return page.locator(".sb-abc-table-wrap table");
}

test("/curva-abc: o seletor oferece Todos, e trocar leva o período — 'Pedidos' vira 'Compras'", async ({ page }) => {
  await login(page, "/curva-abc?criterio=pedidos&dias=30");

  await expect(page.getByRole("heading", { level: 1, name: "Curva ABC" })).toBeVisible();
  await expect(grupo(page, "Critério").getByRole("link", { name: "Pedidos" })).toHaveAttribute("aria-current", "true");

  const seletor = seletorDeMarketplace(page);

  await seletor.locator("summary").click();
  await expect(seletor.getByRole("link")).toHaveText(["Todos os marketplaces", "Mercado Livre", "Shopee"]);
  await seletor.getByRole("link", { name: "Todos os marketplaces", exact: true }).click();

  await expect(page).toHaveURL(/\/curva-abc\?marketplace=todos&criterio=compras&dias=30$/);

  // Fora do ML, "Pedidos" não existe: o pedido do ML não soma com o da Shopee.
  const criterios = grupo(page, "Critério").getByRole("link");

  await expect(criterios).toHaveText(["Faturamento", "Unidades", "Compras"]);
  await expect(grupo(page, "Critério").getByRole("link", { name: "Compras" })).toHaveAttribute("aria-current", "true");
});

test("/curva-abc?marketplace=todos: com a única loja Shopee de teste, a curva é a do Mercado Livre", async ({ page }) => {
  await login(page, "/curva-abc");

  await expect(page.getByRole("heading", { level: 1, name: "Curva ABC" })).toBeVisible();

  const ml = {
    faturamento: await valorDaFaixa(page, "Faturamento do recorte"),
    skus: await valorDaFaixa(page, "SKUs listados"),
    produto: (await tabela(page).getByRole("row").nth(1).getByRole("cell").nth(1).getByRole("link").innerText()).trim(),
    receita: (await tabela(page).getByRole("row").nth(1).getByRole("cell").nth(2).innerText()).trim(),
  };

  // O seed tem venda do ML nos 90 dias: a comparação não é "—" com "—".
  expect(ml.faturamento).not.toBe("—");

  await page.goto("/curva-abc?marketplace=todos");
  await expect(page.getByRole("heading", { level: 1, name: "Curva ABC" })).toBeVisible();

  expect(await valorDaFaixa(page, "Faturamento do recorte")).toBe(ml.faturamento);
  expect(await valorDaFaixa(page, "SKUs listados")).toBe(ml.skus);

  const primeira = tabela(page).getByRole("row").nth(1);

  await expect(primeira.getByRole("cell").nth(1).getByRole("link")).toHaveText(ml.produto);
  await expect(primeira.getByRole("cell").nth(2)).toHaveText(ml.receita);
  // No "Todos", a parte de cada canal (classe, produto, faturamento, unidades,
  // compras, ML, Shopee): toda do ML; a Shopee (só a loja de teste) sem venda.
  await expect(primeira.getByRole("cell").nth(5)).toContainText(ml.receita);
  await expect(primeira.getByRole("cell").nth(6)).toContainText("—");

  // Pedidos, ticket e cobertura são do ML e saem; a nota diz.
  await expect(tabela(page).getByRole("columnheader", { name: "Pedidos" })).toHaveCount(0);
  await expect(tabela(page).getByRole("columnheader", { name: "Cobertura" })).toHaveCount(0);
  await expect(page.getByText(/a curva soma compras/)).toBeVisible();
});

test("/curva-abc?marketplace=shopee: só a loja de teste — nenhum SKU inventado, sem Full, e o Excel diz que é do ML", async ({
  page,
}) => {
  await login(page, "/curva-abc?marketplace=shopee&semFull=1");

  await expect(page.getByRole("heading", { level: 1, name: "Curva ABC" })).toBeVisible();
  await expect(page).toHaveURL(/marketplace=shopee/);

  await expect(page.getByText("Nenhum SKU com venda no período e escopo escolhidos.").first()).toBeVisible();
  await expect(page.getByText("Não foi possível carregar")).toHaveCount(0);
  await expect(page.getByText("Sem estoque no Full")).toHaveCount(0);

  const excel = page.getByRole("link", { name: "Baixar Excel (só Mercado Livre)" });

  await expect(excel).toBeVisible();
  await expect(excel).toHaveAttribute("href", /^\/curva-abc\/export\/xlsx(\?|$)/);
  await expect(excel).not.toHaveAttribute("href", /marketplace=/);
});
