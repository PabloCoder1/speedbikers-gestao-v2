import { expect, test, type Locator, type Page } from "@playwright/test";

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

/** As abas da Central (UX_SYSTEM §6, bloco 1): substituíram os atalhos do cabeçalho e o "Voltar à central". */
function abasDaCentral(page: Page): Locator {
  return page.getByRole("navigation", { name: "Telas da central" });
}

/** A remoção com confirmação (`RemoverComConfirmacao`): o grupo diz o que sai, e "Remover" confirma. */
async function confirmarRemocao(page: Page, grupo: RegExp): Promise<void> {
  await page.getByRole("group", { name: grupo }).getByRole("button", { name: "Remover", exact: true }).click();
}

test("/central: blocos, recorte na URL e o caminho para o faturamento", async ({ page }) => {
  await login(page, "/central");

  await expect(page.getByRole("heading", { level: 1, name: "Central do negócio" })).toBeVisible();
  await expect(
    page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Central do negócio" }),
  ).toBeVisible();

  // D-400: a central de alertas abre a página — com itens, ou com o "nada pede atenção".
  const atencao = page.getByRole("region", { name: "O que precisa da sua atenção" });

  await expect(atencao).toBeVisible();
  await expect(
    atencao.getByRole("listitem").first().or(atencao.getByText(/Nada pede atenção agora/)),
  ).toBeVisible();

  for (const regiao of [
    "Resumo do período",
    "Meta e projeção",
    "Vendas",
    "Resultado e lucro",
    "Custos da venda",
    "Mercado Ads",
  ]) {
    await expect(page.getByRole("region", { name: regiao })).toBeVisible();
  }

  // A tabela que repete os cartões fica recolhida, a um toque (UX_SYSTEM §6, bloco 1).
  await expect(page.getByRole("region", { name: "Comparação completa" })).toBeHidden();
  await page.locator("summary", { hasText: "Comparação completa" }).click();
  await expect(page.getByRole("region", { name: "Comparação completa" })).toBeVisible();

  // As seis telas da Central, nas abas (UX_SYSTEM §6, bloco 1).
  await expect(abasDaCentral(page).getByRole("link")).toHaveText([
    "Central",
    "Metas e imposto",
    "Limites",
    "Detector de frete",
    "Sinais de Ads",
    "Ranking de produtos",
  ]);
  await expect(abasDaCentral(page).getByRole("link", { name: "Central", exact: true })).toHaveAttribute("aria-current", "page");

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

  // D-472: não é falha — a tela já mostra o padrão. É status, não alerta (item 13, D-503).
  await expect(page.getByRole("status").filter({ hasText: "Período personalizado inválido" })).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "Período personalizado inválido" })).toHaveCount(0);
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
  await expect(aliquota.getByRole("alert")).toHaveText("A alíquota fica de 0% a 99,999%.");

  await abasDaCentral(page).getByRole("link", { name: "Central", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Central do negócio" })).toBeVisible();

  const secaoMeta = page.getByRole("region", { name: "Meta e projeção" });

  // exact: a meta de cada marketplace (D-482) tem a barra dela, com o nome do marketplace no fim.
  await expect(secaoMeta.getByRole("progressbar", { name: "Realizado da meta do mês", exact: true })).toBeVisible();
  await expect(secaoMeta.getByText(/1\.234\.567,89/).first()).toBeVisible();

  // Limpa o que o teste gravou, pela própria tela.
  await page.goto("/central/metas");
  // Remover pede confirmação, no lugar (UX_SYSTEM §6, bloco 2).
  await page.getByRole("button", { name: /^Remover a meta de / }).first().click();
  await confirmarRemocao(page, /^Confirmar: Remover a meta de /);
  await expect(page.getByRole("cell", { name: /1\.234\.567,89/ })).toHaveCount(0);
  await page.getByRole("button", { name: /^Remover a alíquota de / }).first().click();
  await confirmarRemocao(page, /^Confirmar: Remover a alíquota de /);
  await expect(page.getByText("Nenhuma alíquota cadastrada.")).toBeVisible();
});

/**
 * Metas por marketplace (D-473, T8b; decisão do dono de 15/10): o ADMIN do
 * seed cadastra a meta do Mercado Livre, ela aparece na tabela e na central ao
 * lado da geral, e a Shopee diz que ainda não entra (o seed não tem loja live
 * lida). Valor inválido volta com o erro no campo, sem gravar. Num banco sem a
 * migration o painel diz "sendo ativado" e o teste para aí.
 */
