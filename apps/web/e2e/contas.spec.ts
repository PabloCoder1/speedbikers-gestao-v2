import { expect, test } from "@playwright/test";

import { E2E_SHOPEE_SHOP } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/contas` — o painel "Lojas Shopee" (D-425). O que só se prova rodando: a
 * leitura de `shopee_shops` sob a RLS do usuário do seed (membro da
 * organização), o ambiente dito por extenso e o botão de conectar para o ADMIN.
 * O clique em si chama a api, que este e2e não sobe.
 */
test("/contas: o painel Lojas Shopee lista a loja da organização e oferece conectar ao ADMIN", async ({ page }) => {
  await login(page, "/contas");

  const tabela = page.getByRole("table", { name: "Lojas Shopee" });

  await expect(tabela).toBeVisible();
  await expect(tabela.getByRole("row", { name: new RegExp(E2E_SHOPEE_SHOP.name) })).toContainText("Teste (sandbox)");
  await expect(tabela.getByRole("row", { name: new RegExp(E2E_SHOPEE_SHOP.name) })).toContainText("Conectada");
  await expect(tabela).toContainText(String(E2E_SHOPEE_SHOP.shopId));
  await expect(page.getByRole("button", { name: "Conectar loja Shopee" })).toBeVisible();
});
