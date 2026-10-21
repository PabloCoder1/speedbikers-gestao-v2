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
 * R$ 200 de custo e R$ 10 de ajuste depois do repasse (resultado R$ 590), 1
 * devolução, 5 repasses e 7 dias de Ads.
 *
 * Roda no projeto `loja-live`, DEPOIS de todos os outros specs: o SKU próprio
 * da loja fica no banco (o histórico de custo é só de inserção), e assim não
 * mexe nas contagens de mais ninguém. A loja sai no fim, com tudo o que é dela.
 */

const dinheiro = (valor: string): RegExp => new RegExp(`R\\$\\s${valor.replaceAll(".", "\\.")}`);
const SEM_ERRO = /Não foi possível|formato que esta tela não reconhece/u;

let db: ClienteDeServico;
let skuId = "";
let lojaId = "";

test.beforeAll(async () => {
  db = clienteDeServico();
  ({ skuId, lojaId } = await criarLojaLive(db));
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

/** "1.234" → 1234 (a contagem com o separador de milhar). */
function inteiro(texto: string): number {
  return Number(texto.replace(/\D/gu, ""));
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

  const receitaTodos = reais((await faixa.locator(".sb-kpi-value").innerText()).trim());

  expect(receitaTodos).toBeCloseTo(receitaMl + LOJA_LIVE.receitaValida, 2);
  await semErro(page);

  // A Home (D-488) mostra a MESMA receita do "Todos" — as mesmas células e o mesmo contrato.
  await page.goto("/");
  const naHome = page.locator(".sb-kpi").filter({ has: page.getByText("multicanal_receita_bruta", { exact: true }) }).first();

  expect(reais((await naHome.locator(".sb-kpi-value").innerText()).trim())).toBeCloseTo(receitaTodos, 2);
  await semErro(page);

  await page.goto("/vendas/shopee");
  const porLoja = page.getByRole("row", { name: new RegExp(LOJA_LIVE.nome) }).first();

  await expect(porLoja).toContainText(String(LOJA_LIVE.pedidosValidos));
  await expect(porLoja).toContainText(dinheiro("1.100,00"));
  await expect(page.getByText(new RegExp(`${LOJA_LIVE.nome} · .* motivo NOT_RECEIPT`, "u"))).toBeVisible();
  await semErro(page);
});

test("/vendas: no 'Todos', o cancelamento por compra tem a Shopee, e o hoje soma a venda dela do dia e diz até quando a leu (D-620, C-70)", async ({
  page,
}) => {
  await entrar(page, "/vendas?marketplace=todos");

  // 1 cancelado em 12 compras da loja live: 8,3%, ao lado da taxa do Mercado Livre.
  await expect(page.locator(".sb-kpi[aria-busy='true']")).toHaveCount(0);
  const celula = page.locator(".sb-kpi").filter({ has: page.locator(".sb-kpi-id", { hasText: /^multicanal_taxa_cancelamento$/u }) });

  await expect(celula).toContainText(/Mercado Livre \d{1,3},\d% · Shopee 8,3%\./u);

  const hoje = page.locator(".sb-hoje-numeros");
  const doHoje = async (rotulo: string): Promise<string> =>
    (await hoje.locator("> span").filter({ hasText: new RegExp(`\\s${rotulo}`, "u") }).locator("strong").innerText()).trim();

  await expect(page.locator(".sb-hoje[aria-busy='true']")).toHaveCount(0);
  // Os 11 válidos são de 1 a 10 dias atrás: nenhum deles é de hoje. A loja é lida, e a linha diz até quando.
  await expect(hoje).toContainText(/Shopee lida até \d{2}\/\d{2}/u);
  const antes = { receita: reais(await doHoje("receita")), compras: inteiro(await doHoje("compras")) };

  // Uma venda paga AGORA, ainda sem financeiro: a receita é a dos itens (R$ 100).
  const { data: org } = await db.from("shopee_shops").select("organization_id").eq("id", lojaId).single();
  const organizationId = org?.organization_id ?? "";
  const agora = new Date().toISOString();

  try {
    const pedido = await db.from("shopee_orders").insert({
      shopee_shop_id: lojaId,
      organization_id: organizationId,
      order_sn: "E2ELIVE-HOJE",
      order_status: "READY_TO_SHIP",
      currency: "BRL",
      total_amount: LOJA_LIVE.receitaPorPedido,
      shopee_created_at: agora,
      shopee_updated_at: agora,
      paid_at: agora,
    });

    expect(pedido.error).toBeNull();

    const item = await db.from("shopee_order_items").insert({
      shopee_shop_id: lojaId,
      order_sn: "E2ELIVE-HOJE",
      position: 0,
      organization_id: organizationId,
      item_id: 990777001,
      item_name: LOJA_LIVE.skuTitulo,
      item_sku: LOJA_LIVE.sku,
      quantity: 1,
      original_price: 120,
      discounted_price: LOJA_LIVE.receitaPorPedido,
      sku_id: skuId,
      vinculo_via: "SKU_DO_PEDIDO",
    });

    expect(item.error).toBeNull();

    await page.reload();
    await expect(page.locator(".sb-hoje[aria-busy='true']")).toHaveCount(0);

    // O hoje do "Todos" ganha exatamente a venda da Shopee: somada no SQL, não aqui.
    expect(reais(await doHoje("receita"))).toBeCloseTo(antes.receita + LOJA_LIVE.receitaPorPedido, 2);
    expect(inteiro(await doHoje("compras"))).toBe(antes.compras + 1);
    await semErro(page);
  } finally {
    await db.from("shopee_order_items").delete().eq("shopee_shop_id", lojaId).eq("order_sn", "E2ELIVE-HOJE");
    await db.from("shopee_orders").delete().eq("shopee_shop_id", lojaId).eq("order_sn", "E2ELIVE-HOJE");
  }
});

test("/vendas: no 'Todos', a marca do produto da loja live recorta a Shopee pelo item, e a compra não se aplica (D-622, C-72)", async ({
  page,
}) => {
  // Uma marca só deste produto, durante o teste: nenhuma venda do ML a tem, então
  // o "Todos" com ela é exatamente a Shopee da loja live — 11 unidades e R$ 1.100.
  const MARCA = "E2E Marca Loja Live";
  const marcou = await db
    .from("skus")
    .update({ supplier_brand: MARCA, supplier_brand_source: "DERIVED" })
    .eq("id", skuId);

  expect(marcou.error).toBeNull();

  try {
    await entrar(page, "/vendas?marketplace=todos");
    await page.locator('summary[aria-label^="Marca:"]').click();
    await page.getByRole("link", { name: MARCA, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`marca=${encodeURIComponent(MARCA).replaceAll("%20", "\\+")}`, "u"));

    const faixa = (metricId: string) =>
      page.locator(".sb-kpi").filter({ has: page.locator(".sb-kpi-id", { hasText: new RegExp(`^${metricId}$`, "u") }) });

    await expect(faixa("multicanal_receita_bruta").locator(".sb-kpi-value")).toHaveText(dinheiro("1.100,00"));
    await expect(faixa("multicanal_unidades").locator(".sb-kpi-value")).toHaveText(String(LOJA_LIVE.pedidosValidos));
    await expect(faixa("multicanal_compras").locator(".sb-kpi-value")).toHaveText("—");
    await expect(faixa("multicanal_taxa_cancelamento")).toContainText("não se aplica sob recorte de marca");

    // A linha da loja na tabela tem a receita da marca; compras e recebido não se aplicam.
    const loja = page.getByRole("table", { name: "Vendas por marketplace e conta" }).getByRole("row", { name: new RegExp(LOJA_LIVE.nome) });

    await expect(loja.getByRole("cell").nth(1)).toContainText(dinheiro("1.100,00"));
    await expect(loja.getByRole("cell").nth(2)).toHaveText("—");

    // D-624 (C-75): o ranking recorta pela marca — só o produto da loja live, com os R$ 1.100.
    const ranking = page.getByRole("table", { name: "Produtos que mais venderam" });

    await expect(ranking.locator("tbody tr")).toHaveCount(1);
    await expect(ranking.locator("tbody tr")).toContainText(LOJA_LIVE.skuTitulo);
    await expect(ranking.locator("tbody tr")).toContainText(dinheiro("1.100,00"));
    await semErro(page);
  } finally {
    await db.from("skus").update({ supplier_brand: null, supplier_brand_source: null }).eq("id", skuId);
  }
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

  // D-492: a proteção de envio é degrau próprio (R$ 1 em cada um dos 10 cobertos),
  // e o "outros" que sobra é zero -- fora das barras, dito à parte.
  const dinheiroVai = page.getByRole("region", { name: "Para onde vai o dinheiro" });

  await expect(dinheiroVai.getByRole("listitem").filter({ hasText: "Proteção de envio" })).toContainText(dinheiro("10,00"));
  await expect(dinheiroVai.getByText(/Sem valor no período: Outros \(fecha com o recebido\)\./u)).toBeVisible();

  // D-485/D-498: o ajuste cobrado depois do repasse é degrau entre o recebido e o custo, e o resultado o inclui.
  await expect(dinheiroVai.getByRole("listitem").filter({ hasText: "Ajustes depois do repasse" })).toContainText(dinheiro("10,00"));
  await expect(page.getByText(/os ajustes que ela cobra depois do repasse − o custo/u)).toBeVisible();
  // D-487/D-498: a linha do lucro após imposto e Ads existe; o valor depende da alíquota que outro spec cadastra.
  await expect(dinheiroVai.getByText("Lucro após imposto e Ads", { exact: true })).toBeVisible();
  await semErro(page);

  await page.goto("/faturamento?marketplace=todos");
  const lado = page.getByRole("table", { name: "Faturamento por marketplace, lado a lado" });

  await expect(lado.getByRole("row", { name: /^Receita bruta/u })).toContainText(dinheiro("1.100,00"));
  await expect(lado.getByRole("row", { name: /^Recebido/u })).toContainText(dinheiro("800,00"));
  await expect(lado.getByRole("row", { name: /^Resultado da venda/u })).toContainText(dinheiro("590,00"));
  await expect(lado.getByRole("row", { name: /^Resultado da venda/u })).toContainText("recebido + ajustes depois do repasse − custo");
  await expect(lado.getByRole("row", { name: /^Lucro após imposto e Ads/u })).toContainText("Ads CPC da loja");
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

test("/anuncios/shopee, /produtos, /curva-abc e /reposicao: o anúncio e o SKU da loja live aparecem, e a demanda da Shopee entra na cobertura", async ({
  page,
}) => {
  await entrar(page, "/anuncios/shopee");
  const anuncio = page.getByRole("row", { name: new RegExp(LOJA_LIVE.skuTitulo) });

  await expect(anuncio).toContainText(LOJA_LIVE.nome);
  await expect(anuncio).toContainText("pelo SKU do anúncio");
  await semErro(page);

  // O SKU só tem anúncio e venda na Shopee: os dois filtros de C-56 o acham.
  for (const filtro of ["anuncios=so-shopee", "vendas=so-shopee"]) {
    await page.goto(`/produtos?${filtro}`);
    await expect(page.getByText("1 produto", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(LOJA_LIVE.skuTitulo) }).first()).toBeVisible();
    await semErro(page);
  }

  await page.goto("/curva-abc?marketplace=shopee");
  const linha = page.locator(".sb-abc-table-wrap table").getByRole("row", { name: new RegExp(LOJA_LIVE.sku) });

  await expect(linha).toContainText(dinheiro("1.100,00"));
  await semErro(page);

  await page.goto("/reposicao");
  await expect(page.getByText(/Shopee na demanda/u)).toBeVisible();
  await expect(page.getByText(`${String(LOJA_LIVE.pedidosValidos)} un da Shopee em 30 d`)).toBeVisible();
  await semErro(page);
});

test("/anuncios/shopee: as vendas do anúncio no período, o vendeu, a ordem e o CSV (D-606, C-67)", async ({ page }) => {
  await entrar(page, `/anuncios/shopee?loja=${lojaId}`);
  const anuncio = page.getByRole("row", { name: new RegExp(LOJA_LIVE.skuTitulo) });

  // 11 pedidos válidos de 1 unidade e R$ 100 cada (o cancelado fica fora; o sem financeiro entra: VALIDA não pede financeiro).
  const n = String(LOJA_LIVE.pedidosValidos);

  await expect(anuncio.locator('td[data-label="Unidades"]')).toHaveText(new RegExp(`^${n}\\s*em ${n} pedidos$`, "u"));
  await expect(anuncio.locator('td[data-label="Faturamento"]')).toContainText(dinheiro("1.100,00"));

  // O resumo do recorte, somado no SQL: aqui o recorte é este anúncio só.
  const resumo = page.getByLabel("Resumo das vendas do recorte");

  await expect(resumo).toContainText(dinheiro("1.100,00"));
  await expect(resumo.getByText(n, { exact: true })).toBeVisible();
  await semErro(page);

  // O cabeçalho ordena do maior para o menor, e clicar de novo volta à ordem de sempre.
  const unidades = page.getByRole("columnheader", { name: "Unidades" });

  await unidades.getByRole("link").click();
  await expect(page).toHaveURL(/[?&]ordem=vendas/u);
  await expect(unidades).toHaveAttribute("aria-sort", "descending");
  await expect(anuncio).toBeVisible();
  await unidades.getByRole("link").click();
  await expect(page).not.toHaveURL(/ordem=/u);
  await expect(unidades).toHaveAttribute("aria-sort", "none");

  // O vendeu filtra no banco: o anúncio que vendeu some do "sem venda" e fica no "vendeu".
  await page.goto(`/anuncios/shopee?loja=${lojaId}&vendeu=sem`);
  await expect(page.getByText("Nenhum anúncio corresponde a estes filtros.")).toBeVisible();
  await expect(anuncio).toHaveCount(0);
  await page.goto(`/anuncios/shopee?loja=${lojaId}&vendeu=com`);
  await expect(anuncio).toBeVisible();
  await semErro(page);

  // Um período sem pedido: com a loja lida, não vender é 0, que é fato -- não "—".
  await page.goto(`/anuncios/shopee?loja=${lojaId}&from=2020-01-01&to=2020-01-31`);
  await expect(anuncio.locator('td[data-label="Unidades"]')).toHaveText("0");
  await expect(anuncio.locator('td[data-label="Faturamento"]')).toContainText(dinheiro("0,00"));
  await semErro(page);

  // O CSV leva o mesmo período: as quatro colunas de venda no fim da linha do anúncio.
  await page.goto(`/anuncios/shopee?loja=${lojaId}`);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("region", { name: "Anúncios e vínculos" }).getByRole("link", { name: /Exportar CSV/u }).click(),
  ]);
  const { readFileSync } = await import("node:fs");
  const linhas = readFileSync(await download.path(), "utf-8").replace(/^\uFEFF/u, "").trim().split("\r\n");

  expect(linhas[0]?.endsWith(";Unidades vendidas;Faturamento;Pedidos;Unidades sem receita conhecida")).toBe(true);
  expect(linhas.find((linha) => linha.startsWith("990777001;"))?.endsWith(`;${n};1100;${n};0`)).toBe(true);
});

