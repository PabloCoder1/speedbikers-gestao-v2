import type { Database } from "@sb/db";
import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import {
  E2E_DECISION_TEXT,
  E2E_LISTINGS,
  E2E_LISTING_FULL,
  E2E_LOCAL_STOCK,
  E2E_SKU_SALES,
} from "./constants.js";
import { derrubarPrimeiraAcao, login } from "./helpers.js";
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
  // Como no frame: a página abre com o cabeçalho "Detalhe do SKU" (h1) e o
  // cartão de entidade traz o nome do produto como título do cartão (h2), com
  // o identificador em mono acima dele.
  await expect(page.getByRole("heading", { level: 1, name: "Detalhe do SKU" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Produto de teste E2E" })).toBeVisible();
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

  /*
    A ABA PROVA O VÍNCULO — E A DEFINIÇÃO MUDOU EM D-316.

    Este caso AFIRMAVA a perda: dizia que o anúncio vinculado por VARIAÇÃO não
    aparecia, porque a tela filtrava por `listings.sku_id` e essa coluna é nula
    para ele. Era a definição mais estreita de "vinculado" do repositório, e
    D-122 mediu o tamanho do buraco: 1.013 de 1.917 anúncios (52,8%).

    Agora a aba usa a régua canônica — vínculo direto OU linha em
    `sku_listing_links` —, a mesma de `/produtos` e de `/vinculacoes`. Os dois
    do seed aparecem; os que não têm vínculo nenhum continuam fora.
  */
  const vinculados = E2E_LISTINGS.filter((anuncio) => anuncio.vinculo !== "nenhum");

  expect(vinculados.length).toBeGreaterThan(1);

  for (const anuncio of vinculados) {
    await expect(page.getByText(anuncio.itemId)).toBeVisible();
  }

  for (const outro of E2E_LISTINGS.filter((anuncio) => anuncio.vinculo === "nenhum")) {
    await expect(page.getByText(outro.itemId)).toHaveCount(0);
  }

  // E a coluna Estoque, que existia no esquema e não era lida (D-316).
  const comEstoque = vinculados.find((anuncio) => anuncio.available > 0);

  await expect(page.locator("tbody tr", { hasText: comEstoque?.itemId ?? "" })).toContainText(
    String(comEstoque?.available ?? ""),
  );
});

/**
 * Aba Full (D-224/D-225/D-243) — a fiação, e o número certo por conta.
 *
 * O seed grava UM snapshot de Full (`E2E_LISTING_FULL`) no anúncio vinculado a
 * este SKU. A tabela por conta tem de mostrar exatamente essa quantidade na
 * conta do seed — lida do último snapshot, nunca somada com os históricos e
 * nunca inventada. (O estado vazio honesto, "ausência de snapshot não é saldo
 * zero", continua sendo o texto da aba quando não há snapshot; com o fixture
 * atual ele não aparece, e é a linha que se afirma.)
 */
test("aba Full mostra o snapshot do seed por conta", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  await page.getByRole("navigation", { name: "Abas do SKU" }).getByRole("link", { name: "Full" }).click();

  await expect(page).toHaveURL(/aba=full/);
  await expect(page.getByRole("heading", { name: "Full por conta" })).toBeVisible();

  const linhaConta = page.getByRole("row", { name: new RegExp(seed.mlAccountLabel) });

  await expect(linhaConta).toBeVisible();
  await expect(linhaConta.locator("td").nth(1)).toHaveText(String(E2E_LISTING_FULL));
});

/**
 * Aba Preços (D-226) — a fiação, e de novo o estado vazio, que aqui é a
 * regra e não a exceção: 95 dos 3.554 SKUs do Dev (2,7%) têm algum evento de
 * preço, então 97% das páginas mostram exatamente esta mensagem.
 *
 * O que ela precisa dizer é o oposto do óbvio. `listing.price.changed` é um
 * DIFF entre duas leituras do anúncio (a da notificação do Mercado Livre e a
 * varredura de 6 em 6 horas, D-631) — logo "sem linha" não é "preço parado", e a tela que dissesse "preço estável" estaria inventando.
 */
