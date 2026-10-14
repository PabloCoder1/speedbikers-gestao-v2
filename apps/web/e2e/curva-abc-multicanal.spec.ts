import { type Page, expect, test } from "@playwright/test";
import JSZip from "jszip";

import { E2E_SHOPEE_SHOP } from "./constants.js";
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

test("/curva-abc?marketplace=shopee: só a loja de teste — nenhum SKU inventado, sem Full, e o Excel leva o recorte", async ({
  page,
}) => {
  await login(page, "/curva-abc?marketplace=shopee&semFull=1");

  await expect(page.getByRole("heading", { level: 1, name: "Curva ABC" })).toBeVisible();
  await expect(page).toHaveURL(/marketplace=shopee/);

  await expect(page.getByText("Nenhum SKU com venda no período e escopo escolhidos.").first()).toBeVisible();
  await expect(page.getByText("Não foi possível carregar")).toHaveCount(0);
  await expect(page.getByText("Sem estoque no Full")).toHaveCount(0);

  // O Excel leva o MESMO recorte da tela (D-450).
  const excel = page.getByRole("link", { name: "Baixar Excel" });

  await expect(excel).toBeVisible();
  await expect(excel).toHaveAttribute("href", /^\/curva-abc\/export\/xlsx\?marketplace=shopee/);
});

/** Baixa o Excel do link da tela e abre o arquivo: as abas e os textos que ele traz. */
async function abrirExcel(page: Page): Promise<{ abas: string; textos: string }> {
  const href = await page.getByRole("link", { name: "Baixar Excel" }).getAttribute("href");

  expect(href).not.toBeNull();

  const resposta = await page.request.get(href ?? "");

  expect(resposta.status()).toBe(200);
  expect(resposta.headers()["content-type"]).toContain("spreadsheetml");

  const zip = await JSZip.loadAsync(await resposta.body());

  return {
    abas: (await zip.file("xl/workbook.xml")?.async("string")) ?? "",
    textos: (await zip.file("xl/sharedStrings.xml")?.async("string")) ?? "",
  };
}

test("o Excel do 'Todos' traz Compras no lugar de Pedidos, o recorte por marketplace e a loja na aba por conta — o do ML não muda", async ({
  page,
}) => {
  await login(page, "/curva-abc?marketplace=todos");
  await expect(page.getByRole("heading", { level: 1, name: "Curva ABC" })).toBeVisible();

  const todos = await abrirExcel(page);

  expect(todos.abas).toContain('name="Compras"');
  expect(todos.abas).not.toContain('name="Pedidos"');
  expect(todos.textos).toContain("Por marketplace");
  // A loja de teste é coluna da aba por conta, marcada.
  expect(todos.textos).toContain(`${E2E_SHOPEE_SHOP.name} (Shopee) — teste`);

  await page.goto("/curva-abc");
  await expect(page.getByRole("heading", { level: 1, name: "Curva ABC" })).toBeVisible();

  const ml = await abrirExcel(page);

  expect(ml.abas).toContain('name="Pedidos"');
  expect(ml.abas).not.toContain('name="Compras"');
  expect(ml.textos).not.toContain("Por marketplace");
});