test("/estoque/movimentacoes: a venda da Shopee tem rótulo e origem próprios, e o pedido abre a /vendas/shopee no dia dele (D-614, C-68)", async ({
  page,
}) => {
  const loja = await db.from("shopee_shops").select("organization_id").eq("id", lojaId).single();

  expect(loja.error).toBeNull();

  // Como o worker grava a baixa da D-495 (b): `VENDA_SHOPEE`, origem `SHOPEE_ORDER` com o
  // `order_sn`. O ledger é só de inserção: o movimento fica, como o SKU da loja (ver o topo).
  const movimento = await db.from("stock_movements").insert({
    organization_id: loja.data?.organization_id ?? "",
    sku_id: skuId,
    movement_type: "VENDA_SHOPEE",
    location_kind: "LOCAL",
    qty_delta: -1,
    occurred_at: new Date().toISOString(),
    source_type: "SHOPEE_ORDER",
    source_id: "E2ELIVE01",
    idempotency_key: `e2e-d614-${lojaId}`,
  });

  expect(movimento.error).toBeNull();

  await entrar(page, "/estoque/movimentacoes?origem=SHOPEE_ORDER");
  const linha = page.getByRole("row", { name: /E2ELIVE01/u });

  // O tipo e a origem nas palavras da tela, nunca o código cru nem "Pedido ML".
  await expect(linha).toContainText("Venda Shopee");
  await expect(linha).toContainText("Pedido Shopee");
  await expect(linha).not.toContainText("Pedido ML");
  await expect(linha).not.toContainText("VENDA_SHOPEE");

  // O link leva à loja e ao DIA da criação do pedido (o `shopee_order_day` do C-68): a
  // /vendas/shopee só acha o pedido dentro do período — e acha.
  const pedido = linha.getByRole("link", { name: "Abrir pedido E2ELIVE01" });

  await expect(pedido).toHaveAttribute(
    "href",
    new RegExp(`^/vendas/shopee\\?loja=${lojaId}&from=(\\d{4}-\\d{2}-\\d{2})&to=\\1&pedido=E2ELIVE01$`, "u"),
  );
  await pedido.click();
  await expect(page).toHaveURL(/\/vendas\/shopee\?.*pedido=E2ELIVE01/u);
  await expect(page.getByRole("row", { name: /E2ELIVE01/u }).first()).toBeVisible();
  await semErro(page);
});

