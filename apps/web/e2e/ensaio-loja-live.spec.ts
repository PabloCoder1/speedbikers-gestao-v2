import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers.js";
import { apagarLojaLive, clienteDeServico, criarLojaLive, LOJA_LIVE, type ClienteDeServico } from "./loja-shopee-live.js";

/**
 * O ENSAIO DO GO LIVE DAS TELAS (D-486, T9).
 *
 * O seed tem só a loja Shopee de TESTE, e as telas a deixam fora de propósito.
 * Por isso nenhum outro spec renderiza o caminho "com Shopee" — o que vale desde
 * o Go Live de 16/10, com duas lojas live em produção. Aqui a loja live existe
 * de verdade no banco do e2e (`loja-shopee-live.ts`), e cada tela da frente
 * multicanal é conferida contra números feitos para fechar de cabeça: 11
 * pedidos válidos, R$ 1.100 de receita, 10 cobertos com R$ 800 de recebido e
 * R$ 200 de custo (resultado R$ 600), 1 devolução, 5 repasses e 7 dias de Ads.
 *
 * Roda no projeto `loja-live`, DEPOIS de todos os outros specs: o SKU próprio
 * da loja fica no banco (o histórico de custo é só de inserção), e assim não
 * mexe nas contagens de mais ninguém. A loja sai no fim, com tudo o que é dela.
 */

const dinheiro = (valor: string): RegExp => new RegExp(`R\\$\\s${valor.replaceAll(".", "\\.")}`);
const SEM_ERRO = /Não foi possível|formato que esta tela não reconhece/u;

let db: ClienteDeServico;
let skuId = "";

test.beforeAll(async () => {
  db = clienteDeServico();
  ({ skuId } = await criarLojaLive(db));
});

test.afterAll(async () => {
  await apagarLojaLive(db);
});

async function entrar(page: Page, rota: string): Promise<void> {
  await login(page, rota);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"));
}

async function semErro(page: Page): Promise<void> {
  await expect(page.locator(".sb-content").getByText(SEM_ERRO)).toHaveCount(0);
}

/** "R$ 1.600,00" → 1600. */
function reais(texto: string): number {
  return Number(texto.replace(/[^\d,]/gu, "").replace(",", "."));
}

test("/vendas: no 'Todos', a loja live soma na faixa e tem a sua linha; no recorte Shopee, o pedido aguardando o financeiro e a devolução", async ({
  page,
}) => {
  await entrar(page, "/vendas?marketplace=todos");

  const tabela = page.getByRole("table").filter({ hasText: "MARKETPLACE / CONTA" });
  const loja = tabela.getByRole("row", { name: new RegExp(LOJA_LIVE.nome) });

  await expect(loja).toContainText(dinheiro("1.100,00"));
  await expect(loja).toContainText(dinheiro("800,00"));
  await expect(loja).toContainText("1 aguardando o financeiro");

  // A faixa "Todos" é a soma: o Mercado Livre da tabela + a Shopee.
  const linhaMl = tabela.getByRole("row").filter({ has: page.getByRole("cell", { name: "Mercado Livre", exact: true }) });
  const receitaMl = reais((await linhaMl.getByRole("cell").nth(1).innerText()).trim());
  const faixa = page.locator(".sb-kpi").filter({ has: page.locator(".sb-kpi-label", { hasText: /^Receita bruta$/u }) }).first();

  expect(reais((await faixa.locator(".sb-kpi-value").innerText()).trim())).toBeCloseTo(receitaMl + LOJA_LIVE.receitaValida, 2);
  await semErro(page);

  await page.goto("/vendas/shopee");
  const porLoja = page.getByRole("row", { name: new RegExp(LOJA_LIVE.nome) }).first();

  await expect(porLoja).toContainText(String(LOJA_LIVE.pedidosValidos));
  await expect(porLoja).toContainText(dinheiro("1.100,00"));
  await expect(page.getByText(new RegExp(`${LOJA_LIVE.nome} · .* motivo NOT_RECEIPT`, "u"))).toBeVisible();
  await semErro(page);
});

