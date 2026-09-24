import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * `/central` (D-394, D-395) — os indicadores contra o período anterior, a meta
 * do mês e o resumo.
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

  for (const regiao of [
    "Resumo do período",
    "Meta e projeção",
    "Vendas",
    "Resultado e lucro",
    "Custos da venda",
    "Mercado Ads",
    "Comparação completa",
  ]) {
    await expect(page.getByRole("region", { name: regiao })).toBeVisible();
  }

  await expect(page.getByText("Não foi possível carregar o período")).toHaveCount(0);
  await expect(page.getByText("Não foi possível carregar a meta")).toHaveCount(0);
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

/**
 * Metas e imposto (D-395): o ADMIN do seed cadastra a meta do mês e a
 * alíquota, e a central passa a mostrar a meta. Num banco sem a migration a
 * tela diz "sendo ativado" e o teste para aí — é o estado da produção entre o
 * merge e o workflow de migrations, e ele também não pode quebrar.
 */
test("/central/metas: cadastrar meta e alíquota aparece na central, e remover limpa", async ({ page }) => {
  await login(page, "/central/metas");

  await expect(page.getByRole("heading", { level: 1, name: "Metas e imposto" })).toBeVisible();

  if ((await page.getByText("SENDO ATIVADO").count()) > 0) {
    test.skip(true, "banco sem as tabelas de D-395");
  }

  const meta = page.getByRole("form", { name: "Cadastrar meta do mês" });

  await meta.getByLabel("Meta de faturamento (R$)").fill("1.234.567,89");
  await meta.getByRole("button", { name: "Salvar meta" }).click();
  await expect(meta.getByRole("status")).toHaveText("Meta salva.");
  await expect(page.getByRole("cell", { name: /1\.234\.567,89/ })).toBeVisible();

  const aliquota = page.getByRole("form", { name: "Cadastrar alíquota de imposto" });

  await aliquota.getByLabel("Alíquota efetiva (%)").fill("6,5");
  await aliquota.getByRole("button", { name: "Salvar alíquota" }).click();
  await expect(aliquota.getByRole("status")).toHaveText("Alíquota salva.");
  await expect(page.getByText(/Hoje vale 6,5% sobre o faturamento/)).toBeVisible();

  // Valor inválido volta com o erro no campo, sem gravar.
  await aliquota.getByLabel("Alíquota efetiva (%)").fill("150");
  await aliquota.getByRole("button", { name: "Salvar alíquota" }).click();
  await expect(aliquota.getByRole("alert")).toHaveText("A alíquota fica entre 0% e 100%.");

  await page.getByRole("link", { name: "Voltar à central" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Central do negócio" })).toBeVisible();

  const secaoMeta = page.getByRole("region", { name: "Meta e projeção" });

  await expect(secaoMeta.getByRole("progressbar", { name: "Realizado da meta do mês" })).toBeVisible();
  await expect(secaoMeta.getByText(/1\.234\.567,89/).first()).toBeVisible();

  // Limpa o que o teste gravou, pela própria tela.
  await page.goto("/central/metas");
  await page.getByRole("button", { name: /^Remover a meta de / }).first().click();
  await expect(page.getByRole("cell", { name: /1\.234\.567,89/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Remover a alíquota de / }).first().click();
  await expect(page.getByText("Nenhuma alíquota cadastrada.")).toBeVisible();
});

/**
 * Detector de frete (D-397): a tela abre, o resumo tem os quatro números e o
 * frete a mais, o filtro de nível viaja pela URL, e a central aponta para ela.
 * Os alertas não são afirmados — o seed não tem 90 dias de frete; lista vazia
 * com o motivo é estado legítimo. Num banco sem a migration a tela diz "sendo
 * ativado" e o teste para aí.
 */
test("/central/frete: resumo, filtro de nível e o caminho a partir da central", async ({ page }) => {
  await login(page, "/central/frete");

  await expect(page.getByRole("heading", { level: 1, name: "Detector de frete" })).toBeVisible();

  if ((await page.getByText("SENDO ATIVADO").count()) > 0) {
    test.skip(true, "banco sem a função de D-397");
  }

  await expect(page.getByText(/Não foi possível carregar o detector/)).toHaveCount(0);
  await expect(page.getByText(/formato que esta tela não reconhece/)).toHaveCount(0);
  await expect(page.locator(".sb-kpi-strip .sb-kpi-label")).toHaveText([
    "Forte indício",
    "Provável problema",
    "Atenção",
    "Analisados",
    "Frete a mais (14 dias)",
  ]);
  await expect(page.getByRole("region", { name: "Anúncios para revisar" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Como o detector decide" })).toBeVisible();

  await page.getByRole("link", { name: /^Forte indício \(/ }).click();
  await expect(page).toHaveURL(/nivel=forte/);
  await expect(page.getByRole("region", { name: "Anúncios para revisar" }).getByText("Só forte indício.")).toBeVisible();

  await page.getByRole("link", { name: "Voltar à central" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Central do negócio" })).toBeVisible();

  const frete = page.getByRole("region", { name: "Frete", exact: true });

  await expect(frete).toBeVisible();
  await frete.getByRole("link", { name: "Abrir o detector" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Detector de frete" })).toBeVisible();
});

/**
 * Sinais de Ads (D-398): a central leva à tela, a tela abre sem erro e, com
 * semana consolidada, mostra os níveis e a tabela. O seed não tem Ads, então o
 * caminho normal aqui é o vazio com o motivo — estado legítimo.
 */
test("/central/ads: abre a partir da central, sem erro, com o motivo quando não há semana consolidada", async ({ page }) => {
  await login(page, "/central");

  await page.getByRole("link", { name: "Sinais de Ads", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Sinais de Ads" })).toBeVisible();

  if ((await page.getByText("SENDO ATIVADO").count()) > 0) {
    test.skip(true, "banco sem a função de D-398");
  }

  await expect(page.getByText(/Não foi possível carregar os sinais de Ads/)).toHaveCount(0);
  await expect(page.getByText(/formato que esta tela não reconhece/)).toHaveCount(0);

  const vazio = page.getByText(/Nenhuma semana de Ads consolidada/);

  if ((await vazio.count()) > 0) {
    await expect(vazio).toBeVisible();

    return;
  }

  await expect(page.locator(".sb-kpi-strip .sb-kpi-label")).toHaveText([
    "Crítico",
    "ROAS abaixo da meta",
    "Atenção",
    "Oportunidade de escala",
    "ROAS da semana",
    "Lucro estimado após Ads",
  ]);
  await expect(page.getByRole("region", { name: "Todas as campanhas da semana" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Como os sinais são decididos" })).toBeVisible();
});

test("/central/produtos: abre da central com o mesmo recorte, e a ordem mora na URL", async ({ page }) => {
  await login(page, "/central?p=7d");

  await page.getByRole("link", { name: "Ranking de produtos", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Ranking de produtos" })).toBeVisible();
  await expect(page).toHaveURL(/\/central\/produtos\?p=7d/);

  if ((await page.getByText("SENDO ATIVADO").count()) > 0) {
    test.skip(true, "banco sem a função de D-402");
  }

  await expect(page.getByText(/Não foi possível carregar o ranking/)).toHaveCount(0);
  await expect(page.getByText(/formato que esta tela não reconhece/)).toHaveCount(0);
  await expect(page.locator(".sb-kpi-strip .sb-kpi-label")).toHaveText([
    "Produtos vendidos",
    "Resultado das vendas",
    "No prejuízo",
    "Metade do resultado",
    "Cresceram 30% ou mais",
  ]);

  // O seed vende há dois dias: os 7 dias até ontem têm produto, e cada um abre o dashboard do SKU.
  const lista = page.getByRole("region", { name: "Maior faturamento" });

  await expect(lista).toBeVisible();
  await expect(lista.locator("tbody tr").first()).toBeVisible();
  await expect(lista.locator("tbody tr").first().getByRole("link")).toHaveAttribute("href", /^\/skus\//);

  // Sem custo cadastrado no seed, ninguém tem resultado: a lista do prejuízo diz que está vazia, não "0".
  await page.getByRole("navigation", { name: "Ordem do ranking" }).getByRole("link", { name: "No prejuízo" }).click();
  await expect(page).toHaveURL(/ordem=prejuizo/);
  await expect(page).toHaveURL(/p=7d/);
  await expect(page.getByRole("region", { name: "No prejuízo" })).toBeVisible();
  await expect(page.getByText("Nenhum produto vendeu com prejuízo neste período.")).toBeVisible();
  await expect(page.getByRole("region", { name: "Como o ranking é calculado" })).toBeVisible();
});