test("o SKU, a busca e a sincronização enxergam a loja live", async ({ page }) => {
  await entrar(page, `/skus/${skuId}?aba=vendas`);
  // Na tabela entre marketplaces: desde a D-618, a lista de pedidos da Shopee também tem o nome da loja.
  await expect(
    page
      .getByRole("table", { name: "Vendas do produto por marketplace, conta e loja" })
      .getByRole("row", { name: new RegExp(LOJA_LIVE.nome) }),
  ).toContainText(dinheiro("1.100,00"));
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

test("/skus/[id]?aba=vendas: o dia a dia por canal e os pedidos da Shopee com o produto da loja live (D-618, C-71)", async ({
  page,
}) => {
  await entrar(page, `/skus/${skuId}?aba=vendas`);
  await expect(page.locator(".sb-carregando-bloco")).toHaveCount(0);

  // 11 vendas válidas em 10 dias (o 2º dia tem duas): 10 linhas, a Shopee em
  // cada uma e nenhum Mercado Livre — o produto só vende na loja live.
  const porCanal = page.getByRole("table", { name: "Vendas do produto por dia e por canal" }).locator("tbody tr");

  await expect(porCanal).toHaveCount(10);
  const doisNoDia = porCanal.filter({ hasText: dinheiro("200,00") });

  await expect(doisNoDia).toHaveCount(1);
  await expect(doisNoDia.getByRole("cell").nth(1)).toHaveText("—");
  await expect(doisNoDia.getByRole("cell").nth(2)).toContainText("2 un");

  // Os 12 pedidos com o produto (o cancelado inclusive), 1 unidade e R$ 100 cada.
  const pedidos = page.getByRole("table", { name: "Pedidos da Shopee com este produto" });

  await expect(pedidos.locator("tbody tr")).toHaveCount(12);
  await expect(pedidos.getByRole("row").filter({ hasText: "E2ELIVE-CANCEL" })).toContainText("Cancelada");
  // Pelo número exato: o texto da linha emenda o número com o "Abrir pedido".
  const primeiro = pedidos.getByRole("row").filter({ has: page.getByText("E2ELIVE01", { exact: true }) });

  await expect(primeiro.getByRole("cell").nth(4)).toHaveText("1");
  await expect(primeiro.getByRole("cell").nth(5)).toHaveText(dinheiro("100,00"));
  await expect(primeiro).not.toContainText("Teste");
  await semErro(page);

  await primeiro.getByRole("link", { name: "Abrir pedido" }).click();
  await expect(page).toHaveURL(new RegExp(`/vendas/shopee\\?loja=${lojaId}&from=(\\d{4}-\\d{2}-\\d{2})&to=\\1&pedido=E2ELIVE01$`, "u"));
  await expect(page.getByRole("row").filter({ hasText: "E2ELIVE01" }).first()).toBeVisible();
});

test("o CSV dos pedidos da loja live tem os 12 pedidos do período, com a situação de cada um (D-490)", async ({ page }) => {
  await entrar(page, `/vendas/shopee?loja=${lojaId}`);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("region", { name: "Pedidos", exact: true }).getByRole("link", { name: /Exportar CSV/ }).click(),
  ]);
  const { readFileSync } = await import("node:fs");
  const linhas = readFileSync(await download.path(), "utf-8").replace(/^\uFEFF/u, "").trim().split("\r\n");

  // 10 cobertos, 1 aguardando o financeiro e 1 cancelado — todos da loja real.
  expect(linhas).toHaveLength(1 + 12);
  expect(linhas.slice(1).every((linha) => linha.includes(`;${LOJA_LIVE.nome};Real;`))).toBe(true);
  expect(linhas.find((linha) => linha.startsWith("E2ELIVE-CANCEL;"))).toContain(";Cancelada;");
  expect(linhas.find((linha) => linha.startsWith("E2ELIVE01;"))).toContain(";100;80;Sim;Sim;");
});

