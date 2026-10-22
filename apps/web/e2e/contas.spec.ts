import { expect, test } from "@playwright/test";

import { E2E_SHOPEE_ESPERADO, E2E_SHOPEE_SHOP } from "./constants.js";
import { login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * `/contas` — o painel "Lojas Shopee" (D-425). O que só se prova rodando: a
 * leitura de `shopee_shops` sob a RLS do usuário do seed (membro da
 * organização), o ambiente dito por extenso e o botão de conectar para o ADMIN.
 * O clique em si chama a api, que este e2e não sobe.
 */
test("/contas: o painel Lojas Shopee lista a loja da organização e oferece conectar ao ADMIN", async ({ page }) => {
  await login(page, "/contas");

  // O título e o menu falam dos dois canais (D-431): a Shopee se conecta aqui.
  await expect(page.getByRole("heading", { level: 1, name: "Contas e lojas" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Contas e lojas" }).first()).toBeVisible();

  const tabela = page.getByRole("table", { name: "Lojas Shopee" });

  await expect(tabela).toBeVisible();
  await expect(tabela.getByRole("row", { name: new RegExp(E2E_SHOPEE_SHOP.name) })).toContainText("Teste (sandbox)");
  await expect(tabela.getByRole("row", { name: new RegExp(E2E_SHOPEE_SHOP.name) })).toContainText("Conectada");
  await expect(tabela).toContainText(String(E2E_SHOPEE_SHOP.shopId));
  await expect(page.getByRole("button", { name: "Conectar loja Shopee" })).toBeVisible();
});

/**
 * A coluna "Anúncios" da loja Shopee (D-429): o tamanho do catálogo e quantos
 * estão vinculados, contados no banco (`get_shopee_shop_catalog_counts`) — os
 * MESMOS números da faixa de `/anuncios/shopee`, conferidos contra
 * `E2E_SHOPEE_ESPERADO`, que está escrito à mão. O número leva à lista da loja.
 */
test("/contas: a loja Shopee do seed mostra quantos anúncios tem e quantos estão vinculados", async ({ page }) => {
  await login(page, "/contas");

  const linha = page.getByRole("table", { name: "Lojas Shopee" }).getByRole("row", {
    name: new RegExp(E2E_SHOPEE_SHOP.name),
  });
  const resumo = `${String(E2E_SHOPEE_ESPERADO.anuncios)} anúncios · ${String(E2E_SHOPEE_ESPERADO.vinculados)} vinculados`;

  await expect(linha.getByRole("link", { name: resumo, exact: true })).toHaveAttribute(
    "href",
    /^\/anuncios\/shopee\?loja=[0-9a-f-]{36}$/,
  );
  // A loja do seed foi lida há meia hora: a linha diz quando, e não "ainda não lido".
  await expect(linha).toContainText("lido há");
  await expect(linha).not.toContainText("catálogo ainda não lido");
});

/**
 * D-600: a faixa de `/contas` conta as contas do Mercado Livre E as lojas
 * Shopee -- o número é a soma das duas listas da própria tela (os cartões das
 * contas e as linhas da tabela das lojas), com a divisão dita ao lado. A loja do
 * seed é de teste e conectada, com a autorização a um ano: não requer atenção.
 */
test("/contas: a faixa conta as contas do ML e as lojas Shopee, com a divisão ao lado (D-600)", async ({ page }) => {
  await login(page, "/contas");

  const cadastradas = page.locator(".sb-kpi").filter({ hasText: "Contas e lojas cadastradas" });
  const linhasDasLojas = page.getByRole("table", { name: "Lojas Shopee" }).locator("tbody > tr");

  // Espera as duas listas chegarem antes de contar: count() não espera.
  await expect(linhasDasLojas).toHaveCount(1);
  await expect(page.locator(".sb-account-card").first()).toBeVisible();

  const cartoes = await page.locator(".sb-account-card").count();
  const lojas = await linhasDasLojas.count();
  await expect(cadastradas.locator(".sb-kpi-value")).toHaveText(String(cartoes + lojas));
  await expect(cadastradas).toContainText(`${String(cartoes)} do Mercado Livre · 1 da Shopee (1 de teste)`);
  await expect(page.locator(".sb-kpi").filter({ hasText: "Requerem atenção" })).toContainText("· 0 da Shopee");
  await expect(page.getByText("reautorize na Shopee")).toHaveCount(0);
});

/**
 * D-652 (o C-86 do A1, D-645): as lojas do TikTok Shop na `/contas`. O seed não
 * tem loja do TikTok: o painel diz que não há, o botão aparece ao ADMIN e a faixa
 * diz "0 do TikTok Shop" (a leitura veio; zero é fato). Depois, duas lojas entram
 * pela chave de serviço -- uma conectada com a autorização a 3 dias de vencer, e
 * uma com erro -- e saem no `finally`. O clique no botão vai à api, que este e2e
 * não sobe: as respostas da api são simuladas na rota.
 */
test.describe("/contas: as lojas do TikTok Shop (D-652, C-86)", () => {
  test("sem loja, o painel diz que não há, o ADMIN vê o botão e a faixa diz zero", async ({ page }) => {
    await login(page, "/contas");

    const painel = page.getByRole("region", { name: "Lojas do TikTok Shop" });

    await expect(painel).toContainText("Nenhuma loja do TikTok Shop conectada ainda.");
    await expect(painel.getByRole("button", { name: "Conectar loja do TikTok Shop" })).toBeVisible();
    await expect(painel).toContainText("Depois de autorizar no TikTok Shop, volte para esta tela");
    await expect(page.locator(".sb-kpi").filter({ hasText: "Contas e lojas cadastradas" })).toContainText("· 0 do TikTok Shop");
  });

  test("o 503 da api é o TikTok ainda desligado: aviso sem erro; o 409 é erro", async ({ page }) => {
    let resposta: { status: number; body: unknown } = { status: 503, body: { error: { code: "not_configured" } } };

    await page.route("**/v1/tiktok-shop/connect", async (route) => {
      await route.fulfill({ status: resposta.status, contentType: "application/json", body: JSON.stringify(resposta.body) });
    });
    await login(page, "/contas");

    const painel = page.getByRole("region", { name: "Lojas do TikTok Shop" });
    const botao = painel.getByRole("button", { name: "Conectar loja do TikTok Shop" });

    await botao.click();
    await expect(painel.getByRole("status")).toHaveText("O TikTok Shop ainda não está disponível.");
    await expect(painel.getByRole("alert")).toHaveCount(0);

    resposta = { status: 409, body: { error: { code: "rejected", message: "não foi possível iniciar a autorização" } } };
    await botao.click();
    await expect(painel.getByRole("alert")).toHaveText("O TikTok Shop não deixou a autorização começar. Tente de novo.");
    await expect(painel.getByRole("status")).toHaveCount(0);
  });

  test("com lojas, a tabela, a autorização vencendo e a faixa contam o TikTok", async ({ page }) => {
    const seed = await readSeedOutput();
    const db = clienteDeServico();
    const vence = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const inseridas = await db
      .from("tiktok_shops")
      .insert([
        {
          organization_id: seed.organizationId,
          shop_id: "7495000000000000001",
          shop_name: "Loja TikTok E2E",
          region: "BR",
          seller_type: "LOCAL",
          seller_name: "Vendedor E2E",
          granted_scopes: ["seller.authorization.info", "seller.order.info", "seller.product.basic"],
          status: "CONNECTED",
          auth_expires_at: vence,
        },
        {
          organization_id: seed.organizationId,
          shop_id: "7495000000000000002",
          shop_name: null,
          status: "ERROR",
          last_error: "O TikTok Shop recusou a renovação do acesso: refresh token expired",
        },
      ])
      .select("id");

    expect(inseridas.error).toBeNull();

    try {
      await login(page, "/contas");

      const tabela = page.getByRole("table", { name: "Lojas do TikTok Shop" });
      const conectada = tabela.getByRole("row", { name: /Loja TikTok E2E/u });
      const comErro = tabela.getByRole("row", { name: /Loja sem nome lido/u });

      await expect(conectada).toContainText("7495000000000000001 · BR");
      await expect(conectada).toContainText("Vendedor E2E");
      await expect(conectada).toContainText("Conectada");
      await expect(conectada).toContainText("3 permissões");
      await expect(conectada).toContainText("reautorize no TikTok Shop: vence em até 7 dias");
      await expect(comErro).toContainText("Com erro");
      await expect(comErro).toContainText("refresh token expired");
      // Sem permissões lidas nem vencimento: "—", nunca zero.
      await expect(comErro.getByRole("cell", { name: "—", exact: true })).toHaveCount(3);

      // A faixa: 2 lojas do TikTok cadastradas, 1 conectada, e as 2 requerem atenção.
      await expect(page.locator(".sb-kpi").filter({ hasText: "Contas e lojas cadastradas" })).toContainText("· 2 do TikTok Shop");
      await expect(page.locator(".sb-kpi").filter({ hasText: "Conectadas" })).toContainText("· 1 do TikTok Shop");
      await expect(page.locator(".sb-kpi").filter({ hasText: "Requerem atenção" })).toContainText("· 2 do TikTok Shop");
    } finally {
      const apagou = await db.from("tiktok_shops").delete().in("shop_id", ["7495000000000000001", "7495000000000000002"]);

      if (apagou.error !== null) console.error(`lojas do TikTok da D-652 ficaram no banco: ${apagou.error.message}`);
    }
  });
});