test("aba Preços existe e não confunde ausência de evento com preço parado", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  await page.getByRole("navigation", { name: "Abas do SKU" }).getByRole("link", { name: "Preços" }).click();

  await expect(page).toHaveURL(/aba=precos/);
  await expect(page.getByRole("heading", { name: "Mudanças de preço observadas" })).toBeVisible();

  // Desde D13 o seed grava um evento `listing.price.changed` no anúncio
  // vinculado a este SKU, então a aba tem UMA linha — e é ela que prova a
  // fiação: a mudança de preço de um ANÚNCIO aparece no SKU que ele vende.
  await expect(page.locator("tbody tr")).toHaveCount(1);

  // A ressalva que impede a leitura errada continua, com ou sem linha: "sem
  // evento" nunca quer dizer "preço parado".
  await expect(page.getByText("uma alteração feita e desfeita entre duas leituras não deixa registro")).toBeVisible();
});

for (const { aba, busca, secao } of [
  { aba: "Visão geral", busca: "", secao: "Anúncios vinculados" },
  { aba: "Anúncios", busca: "?aba=anuncios", secao: "Anúncios vinculados" },
  { aba: "Preços", busca: "?aba=precos", secao: "Mudanças de preço observadas" },
]) {
  test(`SKU · ${aba}: o anúncio abre ao clicar e a volta preserva a aba`, async ({ page }) => {
    const { skuId } = await readSeedOutput();
    const anuncio = E2E_LISTINGS[0];
    const origem = `/skus/${skuId}`;
    const destino = `/anuncios/${anuncio.itemId}`;
    const prefetches: string[] = [];

    page.on("request", (request) => {
      const headers = request.headers();
      const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;

      if (prefetch && new URL(request.url()).pathname === destino) prefetches.push(request.url());
    });

    await login(page, origem + busca);
    const painel = page.getByRole("region", { name: secao, exact: true });
    const link = painel.getByRole("link", { name: anuncio.itemId, exact: true });
    const abrir = aba === "Anúncios"
      ? painel.getByRole("row").filter({ hasText: anuncio.itemId }).getByRole("link", { name: "Ver", exact: true })
      : link;

    await expect(link).toHaveAttribute("href", destino);
    await expect(abrir).toHaveAttribute("href", destino);
    await link.scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    expect(prefetches).toEqual([]);

    await abrir.click();
    await expect(page).toHaveURL((url) => url.pathname === destino);
    await expect(page.getByRole("heading", { level: 2, name: anuncio.title, exact: true })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL((url) => url.pathname === origem && url.search === busca);
    await expect(link).toBeVisible();
  });
}

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
  // O `<h2>` virou rótulo de seção e os números viraram cartões de indicador —
  // o vocabulário do design system. O que se afirma continua sendo o mesmo: o
  // título da seção, e cada número no seu cartão.
  // O seed tem loja Shopee: a seção do ML vem depois da "Entre marketplaces"
  // (D-444) e se chama pelo canal. Sem loja Shopee, ela é "Vendas do SKU".
  await expect(page.getByText("No Mercado Livre", { exact: true })).toBeVisible();

  // Os seis números canônicos viraram UMA faixa de KPIs (a mesma apresentação
  // que /vendas dá às mesmas métricas), em vez de seis cartões soltos.
  const cartao = (rotulo: string) =>
    page.locator(".sb-kpi", { has: page.getByText(rotulo, { exact: true }) }).locator(".sb-kpi-value");

  await expect(cartao("Unidades vendidas")).toHaveText(String(unidades));
  // Razão sobre as SOMAS (500 / 5 = R$ 100,00), não média das razões diárias.
  await expect(cartao("Ticket médio")).toContainText(`${String(receita / compras)},00`);

  // A conta do seed aparece na tabela por conta do ML, com as mesmas unidades
  // (ela também está na tabela entre marketplaces, acima: daí o painel).
  const linhaConta = page
    .getByRole("region", { name: "Por conta" })
    .getByRole("row", { name: new RegExp(seed.mlAccountLabel) });
  await expect(linhaConta).toContainText(String(unidades));

  // Dois dias gravados, duas linhas por dia — e nenhum dia inventado com zero.
  // `exact`: o painel "Por dia, por canal" (D-618) também casa com "Por dia" por trecho.
  await expect(page.getByRole("heading", { name: "Por dia", exact: true })).toBeVisible();
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
  // O autor entre o tipo e a data (D-320): a aba dona diz quem decidiu, como o
  // painel da visão geral — o seed grava a decisão com o ADMIN "E2E".
  await expect(page.getByText("Venda anômala · Queda · E2E ·")).toBeVisible();
  // O retrato "antes × depois" é uma tabela: cada linha nomeia o momento e
  // carrega o retrato bruto — nenhuma porcentagem sintetizada (D-228).
  await expect(page.getByRole("row", { name: /No momento da decisão/ })).toContainText("Vendido (7d): 2");
  await expect(page.getByRole("row", { name: /7 dias depois/ })).toContainText("Vendido (7d): 5");
  await expect(page.getByText("Ainda sem medição: 15 dias depois, 30 dias depois.")).toBeVisible();
});