test("o CSV de /vendas tem a loja live com os números da tabela, e um dia por dia com venda (D-496)", async ({ page }) => {
  await entrar(page, "/vendas?marketplace=todos");

  const { readFileSync } = await import("node:fs");
  const baixar = async (nome: string): Promise<string[]> => {
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: nome, exact: true }).click(),
    ]);

    return readFileSync(await download.path(), "utf-8").replace(/^\uFEFF/u, "").trim().split("\r\n");
  };

  // 11 pedidos válidos de R$ 100, R$ 800 recebidos e 1 aguardando o financeiro: a linha da tabela, coluna a coluna.
  const contas = await baixar("Exportar CSV por conta");

  expect(contas.find((linha) => linha.includes(`;${LOJA_LIVE.nome};`))).toContain(";Real;1100;0;11;11;100;;800;1;");

  // No recorte Shopee, um dia por dia com venda (os 10 dos pedidos), sem a linha do total.
  await page.goto("/vendas?marketplace=shopee");
  const dias = await baixar("Exportar CSV por dia");

  expect(dias).toHaveLength(1 + 10);
  expect(dias.slice(1).every((linha) => linha.split(";")[1] === "Shopee")).toBe(true);
  await semErro(page);
});

test("/contas: a faixa conta a loja live ao lado da de teste e das contas do ML (D-600)", async ({ page }) => {
  await entrar(page, "/contas");

  const cadastradas = page.locator(".sb-kpi").filter({ hasText: "Contas e lojas cadastradas" });

  await expect(cadastradas).toContainText("· 2 da Shopee (1 de teste)");
  await expect(page.locator(".sb-kpi").filter({ hasText: "Conectadas" })).toContainText("· 2 da Shopee");
  await semErro(page);
});

