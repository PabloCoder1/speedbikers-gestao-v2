import { expect, test } from "@playwright/test";

import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from "./constants.js";

/**
 * "Login" (docs/TESTING.md). A mensagem genérica em caso de erro é
 * deliberada (`login-form.tsx`): distinguir "e-mail não existe" de "senha
 * errada" entrega ao atacante quais endereços são válidos — o teste prova
 * que o erro genérico aparece, não que uma mensagem específica aparece.
 */
test.describe("login", () => {
  test("credenciais inválidas mostram erro genérico e não autenticam", async ({ page }) => {
    await page.goto("/login");

    await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
    await page.getByLabel("Senha").fill("senha-errada-de-proposito");
    await page.getByRole("button", { name: "Entrar" }).click();

    // `getByRole("alert")` sozinho pegaria também o route announcer do
    // próprio Next.js (`#__next-route-announcer__`, também role="alert",
    // sempre presente no DOM) — o erro do formulário é especificamente um
    // `<p role="alert">`.
    await expect(page.locator('p[role="alert"]')).toHaveText("E-mail ou senha incorretos.");
    await expect(page).toHaveURL(/\/login$/);
  });

  test("login com credenciais válidas volta para a página protegida pedida", async ({ page }) => {
    await page.goto("/login?next=%2Fcompras");

    await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
    await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();

    await expect(page).toHaveURL(/\/compras$/);
    await expect(page.getByRole("link", { name: "Visão Geral" })).toBeVisible();
  });
});
