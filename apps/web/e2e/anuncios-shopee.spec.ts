import { type Page, expect, test } from "@playwright/test";

import { E2E_ANOMALIA, E2E_SHOPEE_ESPERADO, E2E_SHOPEE_ITEMS, E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/anuncios/shopee` — o catálogo da loja Shopee e o vínculo pelo SKU do
 * anúncio (D-428, fatia 4a), e o vínculo manual, que vence (D-429, fatia 4b).
 *
 * O seed planta um item por estado do vínculo e um apagado
 * (`E2E_SHOPEE_ITEMS`); as contagens esperadas estão escritas à mão em
 * `E2E_SHOPEE_ESPERADO`, para o teste conferir a view, e não uma cópia dela.
 *
 * O que ele protege, em ordem de gravidade:
 *
 *  1. **O vínculo normaliza o SKU como `skus.sku_key`.** O SKU do item chega em
 *     minúsculas e com espaços; se a comparação deixar de ser `upper(btrim())`,
 *     o "Vinculados" cai de 2 para 1 e a linha perde o link.
 *  2. **A faixa não diverge da lista.** Cada célula é um filtro de estado, e
 *     clicar mostra exatamente aquela quantidade.
 *  3. **Item apagado não é anúncio**, e ausência não vira zero: o item ainda
 *     não lido mostra "—" no preço e no estoque.
 *  4. **O vínculo manual vence, conta e se desfaz** (D-429): vincular à mão
 *     move a linha e a faixa, a página do SKU vê o mesmo vínculo, e remover
 *     (com motivo) devolve tudo ao estado do seed.
 *
 * Localizadores por papel e texto, nunca por classe: o esqueleto de
 * carregamento repete as classes do shell (`components/carregando.tsx`).
 */

function faixa(page: Page) {
  return page.getByRole("region", { name: "Contadores dos anúncios da Shopee" });
}

/** A célula da faixa: o pai do rótulo exato. */
function celula(page: Page, rotulo: string) {
  return faixa(page).getByText(rotulo, { exact: true }).locator("..");
}

function tabela(page: Page) {
  return page.getByRole("table", { name: "Anúncios da Shopee" });
}

/** As linhas de dados: todas as linhas da tabela menos a do cabeçalho. */
async function esperaLinhas(page: Page, quantidade: number): Promise<void> {
  await expect(tabela(page).getByRole("row")).toHaveCount(quantidade + 1);
}

const { skuNoItem, duasVariacoes, semSku, aguardando, apagado } = E2E_SHOPEE_ITEMS;
const [variacaoVinculada, variacaoFora] = duasVariacoes.variacoes;

test("/anuncios/shopee: a faixa conta os estados do vínculo, e a última leitura aparece", async ({ page }) => {
  await login(page, "/anuncios/shopee");

  await expect(page.getByRole("heading", { level: 1, name: "Anúncios da Shopee" })).toBeVisible();

  const esperado: [string, number][] = [
    ["Anúncios", E2E_SHOPEE_ESPERADO.anuncios],
    ["Vinculados", E2E_SHOPEE_ESPERADO.vinculados],
    ["Sem SKU no anúncio", E2E_SHOPEE_ESPERADO.semSkuNoAnuncio],
    ["SKU fora do catálogo", E2E_SHOPEE_ESPERADO.skuForaDoCatalogo],
    ["Aguardando leitura", E2E_SHOPEE_ESPERADO.aguardandoLeitura],
  ];

  for (const [rotulo, quantidade] of esperado) {
    await expect(celula(page, rotulo).getByText(String(quantidade), { exact: true }), rotulo).toBeVisible();
  }

  // Cada variação é um anúncio; a célula diz em quantos itens.
  await expect(celula(page, "Anúncios")).toContainText(`em ${String(E2E_SHOPEE_ESPERADO.itens)} itens`);

  // A loja do seed foi lida há meia hora: a célula tem instante, não "—".
  const leitura = celula(page, "Última leitura do catálogo");

  await expect(leitura).toContainText("a leitura roda de hora em hora");
  await expect(faixa(page).getByText("—", { exact: true })).toHaveCount(0);

  // A lista mostra as cinco unidades, e a janela declara o total.
  await esperaLinhas(page, E2E_SHOPEE_ESPERADO.anuncios);
  await expect(page.getByText(`${String(E2E_SHOPEE_ESPERADO.anuncios)} anúncios.`, { exact: true })).toBeVisible();

  // O apagado pelo vendedor não aparece em lugar nenhum.
  await expect(page.getByText(apagado.nome)).toHaveCount(0);
  await expect(page.getByText(String(apagado.itemId))).toHaveCount(0);
});

test("/anuncios/shopee: o vínculo pelo SKU do anúncio leva ao SKU, e cada estado tem rótulo próprio", async ({
  page,
}) => {
  await login(page, "/anuncios/shopee");

  const lista = tabela(page);

  // (a) SKU do ITEM em minúsculas e com espaços: vinculado ao SKU do seed.
  const linhaItem = lista.getByRole("row", { name: new RegExp(String(skuNoItem.itemId)) });
  const linkSku = linhaItem.getByRole("link", { name: E2E_SKU_CODE, exact: true });

  await expect(linkSku).toHaveAttribute("href", /^\/skus\/[0-9a-f-]{36}$/);
  await expect(linhaItem).toContainText("pelo SKU do anúncio");
  // O SKU do anúncio aparece como o vendedor digitou (sem as pontas em branco).
  await expect(linhaItem).toContainText(E2E_SKU_CODE.toLowerCase());

  // (b) O vínculo mora na VARIAÇÃO: uma vinculada, a outra fora do catálogo.
  const linhaVinculada = lista.getByRole("row", { name: new RegExp(variacaoVinculada.nome) });

  await expect(linhaVinculada.getByRole("link", { name: E2E_ANOMALIA.sku, exact: true })).toHaveAttribute(
    "href",
    /^\/skus\//,
  );

  const linhaFora = lista.getByRole("row", { name: new RegExp(variacaoFora.nome) });

  await expect(linhaFora).toContainText("SKU fora do catálogo");
  await expect(linhaFora).toContainText(variacaoFora.sku);
  await expect(linhaFora).toContainText("variação indisponível");
  await expect(linhaFora.getByRole("link")).toHaveCount(0);

  // (c) SKU em branco não é SKU.
  const linhaSemSku = lista.getByRole("row", { name: new RegExp(semSku.nome) });

  await expect(linhaSemSku).toContainText("Sem SKU no anúncio");
  await expect(linhaSemSku).toContainText("Pausado");

  // (d) Só a lista foi lida: sem nome, e preço e estoque "—", nunca zero.
  // Colunas: Anúncio, Loja, SKU do anúncio, Vínculo, Preço, Estoque, Status.
  const linhaAguardando = lista.getByRole("row", { name: new RegExp(String(aguardando.itemId)) });

  await expect(linhaAguardando).toContainText("Aguardando leitura");
  await expect(linhaAguardando).toContainText("Nome ainda não lido");
  await expect(linhaAguardando.getByRole("cell").nth(4)).toHaveText("—");
  await expect(linhaAguardando.getByRole("cell").nth(5)).toHaveText("—");

  // Clicar no SKU leva à página dele.
  await linkSku.click();
  await expect(page).toHaveURL(/\/skus\/[0-9a-f-]{36}$/);
});

test("/anuncios/shopee: clicar num contador filtra a lista para exatamente aquele estado", async ({ page }) => {
  await login(page, "/anuncios/shopee");

  await celula(page, "Sem SKU no anúncio").getByRole("link", { name: "ver lista" }).click();

  await expect(page).toHaveURL(/estado=sem-sku/);
  await esperaLinhas(page, E2E_SHOPEE_ESPERADO.semSkuNoAnuncio);
  await expect(tabela(page)).toContainText(semSku.nome);

  // O filtro aparece como chip que se desfaz; a faixa segue contando o escopo.
  const chips = page.getByLabel("Filtros ativos");

  await expect(chips).toContainText("Sem SKU no anúncio");
  await expect(celula(page, "Anúncios").getByText(String(E2E_SHOPEE_ESPERADO.anuncios), { exact: true })).toBeVisible();

  await celula(page, "Vinculados").getByRole("link", { name: "ver lista" }).click();

  await expect(page).toHaveURL(/estado=vinculado/);
  await esperaLinhas(page, E2E_SHOPEE_ESPERADO.vinculados);
  await expect(tabela(page).getByRole("link", { name: E2E_SKU_CODE, exact: true })).toBeVisible();
  await expect(tabela(page).getByRole("link", { name: E2E_ANOMALIA.sku, exact: true })).toBeVisible();

  await celula(page, "SKU fora do catálogo").getByRole("link", { name: "ver lista" }).click();

  await expect(page).toHaveURL(/estado=fora-do-catalogo/);
  await esperaLinhas(page, E2E_SHOPEE_ESPERADO.skuForaDoCatalogo);
  await expect(tabela(page)).toContainText(variacaoFora.nome);

  // Tirar o chip volta para a lista inteira.
  await page.getByRole("link", { name: "Tirar o filtro SKU fora do catálogo" }).click();

  await expect(page).not.toHaveURL(/estado=/);
  await esperaLinhas(page, E2E_SHOPEE_ESPERADO.anuncios);
});

test("/anuncios/shopee: a busca recorta pelo SKU e mantém o estado", async ({ page }) => {
  await login(page, "/anuncios/shopee?estado=vinculado");

  await esperaLinhas(page, E2E_SHOPEE_ESPERADO.vinculados);

  const busca = page.getByRole("searchbox", { name: "Buscar anúncio da Shopee por nome, SKU ou número do item" });

  await busca.fill(E2E_ANOMALIA.sku);
  await busca.press("Enter");

  await expect(page).toHaveURL(/estado=vinculado/);
  await expect(page).toHaveURL(/q=/);
  await esperaLinhas(page, 1);
  await expect(tabela(page)).toContainText(variacaoVinculada.nome);

  // A faixa conta sem a busca, e o "ver lista" dela também a larga: com a
  // busca, a célula dizendo 2 abriria uma lista de 1.
  await expect(celula(page, "Vinculados").getByText(String(E2E_SHOPEE_ESPERADO.vinculados), { exact: true })).toBeVisible();
  await expect(celula(page, "Vinculados").getByRole("link", { name: "ver lista" })).toHaveAttribute(
    "href",
    "/anuncios/shopee?estado=vinculado",
  );
});

/**
 * O VÍNCULO MANUAL (D-429), ida e volta numa corrida só — as duas metades
 * separadas passariam mesmo se a escrita fosse para um lugar que a leitura não
 * lê.
 *
 * O alvo é a variação "Azul / G": o SKU do anúncio não existe no catálogo, então
 * vincular à mão é o caso de uso real, e a faixa tem de mover de "SKU fora do
 * catálogo" para "Vinculados". O SKU de destino é o da anomalia — não o
 * principal, que o painel da página do SKU afirma sozinho em outro spec.
 *
 * **Deixa o banco como encontrou:** termina removendo o vínculo que criou, e
 * confere que a linha e a faixa voltaram ao seed. (Se cair no meio, o seed
 * apaga os vínculos manuais da loja ao rodar de novo.)
 */
test("/anuncios/shopee: vincular à mão a variação fora do catálogo, e remover o vínculo manual com motivo", async ({
  page,
}) => {
  await login(page, "/anuncios/shopee");

  const linhaAlvo = () => tabela(page).getByRole("row", { name: new RegExp(variacaoFora.nome) });
  const faixaDiz = async (rotulo: string, quantidade: number): Promise<void> => {
    await expect(celula(page, rotulo).getByText(String(quantidade), { exact: true }), rotulo).toBeVisible();
  };

  // Ponto de partida: o do seed.
  await expect(linhaAlvo()).toContainText("SKU fora do catálogo");
  await faixaDiz("Vinculados", E2E_SHOPEE_ESPERADO.vinculados);
  await faixaDiz("SKU fora do catálogo", E2E_SHOPEE_ESPERADO.skuForaDoCatalogo);
  // A faixa diz que "Vinculados" soma as duas origens.
  await expect(celula(page, "Vinculados")).toContainText("manual ou pelo SKU do anúncio");

  // A linha aguardando leitura não oferece vínculo — a RPC recusaria.
  const linhaAguardando = tabela(page).getByRole("row", { name: new RegExp(String(aguardando.itemId)) });

  await expect(linhaAguardando.getByRole("button")).toHaveCount(0);
  await expect(linhaAguardando).toContainText("vincular à mão só depois da leitura");

  // 1. VINCULAR pelo popup, com a busca de SKU.
  await linhaAlvo().getByRole("button", { name: "Vincular", exact: true }).click();

  const popup = page.getByRole("dialog");

  await expect(popup).toBeVisible();
  await expect(popup).toContainText(variacaoFora.sku);
  await expect(popup).toContainText("não existe no catálogo");

  await popup.getByLabel("SKU de destino").fill(E2E_ANOMALIA.sku);
  await popup.getByRole("option").filter({ hasText: E2E_ANOMALIA.sku }).first().click();

  await expect(popup.getByRole("status")).toContainText(`vai para o SKU ${E2E_ANOMALIA.sku}`);

  await popup.getByRole("button", { name: "Vincular", exact: true }).click();

  await expect(popup).toHaveCount(0);

  // A linha virou "vínculo manual", com o SKU clicável — e a faixa contou.
  const skuDaLinha = linhaAlvo().getByRole("link", { name: E2E_ANOMALIA.sku, exact: true });

  await expect(skuDaLinha).toHaveAttribute("href", /^\/skus\/[0-9a-f-]{36}$/);
  await expect(linhaAlvo()).toContainText("vínculo manual");
  await expect(linhaAlvo()).not.toContainText("SKU fora do catálogo");
  // O SKU do anúncio não existe no catálogo: não há "o anúncio indica" a dizer.
  await expect(linhaAlvo()).not.toContainText("o anúncio indica");
  await expect(linhaAlvo().getByRole("button", { name: "Trocar SKU" })).toBeVisible();
  await faixaDiz("Vinculados", E2E_SHOPEE_ESPERADO.vinculados + 1);
  await faixaDiz("SKU fora do catálogo", E2E_SHOPEE_ESPERADO.skuForaDoCatalogo - 1);

  // 2. A PÁGINA DO SKU lê o mesmo vínculo (`get_sku_shopee_listings`).
  const hrefDoSku = await skuDaLinha.getAttribute("href");

  await page.goto(`${hrefDoSku ?? ""}?aba=anuncios`);

  const painel = page.getByRole("region", { name: "Anúncios da Shopee" });

  await expect(painel.getByRole("row", { name: new RegExp(variacaoFora.nome) })).toContainText("vínculo manual");
  await expect(painel.getByRole("row", { name: new RegExp(variacaoVinculada.nome) })).toContainText(
    "pelo SKU do anúncio",
  );

  // 3. REMOVER, com motivo obrigatório: o SKU do anúncio volta a valer.
  await page.goto("/anuncios/shopee");
  await linhaAlvo().getByRole("button", { name: "Remover vínculo manual" }).click();

  const confirmacao = page.getByRole("dialog");
  const remover = confirmacao.getByRole("button", { name: "Remover vínculo manual" });

  await expect(confirmacao).toContainText("Nada muda na Shopee");
  await expect(confirmacao).toContainText("a linha fica sem vínculo");
  await expect(remover).toBeDisabled();

  await confirmacao.getByLabel("Motivo da remoção").fill("e2e: desfaz o vínculo manual de teste");
  await remover.click();

  await expect(confirmacao).toHaveCount(0);

  // De volta ao seed: a linha, o link e a faixa.
  await expect(linhaAlvo()).toContainText("SKU fora do catálogo");
  await expect(linhaAlvo().getByRole("link")).toHaveCount(0);
  await faixaDiz("Vinculados", E2E_SHOPEE_ESPERADO.vinculados);
  await faixaDiz("SKU fora do catálogo", E2E_SHOPEE_ESPERADO.skuForaDoCatalogo);
});

/** O seletor de marketplace do cabeçalho (D-431), pelo nome acessível dele. */
function seletorDeMarketplace(page: Page) {
  return page.locator("details.sb-menu").filter({ has: page.locator('summary[aria-label^="Marketplace:"]') });
}

test("/anuncios: o seletor de marketplace leva à lista inteira da Shopee", async ({ page }) => {
  await login(page, "/anuncios");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de anúncios" })).toBeVisible();

  const seletor = seletorDeMarketplace(page);

  await seletor.locator("summary").click();
  await seletor.getByRole("link", { name: "Shopee", exact: true }).click();

  await expect(page).toHaveURL(/\/anuncios\/shopee$/);
  await expect(page.getByRole("heading", { level: 1, name: "Anúncios da Shopee" })).toBeVisible();
  await esperaLinhas(page, E2E_SHOPEE_ESPERADO.anuncios);
});

/**
 * A TROCA DE MARKETPLACE (D-431) nas listas de anúncios: a busca por SKU
 * atravessa nos dois sentidos — "este SKU na outra loja" é para isso que a
 * troca serve — e o código de anúncio do Mercado Livre fica para trás, porque
 * não existe na Shopee. Conta, período e estados são de um canal só.
 */
test("/anuncios: o seletor de marketplace leva aos anúncios da Shopee com a busca do SKU, e volta", async ({ page }) => {
  await login(page, `/anuncios?busca=${encodeURIComponent(E2E_ANOMALIA.sku)}&dias=7`);

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de anúncios" })).toBeVisible();

  const seletor = seletorDeMarketplace(page);

  await expect(seletor.locator("summary")).toHaveAttribute("aria-label", "Marketplace: Mercado Livre");
  await seletor.locator("summary").click();
  await seletor.getByRole("link", { name: "Shopee", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/anuncios/shopee\\?q=${encodeURIComponent(E2E_ANOMALIA.sku)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Anúncios da Shopee" })).toBeVisible();
  await expect(tabela(page)).toContainText(variacaoVinculada.nome);

  // A volta leva a busca e larga o estado da Shopee.
  await page.goto(`/anuncios/shopee?estado=vinculado&q=${encodeURIComponent(E2E_ANOMALIA.sku)}`);
  await seletor.locator("summary").click();
  await seletor.getByRole("link", { name: "Mercado Livre", exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/anuncios\\?busca=${encodeURIComponent(E2E_ANOMALIA.sku)}$`));
  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de anúncios" })).toBeVisible();
});