test("/notificacoes: o recorte da loja live mostra o aviso dela, e o lote marca só o que é dela (D-604, D-616)", async ({ page }) => {
  const loja = await db.from("shopee_shops").select("organization_id").eq("id", lojaId).single();

  if (loja.data === null) throw new Error(`loja live sem organização: ${loja.error.message}`);

  // Um aviso da loja, como o vigia grava (D-438): a loja na própria coluna, o nome no `after`.
  // O gatilho de D-073 faz a notificação; o evento é só de inserção e fica (o banco do e2e é recriado).
  const evento = await db.from("domain_events").insert({
    organization_id: loja.data.organization_id,
    event_type: "sync.failed",
    entity_type: "shopee_shop",
    entity_id: lojaId,
    shopee_shop_id: lojaId,
    severity: "importante",
    source: "system",
    occurred_at: new Date().toISOString(),
    dedup_key: `e2e-d604-${lojaId}`,
    after: { tipo: "reconciliacao", marketplace: "SHOPEE", label: LOJA_LIVE.nome },
  });

  expect(evento.error).toBeNull();

  await entrar(page, `/notificacoes?loja=${lojaId}`);

  await expect(page.locator(".sb-content").getByText(LOJA_LIVE.nome).first()).toBeVisible();
  // O recorte filtra de verdade: só o aviso desta loja, nenhuma das notificações do Mercado Livre do seed.
  await expect(page.locator("main .sb-notification-row")).toHaveCount(1);
  // D-616: a escrita em lote conhece a loja (C-69). O botão é o do recorte, e a confirmação diz qual.
  await page.getByRole("button", { name: "Marcar este recorte como lido" }).click();
  const confirmacao = page.getByRole("group", { name: "Confirmar leitura de todas as notificações" });

  await expect(confirmacao).toContainText(LOJA_LIVE.nome);
  await confirmacao.getByRole("button", { name: "Confirmar" }).click();
  // Nada mais por ler na loja: o botão do recorte some.
  await expect(page.getByRole("button", { name: "Marcar este recorte como lido" })).toHaveCount(0);

  // As notificações do Mercado Livre do seed continuam por ler: o lote marcou só o que era da loja.
  await page.goto("/notificacoes");
  await expect(page.getByRole("button", { name: "Marcar todas como lidas" })).toBeVisible();
  await semErro(page);
});

