import { type Page, expect, test } from "@playwright/test";

import { E2E_SHOPEE_SHOP } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/faturamento` com a SHOPEE e com "TODOS" (D-442, etapa T5 da frente
 * multicanal), sobre o contrato C-58 (D-437).
 *
 * O seed tem uma conta do Mercado Livre e uma loja Shopee de TESTE, cujos
 * pedidos nunca foram lidos. Isso faz deste spec a prova das regras que mais
 * importam:
 *
 *  1. **O lado a lado não inventa nem soma.** A coluna do Mercado Livre em
 *     `marketplace=todos` é a mesma conta da tela do ML — os mesmos números,
 *     lidos de novo. E não existe coluna de total: os dois resultados têm
 *     componentes diferentes.
 *  2. **Ausência não é zero.** Sem loja real lida, a faixa da Shopee é "—" e
 *     diz por quê; a loja de teste aparece na tabela, marcada e fora das somas.
 *  3. **O recorte vive na URL** com os nomes de `/vendas` (`marketplace`,
 *     período, `contas`), e as lojas só valem no recorte Shopee.
 *
 * Localizadores por papel, nome de menu e id da métrica — nunca pela posição.
 */

function menu(page: Page, nome: string) {
  return page.locator("details.sb-menu").filter({ has: page.locator(`summary[aria-label^="${nome}:"]`) });
}

/** O valor de uma célula da faixa, pelo id da métrica que ela mostra. */
async function valorDaFaixa(page: Page, metricId: string): Promise<string> {
  const celula = page
    .locator(".sb-kpi")
    .filter({ has: page.locator(".sb-kpi-id", { hasText: new RegExp(`^${metricId}$`) }) });

  return (await celula.locator(".sb-kpi-value").innerText()).trim();
}

function linhaDaComparacao(page: Page, rotulo: string) {
  return page
    .getByRole("table", { name: "Faturamento por marketplace, lado a lado" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: rotulo, exact: true }) });
}

test("/faturamento: o seletor oferece Todos, Mercado Livre e Shopee, e o período vai junto", async ({ page }) => {
  await login(page, "/faturamento?days=7");

  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();

  const seletor = menu(page, "Marketplace");

  await seletor.locator("summary").click();
  await expect(seletor.getByRole("link")).toHaveText(["Todos os marketplaces", "Mercado Livre", "Shopee"]);
  await seletor.getByRole("link", { name: "Shopee", exact: true }).click();

  await expect(page).toHaveURL(/\/faturamento\?marketplace=shopee&days=7$/);
  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();
  await expect(seletor.locator("summary")).toHaveAttribute("aria-label", "Marketplace: Shopee");

  // E de volta ao Mercado Livre, com o período.
  await seletor.locator("summary").click();
  await seletor.getByRole("link", { name: "Mercado Livre", exact: true }).click();
  await expect(page).toHaveURL(/\/faturamento\?days=7$/);
  await expect(page.getByRole("region", { name: "Para onde vai o dinheiro" })).toBeVisible();
});

test("/faturamento?marketplace=shopee: sem loja real lida, a faixa diz '—' e por quê; a de teste fica fora", async ({
  page,
}) => {
  await login(page, "/faturamento?marketplace=shopee");

  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();

  expect(await valorDaFaixa(page, "shopee_receita_bruta")).toBe("—");
  expect(await valorDaFaixa(page, "shopee_resultado_venda")).toBe("—");
  await expect(page.getByText("nenhuma loja com venda somável neste recorte").first()).toBeVisible();
  await expect(page.getByText("Não foi possível carregar o faturamento")).toHaveCount(0);

  const tabela = page.getByRole("table", { name: "Faturamento por loja Shopee" });
  const loja = tabela.getByRole("row").filter({ hasText: E2E_SHOPEE_SHOP.name });

  await expect(loja).toContainText("Teste");
  await expect(loja).toContainText("fora das somas");
  await expect(loja).toContainText("pedidos ainda não lidos");
  await expect(loja.getByRole("cell").nth(1)).toHaveText("—");
  await expect(tabela.getByRole("row").filter({ hasText: "Total das lojas somáveis" })).toContainText("nada somável");

  await expect(page.getByText(/Nenhuma loja real com pedidos lidos neste recorte/)).toBeVisible();
});

test("/faturamento?marketplace=todos: o Mercado Livre lado a lado é o da tela do ML, e não há total", async ({ page }) => {
  await login(page, "/faturamento");

  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();

  const ml = {
    receita: await valorDaFaixa(page, "receita_bruta"),
    resultado: await valorDaFaixa(page, "resultado_venda"),
    margem: await valorDaFaixa(page, "margem_venda"),
  };

  // O seed tem venda do ML no período padrão: a comparação não é "—" com "—".
  expect(ml.receita).not.toBe("—");

  await page.goto("/faturamento?marketplace=todos");
  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();

  const tabela = page.getByRole("table", { name: "Faturamento por marketplace, lado a lado" });

  // Duas colunas de marketplace e nenhuma de total.
  await expect(tabela.getByRole("columnheader")).toHaveText(["Métrica", "Mercado Livre", "Shopee"]);

  await expect(linhaDaComparacao(page, "Receita bruta").getByRole("cell").nth(1)).toHaveText(ml.receita);
  await expect(linhaDaComparacao(page, "Resultado da venda").getByRole("cell").nth(1)).toContainText(ml.resultado);
  await expect(linhaDaComparacao(page, "Margem sobre a venda").getByRole("cell").nth(1)).toContainText(ml.margem);

  // A Shopee só tem a loja de teste: "—", e o motivo dito.
  await expect(linhaDaComparacao(page, "Receita bruta").getByRole("cell").nth(2)).toHaveText("—");
  await expect(page.getByText(/Shopee: nenhuma loja real com pedidos lidos/)).toBeVisible();

  // A receita que soma está em Vendas, com o mesmo recorte.
  await page.getByRole("link", { name: "Vendas, todos os marketplaces" }).click();
  await expect(page).toHaveURL(/\/vendas$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();
});

test("/faturamento?marketplace=shopee: as lojas ligam e desligam por clique, e caem no Todos", async ({ page }) => {
  await login(page, "/faturamento?marketplace=shopee");

  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();

  const lojas = menu(page, "Lojas");

  await expect(lojas.locator("summary")).toHaveAttribute("aria-label", "Lojas: Todas as lojas");
  await lojas.locator("summary").click();
  await lojas.getByRole("link", { name: `${E2E_SHOPEE_SHOP.name} (teste)`, exact: true }).click();

  await expect(page).toHaveURL(/\/faturamento\?marketplace=shopee&contas=[0-9a-f-]{36}$/);
  await expect(lojas.locator("summary")).toHaveAttribute("aria-label", `Lojas: ${E2E_SHOPEE_SHOP.name}`);

  // Trocar para o Todos leva o período e deixa as lojas: lá o ML aceita uma conta só.
  const seletor = menu(page, "Marketplace");

  await seletor.locator("summary").click();
  await seletor.getByRole("link", { name: "Todos os marketplaces", exact: true }).click();
  await expect(page).toHaveURL(/\/faturamento\?marketplace=todos$/);
  await expect(menu(page, "Lojas")).toHaveCount(0);
});

/**
 * D-456 (T5c, contrato C-63): os Ads CPC da loja no recorte Shopee. O seed tem
 * só a loja de TESTE, com os Ads nunca lidos — a prova de que a seção não
 * inventa: sem loja real lida não há faixa nem total de zeros, a loja aparece
 * com "—" e o motivo, e a ressalva "não é o total de Ads" está sempre lá. A
 * seção é só da Shopee: o ML tem o Mercado Ads, e o "Todos" não soma os dois.
 */
test("/faturamento?marketplace=shopee: os Ads CPC da loja dizem o que não se sabe, sem inventar zero", async ({
  page,
}) => {
  await login(page, "/faturamento?marketplace=shopee");

  const ads = page.getByRole("region", { name: "Ads CPC da loja Shopee" });

  await expect(ads.getByText("Ads CPC da loja — Shopee")).toBeVisible();
  await expect(ads.getByRole("note").filter({ hasText: "Não é o total de Ads" })).toBeVisible();
  await expect(ads.getByText(/Nenhuma loja real com os Ads já lidos/)).toBeVisible();
  // Sem loja lida, nenhuma faixa: "R$ 0,00 investidos" seria inventado.
  await expect(ads.locator(".sb-kpi")).toHaveCount(0);

  const loja = ads.getByRole("list", { name: "Ads CPC por loja" }).getByRole("listitem");

  await expect(loja).toHaveCount(1);
  await expect(loja).toContainText(`${E2E_SHOPEE_SHOP.name} (teste)`);
  await expect(loja).toContainText("—");
  await expect(loja).toContainText("Ads ainda não lidos · loja de teste, fora do total");

  // No ML e no "Todos" a seção não existe.
  await page.goto("/faturamento?marketplace=todos");
  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Ads CPC da loja Shopee" })).toHaveCount(0);
  await page.goto("/faturamento");
  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Ads CPC da loja Shopee" })).toHaveCount(0);
});

/**
 * D-458 (T5d, contrato C-64): o repasse da Shopee no recorte Shopee — o
 * realizado ao lado do previsto. O seed só tem a loja de TESTE, com os
 * repasses nunca lidos: sem total de zeros, a loja com "—" e o motivo, e a
 * ressalva de que o liberado é do dia da liberação, não da venda. A seção vem
 * antes dos Ads e não existe no ML nem no "Todos".
 */
test("/faturamento?marketplace=shopee: o repasse diz o que não se sabe e não se compara com a receita", async ({
  page,
}) => {
  await login(page, "/faturamento?marketplace=shopee");

  const repasse = page.getByRole("region", { name: "Repasse da Shopee" });

  await expect(repasse.getByText("Repasse da Shopee", { exact: true })).toBeVisible();
  await expect(repasse.getByRole("note").filter({ hasText: "contado pelo dia da liberação" })).toBeVisible();
  await expect(repasse.getByText(/Nenhuma loja real com os repasses já lidos/)).toBeVisible();
  await expect(repasse.locator(".sb-kpi")).toHaveCount(0);

  const loja = repasse.getByRole("list", { name: "Repasse por loja" }).getByRole("listitem");

  await expect(loja).toHaveCount(1);
  await expect(loja).toContainText(`${E2E_SHOPEE_SHOP.name} (teste)`);
  await expect(loja).toContainText("—");
  await expect(loja).toContainText("repasses ainda não lidos · loja de teste, fora do total");

  // O repasse vem antes dos Ads: o realizado fica junto do resultado.
  const secoes = await page.locator("section.sb-campanhas-ml").evaluateAll((s) => s.map((e) => e.id));

  expect(secoes).toEqual(["repasse", "ads"]);

  await page.goto("/faturamento?marketplace=todos");
  await expect(page.getByRole("heading", { level: 1, name: "Faturamento" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Repasse da Shopee" })).toHaveCount(0);
});