test("/central/metas: a meta do Mercado Livre aparece na central ao lado da geral, e a Shopee ainda não entra", async ({
  page,
}) => {
  await login(page, "/central/metas");

  await expect(page.getByRole("heading", { level: 1, name: "Metas e imposto" })).toBeVisible();

  if ((await page.getByText("SENDO ATIVADO").count()) > 0) {
    test.skip(true, "banco sem a tabela de D-473");
  }

  const formulario = page.getByRole("form", { name: "Cadastrar meta por marketplace" });

  await formulario.getByLabel("Meta do marketplace (R$)").fill("0");
  await formulario.getByRole("button", { name: "Salvar meta do marketplace" }).click();
  await expect(formulario.getByRole("alert")).toHaveText("A meta precisa ser maior que zero.");

  await formulario.getByLabel("Marketplace", { exact: true }).selectOption("ML");
  await formulario.getByLabel("Meta do marketplace (R$)").fill("765.432,10");
  await formulario.getByRole("button", { name: "Salvar meta do marketplace" }).click();
  await expect(formulario.getByRole("status")).toHaveText("Meta do Mercado Livre salva.");

  const tabela = page.getByRole("table", { name: "Metas por marketplace" });

  await expect(tabela.getByRole("row", { name: /Mercado Livre.*765\.432,10/ })).toBeVisible();

  await abasDaCentral(page).getByRole("link", { name: "Central", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Central do negócio" })).toBeVisible();

  const cadaMarketplace = page.getByRole("region", { name: "Meta de cada marketplace" });

  await expect(cadaMarketplace.getByText(/^meta de R\$\s765\.432,10$/)).toBeVisible();
  await expect(cadaMarketplace.getByText("A Shopee ainda não entra na meta")).toBeVisible();

  // A geral continua sendo a de sempre, agora com o nome que diz que soma os dois.
  await expect(
    page.getByRole("region", { name: "Meta e projeção" }).getByRole("heading", { name: /^Meta geral de / }),
  ).toBeVisible();

  // Limpa o que o teste gravou, pela própria tela.
  await page.goto("/central/metas");
  await page.getByRole("button", { name: /^Remover a meta do Mercado Livre de / }).first().click();
  await confirmarRemocao(page, /^Confirmar: Remover a meta do Mercado Livre de /);
  await expect(page.getByText("Nenhuma meta por marketplace cadastrada.")).toBeVisible();
});

/**
 * Limites da central (D-408): o ADMIN muda os limites, a central passa a dizer
 * que julga com os da empresa (e com o número novo), e "voltar aos padrões"
 * desfaz. Forte igual ao estável volta com o erro no campo, sem gravar. Num
 * banco sem a migration a tela diz "sendo ativado" e o teste para aí.
 */
test("/central/limites: salvar muda o que a central diz, e voltar aos padrões desfaz", async ({ page }) => {
  await login(page, "/central/limites");

  await expect(page.getByRole("heading", { level: 1, name: "Limites da central" })).toBeVisible();

  if ((await page.getByText("SENDO ATIVADO").count()) > 0) {
    test.skip(true, "banco sem a tabela de D-408");
  }

  await expect(page.getByText("Os padrões do sistema: nenhum limite foi mudado ainda.")).toBeVisible();

  const form = page.getByRole("form", { name: "Limites da central" });

  await form.getByLabel("Variação forte (%)").fill("2");
  await form.getByRole("button", { name: "Salvar limites" }).click();
  await expect(form.getByRole("alert")).toHaveText("A variação forte precisa ser maior que a estável.");

  await form.getByLabel("Variação forte (%)").fill("15");
  await form.getByLabel("Amostra mínima (pedidos)").fill("30");
  await form.getByRole("button", { name: "Salvar limites" }).click();
  await expect(form.getByRole("status")).toHaveText("Limites salvos. A central já julga com eles.");

  await abasDaCentral(page).getByRole("link", { name: "Central", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Central do negócio" })).toBeVisible();
  // O "como ler" fica recolhido (UX_SYSTEM §6, bloco 1).
  await page.locator("summary", { hasText: "Como ler estes números" }).click();
  await expect(page.getByText(/com 30 pedidos ou mais nos dois períodos\. Limites da empresa/)).toBeVisible();

  await page.goto("/central/limites");
  // Voltar aos padrões pede confirmação, no lugar (UX_SYSTEM §6, bloco 2). O
  // foco vai para o grupo ao abrir e volta para o botão ao cancelar (D-518).
  const voltar = page.getByRole("button", { name: "Voltar aos padrões" });
  const confirmacao = page.getByRole("group", { name: "Confirmar: Voltar aos padrões" });

  await voltar.click();
  await expect(confirmacao).toBeFocused();
  await confirmacao.getByRole("button", { name: "Cancelar" }).click();
  await expect(voltar).toBeFocused();
  await voltar.click();
  await confirmacao.getByRole("button", { name: "Voltar aos padrões" }).click();
  await expect(page.getByText("Os padrões do sistema: nenhum limite foi mudado ainda.")).toBeVisible();
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

  await abasDaCentral(page).getByRole("link", { name: "Central", exact: true }).click();
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

/**
 * D-480 (T8a, decisão do dono de 15/10): a Shopee na central, LADO A LADO, com
 * a receita somada e sem total de resultado — o mesmo bloco do "Todos" de
 * /faturamento (D-442). O seed só tem a loja de TESTE: o bloco diz que a
 * Shopee ainda não entra. É da empresa inteira, então some com uma conta do ML
 * escolhida.
 */
test("/central: a Shopee entra lado a lado, sem total de resultado, e some com uma conta do ML escolhida", async ({ page }) => {
  await login(page, "/central");

  const porMarketplace = page.getByRole("region", { name: "Por marketplace" });

  await expect(porMarketplace.getByRole("table", { name: "Faturamento por marketplace, lado a lado" })).toBeVisible();
  await expect(porMarketplace.getByText(/Sem total de resultado/)).toBeVisible();
  await expect(porMarketplace.getByText(/nenhuma loja real com pedidos lidos/)).toBeVisible();

  await page.goto("/central?account=e2e-loja");
  await expect(page.getByRole("heading", { level: 1, name: "Central do negócio" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Por marketplace" })).toHaveCount(0);
});