test("/notificacoes e a Home: a mudança de preço do anúncio da Shopee tem o anúncio, a loja e o destino (D-638, C-81)", async ({ page }) => {
  const loja = await db.from("shopee_shops").select("organization_id").eq("id", lojaId).single();

  if (loja.data === null) throw new Error(`loja live sem organização: ${loja.error.message}`);

  // O evento como o worker do A1 grava (C-81): o mesmo tipo do ML, a loja na coluna,
  // o item da Shopee em `entity_id` e os nomes no `after`, porque `domain_events` não tem
  // relação com `shopee_shops`. É só de inserção e fica (o banco do e2e é recriado).
  const evento = await db.from("domain_events").insert({
    organization_id: loja.data.organization_id,
    event_type: "listing.price.changed",
    entity_type: "shopee_item",
    entity_id: "990777001",
    shopee_shop_id: lojaId,
    severity: "informativo",
    source: "system",
    occurred_at: new Date().toISOString(),
    dedup_key: `e2e-d638-${lojaId}`,
    before: { price: 100, current_price: 90, model_id: 7001 },
    after: { price: 120, current_price: 120, model_id: 7001, model_name: "Preta", item_name: LOJA_LIVE.skuTitulo, shop_name: LOJA_LIVE.nome },
  });

  expect(evento.error).toBeNull();

  await entrar(page, `/notificacoes?loja=${lojaId}`);

  const linha = page.locator("main .sb-notification-row").filter({ hasText: "Anúncio Shopee" });

  await expect(linha).toHaveCount(1);
  await expect(linha.locator(".sb-notification-title")).toHaveText("Preço do anúncio alterado");
  await expect(linha.locator(".sb-notification-account")).toHaveText(LOJA_LIVE.nome);
  await expect(linha.locator(".sb-notification-diff")).toHaveText("R$ 100,00 → R$ 120,00");

  const alvo = linha.getByRole("link", { name: `Anúncio Shopee ${LOJA_LIVE.skuTitulo} · Preta`, exact: true });

  await expect(alvo).toHaveAttribute("href", `/anuncios/shopee?loja=${lojaId}&q=990777001`);

  // A atividade recente da Home diz a loja de onde veio, como diz a conta do ML.
  await page.goto("/");
  await expect(
    page.locator(".sb-feed-row").filter({ hasText: "Preço do anúncio alterado" }).filter({ hasText: LOJA_LIVE.nome }),
  ).toHaveCount(1);
  await semErro(page);
});

