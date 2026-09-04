import { expect, test } from "@playwright/test";

import { E2E_DECISION_TEXT, E2E_SKU_SALES } from "./constants.js";
import { login, statValue } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * "Página do produto" (docs/TESTING.md) — Dashboard de SKU. O saldo LOCAL
 * exibido vem de `inventory_balances`, projeção mantida por trigger sobre
 * `stock_movements` (nunca somado em JS — docs/ARCHITECTURE.md secao 21):
 * o seed grava um `ENTRADA_NFE` de 50 unidades, e este teste prova que ele
 * chega inteiro até a tela, não só até o banco.
 */
test("dashboard de SKU mostra saldo local do seed", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  await expect(page).toHaveURL(new RegExp(`/skus/${seed.skuId}$`));
  // O `<h1>` é o NOME do produto e o código do SKU é o identificador em
  // monoespaçado acima dele — o cabeçalho de entidade do Figma. Era o
  // contrário: `<h1>E2E-SKU-001</h1>` com o nome como parágrafo cinza. O código
  // é chave (o que se copia e se cola em outro sistema), não título.
  await expect(page.getByRole("heading", { level: 1, name: "Produto de teste E2E" })).toBeVisible();
  await expect(page.getByText(`SKU ${seed.skuCode}`, { exact: true })).toBeVisible();

  // O cartão de estoque consolidou os quatro saldos: o valor é o LOCAL e a
  // nota carrega reservado, trânsito e Full. Nenhum sumiu — o que não existe é
  // uma soma dos quatro, que seria um agregado sem definição.
  const estoque = page.locator(".sb-stat", { hasText: "Estoque local" });

  await expect(estoque.locator(".sb-stat-value")).toHaveText("50");
  await expect(estoque.locator(".sb-stat-note")).toContainText("reservado");
  await expect(estoque.locator(".sb-stat-note")).toContainText("em trânsito");
  await expect(estoque.locator(".sb-stat-note")).toContainText("no Full");

  // Abas (D-169): "Anúncios" virou aba própria — navegar por ela cobre a
  // navegação junto. O locator escopa pelo nav das abas porque o menu
  // lateral também tem um link "Anúncios".
  await page.getByRole("navigation", { name: "Abas do SKU" }).getByRole("link", { name: "Anúncios" }).click();
  await expect(page.getByText("Nenhum anúncio vinculado a este SKU.")).toBeVisible();
});

/**
 * Aba Full (D-224/D-225) — a fiação, e o estado vazio HONESTO.
 *
 * O seed não cria snapshot de Full de propósito: é o estado mais comum de um
 * SKU qualquer, e é onde a tela pode mentir. A regra de D-067 é que ausência
 * de dado nunca vira zero — aqui isso significa dizer "não há snapshot", e
 * não estampar "0 no Full", que é uma afirmação diferente e falsa.
 */
test("aba Full existe e distingue ausência de snapshot de saldo zero", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  await page.getByRole("navigation", { name: "Abas do SKU" }).getByRole("link", { name: "Full" }).click();

  await expect(page).toHaveURL(/aba=full/);
  await expect(page.getByRole("heading", { name: "Full por conta" })).toBeVisible();
  await expect(page.getByText("Ausência de snapshot não é o mesmo que saldo zero")).toBeVisible();
});

/**
 * Aba Preços (D-226) — a fiação, e de novo o estado vazio, que aqui é a
 * regra e não a exceção: 95 dos 3.554 SKUs do Dev (2,7%) têm algum evento de
 * preço, então 97% das páginas mostram exatamente esta mensagem.
 *
 * O que ela precisa dizer é o oposto do óbvio. `listing.price.changed` é um
 * DIFF entre snapshots de 6 em 6 horas — logo "sem linha" não é "preço
 * parado", e a tela que dissesse "preço estável" estaria inventando.
 */
