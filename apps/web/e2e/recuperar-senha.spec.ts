import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * "ESQUECI A SENHA" POR CONTA PRÓPRIA (D-863).
 *
 * A suíte sobe a `web` com `RECUPERACAO_SENHA_POR_EMAIL=1`
 * (`playwright.config.ts`): o botão é o estado de produção depois do SMTP do
 * Auth. O Supabase local não entrega e-mail (`[local_smtp]` desligado), então
 * o caminho é provado em duas metades que se encontram no MESMO link:
 *
 * 1. a tela faz o pedido certo ao Auth — interceptado, com o e-mail e a volta
 *    para `/login` conferidos;
 * 2. o link de recuperação (o que o e-mail levaria, gerado pela Admin API como
 *    o Auth gera) leva a criar a nova senha, e a nova senha vale na entrada
 *    seguinte.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const SENHA_ANTIGA = "SenhaEsquecida!2026";
const SENHA_NOVA = "SenhaRecuperada!2026";

function admin(): ReturnType<typeof createClient> {
  if (SERVICE_ROLE_KEY === "") {
    throw new Error("defina SUPABASE_SERVICE_ROLE_KEY (a chave local de `supabase status`) antes de rodar este spec");
  }

  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

/** Conta nova por execução, com senha: é quem esqueceu, não quem foi convidado. */
async function contaComSenha(): Promise<string> {
  const email = `esqueci-${String(Date.now())}@e2e.test`;
  const criada = await admin().auth.admin.createUser({ email, password: SENHA_ANTIGA, email_confirm: true });

  if (criada.error !== null) throw new Error(`conta não criada: ${criada.error.message}`);

  return email;
}

/** Abre o "Esqueci a senha" a partir da tela de entrada, com o e-mail digitado lá. */
async function abrirEsqueci(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("E-mail").fill(email);
  await page.getByRole("button", { name: "Esqueci a senha" }).click();
  await expect(page.getByRole("heading", { name: "Esqueci a senha" })).toBeVisible();
}

test("esqueci a senha: o pedido vai ao Auth com o e-mail e a volta para /login", async ({ page }) => {
  const email = await contaComSenha();
  const pedidos: { url: string; corpo: unknown }[] = [];

  // O Auth local não manda e-mail; o pedido é conferido aqui e respondido como
  // o Auth responde (200 vazio, também para e-mail que não existe).
  await page.route("**/auth/v1/recover**", async (route) => {
    pedidos.push({ url: route.request().url(), corpo: route.request().postDataJSON() });
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await abrirEsqueci(page, email);

  // O e-mail digitado na entrada vem junto: a pessoa não digita duas vezes.
  await expect(page.getByLabel("E-mail")).toHaveValue(email);

  await page.getByRole("button", { name: "Enviar link" }).click();
  await expect(page.getByText("Pedido recebido")).toBeVisible();

  expect(pedidos).toHaveLength(1);
  expect(pedidos[0]?.corpo).toMatchObject({ email });

  const volta = new URL(pedidos[0]?.url ?? "").searchParams.get("redirect_to") ?? "";

  expect(new URL(volta).pathname).toBe("/login");

  // Implícito, e não PKCE: sem desafio (o cliente manda `code_challenge: null`),
  // o link volta com a sessão no fragmento e abre em qualquer navegador — o
  // e-mail pode ser lido no celular. Com PKCE viria uma string aqui.
  const corpo = (pedidos[0]?.corpo ?? {}) as { code_challenge?: unknown };

  expect(corpo.code_challenge ?? null).toBeNull();

  // "Voltar para a entrada" devolve o formulário de entrada.
  await page.getByRole("button", { name: "Voltar para a entrada" }).click();
  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
});

test("esqueci a senha: o limite de envios é dito, e o pedido não vira erro mudo", async ({ page }) => {
  await page.route("**/auth/v1/recover**", async (route) => {
    await route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ code: "over_email_send_rate_limit", msg: "email rate limit exceeded" }),
    });
  });

  await abrirEsqueci(page, "qualquer@e2e.test");
  await page.getByRole("button", { name: "Enviar link" }).click();

  await expect(page.getByText("Muitos pedidos de link em pouco tempo.")).toBeVisible();
  await expect(page.getByText("Pedido recebido")).toHaveCount(0);
});

test("esqueci a senha: o link de recuperação leva a criar a nova senha, e ela vale na entrada", async ({
  page,
}) => {
  const email = await contaComSenha();
  const gerado = await admin().auth.admin.generateLink({ type: "recovery", email });

  if (gerado.error !== null) throw new Error(`link não gerado: ${gerado.error.message}`);

  await page.goto(gerado.data.properties.action_link);

  await expect(page.getByRole("heading", { name: "Crie uma nova senha" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");

  await page.getByLabel("Nova senha").fill(SENHA_NOVA);
  await page.getByLabel("Repita a senha").fill(SENHA_NOVA);
  await page.getByRole("button", { name: "Salvar senha e entrar" }).click();
  await expect(page).not.toHaveURL(/\/login/);

  const entrar = async (senha: string): Promise<number> => {
    const resposta = await page.request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "" },
      data: { email, password: senha },
    });

    return resposta.status();
  };

  expect(await entrar(SENHA_NOVA)).toBe(200);
  expect(await entrar(SENHA_ANTIGA)).toBe(400);
});
