import { expect, test } from "@playwright/test";

import { E2E_ML_ACCOUNT } from "./constants.js";
import { login } from "./helpers.js";

test("/contas: o cartão leva à leitura de saúde e o cadastro segue o fluxo OAuth", async ({ page }) => {
  await login(page, "/contas");

  await expect(page.getByRole("heading", { name: "Contas Mercado Livre", level: 1 })).toBeVisible();

  const account = page.getByLabel(E2E_ML_ACCOUNT.label);
  await expect(account.getByRole("heading", { name: E2E_ML_ACCOUNT.label, level: 2 })).toBeVisible();
  await expect(account.getByText("Última sincronização")).toBeVisible();
  await expect(account.getByText("Anúncios sincronizados")).toBeVisible();

  const healthLink = account.getByRole("link", { name: `Ver saúde da conta ${E2E_ML_ACCOUNT.label}` });
  await expect(healthLink).toHaveAttribute("href", "/sincronizacao#contas");

  const form = page.getByRole("form", { name: "Cadastrar uma conta Mercado Livre" });
  await expect(form.getByLabel("Rótulo")).toBeVisible();
  await expect(form.getByLabel("Identificador (nomeia a fila interna)")).toBeVisible();
  await expect(form.getByRole("button", { name: "Cadastrar conta" })).toBeDisabled();
});