test("/faturamento: o recorte Shopee fecha o resultado, o repasse e os Ads; o 'Todos' tem a coluna da Shopee e nenhum total de resultado", async ({
  page,
}) => {
  await entrar(page, "/faturamento?marketplace=shopee");

  await expect(page.getByText(`${String(LOJA_LIVE.pedidosValidos)} un · resultado R$`)).toBeVisible();
  await expect(page.getByText(/5 pedidos liberados/u)).toBeVisible();

  const ads = page.getByRole("region", { name: "Ads CPC da loja Shopee" });

  await expect(ads.getByText(dinheiro("70,00")).first()).toBeVisible();
  await expect(ads.getByText("20,00x").first()).toBeVisible();
  await semErro(page);

  await page.goto("/faturamento?marketplace=todos");
  const lado = page.getByRole("table", { name: "Faturamento por marketplace, lado a lado" });

  await expect(lado.getByRole("row", { name: /^Receita bruta/u })).toContainText(dinheiro("1.100,00"));
  await expect(lado.getByRole("row", { name: /^Recebido/u })).toContainText(dinheiro("800,00"));
  await expect(lado.getByRole("row", { name: /^Resultado da venda/u })).toContainText(dinheiro("600,00"));
  await expect(lado.getByRole("row", { name: /^Cobertura/u })).toContainText("90,9%");
  await expect(page.getByText(/nenhuma loja real com pedidos lidos/u)).toHaveCount(0);
  await semErro(page);
});

test("/central: a Shopee entra no lado a lado e na meta de cada marketplace (D-480, D-482)", async ({ page }) => {
  await entrar(page, "/central");

  const porMarketplace = page.getByRole("region", { name: "Por marketplace" });

  await expect(porMarketplace.getByRole("row", { name: /^Receita bruta/u })).toContainText(dinheiro("1.100,00"));

  const cadaMarketplace = page.getByRole("region", { name: "Meta de cada marketplace" });

  await expect(cadaMarketplace.getByText(/Realizado até agora: R\$\s1\.100,00/u)).toBeVisible();
  await expect(cadaMarketplace.getByText("A Shopee ainda não entra na meta")).toHaveCount(0);
  // Só o realizado soma entre escopos; cada projeção usa a janela do próprio histórico (D-473, D-486).
  await expect(cadaMarketplace.getByText(/as projeções não somam/u)).toBeVisible();
  await semErro(page);
});

test("/produtos, /curva-abc e /reposicao: o SKU que só vende na Shopee aparece, e a demanda da Shopee entra na cobertura", async ({
  page,
}) => {
  await entrar(page, "/produtos?vendas=so-shopee");
  await expect(page.getByText("1 produto", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(LOJA_LIVE.skuTitulo) }).first()).toBeVisible();
  await semErro(page);

  await page.goto("/curva-abc?marketplace=shopee");
  const linha = page.locator(".sb-abc-table-wrap table").getByRole("row", { name: new RegExp(LOJA_LIVE.sku) });

  await expect(linha).toContainText(dinheiro("1.100,00"));
  await semErro(page);

  await page.goto("/reposicao");
  await expect(page.getByText(/Shopee na demanda/u)).toBeVisible();
  await expect(page.getByText(`${String(LOJA_LIVE.pedidosValidos)} un da Shopee em 30 d`)).toBeVisible();
  await semErro(page);
});

test("o SKU, a busca e a sincronização enxergam a loja live", async ({ page }) => {
  await entrar(page, `/skus/${skuId}?aba=vendas`);
  await expect(page.getByRole("row", { name: new RegExp(LOJA_LIVE.nome) })).toContainText(dinheiro("1.100,00"));
  await semErro(page);

  // O pedido de loja live é achado pela busca e abre na /vendas/shopee (D-476).
  await page.getByRole("button", { name: /Buscar SKU, anúncio, NF-e/u }).click();
  const caixa = page.getByRole("dialog", { name: "Buscar na Speed Bikers" });

  await caixa.getByRole("combobox", { name: "Buscar" }).fill("E2ELIVE01");
  const pedido = caixa.getByRole("group", { name: "Pedido Shopee" }).getByRole("option", { name: /E2ELIVE01/u });

  await expect(pedido).toBeVisible();
  await pedido.click();
  await expect(page).toHaveURL(/\/vendas\/shopee\?.*pedido=E2ELIVE01/u);

  await page.goto("/sincronizacao");
  await expect(page.getByText(LOJA_LIVE.nome).first()).toBeVisible();
  await expect(page.getByText("PEDIDOS EM DIA").first()).toBeVisible();
  await semErro(page);
});
