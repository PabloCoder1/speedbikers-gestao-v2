import { expect, test } from "@playwright/test";

import { E2E_SHOPEE_ESPERADO, E2E_SHOPEE_SHOP } from "./constants.js";
import { login } from "./helpers.js";

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