/**
 * "Últimas decisões" na visão geral, na anatomia do frame (A12, D-320): avatar
 * de quem decidiu, o TIPO da ação como título, o texto, e autor · idade.
 *
 * As afirmações só valem juntas. O monograma é "E" — o ADMIN do seed se chama
 * "E2E", uma parte só, e "EE" seria a regra errada. A linha de baixo é IDADE e
 * não data (a decisão acabou de ser gravada pelo seed, dentro da janela de
 * `formatAge`), e a data exata não se perde: está no `title`. A decisão do
 * ANÚNCIO, que o seed também grava, não entra aqui — a ação dela não tem
 * `sku_id`, e é por isso que a linha do SKU é a primeira.
 */
test("visão geral: Últimas decisões diz quem decidiu, sobre o quê e há quanto tempo", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  const painel = page.getByRole("region", { name: "Últimas decisões" });
  const linha = painel.locator(".sb-feed-row").first();

  await expect(linha.locator(".sb-avatar")).toHaveText("E");
  await expect(linha.locator("b")).toHaveText("Venda anômala · Queda");
  await expect(linha.locator(".sb-feed-text")).toHaveText(E2E_DECISION_TEXT);

  const carimbo = linha.locator("small");

  await expect(carimbo).toHaveText(/^E2E · (agora há pouco|há \d+ (min|h|dias?))$/);
  await expect(carimbo).toHaveAttribute("title", /\d{2}\/\d{2}\/\d{4}/);
});


/**
 * UMA CONTA DE COBERTURA, DUAS TELAS (D-314).
 *
 * O cartão imprimia `local ÷ venda média`, a definição que D-288 aposentou ao
 * fundir `/cobertura` com `/reposicao`: eram **300 dias** aqui contra **318**
 * em `/reposicao`, para o MESMO SKU, na tela cujo cabeçalho leva justamente
 * para lá.
 *
 * Os dois números são DERIVADOS do seed, como faz o spec de `/reposicao` —
 * mudar o fixture move os dois lados juntos. E o caso afirma a ausência do
 * número velho: sem isso, ele passaria se alguém imprimisse os dois.
 */
test("dashboard de SKU: a Cobertura conta o APROVEITÁVEL, e é o mesmo número de /reposicao", async ({ page }) => {
  const seed = await readSeedOutput();

  const vendaDiaria = E2E_SKU_SALES.reduce((total, dia) => total + dia.units, 0) / 30;
  const aproveitavel = E2E_LOCAL_STOCK + E2E_LISTING_FULL;
  const pelaReposicao = Math.round((aproveitavel / vendaDiaria) * 10) / 10;
  const peloEstoqueLocal = Math.round((E2E_LOCAL_STOCK / vendaDiaria) * 10) / 10;

  // As duas definições PRECISAM divergir, senão o caso não prova nada.
  expect(pelaReposicao).not.toBe(peloEstoqueLocal);

  await login(page, `/skus/${seed.skuId}`);

  const cartao = page.locator(".sb-stat", { hasText: "Cobertura" });

  await expect(cartao.locator(".sb-stat-value")).toHaveText(`${pelaReposicao.toFixed(1).replace(".", ",")} dias`);
  await expect(cartao).not.toContainText(peloEstoqueLocal.toFixed(1).replace(".", ","));

  // A ressalva carrega a CONTA — é por ela que alguém percebe uma divergência
  // futura sem precisar abrir duas telas.
  await expect(cartao.locator(".sb-stat-note")).toContainText(`aproveitável ${String(aproveitavel)}`);
});


/**
 * GERIR O VÍNCULO DE DENTRO DO SKU (D-316).
 *
 * O pedido do dono: adicionar por MLB com confirmação, remover com
 * confirmação, e as duas telas trabalhando sobre a MESMA fonte. Este caso
 * percorre o ciclo inteiro numa corrida só — vincular, ver aparecer, remover,
 * ver sumir —, porque as duas metades separadas passariam mesmo se a escrita
 * fosse para um lugar que a leitura não lê.
 */