test("/acoes: a ação da Shopee vendendo sem vínculo tem rótulo, a loja e o atalho para o anúncio (D-626, C-73)", async ({ page }) => {
  // A ação como a `sincronizar_alertas_central` a grava (D-609), para o anúncio
  // da loja live: a loja em `shopee_shop_id` e o retrato em `evidence.detector`.
  const { data: org } = await db.from("shopee_shops").select("organization_id").eq("id", lojaId).single();
  const organizationId = org?.organization_id ?? "";
  const subject = `${lojaId}:990777001:-`;
  const acao = await db
    .from("actions")
    .insert({
      organization_id: organizationId,
      kind: "shopee_sem_vinculo",
      severity: "media",
      confidence: "alta",
      estimated_impact_brl: 300,
      shopee_shop_id: lojaId,
      evidence: {
        evidencias: [
          { tipo: "venda", descricao: `3 unidades em 3 pedidos, R$ 300,00 de receita, na loja ${LOJA_LIVE.nome}, sem SKU vinculado.` },
          { tipo: "vinculo", descricao: `O anúncio traz o SKU "${LOJA_LIVE.sku}", que não existe no catálogo.` },
        ],
        detector: {
          shopee_shop_id: lojaId,
          loja: LOJA_LIVE.nome,
          item_id: 990777001,
          model_id: null,
          anuncio: LOJA_LIVE.skuTitulo,
          variacao: null,
          sku_anuncio: LOJA_LIVE.sku,
          estado: "SKU_FORA_DO_CATALOGO",
        },
      },
      recommendation: "Vincule o anúncio a um SKU em Anúncios da Shopee: sem o vínculo, a venda não baixa o estoque.",
      created_by: "system",
      dedup_key: `shopee_sem_vinculo:${subject}:e2e`,
      subject_key: subject,
    })
    .select("id")
    .single();

  expect(acao.error).toBeNull();

  try {
    await entrar(page, "/acoes?tipo=shopee_sem_vinculo");

    const cartao = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Shopee vendendo sem vínculo", level: 3 }) });

    await expect(cartao).toHaveCount(1);
    // A loja no lugar da conta, o anúncio no lugar do SKU que ele não tem.
    await expect(cartao).toContainText(LOJA_LIVE.nome);
    await expect(cartao).toContainText(`Shopee ${LOJA_LIVE.sku}`);
    await expect(cartao).toContainText(LOJA_LIVE.skuTitulo);
    await expect(cartao).toContainText("que não existe no catálogo");
    await semErro(page);

    // O atalho abre a /anuncios/shopee na loja, pela busca que ela entende (`q`), e acha o anúncio.
    await cartao.getByRole("link", { name: "Anúncio na Shopee" }).click();
    await expect(page).toHaveURL(new RegExp(`/anuncios/shopee\\?loja=${lojaId}&q=${LOJA_LIVE.sku}$`, "u"));
    await expect(page.getByText(LOJA_LIVE.skuTitulo).first()).toBeVisible();
  } finally {
    await db.from("actions").delete().eq("id", acao.data?.id ?? "");
  }
});

