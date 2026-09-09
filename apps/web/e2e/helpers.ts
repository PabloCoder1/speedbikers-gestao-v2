import type { Locator, Page } from "@playwright/test";

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
  await loginAs(page, E2E_USER_EMAIL, E2E_USER_PASSWORD, redirectTo);
}

/** O mesmo fluxo, para o segundo usuário do seed (GESTOR, D-232). */
export async function loginAs(page: Page, email: string, password: string, redirectTo = "/"): Promise<void> {
  await page.goto(redirectTo);
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

/**
 * Valor de um fato na grade do `ObjectHeader` (`<dl class="sb-fact-grid">`,
 * D-277).
 *
 * Substituiu o `statValue`, que lia o `Stat` inline
 * (`<div><div>rótulo</div><div>valor</div></div>`) das telas de detalhe. Com
 * `/notas-fiscais/[id]` e `/compras/[id]` migradas, aquele helper ficou sem
 * nenhum consumidor e saiu junto.
 *
 * O xpath ancora no `dt` de texto EXATO e pega o `dd` irmão: rótulos como
 * "Itens" também aparecem como cabeçalho na mesma tela.
 */
export function factValue(page: Page, label: string): Locator {
  return page.locator(`xpath=//dl[@class="sb-fact-grid"]/div[dt[normalize-space(text())="${label}"]]/dd`);
}
