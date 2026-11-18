import { expect, test, type Page } from "@playwright/test";

import { E2E_LISTINGS, E2E_LISTING_TRAFFIC } from "./constants.js";
import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * A TROCA DE TELA SEM ESQUELETO (D-512, D-513): com o `Shell` no layout e sem
 * `loading.tsx` no grupo `(app)`, trocar de tela mantém a tela anterior até a
 * nova chegar — e o que diz "o clique pegou" é o sinal da atualização no lugar
 * (D-500): o `aria-busy` do conteúdo e a barra da moldura.
 *
 * No banco local a tela nova chega antes de qualquer `expect` ver a espera.
 * Por isso cada teste SEGURA a resposta da tela de destino: a navegação suave
 * pede o conteúdo dela com `?_rsc=`, e o `page.route` atrasa só esse pedido.
 * Sem o sinal, a tela ficaria parada pelo atraso inteiro — o defeito que a
 * D-513 achou na paleta de busca, que navega por código e não por `<a>`.
 */

const ESPERA_MS = 1_500;

async function segurarTela(page: Page, caminho: string, aba?: string): Promise<void> {
  await page.route(
    (url) => url.pathname === caminho && url.searchParams.has("_rsc") && (aba === undefined || url.searchParams.get("aba") === aba),
    async (route) => {
      await new Promise((pronto) => setTimeout(pronto, ESPERA_MS));
      await route.continue();
    },
  );
}

/** A Home inteira, com a "Atenção necessária" (que chega num `Suspense`, D-504) e a página hidratada. */
async function abrirHome(page: Page): Promise<string> {
  await login(page, "/");
  await page.waitForURL((url) => url.pathname === "/");
  await page.getByRole("region", { name: "Atenção necessária" }).locator("a[href='/notificacoes']").waitFor();
  await page.waitForLoadState("networkidle");

  return (await page.locator("h1").first().textContent()) ?? "";
}

/** A tela anterior continua, com UM sinal (sem barra dobrada) e o conteúdo marcado como ocupado. */
async function esperandoNaTelaAnterior(page: Page, titulo: string): Promise<void> {
  await expect(page.locator(".sb-content[aria-busy='true']")).toHaveCount(1);
  await expect(page.locator(".sb-atualizando-barra")).toHaveCount(1);
  await expect(page.locator("h1").first()).toHaveText(titulo);
}

/** A tela nova chegou e o sinal saiu. */
async function chegou(page: Page, titulo: RegExp): Promise<void> {
  await expect(page.getByRole("heading", { level: 1, name: titulo })).toBeVisible();
  await expect(page.locator(".sb-content[aria-busy]")).toHaveCount(0);
  await expect(page.locator(".sb-atualizando-barra")).toHaveCount(0);
}

function contarPrefetches(page: Page, caminho: string, aba?: string): () => number {
  let prefetches = 0;
  page.on("request", (request) => {
    const headers = request.headers();
    const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;
    const url = new URL(request.url());

    if (prefetch && url.pathname === caminho && (aba === undefined || url.searchParams.get("aba") === aba)) prefetches += 1;
  });

  return () => prefetches;
}

for (const { entidade, aba, rotulo, tituloAnterior } of [
  { entidade: "SKU", aba: "precos", rotulo: "Preços", tituloAnterior: "Anúncios vinculados" },
  { entidade: "anúncio", aba: "preco", rotulo: "Preço", tituloAnterior: "Checagem do anúncio" },
]) {
  test(`abas do ${entidade}: abre ao acionar e mantém o painel até a troca`, async ({ page }) => {
    const caminho = entidade === "SKU"
      ? `/skus/${(await readSeedOutput()).skuId}`
      : `/anuncios/${E2E_LISTING_TRAFFIC.itemId}`;
    const prefetches = contarPrefetches(page, caminho, aba);
    const abas = page.getByRole("navigation", { name: `Abas do ${entidade}`, exact: true });
    const visaoGeral = abas.getByRole("link", { name: "Visão geral", exact: true });
    const destino = abas.getByRole("link", { name: rotulo, exact: true });
    const painelAnterior = page.getByRole("heading", { name: tituloAnterior, exact: true });

    await login(page, caminho);
    await expect(visaoGeral).toHaveAttribute("aria-current", "page");
    await expect(destino).toHaveAttribute("href", `${caminho}?aba=${aba}`);
    await destino.scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    expect(prefetches()).toBe(0);

    await segurarTela(page, caminho, aba);
    await destino.press("Enter");
    await expect(page.locator(".sb-content[aria-busy='true']")).toHaveCount(1);
    await expect(page.locator(".sb-atualizando-barra")).toHaveCount(1);
    await expect(painelAnterior).toBeVisible();

    await expect(page).toHaveURL((url) => url.pathname === caminho && url.search === `?aba=${aba}`);
    await expect(destino).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: "Mudanças de preço observadas", exact: true })).toBeVisible();
    await expect(page.locator(".sb-atualizando-barra")).toHaveCount(0);
    await expect(page.locator(".sb-content[aria-busy]")).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === caminho && url.search === "");
    await expect(visaoGeral).toHaveAttribute("aria-current", "page");
    await expect(painelAnterior).toBeVisible();
  });
}

