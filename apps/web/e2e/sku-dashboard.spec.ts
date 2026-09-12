import { expect, test } from "@playwright/test";

import {
  E2E_DECISION_TEXT,
  E2E_LISTINGS,
  E2E_LISTING_FULL,
  E2E_LOCAL_STOCK,
  E2E_SKU_SALES,
} from "./constants.js";
import { login } from "./helpers.js";
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
 * DIFF entre snapshots de 6 em 6 horas — logo "sem linha" não é "preço
 * parado", e a tela que dissesse "preço estável" estaria inventando.
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
  // O `<h2>` virou rótulo de seção e os números viraram cartões de indicador —
  // o vocabulário do design system. O que se afirma continua sendo o mesmo: o
  // título da seção, e cada número no seu cartão.
  await expect(page.getByText("Vendas do SKU", { exact: true })).toBeVisible();

  // Os seis números canônicos viraram UMA faixa de KPIs (a mesma apresentação
  // que /vendas dá às mesmas métricas), em vez de seis cartões soltos.
  const cartao = (rotulo: string) =>
    page.locator(".sb-kpi", { has: page.getByText(rotulo, { exact: true }) }).locator(".sb-kpi-value");

  await expect(cartao("Unidades vendidas")).toHaveText(String(unidades));
  // Razão sobre as SOMAS (500 / 5 = R$ 100,00), não média das razões diárias.
  await expect(cartao("Ticket médio")).toContainText(`${String(receita / compras)},00`);

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
  await expect(saude.locator(".sb-stat", { hasText: "Preço anunciado" })).toContainText("sobre o menor (teto 10%)");

  const problemas = page.getByRole("region", { name: "Problemas encontrados" });

  // As quatro partes que o dono pediu, e a régua junto de cada uma.
  await expect(problemas).toContainText("Problema");
  await expect(problemas).toContainText("Possível causa");
  await expect(problemas).toContainText("Recomendação");
  await expect(problemas).toContainText("acendeu por:");

  /*
    E A LISTA DO QUE NÃO DÁ PARA JULGAR. Ela é a metade que impede a outra de
    mentir: sem teto configurado não há selo de dispersão, e sem tabela de
    outra plataforma não há diagnóstico de Shopee.
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
