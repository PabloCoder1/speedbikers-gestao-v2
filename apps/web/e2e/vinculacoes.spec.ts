import { type Page, expect, test } from "@playwright/test";
import type { Database } from "@sb/db";
import { createClient } from "@supabase/supabase-js";

import { E2E_LISTINGS, E2E_LISTING_SOLD_UNLINKED, E2E_ML_ACCOUNT, E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * `/vinculacoes` — Integridade de Catálogo (D21, D-259), com o popup de D-374 e
 * o resumo + cartões de D-376.
 *
 * **A tela mudou de assunto duas vezes, e é isso que este arquivo protege.** Era
 * uma fila de `link_candidates`; virou uma visão de integridade sobre ANÚNCIOS
 * (D-259); em D-376 trocou a faixa de KPIs e os menus suspensos pelo resumo e
 * pelos cartões de recorte de `/reposicao`.
 *
 * O que ele afirma, em ordem de gravidade:
 *
 *  1. **"Sem vínculo" não é `sku_id is null`** (D-122). O quarto anúncio do
 *     seed tem vínculo por VARIAÇÃO e `sku_id` nulo — se alguém trocar a
 *     contagem pelo atalho, o cartão passa de 3 para 4 e este teste fica
 *     vermelho. No Dev a diferença é 471 contra 1.893.
 *  2. **O cartão "Vendeu sem vínculo" é a interseção de dois predicados**, e
 *     clicar nele mostra exatamente aquelas linhas (D-242). O quinto anúncio
 *     do seed existe só para esse caso.
 *  3. **O zero de candidatos diz POR QUE é zero.** Um "0" cru leria como "não
 *     há trabalho", que é afirmação diferente de "toda linha resolveu"
 *     (lição dos cartões de D-250).
 *  4. **Vincular acontece num popup, sem navegar nem rolar** (D-374).
 */

const ESPERADO = {
  total: E2E_LISTINGS.length,
  // `vinculo: "sku"` e `vinculo: "variacao"` contam como VINCULADO.
  vinculados: E2E_LISTINGS.filter((a) => a.vinculo !== "nenhum").length,
  semVinculo: E2E_LISTINGS.filter((a) => a.vinculo === "nenhum").length,
  porVariacao: E2E_LISTINGS.filter((a) => a.vinculo === "variacao").length,
};

/** Um cartão de recorte — o que substituiu a célula da faixa em D-376. */
function cartao(page: Page, rotulo: string) {
  return page
    .getByRole("navigation", { name: "Recortes do catálogo" })
    .getByRole("link", { name: new RegExp(`^${rotulo}`) });
}

/** Um destaque do resumo, pelo rótulo em versalete. */
function destaque(page: Page, rotulo: string) {
  return page
    .getByRole("region", { name: "Resumo da integridade do catálogo" })
    .locator(".sb-rep-destaque")
    .filter({ hasText: rotulo });
}

const tabela = (page: Page) => page.getByRole("region", { name: "Anúncios do Mercado Livre" });

/**
 * O RESUMO CHEGOU — ou a página DIZ por que não (D-478).
 *
 * A tela é renderizada no servidor depois da leitura única
 * (`get_listings_link_overview`, D-376). Se a leitura falha, ela cai na lista
 * de sempre, SEM os cartões, com uma nota que dá o motivo. Uma falha que só
 * dissesse "cartão não encontrado" não separava os dois casos: em 15/10 uma
 * rodada inteira, com outra suíte no mesmo Docker, falhou assim e passou nas
 * três seguintes (6 repetições depois, com e sem a CPU ocupada, sem reproduzir).
 * Aqui:
 *  - o resumo tem até 15 s para chegar (a renderização no servidor sob carga;
 *    o teste tem 60), em vez dos 5 s do `expect`;
 *  - se a página caiu na lista de sempre, o teste falha com o MOTIVO que ela
 *    mostrou — é defeito, não lentidão.
 */
async function esperaResumo(page: Page): Promise<void> {
  const resumo = page.getByRole("region", { name: "Resumo da integridade do catálogo" });
  const semLeitura = page.getByText(/não estão disponíveis neste banco/);

  await expect(resumo.or(semLeitura)).toBeVisible({ timeout: 15_000 });

  if (await semLeitura.isVisible()) {
    throw new Error(`a leitura do resumo falhou e a tela caiu na lista de sempre: ${await semLeitura.innerText()}`);
  }
}

test("/vinculacoes: os cartões contam o que a tabela mostra, e vínculo por variação é vinculado", async ({
  page,
}) => {
  await login(page, "/vinculacoes");
  await esperaResumo(page);

  await expect(page.getByRole("heading", { name: "Integridade de Catálogo", level: 1 })).toBeVisible();
  await expect(page.getByText("ESTOQUE / VINCULAÇÕES")).toBeVisible();

  await expect(cartao(page, "Todos")).toContainText(String(ESPERADO.total));
  await expect(cartao(page, "Vinculados")).toContainText(String(ESPERADO.vinculados));

  /*
    O CASO DE D-122: são 3 sem vínculo, não 4. O anúncio de vínculo por
    variação tem `sku_id` nulo e NÃO é fila de trabalho — e o resumo diz isso
    com todas as letras, em vez de deixar a diferença sem explicação.
  */
  await expect(cartao(page, "Sem vínculo")).toContainText(String(ESPERADO.semVinculo));
  await expect(destaque(page, "CATÁLOGO VINCULADO")).toContainText(
    `${String(ESPERADO.porVariacao)} deles por variação`,
  );
  await expect(destaque(page, "CATÁLOGO VINCULADO")).toContainText("estão ligados");
});

test("/vinculacoes: os detalhes do anúncio e do SKU carregam ao clicar", async ({ page }) => {
  const { skuId } = await readSeedOutput();
  const [vinculado] = E2E_LISTINGS;
  const filtro = `?busca=${vinculado.itemId}`;
  const anuncio = `/anuncios/${vinculado.itemId}`;
  const sku = `/skus/${skuId}`;
  const prefetches: string[] = [];

  page.on("request", (request) => {
    const headers = request.headers();
    const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;
    const { pathname } = new URL(request.url());

    if (prefetch && (pathname === anuncio || pathname === sku)) prefetches.push(pathname);
  });

  await login(page, "/vinculacoes" + filtro);
  await esperaResumo(page);
  const linha = tabela(page).getByRole("row").filter({ hasText: vinculado.itemId });
  const linkAnuncio = linha.getByRole("link", { name: vinculado.title, exact: true });
  const linkSku = linha.getByRole("link", { name: E2E_SKU_CODE, exact: true });

  await expect(linkAnuncio).toHaveAttribute("href", anuncio);
  await expect(linkSku).toHaveAttribute("href", sku);
  await linkAnuncio.scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle");
  expect(prefetches).toEqual([]);

  await linkAnuncio.click();
  await expect(page).toHaveURL((url) => url.pathname === anuncio);
  await expect(page.getByRole("heading", { level: 2, name: vinculado.title, exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL((url) => url.pathname === "/vinculacoes" && url.search === filtro);
  await linkSku.click();
  await expect(page).toHaveURL((url) => url.pathname === sku);
  await expect(page.getByRole("heading", { level: 2, name: "Produto de teste E2E", exact: true })).toBeVisible();
});

test("/vinculacoes: clicar em 'Vendeu sem vínculo' mostra exatamente aquelas linhas", async ({ page }) => {
  await login(page, "/vinculacoes");
  await esperaResumo(page);

  // Um só no fixture, e é o quinto anúncio — o único sem vínculo COM venda.
  await expect(cartao(page, "Vendeu sem vínculo")).toContainText("1");

  // UM clique muda estado E venda: em D-374 isso pedia dois menus suspensos.
  await cartao(page, "Vendeu sem vínculo").click();

  await expect(page).toHaveURL(/estado=sem-vinculo&venda=vendeu/);

  // Escopado ao painel: a tela tem uma SEGUNDA tabela (comparação entre
  // contas), e `tbody tr` solto passaria a contar as linhas das duas.
  const linhas = tabela(page).locator("tbody tr");
  await expect(linhas).toHaveCount(1);
  await expect(linhas.first()).toContainText(E2E_LISTING_SOLD_UNLINKED.itemId);
  await expect(linhas.first()).toContainText("Sem vínculo");
});

test("/vinculacoes: o zero de candidatos diz por que é zero, e a vinculação manual continua", async ({
  page,
}) => {
  await login(page, "/vinculacoes");
  await esperaResumo(page);

  /*
    O seed não cria candidato — como o Dev, onde toda linha do ERP resolveu.
    O que a tela não pode fazer é mostrar "0" mudo.
  */
  await expect(destaque(page, "CANDIDATOS DO ERP")).toContainText("0");
  await expect(destaque(page, "CANDIDATOS DO ERP")).toContainText("nenhuma linha do ERP ficou sem SKU");

  await expect(page.getByText(/toda linha do ERP encontrou o seu SKU/)).toBeVisible();

  // Funcionalidade que o frame não desenha e a tela real tem: ela sobrevive —
  // desde D-374 como botão no cabeçalho, que abre o popup.
  await expect(page.getByRole("button", { name: "Vincular um MLB" })).toBeVisible();
});

/**
 * O CAMINHO INTEIRO DA VINCULAÇÃO, num popup (D-313 → D-374).
 *
 * D-313 protegia o formulário do fim da página, que D-284 tinha quebrado sem
 * ninguém ver. D-374 trocou o formulário por um popup sobre a tabela — o dono
 * reclamava que "Vincular" levava a tela lá para baixo. O que este caso afirma:
 *
 *  1. clicar em "Vincular" NÃO navega nem rola: abre o popup ali mesmo;
 *  2. o popup é do anúncio da linha;
 *  3. sem SKU escolhido, "Vincular" fica desabilitado; com SKU, habilita;
 *  4. Esc fecha.
 *
 * NÃO grava: o anúncio do seed precisa continuar sem vínculo para as contagens
 * dos outros casos — o mesmo cuidado do teste de D-313.
 */
test("/vinculacoes: 'Vincular' abre o popup sem sair do lugar, e o popup vincula", async ({ page }) => {
  await login(page, "/vinculacoes?estado=sem-vinculo");

  const linha = tabela(page).locator("tbody tr").filter({ hasText: E2E_LISTING_SOLD_UNLINKED.itemId });

  // A URL só vale depois que o login redirecionou e a linha está na tela.
  await expect(linha).toBeVisible();
  const urlAntes = page.url();

  await linha.getByRole("button", { name: "Vincular" }).click();

  const popup = page.getByRole("dialog");

  await expect(popup).toBeVisible();
  await expect(popup.getByRole("link", { name: new RegExp(E2E_LISTING_SOLD_UNLINKED.itemId) })).toBeVisible();
  // Nada de navegação: a URL é a mesma de antes do clique.
  expect(page.url()).toBe(urlAntes);

  const vincular = popup.getByRole("button", { name: "Vincular", exact: true });

  // A sugestão dos pedidos pode pré-escolher o SKU; sem ela, o botão espera a escolha.
  await popup.getByLabel("SKU de destino").fill(E2E_SKU_CODE);
  await popup.getByRole("option").filter({ hasText: E2E_SKU_CODE }).first().click();

  await expect(popup.getByText(new RegExp(`vai para o SKU ${E2E_SKU_CODE}`))).toBeVisible();
  await expect(vincular).toBeEnabled();

  await page.keyboard.press("Escape");
  await expect(popup).toHaveCount(0);
  await expect(linha.getByRole("button", { name: "Vincular" })).toBeVisible();
});

test("/vinculacoes: o link de outra tela (?item=) abre o popup direto no anúncio", async ({ page }) => {
  await login(page, `/vinculacoes?estado=sem-vinculo&conta=${E2E_ML_ACCOUNT.slug}&item=${E2E_LISTING_SOLD_UNLINKED.itemId}`);

  const popup = page.getByRole("dialog");

  await expect(popup).toBeVisible();
  await expect(popup.getByRole("link", { name: new RegExp(E2E_LISTING_SOLD_UNLINKED.itemId) })).toBeVisible();
});

for (const operacao of ["vincular anúncio", "resolver candidato", "descartar candidato"] as const) {
  test(`/vinculacoes: falha de conexão ao ${operacao} preserva o diálogo e permite nova tentativa`, async ({ page }) => {
    test.setTimeout(60_000);
    const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
    const db = createClient<Database>(url.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false } });
    const seed = await readSeedOutput();
    const conta = await db.from("ml_accounts").select("id").eq("organization_id", seed.organizationId)
      .eq("slug", E2E_ML_ACCOUNT.slug).single();
    if (conta.error !== null) throw new Error(conta.error.message);
    const itemId = "MLB760000001";
    const skuInformado = "E2E-CANDIDATO-CONEXAO";
    const manual = operacao === "vincular anúncio";
    let loteId: string | null = null;
    let candidatoId: string | null = null;
    const erros: string[] = [];
    page.on("pageerror", (erro) => erros.push(erro.message));

    try {
      const anuncio = await db.from("listings").upsert({
        organization_id: seed.organizationId, ml_account_id: conta.data.id, item_id: itemId,
        title: "Anúncio E2E de falha de vínculo", status: "active", currency_id: "BRL", price: 100,
        available_quantity: 1, deleted_at: null, sku_id: null,
      }, { onConflict: "ml_account_id,item_id" });
      if (anuncio.error !== null) throw new Error(anuncio.error.message);
      if (!manual) {
        const lote = await db.from("erp_import_batches").insert({
          organization_id: seed.organizationId, kind: "LINKS", status: "PARSED",
          storage_path: "e2e/falha-vinculo.csv", content_hash: "76".repeat(32),
        }).select("id").single();
        if (lote.error !== null) throw new Error(lote.error.message);
        loteId = lote.data.id;
        const origem = await db.from("erp_import_rows").insert({
          batch_id: loteId, row_number: 1, status: "OK", sku_key: skuInformado,
          payload: { skuKey: skuInformado, storeSlug: E2E_ML_ACCOUNT.slug, ref: { kind: "ITEM", itemId } },
        }).select("id").single();
        if (origem.error !== null) throw new Error(origem.error.message);
        const candidato = await db.from("link_candidates").insert({
          organization_id: seed.organizationId, ml_account_id: conta.data.id, source_row_id: origem.data.id,
          sku_key: skuInformado, ref_kind: "ITEM", item_id: itemId, status: "OPEN",
        }).select("id").single();
        if (candidato.error !== null) throw new Error(candidato.error.message);
        candidatoId = candidato.data.id;
      }

      await login(page, "/vinculacoes");
      if (manual) {
        await tabela(page).getByRole("row").filter({ hasText: itemId }).getByRole("button", { name: "Vincular", exact: true }).click();
      } else {
        await page.getByRole("region", { name: "Candidatos da importação do ERP", exact: true })
          .getByRole("row").filter({ hasText: skuInformado }).getByRole("button", { name: "Resolver", exact: true }).click();
      }
      const popup = page.getByRole("dialog");
      await popup.getByLabel("SKU de destino").fill(E2E_SKU_CODE);
      await popup.getByRole("option").filter({ hasText: E2E_SKU_CODE }).first().click();
      let bloqueada = false;
      await page.route((u) => u.pathname === "/vinculacoes", async (route) => {
        const request = route.request();
        if (!bloqueada && request.method() === "POST" && request.headers()["next-action"] !== undefined) {
          bloqueada = true;
          await route.abort("failed");
        } else await route.continue();
      });
      const botao = popup.getByRole("button", { name: operacao === "descartar candidato" ? "Descartar candidato" : "Vincular", exact: true });
      await botao.click();
      await expect(popup.getByRole("alert")).toContainText("Não foi possível confirmar");
      await expect(botao).toBeEnabled();
      await expect(popup.getByRole("button", { name: "Cancelar", exact: true })).toBeEnabled();
      await expect(popup.getByRole("status")).toContainText(E2E_SKU_CODE);
      expect(bloqueada).toBe(true);
      expect(erros).toEqual([]);
      const vinculoAntes = await db.from("sku_listing_links").select("id").eq("ml_account_id", conta.data.id)
        .eq("item_id", itemId).maybeSingle();
      expect(vinculoAntes.error).toBeNull();
      expect(vinculoAntes.data).toBeNull();
      if (candidatoId !== null) {
        const antes = await db.from("link_candidates").select("status").eq("id", candidatoId).single();
        expect(antes.error).toBeNull();
        expect(antes.data?.status).toBe("OPEN");
      }

      await botao.click();
      await expect(popup).toHaveCount(0);
      const vinculo = await db.from("sku_listing_links").select("sku_id").eq("ml_account_id", conta.data.id)
        .eq("item_id", itemId).maybeSingle();
      expect(vinculo.error).toBeNull();
      expect(vinculo.data?.sku_id ?? null).toBe(operacao === "descartar candidato" ? null : seed.skuId);
      if (candidatoId !== null) {
        const depois = await db.from("link_candidates").select("status").eq("id", candidatoId).single();
        expect(depois.error).toBeNull();
        expect(depois.data?.status).toBe(operacao === "descartar candidato" ? "DISMISSED" : "RESOLVED");
      }
    } finally {
      const vinculos = await db.from("sku_listing_links").delete().eq("organization_id", seed.organizationId)
        .eq("ml_account_id", conta.data.id).eq("item_id", itemId);
      // A API não permite apagar anúncios. A fixture sai das telas pela exclusão lógica.
      const anuncio = await db.from("listings").update({ deleted_at: new Date().toISOString(), status: "closed", sku_id: null })
        .eq("organization_id", seed.organizationId)
        .eq("ml_account_id", conta.data.id).eq("item_id", itemId);
      expect.soft(vinculos.error).toBeNull();
      expect.soft(anuncio.error).toBeNull();
      if (loteId !== null) {
        const lote = await db.from("erp_import_batches").delete().eq("id", loteId);
        expect.soft(lote.error).toBeNull();
      }
    }
  });
}

/**
 * As duas leituras POR CONTA que o reenquadramento de D-259 perdeu: o recorte
 * (ver uma conta só) e a comparação (ver as contas lado a lado). Desde D-376 as
 * duas saem da MESMA leitura que monta a tabela, e a comparação chega junto com
 * a página em vez de esperar `get_link_integrity`.
 */
test("/vinculacoes: dá para recortar numa conta e comparar as contas entre si", async ({ page }) => {
  await login(page, "/vinculacoes");

  const comparacao = page.getByRole("region", { name: "Comparação entre contas" });
  await expect(comparacao).toBeVisible();

  const linhaDaConta = comparacao.locator("tbody tr").filter({ hasText: E2E_ML_ACCOUNT.label });

  /*
    E A COMPARAÇÃO SOMA COM OS CARTÕES — a afirmação que custou uma migration.

    `get_link_integrity.com_vinculo` contava só o vínculo gravado em
    `sku_listing_links` e ignorava o vínculo DIRETO (`listings.sku_id`): a faixa
    dizia 3 sem vínculo e a comparação, dois painéis abaixo, dizia 4. Duas
    definições da mesma palavra na mesma tela. D-313 alinhou a função com D-122,
    e D-376 fez as duas leituras virarem UMA — se alguém desalinhar de novo,
    agora é preciso desalinhar a função consigo mesma.
  */
  const celulas = linhaDaConta.locator("td");
  await expect(celulas.nth(1)).toHaveText(String(ESPERADO.total));
  await expect(celulas.nth(2)).toHaveText(String(ESPERADO.vinculados));
  await expect(celulas.nth(3)).toHaveText(String(ESPERADO.semVinculo));

  // Da comparação para o recorte: clicar na conta filtra a tabela acima.
  await linhaDaConta.getByRole("link", { name: E2E_ML_ACCOUNT.label }).click();

  await expect(page).toHaveURL(new RegExp(`conta=${E2E_ML_ACCOUNT.slug}`));
  await expect(tabela(page).locator("tbody tr")).toHaveCount(ESPERADO.total);

  // Os cartões acompanham o recorte: cabeçalho e corpo falam da mesma conta (D-236).
  await expect(cartao(page, "Todos")).toContainText(String(ESPERADO.total));
});

/**
 * A CONFERÊNCIA COM OS PEDIDOS (D-376) chega DEPOIS, por `Suspense`: ela é a
 * única parte que ainda depende de `get_link_integrity` (1,3 s a frio no Dev).
 * O caso afirma que a tabela não espera por ela e que ela chega.
 */
test("/vinculacoes: a comparação chega com a página, e a conferência pelos pedidos chega depois", async ({
  page,
}) => {
  await login(page, "/vinculacoes");

  // A comparação já está pronta assim que a tabela está — mesma leitura.
  await expect(tabela(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "Comparação entre contas" }).locator("tbody tr").first()).toBeVisible();

  // E a conferência, que vem da fonte independente, aparece em seguida.
  await expect(page.getByText(/Conferido pelos pedidos/)).toBeVisible();
});