test("Dashboard do SKU: vincular um anúncio por MLB e remover o vínculo, com confirmação", async ({ page }) => {
  const seed = await readSeedOutput();
  // O anúncio sem vínculo nenhum do seed — é o que dá para vincular sem
  // desfazer nada.
  const alvo = E2E_LISTINGS.find((anuncio) => anuncio.vinculo === "nenhum");

  await login(page, `/skus/${seed.skuId}?aba=anuncios`);

  await expect(page.getByRole("region", { name: "Anúncios vinculados" })).toBeVisible();
  await expect(page.getByText(alvo?.itemId ?? "")).toHaveCount(0);

  await page.getByRole("button", { name: "+ Vincular anúncio" }).click();

  const modal = page.getByRole("dialog", { name: "Vincular anúncio" });

  await expect(modal).toBeVisible();

  /*
    A CONFIRMAÇÃO É O PONTO DA FATIA: `create_sku_listing_link` não confere se
    o anúncio existe (não há FK, só o regex), então um MLB errado viraria
    vínculo morto em silêncio. A tela procura ANTES e, quando não acha, recusa
    — e não afirma que o anúncio não existe, porque não sabemos.
  */
  await modal.getByLabel("MLB / id do anúncio").fill("MLB999999999");
  await modal.getByRole("button", { name: "Procurar anúncio" }).click();

  await expect(modal.getByText("Não encontramos este anúncio")).toBeVisible();
  await expect(modal.getByRole("button", { name: "Confirmar vinculação" })).toHaveCount(0);

  // Agora o MLB de verdade: a tela mostra o que encontrou antes de gravar.
  await modal.getByLabel("MLB / id do anúncio").fill(alvo?.itemId ?? "");
  await modal.getByRole("button", { name: "Procurar anúncio" }).click();

  await expect(modal.getByText("Anúncio encontrado")).toBeVisible();
  await expect(modal).toContainText(alvo?.title ?? "");

  await modal.getByRole("button", { name: "Confirmar vinculação" }).click();

  const linha = page.locator("tbody tr", { hasText: alvo?.itemId ?? "" });

  await expect(linha).toBeVisible();

  // E a remoção, com a frase que o dono pediu: nada acontece no Mercado Livre.
  await linha.getByRole("button", { name: "Remover" }).click();

  const confirmacao = page.getByRole("dialog", { name: "Remover vinculação" });

  await expect(confirmacao).toContainText("não");
  await expect(confirmacao).toContainText("Mercado Livre");

  await confirmacao.getByRole("button", { name: "Remover vinculação" }).click();

  await expect(page.locator("tbody tr", { hasText: alvo?.itemId ?? "" })).toHaveCount(0);
});


/**
 * D-718: a remoção que perde a conexão no meio. O POST bloqueado deixava o
 * diálogo preso em "Removendo…", com Cancelar e Esc desligados. O caso cria o
 * vínculo pela tela, num anúncio do seed sem vínculo, e apaga o que sobrar.
 */
test("Dashboard do SKU: falha de conexão ao remover o vínculo libera o diálogo e permite nova tentativa", async ({ page }) => {
  const seed = await readSeedOutput();
  const alvo = E2E_LISTINGS.find((anuncio) => anuncio.vinculo === "nenhum");

  if (alvo === undefined) throw new Error("O seed não tem anúncio sem vínculo.");

  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");

  const db = createClient<Database>(url.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false },
  });
  const destino = `/skus/${seed.skuId}`;
  const erros: string[] = [];

  page.on("pageerror", (erro) => erros.push(erro.message));

  const vinculoDoAlvo = () =>
    db.from("sku_listing_links").select("id").eq("organization_id", seed.organizationId).eq("item_id", alvo.itemId);

  try {
    await login(page, `${destino}?aba=anuncios`);
    await page.getByRole("button", { name: "+ Vincular anúncio" }).click();

    const modal = page.getByRole("dialog", { name: "Vincular anúncio" });

    await modal.getByLabel("MLB / id do anúncio").fill(alvo.itemId);
    await modal.getByRole("button", { name: "Procurar anúncio" }).click();
    await expect(modal.getByText("Anúncio encontrado")).toBeVisible();
    await modal.getByRole("button", { name: "Confirmar vinculação" }).click();

    const linha = page.locator("tbody tr", { hasText: alvo.itemId });

    await expect(linha).toBeVisible();

    let bloqueada = false;

    await page.route(
      (endereco) => endereco.pathname === destino,
      async (rota) => {
        const pedido = rota.request();

        if (!bloqueada && pedido.method() === "POST" && pedido.headers()["next-action"] !== undefined) {
          bloqueada = true;
          await rota.abort("failed");
        } else {
          await rota.continue();
        }
      },
    );

    await linha.getByRole("button", { name: "Remover" }).click();

    const confirmacao = page.getByRole("dialog", { name: "Remover vinculação" });
    const remover = confirmacao.getByRole("button", { name: "Remover vinculação", exact: true });

    await remover.click();
    await expect(confirmacao.getByRole("alert")).toContainText("Não foi possível confirmar");
    await expect(remover).toBeEnabled();
    await expect(confirmacao.getByRole("button", { name: "Cancelar", exact: true })).toBeEnabled();
    expect(bloqueada).toBe(true);
    expect(erros).toEqual([]);

    const antes = await vinculoDoAlvo();

    expect(antes.error).toBeNull();
    expect(antes.data).toHaveLength(1);

    await remover.click();
    await expect(confirmacao).toHaveCount(0);
    await expect(page.locator("tbody tr", { hasText: alvo.itemId })).toHaveCount(0);

    const depois = await vinculoDoAlvo();

    expect(depois.error).toBeNull();
    expect(depois.data).toHaveLength(0);
  } finally {
    const limpeza = await db
      .from("sku_listing_links")
      .delete()
      .eq("organization_id", seed.organizationId)
      .eq("item_id", alvo.itemId);

    expect.soft(limpeza.error).toBeNull();
  }
});

