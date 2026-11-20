import { expect, test } from "@playwright/test";

import { E2E_SHOPEE_ESPERADO, E2E_SHOPEE_SHOP } from "./constants.js";
import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * `/contas` — o painel "Lojas Shopee" (D-425). O que só se prova rodando: a
 * leitura de `shopee_shops` sob a RLS do usuário do seed (membro da
 * organização), o ambiente dito por extenso e o botão de conectar para o ADMIN.
 * O clique em si chama a api, que este e2e não sobe.
 */
test("/contas: falha de conexão ao cadastrar conserva os campos e permite nova tentativa", async ({ page }) => {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const slug = "e2e-conta-falha-conexao";
  const label = "Conta E2E de falha de conexão";
  const lista = () => db.from("ml_accounts").select("label,status").eq("organization_id", seed.organizationId).eq("slug", slug);

  try {
    await login(page, "/contas");
    await page.getByLabel("Rótulo", { exact: true }).fill(label);
    await page.getByLabel("Identificador (nomeia a fila interna)", { exact: true }).fill(slug);
    const cadastrar = page.getByRole("button", { name: "Cadastrar conta", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await cadastrar.click();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível confirmar o cadastro" })).toBeVisible();
    await expect(cadastrar).toBeEnabled();
    await expect(page.getByLabel("Rótulo", { exact: true })).toHaveValue(label);
    await expect(page.getByLabel("Identificador (nomeia a fila interna)", { exact: true })).toHaveValue(slug);
    expect(caiu()).toBe(true);
    const antes = await lista();
    expect(antes.error).toBeNull();
    expect(antes.data).toEqual([]);

    await cadastrar.click();
    await expect(page.getByLabel("Rótulo", { exact: true })).toHaveValue("");
    const depois = await lista();
    expect(depois.error).toBeNull();
    expect(depois.data).toEqual([{ label, status: "PENDING" }]);
  } finally {
    const limpeza = await db.from("ml_accounts").delete().eq("organization_id", seed.organizationId).eq("slug", slug);
    expect.soft(limpeza.error).toBeNull();
  }
});

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
 * D-741: resposta 200 com JSON inválido (ex.: HTML de proxy) nos conectores
 * OAuth não pode travar o botão em estado ocupado nem gerar rejeição sem
 * feedback visível.
 */
test("/contas: JSON inválido em 200 OK ao conectar ML ou Shopee mostra alerta e reabilita botão (D-741)", async ({
  page,
}) => {
  const seed = await readSeedOutput();
  const db = clienteDeServico();
  const slug = `e2e-d741-${Date.now().toString(36)}`;

  await page.route("**/v1/shopee/connect", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<html><body>proxy</body></html>",
    });
  });

  await page.route("**/v1/ml-accounts/connect", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<html><body>proxy</body></html>",
    });
  });

  let limpeza: { error: { message: string } | null } | undefined;

  try {
    await login(page, "/contas");

    await page.getByLabel("Rótulo").fill("Conta D741");
    await page.getByLabel("Identificador (nomeia a fila interna)").fill(slug);
    await page.getByRole("button", { name: "Cadastrar conta" }).click();

    const botaoMl = page.getByRole("button", { name: "Conectar Conta D741 ao Mercado Livre" });
    await expect(botaoMl).toBeVisible();
    await botaoMl.click();

    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível" })).toBeVisible();
    await expect(botaoMl).toBeEnabled();

    const botaoShopee = page.getByRole("button", { name: "Conectar loja Shopee" });
    await expect(botaoShopee).toBeVisible();
    await botaoShopee.click();

    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível" })).toHaveCount(2);
    await expect(botaoShopee).toBeEnabled();
  } finally {
    limpeza = await db.from("ml_accounts").delete().eq("organization_id", seed.organizationId).eq("slug", slug);
  }

  expect(limpeza.error).toBeNull();
});
