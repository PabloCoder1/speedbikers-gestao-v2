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

  test("a Home exige sessão desde D-105 — deixou de ser painel estático", async ({ page }) => {
    // `/` era rota pública enquanto era o painel de progresso da construção
    // ("nenhum dado do negócio", dizia `proxy.ts`). A Visão Geral que a
    // substituiu lê `actions`/`support_cases`/`notification_recipients`, então
    // a exceção saiu junto com a página estática. Sem este teste, alguém
    // reintroduz `/` em `PUBLIC_EXACT` sem perceber o que mudou.
    await page.goto("/");

    await expect(page).toHaveURL(/\/login\?next=%2F$/);
  });

  test("login com credenciais válidas volta para a página protegida pedida", async ({ page }) => {
    await page.goto("/login?next=%2Fcompras");

    await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
    await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();

    await expect(page).toHaveURL(/\/compras$/);

    // A afirmação é "a moldura autenticada renderizou". Ela era um rótulo de
    // link ("Visão Geral"), que D3 renomeou ao trocar o cabeçalho horizontal
    // pela sidebar — e um teste que quebra ao renomear um rótulo estava
    // medindo o rótulo, não a moldura. Agora afirma o landmark de navegação e
    // um item dentro dele, o que sobrevive a renomeação e continua provando
    // que o Shell montou com o menu.
    const menu = page.getByRole("navigation", { name: "Navegação principal" });

    await expect(menu).toBeVisible();
    await expect(menu.getByRole("link", { name: "Vendas" })).toBeVisible();
  });

  /*
    D-532: o `proxy.ts` confere o token pela ASSINATURA (`getClaims`), sem ir ao
    servidor de Auth. O que não pode mudar é isto: um token adulterado no
    cookie — a sessão de verdade com a assinatura trocada — cai no login, como
    caía quando o Auth o recusava.
  */
  test("um token adulterado no cookie cai no login", async ({ page, context }) => {
    await page.goto("/login?next=%2Fcompras");
    await page.getByLabel("E-mail").fill(E2E_USER_EMAIL);
    await page.getByLabel("Senha").fill(E2E_USER_PASSWORD);
    await page.getByRole("button", { name: "Entrar" }).click();
    await expect(page).toHaveURL(/\/compras$/);

    // O cookie da sessão do `@supabase/ssr`: `sb-<ref>-auth-token`, às vezes em
    // pedaços (`.0`, `.1`), com o valor `base64-<JSON em base64url>`.
    const pedacos = (await context.cookies())
      .filter((cookie) => /^sb-.+-auth-token(\.\d+)?$/u.test(cookie.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    expect(pedacos.length).toBeGreaterThan(0);

    const nome = pedacos[0]?.name.replace(/\.\d+$/u, "") ?? "";
    const bruto = pedacos.map((cookie) => cookie.value).join("");
    const sessao = JSON.parse(Buffer.from(bruto.replace(/^base64-/u, ""), "base64url").toString("utf8")) as {
      access_token: string;
    };
    const [cabecalho, corpo, assinatura] = sessao.access_token.split(".");
    const trocada = `${(assinatura ?? "").slice(0, -4)}${(assinatura ?? "").endsWith("AAAA") ? "BBBB" : "AAAA"}`;

    sessao.access_token = `${cabecalho ?? ""}.${corpo ?? ""}.${trocada}`;

    const valor = `base64-${Buffer.from(JSON.stringify(sessao), "utf8").toString("base64url")}`;
    const novos = valor.match(/.{1,3180}/gu) ?? [];

    await context.clearCookies();
    await context.addCookies(
      novos.map((parte, i) => ({
        name: novos.length === 1 ? nome : `${nome}.${String(i)}`,
        value: parte,
        domain: pedacos[0]?.domain ?? "localhost",
        path: "/",
      })),
    );

    await page.goto("/compras");
    await expect(page).toHaveURL(/\/login\?next=%2Fcompras$/);
  });
});