test("aba Preços existe e não confunde ausência de evento com preço parado", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  await page.getByRole("navigation", { name: "Abas do SKU" }).getByRole("link", { name: "Preços" }).click();

  await expect(page).toHaveURL(/aba=precos/);
  await expect(page.getByRole("heading", { name: "Mudanças de preço observadas" })).toBeVisible();
  await expect(page.getByText("Nenhuma mudança de preço observada neste período")).toBeVisible();
  await expect(page.getByText("uma alteração feita e desfeita entre duas sincronizações não deixa registro")).toBeVisible();
});

/**
 * Aba Vendas (D-227) — a única com RPC própria, e por isso a única em que o
 * e2e precisa provar NÚMERO, não só fiação: total, por conta e por dia saem
 * de `get_sku_sales_breakdown` já somados no banco. O seed grava dois dias na
 * mesma conta; se a tela somasse em JavaScript, ou se a RPC dividisse a
 * razão errado, os valores abaixo não fechariam.
 */
test("aba Vendas mostra total, ticket médio e a conta — somados no banco", async ({ page }) => {
  const seed = await readSeedOutput();
  const unidades = E2E_SKU_SALES.reduce((acc, v) => acc + v.units, 0);
  const receita = E2E_SKU_SALES.reduce((acc, v) => acc + v.revenue, 0);
  const compras = E2E_SKU_SALES.reduce((acc, v) => acc + v.purchases, 0);

  await login(page, `/skus/${seed.skuId}`);

  await page.getByRole("navigation", { name: "Abas do SKU" }).getByRole("link", { name: "Vendas" }).click();

  await expect(page).toHaveURL(/aba=vendas/);
  await expect(page.getByRole("heading", { name: "Vendas do SKU" })).toBeVisible();

  await expect(statValue(page, "Unidades vendidas")).toHaveText(String(unidades));
  // Razão sobre as SOMAS (500 / 5 = R$ 100,00), não média das razões diárias.
  await expect(statValue(page, "Ticket médio")).toContainText(`${String(receita / compras)},00`);

  // A conta do seed aparece na tabela por conta, com as mesmas unidades.
  const linhaConta = page.getByRole("row", { name: new RegExp(seed.mlAccountLabel) });
  await expect(linhaConta).toContainText(String(unidades));

  // Dois dias gravados, duas linhas por dia — e nenhum dia inventado com zero.
  await expect(page.getByRole("heading", { name: "Por dia" })).toBeVisible();
  const tabelaDias = page.getByRole("table").last();
  await expect(tabelaDias.getByRole("row")).toHaveCount(E2E_SKU_SALES.length + 1);
});

/**
 * Aba Decisões (D-228) — a última das nove. Leitura direta sob RLS com embed
 * (`action_decisions → actions!inner`, `→ action_outcomes`), e D-188 é a lição
 * de que embed só se prova RODANDO: este teste é a prova na aplicação servida,
 * com login real. O seed grava uma decisão com baseline e uma medição de 7
 * dias; a tela tem de mostrar os dois retratos lado a lado e dizer quais
 * janelas ainda não foram medidas — sem nenhuma porcentagem de "resultado".
 */
test("aba Decisões mostra a decisão do seed com o antes e o depois lado a lado", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  await page.getByRole("navigation", { name: "Abas do SKU" }).getByRole("link", { name: "Decisões" }).click();

  await expect(page).toHaveURL(/aba=decisoes/);
  await expect(page.getByRole("heading", { name: "Decisões registradas" })).toBeVisible();

  await expect(page.getByText(E2E_DECISION_TEXT)).toBeVisible();
  await expect(page.getByText("Venda anômala · Queda")).toBeVisible();
  await expect(page.getByText("No momento da decisão — Vendido (7d): 2")).toBeVisible();
  await expect(page.getByText(/7 dias depois \(.*\) — Vendido \(7d\): 5/)).toBeVisible();
  await expect(page.getByText("Ainda sem medição: 15 dias depois, 30 dias depois.")).toBeVisible();
});