test("Diagnóstico do SKU: o atalho de anúncios abre sob demanda e volta ao diagnóstico", async ({ page }) => {
  const { skuId } = await readSeedOutput();
  const caminho = `/skus/${skuId}`;
  const origem = `${caminho}?aba=diagnostico`;
  const prefetches = contarPrefetches(page, caminho, "anuncios");
  const abas = page.getByRole("navigation", { name: "Abas do SKU", exact: true });

  await login(page, origem);
  await expect(abas.getByRole("link", { name: "Diagnóstico", exact: true })).toHaveAttribute("aria-current", "page");
  const painel = page.getByRole("region", { name: "O que esta tela NÃO julga", exact: true });
  const link = painel.getByRole("link", { name: "aba Anúncios", exact: true });

  await expect(link).toHaveAttribute("href", `${caminho}?aba=anuncios`);
  await link.scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle");
  expect(prefetches()).toBe(0);

  await segurarTela(page, caminho, "anuncios");
  await link.click();
  await expect(page.locator(".sb-content[aria-busy='true']")).toHaveCount(1);
  await expect(page.locator(".sb-atualizando-barra")).toHaveCount(1);
  await expect(painel).toBeVisible();

  await expect(page).toHaveURL((url) => url.pathname === caminho && url.search === "?aba=anuncios");
  await expect(abas.getByRole("link", { name: "Anúncios", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "+ Vincular anúncio", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Anúncios da Shopee", exact: true })).toBeVisible();
  await expect(page.locator(".sb-content[aria-busy]")).toHaveCount(0);

  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname + url.search === origem);
  await expect(abas.getByRole("link", { name: "Diagnóstico", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(link).toBeVisible();
});

test("atalhos de abas do SKU: o painel de decisões abre sob demanda", async ({ page }) => {
  const { skuId } = await readSeedOutput();
  const caminho = `/skus/${skuId}`;
  const prefetches = contarPrefetches(page, caminho);

  await login(page, caminho);
  const anuncios = page.getByRole("region", { name: "Anúncios vinculados", exact: true }).getByRole("link", { name: /^Ver aba/ });
  const decisoes = page.getByRole("region", { name: "Últimas decisões", exact: true }).getByRole("link", { name: /^Ver aba/ });
  const abas = page.getByRole("navigation", { name: "Abas do SKU", exact: true });

  await expect(anuncios).toHaveAttribute("href", `${caminho}?aba=anuncios`);
  await expect(decisoes).toHaveAttribute("href", `${caminho}?aba=decisoes`);
  await anuncios.scrollIntoViewIfNeeded();
  await decisoes.scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle");
  expect(prefetches()).toBe(0);

  await decisoes.click();
  await expect(page).toHaveURL((url) => url.pathname === caminho && url.search === "?aba=decisoes");
  await expect(abas.getByRole("link", { name: "Decisões", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Decisões registradas", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === caminho && url.search === "");
  await expect(decisoes).toBeVisible();
});

test("atalhos de abas do anúncio: o menu Ações abre as republicações sob demanda", async ({ page }) => {
  const caminho = `/anuncios/${E2E_LISTING_TRAFFIC.itemId}`;
  const prefetches = contarPrefetches(page, caminho);

  await login(page, caminho);
  const vendas = page.getByRole("region", { name: "Vendas por dia", exact: true }).getByRole("link", { name: /^Detalhar/ });
  const trafego = page.getByRole("region", { name: "Visitas por dia", exact: true }).getByRole("link", { name: /^Detalhar/ });
  const republicacoes = page.getByRole("link", { name: "Republicações", exact: true });
  const acoes = page.locator("summary").filter({ hasText: /^Ações/u });
  const linhaDoTempo = page.getByRole("link", { name: "Linha do tempo e republicações", exact: true });

  await expect(vendas).toHaveAttribute("href", `${caminho}?aba=vendas`);
  await expect(trafego).toHaveAttribute("href", `${caminho}?aba=trafego`);
  await expect(republicacoes).toHaveAttribute("href", `${caminho}?aba=historico`);
  await vendas.scrollIntoViewIfNeeded();
  await trafego.scrollIntoViewIfNeeded();
  await acoes.click();
  await expect(linhaDoTempo).toHaveAttribute("href", `${caminho}?aba=historico`);
  await page.waitForLoadState("networkidle");
  expect(prefetches()).toBe(0);

  await linhaDoTempo.click();
  await expect(page).toHaveURL((url) => url.pathname === caminho && url.search === "?aba=historico");
  await expect(page.getByRole("heading", { name: "Republicações", exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === caminho && url.search === "");
  await expect(republicacoes).toBeVisible();
});

for (const { item, rotulo, destino, titulo, busca } of [
  {
    item: E2E_LISTING_TRAFFIC.itemId,
    rotulo: "Ver na Central de Preços",
    destino: "/precos",
    titulo: /^Histórico de Preços$/,
    busca: true,
  },
  {
    item: E2E_LISTINGS[1].itemId,
    rotulo: "Vincular a um SKU",
    destino: "/vinculacoes",
    titulo: /^Integridade de Catálogo$/,
    busca: false,
  },
]) {
  test(`menu Ações entre telas: ${rotulo} carrega no clique`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const origem = `/anuncios/${item}`;
    const query = busca ? `?busca=${item}` : "";
    const prefetches = contarPrefetches(page, destino);
    const menu = page.locator("summary").filter({ hasText: /^Ações/u });
    const link = page.getByRole("link", { name: rotulo, exact: true });

    await login(page, origem);
    await expect(page.getByRole("heading", { level: 1, name: "Detalhe do anúncio", exact: true })).toBeVisible();
    await page.waitForLoadState("networkidle");
    const antesDeAbrir = prefetches();

    await menu.click();
    await expect(link).toHaveAttribute("href", destino + query);
    await link.scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    expect(prefetches()).toBe(antesDeAbrir);

    await segurarTela(page, destino);
    await link.click();
    await esperandoNaTelaAnterior(page, "Detalhe do anúncio");
    await chegou(page, titulo);
    await expect(page).toHaveURL((url) => url.pathname === destino && url.search === query);
    if (busca) {
      await expect(page.getByRole("searchbox", { name: "Buscar por MLB, SKU ou título" })).toHaveValue(item);
    }

    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === origem && url.search === "");
    await expect(menu).toBeVisible();
  });
}

test("link da sidebar: a tela anterior fica, com o sinal, até a nova chegar", async ({ page }) => {
  const prefetches = contarPrefetches(page, "/estoque");
  const titulo = await abrirHome(page);

  await expect(page.getByRole("link", { name: "Estoque", exact: true }).first()).toBeVisible();
  expect(prefetches()).toBe(0);

  await segurarTela(page, "/estoque");
  await page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "Estoque", exact: true }).click();

  await esperandoNaTelaAnterior(page, titulo);
  await chegou(page, /^Visão de estoque$/);
  await expect(page).toHaveURL(/\/estoque$/);
});

const ATALHOS = [
  {
    origem: "/configuracoes",
    seletor: ".sb-settings-links a[href^='/reposicao/configuracoes']",
    destino: "/reposicao/configuracoes",
    titulo: /^Configuração de reposição$/,
  },
  {
    origem: "/estoque",
    seletor: ".sb-kpi-link[href='/full']",
    destino: "/full",
    titulo: /^Central Full$/,
  },
];

for (const { origem, seletor, destino, titulo } of ATALHOS) {
  test(`atalhos sob demanda em ${origem}: abre ${destino} pelo clique`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const prefetches = contarPrefetches(page, destino);
    await login(page, origem);

    const link = page.locator(seletor);
    await link.scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    expect(prefetches()).toBe(0);

    const href = await link.getAttribute("href");
    expect(href).toMatch(new RegExp(`^${destino}`));
    await link.click();
    await expect(page).toHaveURL((url) => `${url.pathname}${url.hash}` === href);
    await chegou(page, titulo);
  });
}

test("link no conteúdo: o IndicadorDeNavegacao dá o sinal até a tela nova chegar", async ({ page }) => {
  const titulo = await abrirHome(page);

  await segurarTela(page, "/notificacoes");
  await page.getByRole("region", { name: "Atenção necessária" }).locator("a[href='/notificacoes']").click();

  await esperandoNaTelaAnterior(page, titulo);
  await chegou(page, /^Central de Notificações$/);
  await expect(page).toHaveURL(/\/notificacoes$/);
});

test("paleta de busca: a escolha navega por código e também tem o sinal (D-513)", async ({ page }) => {
  const titulo = await abrirHome(page);

  await page.getByRole("button", { name: /Buscar SKU, anúncio, NF-e/ }).click();

  const caixa = page.getByRole("dialog", { name: "Buscar na Speed Bikers" });
  const campo = caixa.getByRole("combobox", { name: "Buscar" });

  await campo.fill("movimentacoes");
  await expect(caixa.getByRole("option", { name: /Movimentações/ })).toHaveAttribute("aria-selected", "true");

  await segurarTela(page, "/estoque/movimentacoes");
  await campo.press("Enter");

  await expect(caixa).toHaveCount(0);
  await esperandoNaTelaAnterior(page, titulo);
  await chegou(page, /^Movimentações$/);
  await expect(page).toHaveURL(/\/estoque\/movimentacoes$/);
});