/**
 * D-719: o vínculo que perde a conexão no meio. O POST bloqueado deixava o
 * diálogo em "Gravando o vínculo…", com Cancelar e Esc desligados. O anúncio
 * encontrado fica no diálogo para a nova tentativa.
 */
test("Dashboard do SKU: falha de conexão ao vincular o anúncio conserva o anúncio e permite nova tentativa", async ({ page }) => {
  const seed = await readSeedOutput();
  const alvo = E2E_LISTINGS.find((anuncio) => anuncio.vinculo === "nenhum");

  if (alvo === undefined) throw new Error("O seed não tem anúncio sem vínculo.");

  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");

  const db = createClient<Database>(url.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false },
  });
  const destino = `/skus/${seed.skuId}`;
  const erros: string[] = [];

  page.on("pageerror", (erro) => erros.push(erro.message));

  const vinculoDoAlvo = () =>
    db.from("sku_listing_links").select("sku_id").eq("organization_id", seed.organizationId).eq("item_id", alvo.itemId);

  try {
    await login(page, `${destino}?aba=anuncios`);
    await page.getByRole("button", { name: "+ Vincular anúncio" }).click();

    const modal = page.getByRole("dialog", { name: "Vincular anúncio" });

    await modal.getByLabel("MLB / id do anúncio").fill(alvo.itemId);
    await modal.getByRole("button", { name: "Procurar anúncio" }).click();
    await expect(modal.getByText("Anúncio encontrado")).toBeVisible();

    let bloqueada = false;

    await page.route(
      (endereco) => endereco.pathname === destino,
      async (rota) => {
        const pedido = rota.request();

        if (!bloqueada && pedido.method() === "POST" && pedido.headers()["next-action"] !== undefined) {
          bloqueada = true;
          await rota.abort("failed");
        } else {
          await rota.continue();
        }
      },
    );

    const confirmar = modal.getByRole("button", { name: "Confirmar vinculação", exact: true });

    await confirmar.click();
    await expect(modal.getByRole("alert")).toContainText("Não foi possível confirmar");
    await expect(modal.getByText("Anúncio encontrado")).toBeVisible();
    await expect(modal).toContainText(alvo.title);
    await expect(confirmar).toBeEnabled();
    await expect(modal.getByRole("button", { name: "Cancelar", exact: true })).toBeEnabled();
    expect(bloqueada).toBe(true);
    expect(erros).toEqual([]);

    const antes = await vinculoDoAlvo();

    expect(antes.error).toBeNull();
    expect(antes.data).toHaveLength(0);

    await confirmar.click();
    await expect(modal).toHaveCount(0);
    await expect(page.locator("tbody tr", { hasText: alvo.itemId })).toBeVisible();

    const depois = await vinculoDoAlvo();

    expect(depois.error).toBeNull();
    expect(depois.data?.map((linha) => linha.sku_id)).toEqual([seed.skuId]);
  } finally {
    const limpeza = await db
      .from("sku_listing_links")
      .delete()
      .eq("organization_id", seed.organizationId)
      .eq("item_id", alvo.itemId);

    expect.soft(limpeza.error).toBeNull();
  }
});