test("/acoes: a divergência de estoque da Shopee tem rótulo, o anúncio e o estoque do SKU (D-632, C-78)", async ({ page }) => {
  // A ação como a D-627 a grava: a loja na coluna e no retrato, e o SKU vinculado.
  const { data: org } = await db.from("shopee_shops").select("organization_id").eq("id", lojaId).single();
  const subject = `${lojaId}:990777001:-`;
  const acao = await db
    .from("actions")
    .insert({
      organization_id: org?.organization_id ?? "",
      kind: "shopee_divergencia",
      severity: "media",
      confidence: "media",
      shopee_shop_id: lojaId,
      sku_id: skuId,
      evidence: {
        evidencias: [{ tipo: "estoque", descricao: "A Shopee mostra 7 unidades, e a V3 tem 3 em estoque local." }],
        detector: {
          shopee_shop_id: lojaId,
          loja: LOJA_LIVE.nome,
          item_id: 990777001,
          model_id: null,
          anuncio: LOJA_LIVE.skuTitulo,
          variacao: null,
          sku_anuncio: LOJA_LIVE.sku,
          sku: LOJA_LIVE.sku,
          estoque_shopee: 7,
          saldo_v3_na_leitura: 3,
          saldo_v3_agora: 3,
          diferenca: 4,
        },
      },
      recommendation: "Confira o estoque do anúncio na Shopee: ele não bate com o saldo da V3.",
      created_by: "system",
      dedup_key: `shopee_divergencia:${subject}:e2e`,
      subject_key: subject,
    })
    .select("id")
    .single();

  expect(acao.error).toBeNull();

  try {
    await entrar(page, "/acoes?tipo=shopee_divergencia");

    const cartao = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Divergência de estoque na Shopee", level: 3 }) });

    await expect(cartao).toHaveCount(1);
    await expect(cartao).toContainText(LOJA_LIVE.nome);
    await expect(cartao.getByRole("link", { name: "Anúncio na Shopee" })).toHaveAttribute(
      "href",
      `/anuncios/shopee?loja=${lojaId}&q=${LOJA_LIVE.sku}`,
    );
    await expect(cartao.getByRole("link", { name: "Estoque do SKU" })).toHaveAttribute("href", `/skus/${skuId}?aba=estoque`);
    await semErro(page);
  } finally {
    await db.from("actions").delete().eq("id", acao.data?.id ?? "");
  }
});
