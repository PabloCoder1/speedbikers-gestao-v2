import { type Page, expect, test } from "@playwright/test";
import { shiftBusinessDate, toSalesMetricDate } from "@sb/domain";

import {
  E2E_ANOMALIA,
  E2E_SHOPEE_PEDIDOS,
  E2E_SHOPEE_SHOP,
  E2E_SHOPEE_VENDAS_ESPERADO,
  E2E_SKU_CODE,
} from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/vendas/shopee` — as vendas da Shopee por loja e a lista de pedidos com o
 * SKU gravado (D-430, fatia 6a da trilha Shopee).
 *
 * O seed planta um pedido por caso (`E2E_SHOPEE_PEDIDOS`) na loja de sandbox, e
 * o que o painel deve contar está escrito à mão em `E2E_SHOPEE_VENDAS_ESPERADO`
 * — o teste confere a view `shopee_sales_orders`, não uma cópia dela.
 *
 * O que ele protege, em ordem de gravidade:
 *
 *  1. **A venda válida é pagos menos cancelados e não pagos**, e a receita do
 *     financeiro vence a dos itens: se a view passar a contar o cancelado, ou
 *     somar os itens com o financeiro lido, o painel muda de número.
 *  2. **Ausência não vira zero**: a receita do pedido com item de preço 0 é
 *     "—" e fica de fora da soma, contada à parte; o recebido sem o financeiro
 *     é "aguardando o financeiro".
 *  3. **O SKU gravado e a origem dele**: pelo SKU do anúncio (no item e na
 *     variação) e pelo SKU que veio no próprio pedido, com o link para o SKU.
 *  4. **A loja de teste é marcada** e a tela não soma lojas.
 *
 * Localizadores por papel e texto, nunca por classe: o esqueleto de
 * carregamento repete as classes do shell (`components/carregando.tsx`).
 */

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

function brl(valor: number): string {
  return BRL.format(valor);
}

function tabelaPorLoja(page: Page) {
  return page.getByRole("table", { name: "Vendas da Shopee por loja" });
}

function linhaDaLoja(page: Page) {
  return tabelaPorLoja(page).getByRole("row").filter({ hasText: E2E_SHOPEE_SHOP.name });
}

function painelPedidos(page: Page) {
  return page.getByRole("region", { name: "Pedidos", exact: true });
}

function tabelaPedidos(page: Page) {
  return page.getByRole("table", { name: "Pedidos da Shopee" });
}

/** A linha de um pedido: a que tem o número do pedido, exato, numa célula. */
function linhaDoPedido(page: Page, orderSn: string) {
  return tabelaPedidos(page).getByRole("row").filter({ has: page.getByText(orderSn, { exact: true }) });
}

/** As linhas de dados: todas as linhas da tabela menos a do cabeçalho. */
async function esperaPedidos(page: Page, quantidade: number): Promise<void> {
  await expect(tabelaPedidos(page).getByRole("row")).toHaveCount(quantidade + 1);
}

const ESPERADO = E2E_SHOPEE_VENDAS_ESPERADO;
const { comFinanceiro, semFinanceiro, cancelado, bundle, skuDoPedido, naoPago } = E2E_SHOPEE_PEDIDOS;

test("/vendas/shopee: o painel por loja conta a venda válida, marca a loja de teste e não soma lojas", async ({
  page,
}) => {
  await login(page, "/vendas/shopee");

  await expect(page.getByRole("heading", { level: 1, name: "Vendas da Shopee" })).toBeVisible();

  const linha = linhaDaLoja(page);

  await expect(linha).toHaveCount(1);
  await expect(linha).toContainText("Teste");
  await expect(linha).toContainText("loja de teste: não entra em nenhum total da empresa");

  // Colunas: Loja, Pedidos, Unidades, Receita bruta, Recebido, Cancelados,
  // Devoluções, Com item sem SKU, Última leitura.
  const celulas = linha.getByRole("cell");

  await expect(celulas.nth(1)).toHaveText(String(ESPERADO.pedidos));
  await expect(celulas.nth(2)).toHaveText(String(ESPERADO.unidades));
  // A receita do financeiro vence a dos itens, e o bundle fica de fora — contado à parte.
  await expect(celulas.nth(3)).toContainText(brl(ESPERADO.receitaBruta));
  await expect(celulas.nth(3)).toContainText(`${String(ESPERADO.semReceitaConhecida)} sem receita conhecida`);
  // O recebido é só o dos pedidos com o financeiro lido.
  await expect(celulas.nth(4)).toContainText(brl(ESPERADO.recebido));
  await expect(celulas.nth(4)).toContainText(`${String(ESPERADO.aguardandoFinanceiro)} aguardando o financeiro`);
  await expect(celulas.nth(5)).toHaveText(String(ESPERADO.cancelados));
  await expect(celulas.nth(6)).toHaveText(String(ESPERADO.devolucoes));
  await expect(celulas.nth(7)).toHaveText(String(ESPERADO.comItemSemSku));
  // Os pedidos da loja foram lidos há meia hora: há instante, não "ainda não lidos".
  await expect(celulas.nth(8)).toContainText("a leitura é de hora em hora");
  await expect(celulas.nth(8)).not.toContainText("pedidos ainda não lidos");

  // Cada coluna de métrica carrega o id da definição canônica.
  for (const id of ["shopee_pedidos", "shopee_unidades", "shopee_receita_bruta", "shopee_recebido"]) {
    await expect(tabelaPorLoja(page).getByRole("columnheader", { name: new RegExp(id) })).toBeVisible();
  }

  // Uma linha por loja e nenhuma de total: cabeçalho + a loja do seed.
  await expect(tabelaPorLoja(page).getByRole("row")).toHaveCount(2);
});

test("/vendas/shopee: a lista mostra situação, SKU gravado e origem, e diz o que ainda não se sabe", async ({ page }) => {
  await login(page, "/vendas/shopee");

  await esperaPedidos(page, ESPERADO.naLista);
  await expect(page.getByText(`${String(ESPERADO.naLista)} pedidos.`, { exact: true })).toBeVisible();

  // Colunas: Data, Loja, Pedido, Situação, Itens, Receita bruta, Recebido, Devolução.

  // (a) Financeiro lido: a receita é a do financeiro, o recebido aparece, e a devolução também.
  const a = linhaDoPedido(page, comFinanceiro.orderSn);

  await expect(a.getByRole("cell").nth(1)).toContainText("Teste");
  await expect(a.getByRole("cell").nth(3)).toContainText("Válida");
  await expect(a.getByRole("cell").nth(3)).toContainText(comFinanceiro.status);
  await expect(a.getByRole("link", { name: E2E_SKU_CODE, exact: true })).toHaveAttribute(
    "href",
    /^\/skus\/[0-9a-f-]{36}$/,
  );
  await expect(a).toContainText("pelo SKU do anúncio");
  await expect(a.getByRole("cell").nth(5)).toHaveText(brl(comFinanceiro.financeiro.receitaBruta));
  await expect(a.getByRole("cell").nth(6)).toHaveText(brl(comFinanceiro.financeiro.recebido));
  await expect(a.getByRole("cell").nth(7)).toContainText("Com devolução");

  // (b) Sem financeiro: receita pelos itens, recebido aguardando, devolução não sabida.
  const b = linhaDoPedido(page, semFinanceiro.orderSn);
  const [itemB] = semFinanceiro.itens;

  await expect(b.getByRole("link", { name: E2E_ANOMALIA.sku, exact: true })).toHaveAttribute("href", /^\/skus\//);
  await expect(b).toContainText(itemB.variacao);
  await expect(b).toContainText("pelo SKU do anúncio");
  await expect(b.getByRole("cell").nth(5)).toContainText(brl(itemB.preco));
  await expect(b.getByRole("cell").nth(5)).toContainText("pelos itens");
  await expect(b.getByRole("cell").nth(6)).toHaveText("aguardando o financeiro");
  await expect(b.getByRole("cell").nth(7)).toHaveText("—");

  // (c) Cancelado: na lista, com o status da Shopee.
  const c = linhaDoPedido(page, cancelado.orderSn);

  await expect(c.getByRole("cell").nth(3)).toContainText("Cancelada");
  await expect(c.getByRole("cell").nth(3)).toContainText(cancelado.status);

  // (d) Item de preço 0 (bundle) sem financeiro: receita DESCONHECIDA, nunca zero — e o item sem SKU.
  const d = linhaDoPedido(page, bundle.orderSn);

  await expect(d.getByRole("cell").nth(5)).toContainText("—");
  await expect(d.getByRole("cell").nth(5)).toContainText("sem receita conhecida");
  await expect(d.getByRole("cell").nth(5)).not.toContainText(brl(0));
  await expect(d).toContainText("sem SKU");
  await expect(d.getByRole("cell").nth(6)).toHaveText("aguardando o financeiro");

  // (e) O item não está no catálogo lido: vale o SKU que veio no próprio pedido.
  const e = linhaDoPedido(page, skuDoPedido.orderSn);

  await expect(e.getByRole("link", { name: E2E_ANOMALIA.sku, exact: true })).toHaveAttribute("href", /^\/skus\//);
  await expect(e).toContainText("SKU do pedido");

  // (f) Não pago: fora das somas, e sem financeiro para esperar.
  const f = linhaDoPedido(page, naoPago.orderSn);

  await expect(f.getByRole("cell").nth(3)).toContainText("Não paga");
  await expect(f.getByRole("cell").nth(3)).toContainText(naoPago.status);
  await expect(f.getByRole("cell").nth(6)).toHaveText("—");
});

test("/vendas/shopee: o filtro de situação recorta a lista, não o painel, e compõe com o período", async ({ page }) => {
  await login(page, "/vendas/shopee");

  const painel = painelPedidos(page);

  // Canceladas.
  await painel.locator("summary").click();
  await painel.getByRole("link", { name: "Canceladas", exact: true }).click();

  await expect(page).toHaveURL(/situacao=canceladas/);
  await esperaPedidos(page, ESPERADO.cancelados);
  await expect(linhaDoPedido(page, cancelado.orderSn)).toHaveCount(1);
  await expect(page.getByLabel("Filtros ativos")).toContainText("Canceladas");
  // O painel por loja conta o período inteiro: a situação não o recorta.
  await expect(linhaDaLoja(page).getByRole("cell").nth(1)).toHaveText(String(ESPERADO.pedidos));

  // Válidas.
  await painel.locator("summary").click();
  await painel.getByRole("link", { name: "Válidas", exact: true }).click();

  await expect(page).toHaveURL(/situacao=validas/);
  await esperaPedidos(page, ESPERADO.validasNaLista);
  await expect(linhaDoPedido(page, cancelado.orderSn)).toHaveCount(0);
  await expect(linhaDoPedido(page, naoPago.orderSn)).toHaveCount(0);

  // O período troca sem descartar a situação (todos os pedidos do seed têm até 6 dias).
  const periodo = page.locator("details", { hasText: "Últimos 30 dias" });

  await periodo.locator("summary").click();
  await periodo.getByRole("link", { name: "Últimos 7 dias", exact: true }).click();

  await expect(page).toHaveURL(/days=7/);
  await expect(page).toHaveURL(/situacao=validas/);
  await esperaPedidos(page, ESPERADO.validasNaLista);

  // Tirar o chip volta para todas as situações, no mesmo período.
  await page.getByRole("link", { name: "Tirar o filtro Válidas" }).click();

  await expect(page).not.toHaveURL(/situacao=/);
  await expect(page).toHaveURL(/days=7/);
  await esperaPedidos(page, ESPERADO.naLista);
});

/** O seletor de marketplace do cabeçalho (D-431), pelo nome acessível dele. */
function seletorDeMarketplace(page: Page) {
  return page.locator("details.sb-menu").filter({ has: page.locator('summary[aria-label^="Marketplace:"]') });
}

/**
 * A TROCA DE MARKETPLACE (D-431): o seletor no começo da barra leva de uma tela
 * de vendas à outra levando SÓ o que vale nos dois lados — o período. Conta,
 * marca e métrica são do Mercado Livre e ficam para trás; a volta não traz a
 * loja nem a situação da Shopee. É a regra de compatibilidade do recorte
 * (`docs/MULTICHANNEL_SCREENS.md` §4), provada pela URL.
 */
test("/vendas: o seletor de marketplace leva às vendas da Shopee só com o período, e volta", async ({ page }) => {
  await login(page, "/vendas?days=7&account=e2e-loja&semMarca=1&metric=unidades");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  const seletor = seletorDeMarketplace(page);

  await expect(seletor.locator("summary")).toHaveAttribute("aria-label", "Marketplace: Mercado Livre");
  await seletor.locator("summary").click();
  await seletor.getByRole("link", { name: "Shopee", exact: true }).click();

  // D-440: "Shopee" é o resumo em `/vendas`, com o mesmo período; os pedidos
  // e as lojas da Shopee estão a um clique, no detalhe.
  await expect(page).toHaveURL(/\/vendas\?marketplace=shopee&days=7$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();
  await expect(seletor.locator("summary")).toHaveAttribute("aria-label", "Marketplace: Shopee");

  await page.getByRole("link", { name: "Pedidos e lojas da Shopee →" }).click();

  await expect(page).toHaveURL(/\/vendas\/shopee\?days=7$/);
  await expect(page.getByRole("heading", { level: 1, name: "Vendas da Shopee" })).toBeVisible();
  await expect(seletor.locator("summary")).toHaveAttribute("aria-label", "Marketplace: Shopee");
  await esperaPedidos(page, ESPERADO.naLista);

  // Um recorte da Shopee antes de voltar: ele não pode atravessar.
  await page.goto("/vendas/shopee?days=7&situacao=validas");
  await seletor.locator("summary").click();
  await seletor.getByRole("link", { name: "Mercado Livre", exact: true }).click();

  await expect(page).toHaveURL(/\/vendas\?marketplace=ml&days=7$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();
});

/**
 * O PERÍODO PERSONALIZADO em `/vendas/shopee` (D-431): a URL já aceitava
 * `from`/`to`, faltava o formulário. Aplicar as datas não pode descartar a
 * situação — um GET nativo envia só os campos do formulário, e é o hidden que
 * a mantém (o mesmo defeito que `/vendas` já teve com a métrica).
 */
test("/vendas/shopee: o período personalizado aplica as datas e mantém a situação", async ({ page }) => {
  await login(page, "/vendas/shopee?situacao=validas");

  await esperaPedidos(page, ESPERADO.validasNaLista);

  // Os pedidos do seed têm até 6 dias: uma janela de 10 dias, no calendário de
  // São Paulo, os alcança todos — as mesmas funções de data do seed.
  const hoje = toSalesMetricDate(new Date());
  const de = shiftBusinessDate(hoje, -10);

  const periodo = page.locator("details", { hasText: "Últimos 30 dias" });

  await periodo.locator("summary").click();
  await periodo.getByLabel("Data inicial").fill(de);
  await periodo.getByLabel("Data final").fill(hoje);
  await periodo.getByRole("button", { name: "Aplicar período" }).click();

  await expect(page).toHaveURL(new RegExp(`from=${de}`));
  await expect(page).toHaveURL(new RegExp(`to=${hoje}`));
  await expect(page).toHaveURL(/situacao=validas/);
  await expect(page.locator("details", { hasText: "Período personalizado" }).locator("summary")).toBeVisible();
  await esperaPedidos(page, ESPERADO.validasNaLista);
});

/**
 * T-R5: no celular a tabela "Por loja" vira cartão, e as notas são frases
 * ("a leitura é de hora em hora", "3 aguardando o financeiro"). Em linha e sem
 * quebra, elas invadiam a célula vizinha -- medido em 390 px: 134 a 222 px
 * além da própria célula. Este caso mede, em vez de olhar: nenhuma nota pode
 * passar da borda da célula dela.
 */
test("/vendas/shopee no celular: as notas do cartão por loja ficam dentro da própria célula", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, "/vendas/shopee");

  const tabela = page.getByRole("table", { name: "Vendas da Shopee por loja" });

  await expect(tabela).toBeVisible();
  // O seed sempre tem a nota da última leitura: o teste não passa vazio.
  await expect(tabela.locator("td .sb-an-sub").first()).toBeVisible();

  const transbordos = await tabela.locator("td .sb-an-sub").evaluateAll((notas) =>
    notas.map((nota) => {
      const celula = nota.closest("td");
      const a = nota.getBoundingClientRect();
      const b = celula?.getBoundingClientRect();

      return b === undefined ? 0 : Math.round(a.right - b.right);
    }),
  );

  expect(transbordos.every((px) => px <= 0)).toBe(true);
});

/**
 * D-460 (contrato C-62): as devoluções da Shopee em `/vendas/shopee`, logo
 * depois do "Por loja" — decisão do dono de 15/10. O seed só tem a loja de
 * TESTE, com as devoluções nunca lidas: sem total de zeros, a loja com "—" e o
 * motivo, e a ressalva de que a situação vem como a Shopee manda e o valor é o
 * "reembolso informado", nunca o "reembolsado".
 */
test("/vendas/shopee: as devoluções dizem o que não se sabe e não chamam o valor de reembolsado", async ({ page }) => {
  await login(page, "/vendas/shopee");

  const devolucoes = page.getByRole("region", { name: "Devoluções da Shopee" });

  await expect(devolucoes.getByText("Devoluções", { exact: true })).toBeVisible();
  await expect(devolucoes.getByRole("note").filter({ hasText: "como a Shopee manda" })).toBeVisible();
  await expect(devolucoes.getByText(/Nenhuma loja real com as devoluções já lidas/)).toBeVisible();
  await expect(devolucoes.getByText(/reembolsado/)).toHaveCount(1);

  const loja = devolucoes.getByRole("list", { name: "Devoluções por loja" }).getByRole("listitem");

  await expect(loja).toHaveCount(1);
  await expect(loja).toContainText(`${E2E_SHOPEE_SHOP.name} (teste)`);
  await expect(loja).toContainText("—");
  await expect(loja).toContainText("devoluções ainda não lidas · loja de teste, fora do total");

  // O painel fica entre o "Por loja" e os pedidos.
  const titulos = await page.getByRole("heading", { level: 2 }).allInnerTexts();
  const porLoja = titulos.findIndex((t) => t.trim() === "Por loja");
  const dev = titulos.findIndex((t) => t.trim() === "Devoluções");
  const pedidos = titulos.findIndex((t) => t.trim() === "Pedidos");

  expect(porLoja).toBeGreaterThanOrEqual(0);
  expect(dev).toBeGreaterThan(porLoja);
  expect(pedidos).toBeGreaterThan(dev);
});

/**
 * D-476 (C-57): o pedido que a Busca Universal abre. A URL leva `?pedido=`, a
 * lista mostra só ele (o número casa sem diferenciar maiúscula), o filtro
 * aparece como chip e "Limpar filtros" devolve a lista inteira.
 */
test("/vendas/shopee?pedido=: só o pedido que a busca abriu, com o filtro à vista e o caminho de volta", async ({ page }) => {
  const cancelado = E2E_SHOPEE_PEDIDOS.cancelado.orderSn;

  await login(page, `/vendas/shopee?pedido=${cancelado.toLowerCase()}`);

  await esperaPedidos(page, 1);
  await expect(linhaDoPedido(page, cancelado)).toBeVisible();
  await expect(page.getByRole("link", { name: `Tirar o filtro Pedido ${cancelado.toLowerCase()}` })).toBeVisible();

  await page.getByRole("link", { name: "Limpar filtros" }).first().click();
  await expect(page).not.toHaveURL(/pedido=/);
  await esperaPedidos(page, ESPERADO.naLista);
});

test("/vendas/shopee?pedido=: o número que não está no recorte diz isso, e não 'nenhum pedido'", async ({ page }) => {
  await login(page, "/vendas/shopee?pedido=NAO-EXISTE-123");

  await expect(page.getByText("O pedido NAO-EXISTE-123 não está neste recorte.")).toBeVisible();
  await expect(page.getByText("Nenhum pedido da Shopee no período.")).toHaveCount(0);
});

/**
 * D-490: o CSV dos pedidos sai com o recorte da lista — o mesmo número de
 * pedidos da tela (uma linha por pedido), as palavras dela e a loja de teste
 * marcada. Sem dado do comprador: a RPC não o devolve.
 */
test("/vendas/shopee: o CSV dos pedidos sai com o recorte da lista (D-490)", async ({ page }) => {
  await login(page, "/vendas/shopee");
  await expect(tabelaPedidos(page)).toBeVisible();

  const naTela = await tabelaPedidos(page).locator("tbody > tr").count();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    painelPedidos(page).getByRole("link", { name: /Exportar CSV/ }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^pedidos-shopee-\d{4}-\d{2}-\d{2}-a-\d{4}-\d{2}-\d{2}\.csv$/);

  const { readFileSync } = await import("node:fs");
  const linhas = readFileSync(await download.path(), "utf-8").replace(/^\uFEFF/u, "").trim().split("\r\n");

  expect(linhas[0]).toBe(
    "Pedido;Loja;Ambiente;Criado em;Situação;Status na Shopee;Unidades;Receita bruta;Recebido;Financeiro lido;Devolução;Itens",
  );
  expect(linhas).toHaveLength(1 + naTela);

  const comFinanceiro = linhas.find((linha) => linha.startsWith(`${E2E_SHOPEE_PEDIDOS.comFinanceiro.orderSn};`));

  expect(comFinanceiro).toContain(";Teste;");
  expect(comFinanceiro).toContain(";Sim;");
});