/**
 * A ABA DIAGNÓSTICO (D-317) — três níveis, cada um com régua escrita.
 *
 * A aba era UMA LINHA: um botão que calculava a anomalia de venda no clique, e
 * nada mais. A ação que o job diário já tinha persistido para este mesmo SKU
 * não aparecia em lugar nenhum dela, embora a Central de Ações mandasse o
 * operador para cá.
 *
 * O que estes casos guardam é o que separa diagnóstico de enfeite: todo selo
 * mostra a CONDIÇÃO que o acendeu, e o que não tem condição escrita não vira
 * selo — vai para o painel do que a tela não julga.
 */
test("Dashboard do SKU: o diagnóstico julga com régua, e diz o que não julga", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}?aba=diagnostico`);

  const saude = page.getByRole("region", { name: "Saúde do SKU" });

  await expect(saude).toBeVisible();

  // O seed tem uma ação ABERTA de severidade alta para este SKU: o nível do
  // SKU é o pior entre as verificações, então ele é Crítico.
  await expect(saude.locator(".sb-stat", { hasText: "Nível" }).locator(".sb-stat-value")).toHaveText("Crítico");

  // Estoque anunciado e interno LADO A LADO, sem subtração: o interno é da
  // organização e o anunciado é por anúncio — grãos diferentes, e "divergência"
  // exigiria o mesmo grão.
  await expect(saude.locator(".sb-stat", { hasText: "Estoque anunciado" })).toContainText("interno:");

  /*
    A DISPERSÃO DE PREÇO ESPEROU A RÉGUA. Em D-317 ela era número sem selo;
    o dono decidiu o teto (10% sobre o menor, por organização, D-318) e ela
    virou verificação — o número continua ao lado, com o teto junto.
  */
  // "Preço ao comprador" (D-389): o número é o EFETIVO — promocional quando
  // há campanha ativa do Mercado Livre, senão o cadastrado.
  await expect(saude.locator(".sb-stat", { hasText: "Preço ao comprador" })).toContainText("sobre o menor (teto 10%)");

  const problemas = page.getByRole("region", { name: "Problemas encontrados" });

  // As quatro partes que o dono pediu, e a régua junto de cada uma.
  await expect(problemas).toContainText("Problema");
  await expect(problemas).toContainText("Possível causa");
  await expect(problemas).toContainText("Recomendação");
  await expect(problemas).toContainText("acendeu por:");

  /*
    E A LISTA DO QUE NÃO DÁ PARA JULGAR. Ela é a metade que impede a outra de
    mentir: sem teto configurado não há selo de dispersão, e o diagnóstico
    julga só o Mercado Livre — os anúncios da Shopee (D-429) estão na aba
    Anúncios, sem régua aqui.
  */
  // O seed tem 26,4% de diferença entre os dois anúncios: acima do teto.
  await expect(problemas).toContainText("Preços muito diferentes entre os anúncios");
  await expect(problemas).toContainText("teto da organização");

  const naoJulga = page.getByRole("region", { name: "O que esta tela NÃO julga" });

  await expect(naoJulga).toContainText("Mercado Livre");
  await expect(naoJulga).toContainText("catálogo");

  // O motor de anomalia de venda continua onde estava, e continua sob demanda.
  await expect(page.getByRole("button", { name: "O que aconteceu?" })).toBeVisible();
});

test("SKU: todos os anúncios ML aparecem acima de mil, incluindo vínculo por variação e anúncio sem leitura", async ({ page }) => {
  test.setTimeout(60_000);
  const seed = await readSeedOutput();
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");

  const db = createClient<Database>(url.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false },
  });
  const sku = await db.from("skus").insert({
    organization_id: seed.organizationId,
    sku: "E2E-SKU-PAGINACAO-ML",
    title: "Produto E2E com mais de mil anúncios",
  }).select("id").single();

  if (sku.error !== null) throw new Error(sku.error.message);

  const slugs = ["e2e-paginacao-ml-0", "e2e-paginacao-ml-1"];
  try {
    const contas: string[] = [];
    for (const [indice, slug] of slugs.entries()) {
      const conta = await db.from("ml_accounts").insert({
        organization_id: seed.organizationId,
        slug,
        label: "Conta E2E de paginação",
        status: "CONNECTED",
        seller_id: 720000001 + indice,
        connected_at: new Date().toISOString(),
      }).select("id").single();

      if (conta.error !== null) throw new Error(conta.error.message);
      contas.push(conta.data.id);

      // Mesmos nomes, títulos e MLBs em duas contas exercitam o desempate da paginação.
      const anuncios = await db.from("listings").insert(Array.from({ length: 500 }, (_, n) => ({
        organization_id: seed.organizationId,
        ml_account_id: conta.data.id,
        item_id: `MLB720000${String(n + 1).padStart(3, "0")}`,
        sku_id: sku.data.id,
        title: "Anúncio E2E da paginação",
        status: "active",
        price: 100,
        currency_id: "BRL",
        available_quantity: 1,
        synced_at: new Date().toISOString(),
      })));

      if (anuncios.error !== null) throw new Error(anuncios.error.message);
    }

    const primeiraConta = contas[0];
    if (primeiraConta === undefined) throw new Error("A fixture precisa de uma conta.");

    const especiais = await db.from("listings").insert([
      {
        organization_id: seed.organizationId, ml_account_id: primeiraConta,
        item_id: "MLB729999998", title: "Anúncio E2E da paginação", status: "active",
        price: 100, currency_id: "BRL", available_quantity: 1, synced_at: new Date().toISOString(),
      },
      {
        organization_id: seed.organizationId, ml_account_id: primeiraConta, sku_id: sku.data.id,
        item_id: "MLB729999997", title: "Anúncio excluído E2E", status: "closed",
        price: 100, currency_id: "BRL", available_quantity: 0,
        synced_at: new Date().toISOString(), deleted_at: new Date().toISOString(),
      },
    ]);
    if (especiais.error !== null) throw new Error(especiais.error.message);

    const vinculos = await db.from("sku_listing_links").insert([
      {
        organization_id: seed.organizationId, ml_account_id: primeiraConta, sku_id: sku.data.id,
        ref_kind: "ITEM", item_id: "MLB729999998", variation_id: "72001", source: "MANUAL",
      },
      {
        organization_id: seed.organizationId, ml_account_id: primeiraConta, sku_id: sku.data.id,
        ref_kind: "ITEM", item_id: "MLB729999999", source: "MANUAL",
      },
    ]);
    if (vinculos.error !== null) throw new Error(vinculos.error.message);

    const origem = `/skus/${sku.data.id}`;
    await login(page, origem + "?aba=anuncios");
    const painel = page.getByRole("region", { name: "Anúncios vinculados", exact: true });
    const linhas = painel.locator("tbody tr");

    await expect(linhas).toHaveCount(1_002, { timeout: 20_000 });
    const codigos = await linhas.locator(".sb-skud-mono-caption a").allTextContents();
    expect(codigos.sort()).toEqual([
      ...Array.from({ length: 500 }, (_, n) => `MLB720000${String(n + 1).padStart(3, "0")}`)
        .flatMap((codigo) => [codigo, codigo]),
      "MLB729999998", "MLB729999999",
    ].sort());
    await expect(painel).toContainText("1002 anúncios deste SKU");
    await expect(linhas.filter({ hasText: "MLB720000001" })).toHaveCount(2);
    await expect(linhas.filter({ hasText: "MLB729999998" })).toContainText("por variação");
    await expect(linhas.filter({ hasText: "MLB729999999" })).toContainText("ainda não sincronizado");
    await expect(linhas.filter({ hasText: "MLB729999997" })).toHaveCount(0);

    await page.goto(origem + "?aba=diagnostico");
    const saude = page.getByRole("region", { name: "Saúde do SKU", exact: true });
    await expect(saude.locator(".sb-stat").filter({
      has: page.getByText("Anúncios", { exact: true }),
    }).locator(".sb-stat-value")).toHaveText("1.002");
  } finally {
    const removidas = await db.from("ml_accounts").delete()
      .eq("organization_id", seed.organizationId).in("slug", slugs);
    const removido = await db.from("skus").delete().eq("id", sku.data.id);

    expect.soft(removidas.error).toBeNull();
    expect.soft(removido.error).toBeNull();
  }
});

test("Diagnóstico do SKU: Reler agora lê dados novos e preserva o escopo da conta", async ({ page }) => {
  const seed = await readSeedOutput();
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");

  const db = createClient<Database>(url.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false },
  });
  const original = await db.from("listings")
    .select("id, ml_account_id, available_quantity")
    .eq("organization_id", seed.organizationId)
    .eq("item_id", E2E_LISTINGS[0].itemId)
    .single();

  if (original.error !== null) throw new Error(original.error.message);

  const conta = await db.from("ml_accounts").insert({
    organization_id: seed.organizationId,
    slug: "e2e-reler-diagnostico",
    label: "Conta E2E da releitura",
    status: "CONNECTED",
    seller_id: 710000001,
    connected_at: new Date().toISOString(),
  }).select("id").single();

  if (conta.error !== null) throw new Error(conta.error.message);

  try {
    let quantidadeOutraConta = 97;
    let quantidadeOriginal = original.data.available_quantity;
    const anuncio = await db.from("listings").insert({
      organization_id: seed.organizationId,
      ml_account_id: conta.data.id,
      item_id: "MLB710000001",
      sku_id: seed.skuId,
      title: "Anúncio da conta E2E da releitura",
      status: "active",
      price: 100,
      currency_id: "BRL",
      available_quantity: quantidadeOutraConta,
      synced_at: new Date().toISOString(),
    }).select("id").single();

    if (anuncio.error !== null) throw new Error(anuncio.error.message);

    const caminho = `/skus/${seed.skuId}`;
    await login(page, `${caminho}?aba=diagnostico`);
    await expect(page.getByRole("region", { name: "Saúde do SKU", exact: true })).toBeVisible();

    for (const escopo of [null, original.data.ml_account_id]) {
      const origem = `${caminho}?aba=diagnostico${escopo === null ? "" : `&escopo=${escopo}`}`;

      await page.goto(origem);
      const saude = page.getByRole("region", { name: "Saúde do SKU", exact: true });
      const estoque = saude.locator(".sb-stat").filter({
        has: page.getByText("Estoque anunciado", { exact: true }),
      }).locator(".sb-stat-value");
      const reler = saude.getByRole("link", { name: /^Reler agora/ });

      await expect(reler).toHaveAttribute("href", origem);
      await page.waitForLoadState("networkidle");
      const antes = Number((await estoque.innerText()).replace(/\D/gu, ""));

      // Altera as duas contas. No recorte, só os 13 da conta escolhida entram.
      quantidadeOriginal += 13;
      quantidadeOutraConta += 31;
      const atualizado = await db.from("listings")
        .update({ available_quantity: quantidadeOriginal }).eq("id", original.data.id);
      const outra = await db.from("listings")
        .update({ available_quantity: quantidadeOutraConta }).eq("id", anuncio.data.id);

      if (atualizado.error !== null) throw new Error(atualizado.error.message);
      if (outra.error !== null) throw new Error(outra.error.message);

      await page.route(
        (destino) => destino.pathname === caminho
          && destino.searchParams.has("_rsc")
          && destino.searchParams.get("aba") === "diagnostico"
          && destino.searchParams.get("escopo") === escopo,
        async (route) => {
          await new Promise((pronto) => setTimeout(pronto, 1_200));
          await route.continue();
        },
      );

      await reler.click();
      await expect(page.locator(".sb-content[aria-busy='true']")).toHaveCount(1);
      await expect(estoque).toHaveText(String(antes));
      await expect(estoque).toHaveText(String(antes + (escopo === null ? 44 : 13)));
      await expect(page).toHaveURL((destino) => destino.pathname + destino.search === origem);
      await expect(page.locator(".sb-content[aria-busy]")).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "Abas do SKU" })
        .getByRole("link", { name: "Diagnóstico", exact: true })).toHaveAttribute("aria-current", "page");
    }
  } finally {
    const restaurado = await db.from("listings")
      .update({ available_quantity: original.data.available_quantity }).eq("id", original.data.id);
    const removida = await db.from("ml_accounts").delete().eq("id", conta.data.id);

    expect.soft(restaurado.error).toBeNull();
    expect.soft(removida.error).toBeNull();
  }
});

test("Diagnóstico do SKU: falha de transporte em 'O que aconteceu?' destrava o botão e permite tentar de novo", async ({
  page,
}) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}?aba=diagnostico`);

  const secao = page.getByRole("region", { name: "Diagnóstico de venda" });
  const botao = secao.getByRole("button", { name: "O que aconteceu?" });

  const caiu = await derrubarPrimeiraAcao(page);
  await botao.click();

  expect(caiu()).toBe(true);
  await expect(secao.getByRole("alert")).toContainText("Não foi possível");
  await expect(botao).toBeEnabled();

  await botao.click();
  await expect(secao.getByRole("alert")).toHaveCount(0);
  await expect(secao.getByText(/Histórico insuficiente|nenhuma anomalia|Veredito/)).toBeVisible();
});