test("/anuncios: o código MLB da busca não vai para a Shopee", async ({ page }) => {
  await login(page, "/anuncios?busca=MLB1476804187");

  await expect(seletorDeMarketplace(page).getByRole("link", { name: "Shopee", exact: true, includeHidden: true })).toHaveAttribute(
    "href",
    "/anuncios/shopee",
  );
});

/**
 * D-490: o CSV dos anúncios sai com o recorte da lista — o mesmo número de
 * linhas da tela, o estado do vínculo e a origem do SKU com as palavras dela.
 */
test("/anuncios/shopee: o CSV sai com o recorte da lista e as palavras da tela (D-490)", async ({ page }) => {
  await login(page, "/anuncios/shopee");
  await expect(tabela(page)).toBeVisible();

  const naTela = await tabela(page).locator("tbody > tr").count();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("region", { name: "Anúncios e vínculos" }).getByRole("link", { name: /Exportar CSV/ }).click(),
  ]);

  expect(download.suggestedFilename()).toMatch(/^anuncios-shopee-\d{4}-\d{2}-\d{2}\.csv$/);

  const { readFileSync } = await import("node:fs");
  const linhas = readFileSync(await download.path(), "utf-8").replace(/^\uFEFF/u, "").trim().split("\r\n");

  expect(linhas).toHaveLength(1 + naTela);

  const doItem = linhas.find((linha) => linha.startsWith(`${String(skuNoItem.itemId)};`));

  expect(doItem).toContain(";Vinculado;Ativo;");
  expect(doItem).toContain(";pelo SKU do anúncio;");
});
