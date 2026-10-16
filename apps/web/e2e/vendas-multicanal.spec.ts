import { type Page, expect, test } from "@playwright/test";

import { E2E_SHOPEE_SHOP } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/vendas` com MAIS DE UM MARKETPLACE (D-440, etapa T4 da frente multicanal),
 * sobre o contrato C-53 (D-436).
 *
 * O seed tem uma conta do Mercado Livre e uma loja Shopee de TESTE, cujos
 * pedidos nunca foram dados como lidos. Isso faz deste spec a prova das regras
 * que mais importam:
 *
 *  1. **O consolidado não inventa a Shopee.** A loja de teste nunca entra nas
 *     somas, então o TOTAL de "todos" é o do Mercado Livre — os mesmos números
 *     da tela do ML, lidos de outra RPC. Se a loja de teste vazar para o total,
 *     ou o ML for somado diferente, os números divergem.
 *  2. **Ausência não é zero.** A loja nunca lida aparece com "—"; o recorte só
 *     Shopee, sem loja real lida, mostra "—" na faixa e diz por quê.
 *  3. **O recorte vive na URL num valor só** (`contas=a,b`), para caber num
 *     filtro salvo.
 *
 * Localizadores por papel e texto; a faixa é lida pelo id da métrica, depois do
 * título — o esqueleto de carregamento repete as classes do shell.
 */

function seletorDeMarketplace(page: Page) {
  return page.locator("details.sb-menu").filter({ has: page.locator('summary[aria-label^="Marketplace:"]') });
}

function menuDeContas(page: Page) {
  return page.locator("details.sb-menu").filter({ has: page.locator('summary[aria-label^="Contas:"]') });
}

/** O valor de uma célula da faixa, pelo id da métrica que ela mostra. */
async function valorDaFaixa(page: Page, metricId: string): Promise<string> {
  const celula = page
    .locator(".sb-kpi")
    .filter({ has: page.locator(".sb-kpi-id", { hasText: new RegExp(`^${metricId}$`) }) });

  return (await celula.locator(".sb-kpi-value").innerText()).trim();
}

function tabela(page: Page) {
  return page.getByRole("table", { name: "Vendas por marketplace e conta" });
}

test("/vendas: o seletor oferece Todos os marketplaces, e o período vai junto", async ({ page }) => {
  await login(page, "/vendas?marketplace=ml&days=7");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  const seletor = seletorDeMarketplace(page);

  await seletor.locator("summary").click();
  await expect(seletor.getByRole("link")).toHaveText(["Todos os marketplaces", "Mercado Livre", "Shopee"]);
  await seletor.getByRole("link", { name: "Todos os marketplaces", exact: true }).click();

  await expect(page).toHaveURL(/\/vendas\?days=7$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();
  await expect(seletor.locator("summary")).toHaveAttribute("aria-label", "Marketplace: Todos os marketplaces");
});

test("/vendas?marketplace=todos: com a única loja Shopee de teste, o total é o do Mercado Livre", async ({ page }) => {
  await login(page, "/vendas?marketplace=ml");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  const ml = {
    receita: await valorDaFaixa(page, "receita_bruta"),
    unidades: await valorDaFaixa(page, "unidades_vendidas"),
    ticket: await valorDaFaixa(page, "ticket_medio"),
  };

  // O seed tem venda do ML no período padrão: a comparação não é "—" com "—".
  expect(ml.receita).not.toBe("—");

  await page.goto("/vendas?marketplace=todos");
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  expect(await valorDaFaixa(page, "multicanal_receita_bruta")).toBe(ml.receita);
  expect(await valorDaFaixa(page, "multicanal_unidades")).toBe(ml.unidades);
  expect(await valorDaFaixa(page, "multicanal_ticket_medio")).toBe(ml.ticket);

  // A loja de teste está na tabela, marcada e fora das somas; nunca lida, "—".
  const loja = tabela(page).getByRole("row").filter({ hasText: E2E_SHOPEE_SHOP.name });

  await expect(loja).toContainText("Teste");
  await expect(loja).toContainText("fora das somas");
  await expect(loja).toContainText("pedidos ainda não lidos");
  await expect(loja.getByRole("cell").nth(1)).toHaveText("—");

  // A Shopee não tem soma: só a loja de teste, que não soma.
  await expect(tabela(page).getByRole("row").filter({ hasText: "nada somável" })).toHaveCount(1);
});

test("/vendas?marketplace=shopee: sem loja real lida, a faixa diz '—' e por quê, e os pedidos estão a um clique", async ({
  page,
}) => {
  await login(page, "/vendas?marketplace=shopee&days=7");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  expect(await valorDaFaixa(page, "multicanal_receita_bruta")).toBe("—");
  await expect(page.getByText("nenhuma conta com venda somável neste recorte").first()).toBeVisible();
  await expect(page.getByText(/Nenhum dia com venda somável neste recorte/)).toBeVisible();

  await page.getByRole("link", { name: "Pedidos e lojas da Shopee →" }).click();

  await expect(page).toHaveURL(/\/vendas\/shopee\?days=7$/);
  await expect(page.getByRole("heading", { level: 1, name: "Vendas da Shopee" })).toBeVisible();
});

test("/vendas?marketplace=todos: as contas ligam e desligam por clique, num valor só na URL", async ({ page }) => {
  await login(page, "/vendas?marketplace=todos");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  const contas = menuDeContas(page);

  await expect(contas.locator("summary")).toHaveAttribute("aria-label", "Contas: Todas as contas");
  await contas.locator("summary").click();
  await contas.getByRole("link", { name: "Loja E2E · Mercado Livre", exact: true }).click();

  await expect(page).toHaveURL(/\/vendas\?contas=[0-9a-f-]{36}$/);
  await expect(contas.locator("summary")).toHaveAttribute("aria-label", "Contas: Loja E2E");
  // Só a conta do ML no recorte: a loja Shopee sai da tabela.
  await expect(tabela(page).getByRole("row").filter({ hasText: E2E_SHOPEE_SHOP.name })).toHaveCount(0);

  await contas.locator("summary").click();
  await contas.getByRole("link", { name: "✓ Loja E2E · Mercado Livre", exact: true }).click();

  await expect(page).toHaveURL(/\/vendas$/);
  await expect(contas.locator("summary")).toHaveAttribute("aria-label", "Contas: Todas as contas");
});

test("/vendas?marketplace=todos: o gráfico tem faturamento, unidades e compras — o pedido não soma entre canais", async ({
  page,
}) => {
  await login(page, "/vendas?marketplace=todos&days=7");

  const metricas = page.getByRole("group", { name: "Métrica do gráfico" });

  await expect(metricas.getByRole("link")).toHaveText(["Faturamento", "Unidades", "Compras"]);
  await metricas.getByRole("link", { name: "Compras" }).click();

  await expect(page).toHaveURL(/metric=compras/);
  // O recorte continua "Todos" — que, desde a D-488, é o padrão da /vendas e fica fora da URL.
  await expect(page).not.toHaveURL(/marketplace=/);
  await expect(seletorDeMarketplace(page).locator("summary")).toHaveAttribute("aria-label", "Marketplace: Todos os marketplaces");
  await expect(page).toHaveURL(/days=7/);
});

/**
 * D-488 (decisão do dono de 16/10, depois do Go Live): a /vendas sem
 * `marketplace` abre em "Todos"; o Mercado Livre é `marketplace=ml`. O link de
 * antes, com conta, marca ou métrica que só o ML tem, continua no ML.
 */
test("/vendas sem marketplace abre em Todos; o link antigo com conta do ML continua no ML (D-488)", async ({ page }) => {
  await login(page, "/vendas");

  const seletor = seletorDeMarketplace(page);

  await expect(seletor.locator("summary")).toHaveAttribute("aria-label", "Marketplace: Todos os marketplaces");
  await expect(tabela(page)).toBeVisible();

  await page.goto("/vendas?account=e2e-loja");
  await expect(seletor.locator("summary")).toHaveAttribute("aria-label", "Marketplace: Mercado Livre");

  // E o seletor leva ao ML com o recorte explícito, nunca a uma URL que voltaria para "Todos".
  await page.goto("/vendas");
  await seletor.locator("summary").click();
  await seletor.getByRole("link", { name: "Mercado Livre", exact: true }).click();
  await expect(page).toHaveURL(/\/vendas\?marketplace=ml$/);
  await expect(seletor.locator("summary")).toHaveAttribute("aria-label", "Marketplace: Mercado Livre");
});
