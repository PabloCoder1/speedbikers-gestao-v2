import type { Page } from "@playwright/test";

import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./constants.js";

/**
 * Login pela UI de verdade (nunca injeta cookie/sessão pronta) — é o próprio
 * fluxo crítico "Login" de `docs/TESTING.md`, os outros specs reusam esta
 * função em vez de contornar a tela.
 *
 * `redirectTo` é a página que o teste quer testar de verdade: `page.goto`
 * nela sem sessão cai no redirect do proxy para `/login?next=...`, e o
 * formulário devolve para lá depois de autenticar — uma chamada só cobre
 * "entrar" e "chegar na tela certa".
 */
export async function login(page: Page, redirectTo = "/"): Promise<void> {
  await page.goto(redirectTo);
  await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
  await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
}
