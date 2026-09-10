import { createClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

/**
 * A ACEITAÇÃO DO CONVITE (D-302) — o fim do fluxo que D-296 começou.
 *
 * A pergunta que abriu esta fatia foi do usuário, depois de convidar alguém de
 * verdade: *"como vou saber qual a senha dela pra eu passar?"*. Não há senha a
 * passar, e essa é a resposta certa — mas até aqui ela não era verdade
 * inteira: o link terminava no formulário de entrada, com a sessão no
 * fragmento da URL e **nenhum campo que a usasse**.
 *
 * Este arquivo exercita o caminho completo com um convite DE VERDADE, gerado
 * pela Admin API do Auth como a `api` faz em produção: link → definir senha →
 * dentro da aplicação → e a senha valendo numa entrada nova, que é a única
 * prova de que a pessoa não ficou dependendo de uma sessão de uma hora.
 *
 * **O convidado daqui não ganha vínculo com a organização** — de propósito. O
 * que se testa é a ACEITAÇÃO, e criar membro mudaria a contagem que
 * `usuarios.spec.ts` afirma ("Membros: 2").
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const SENHA = "SenhaDoConvite!2026";

/**
 * Gera o convite pelo mesmo caminho da `api` (`generateLink`, D-296). A `api`
 * não sobe na suíte de e2e — o que ela faz com service role tem teste próprio
 * em `apps/api/src/invites.test.ts` —, então aqui a chave entra direto.
 */
async function gerarConvite(email: string): Promise<string> {
  if (SERVICE_ROLE_KEY === "") {
    throw new Error(
      "defina SUPABASE_SERVICE_ROLE_KEY (a chave local de `supabase status`) antes de rodar este spec — " +
        "o convite é criado pela Admin API, como em produção",
    );
  }

  const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const gerado = await db.auth.admin.generateLink({ type: "invite", email });

  if (gerado.error !== null) throw new Error(`convite não gerado: ${gerado.error.message}`);

  return gerado.data.properties.action_link;
}

/** E-mail novo por execução: o convite não pode reaproveitar conta anterior. */
function emailNovo(): string {
  return `convite-${String(Date.now())}@e2e.test`;
}

test("convite: o link leva a DEFINIR SENHA, e a senha definida vale na entrada seguinte", async ({
  page,
}) => {
  const email = emailNovo();
  const link = await gerarConvite(email);

  await page.goto(link);

  /*
    A tela muda de identidade: quem chega por convite não vê "Entrar", vê
    "Defina sua senha". O título mora no formulário justamente porque só o
    cliente enxerga o fragmento (D-302).
  */
  await expect(page.getByRole("heading", { name: "Defina sua senha" })).toBeVisible();

  /*
    O TOKEN SAI DA URL. Ele é credencial: ficaria no histórico do navegador e em
    qualquer captura desta tela.
  */
  expect(new URL(page.url()).hash).toBe("");

  await page.getByLabel("Nova senha").fill(SENHA);
  await page.getByLabel("Repita a senha").fill(SENHA);
  await page.getByRole("button", { name: "Salvar senha e entrar" }).click();

  // Entrou: a sessão do convite já estava de pé, e definir a senha a completa.
  await expect(page).not.toHaveURL(/\/login/);

  /*
    A PROVA QUE IMPORTA. A sessão do convite dura uma hora; a senha é o que
    faz a pessoa voltar amanhã. Sem esta metade, o teste passaria mesmo que
    `updateUser` não tivesse gravado nada.
  */
  const entrada = await page.request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "" },
    data: { email, password: SENHA },
  });

  expect(entrada.status()).toBe(200);
});

test("convite: senhas diferentes NÃO vão ao servidor", async ({ page }) => {
  const link = await gerarConvite(emailNovo());

  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Defina sua senha" })).toBeVisible();

  await page.getByLabel("Nova senha").fill(SENHA);
  await page.getByLabel("Repita a senha").fill("outra-coisa");
  await page.getByRole("button", { name: "Salvar senha e entrar" }).click();

  /*
    Recusa em CASA. Sem SMTP não existe "esqueci minha senha" (D-296): uma
    senha digitada errada e confirmada errada seria uma conta inalcançável até
    alguém convidar de novo.

    Afirmada pelo TEXTO, não por `getByRole("alert")`: o Next mantém um
    `#__next-route-announcer__` com `role="alert"` em toda página, e a busca por
    papel casaria dois elementos (armadilha registrada em `docs/TESTING.md`).
  */
  await expect(page.getByText("As duas senhas não são iguais.")).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});

test("convite: link já usado é DITO, e não vira formulário de entrada mudo", async ({ page }) => {
  const link = await gerarConvite(emailNovo());

  await page.goto(link);
  await expect(page.getByRole("heading", { name: "Defina sua senha" })).toBeVisible();

  /*
    SEM A SESSÃO DA PRIMEIRA VISITA. Isto não é detalhe de teste: quem reabre um
    link velho normalmente é a pessoa em outro dia, outro navegador — e com
    sessão de pé o próprio proxy a deixaria entrar, escondendo o caso. Sem ela,
    o Auth devolve `error=access_denied` no fragmento, e é esse ramo que se
    guarda aqui.
  */
  await page.context().clearCookies();

  await page.goto(link);

  await expect(page.getByText("Este convite não vale mais")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Entrar" })).toBeVisible();
});
