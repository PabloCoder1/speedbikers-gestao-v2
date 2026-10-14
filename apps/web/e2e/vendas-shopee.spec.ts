import { type Page, expect, test } from "@playwright/test";

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

test("/vendas: o link do cabeçalho leva às vendas da Shopee levando o período, e volta", async ({ page }) => {
  await login(page, "/vendas?days=7");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();

  await page.getByRole("link", { name: "Vendas da Shopee", exact: true }).click();

  await expect(page).toHaveURL(/\/vendas\/shopee\?days=7$/);
  await expect(page.getByRole("heading", { level: 1, name: "Vendas da Shopee" })).toBeVisible();
  await esperaPedidos(page, ESPERADO.naLista);

  await page.getByRole("link", { name: "Dashboard de vendas", exact: true }).click();

  await expect(page).toHaveURL(/\/vendas\?days=7$/);
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de vendas" })).toBeVisible();
});
