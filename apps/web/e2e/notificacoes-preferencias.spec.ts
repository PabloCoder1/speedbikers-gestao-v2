import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

import { E2E_USER_EMAIL } from "./constants.js";
import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";

/**
 * `/notificacoes/preferencias` — as regras que decidem o toast (D-754).
 *
 * A conexão que cai no meio deixava o formulário e a linha com os controles
 * desabilitados e sem aviso. Cada caso cria o que precisa e apaga as regras do
 * usuário no fim: o seed não tem nenhuma.
 */

async function regras() {
  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(supabase.hostname)) throw new Error("Este teste exige Supabase local.");

  const db = clienteDeServico();
  const usuarios = await db.auth.admin.listUsers();

  if (usuarios.error !== null) throw new Error(usuarios.error.message);

  const usuario = usuarios.data.users.find((u) => u.email === E2E_USER_EMAIL);

  if (usuario === undefined) throw new Error("Usuário do seed não encontrado.");

  return {
    db,
    userId: usuario.id,
    async lista() {
      const linhas = await db.from("notification_preferences").select("id, min_severity, enabled").eq("user_id", usuario.id);

      if (linhas.error !== null) throw new Error(linhas.error.message);

      return linhas.data;
    },
    async limpar() {
      const limpeza = await db.from("notification_preferences").delete().eq("user_id", usuario.id);

      expect.soft(limpeza.error).toBeNull();
    },
  };
}

function tabelaDeRegras(page: Page) {
  return page.getByRole("region", { name: "Regras de alerta" }).getByRole("table");
}

test("preferências: falha de conexão ao criar a regra libera o formulário e permite nova tentativa", async ({ page }) => {
  const r = await regras();

  await r.limpar();

  try {
    await login(page, "/notificacoes/preferencias");

    const nova = page.getByRole("region", { name: "Nova regra" });
    const adicionar = nova.getByRole("button", { name: "Adicionar preferência" });
    const caiu = await derrubarPrimeiraAcao(page);

    await adicionar.click();
    await expect(nova.getByRole("alert")).toContainText("Não foi possível confirmar a criação da regra");
    await expect(adicionar).toBeEnabled();
    expect(caiu()).toBe(true);
    expect(await r.lista()).toHaveLength(0);

    await adicionar.click();
    await expect(tabelaDeRegras(page).getByRole("row")).toHaveCount(2);
    expect(await r.lista()).toHaveLength(1);
  } finally {
    await r.limpar();
  }
});

test("preferências: falha de conexão ao alterar e ao remover a regra libera a linha e o diálogo", async ({ page }) => {
  const r = await regras();

  await r.limpar();

  const criada = await r.db
    .from("notification_preferences")
    .insert({ user_id: r.userId, min_severity: "informativo", enabled: true })
    .select("id")
    .single();

  if (criada.error !== null) throw new Error(criada.error.message);

  try {
    await login(page, "/notificacoes/preferencias");

    const linha = tabelaDeRegras(page).getByRole("row").nth(1);
    const severidade = linha.getByRole("combobox");
    const ativa = linha.getByRole("checkbox");
    let caiu = await derrubarPrimeiraAcao(page);

    await severidade.selectOption("critico");
    await expect(linha.getByRole("alert")).toContainText("Não foi possível confirmar a alteração");
    await expect(severidade).toBeEnabled();
    await expect(ativa).toBeEnabled();
    expect(caiu()).toBe(true);
    expect((await r.lista())[0]?.min_severity).toBe("informativo");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    caiu = await derrubarPrimeiraAcao(page);
    await linha.getByRole("button", { name: "Remover", exact: true }).click();

    const dialogo = page.getByRole("dialog", { name: "Remover regra de notificação" });
    const remover = dialogo.getByRole("button", { name: "Remover regra", exact: true });

    await remover.click();
    await expect(dialogo.getByRole("alert")).toContainText("Não foi possível confirmar a remoção");
    await expect(remover).toBeEnabled();
    await expect(dialogo.getByRole("button", { name: "Cancelar", exact: true })).toBeEnabled();
    expect(caiu()).toBe(true);
    expect(await r.lista()).toHaveLength(1);

    await remover.click();
    await expect(dialogo).toHaveCount(0);
    expect(await r.lista()).toHaveLength(0);
  } finally {
    await r.limpar();
  }
});

test("preferências: regra excluída por outra sessão informa recusa ao alterar severidade ou estado sem confirmar escrita", async ({ page }) => {
  const r = await regras();

  await r.limpar();

  const criada = await r.db
    .from("notification_preferences")
    .insert({ user_id: r.userId, min_severity: "informativo", enabled: true })
    .select("id")
    .single();

  if (criada.error !== null) throw new Error(criada.error.message);

  try {
    await login(page, "/notificacoes/preferencias");

    const linha = tabelaDeRegras(page).getByRole("row").nth(1);
    const severidade = linha.getByRole("combobox");
    const ativa = linha.getByRole("checkbox");

    await expect(severidade).toBeVisible();

    // Outra sessão remove a regra depois de esta página já ter carregado.
    const excluida = await r.db.from("notification_preferences").delete().eq("id", criada.data.id);

    expect(excluida.error).toBeNull();

    const respostaSeveridade = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.request().headers()["next-action"] !== undefined,
    );

    await severidade.selectOption("critico");
    expect((await respostaSeveridade).status()).toBe(200);

    await expect(linha.getByRole("alert")).toContainText("Atualize a página para conferir");
    await expect(severidade).toHaveValue("informativo");
    await expect(severidade).toBeEnabled();

    const respostaEstado = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.request().headers()["next-action"] !== undefined,
    );

    await ativa.click();
    expect((await respostaEstado).status()).toBe(200);

    await expect(linha.getByRole("alert")).toContainText("Atualize a página para conferir");
    await expect(ativa).toBeChecked();
    await expect(ativa).toBeEnabled();
    expect(await r.lista()).toHaveLength(0);
  } finally {
    await r.limpar();
  }
});

test("preferências: regra excluída por outra sessão informa recusa ao remover sem fechar o diálogo em falso", async ({ page }) => {
  const r = await regras();

  await r.limpar();

  const criada = await r.db
    .from("notification_preferences")
    .insert({ user_id: r.userId, min_severity: "informativo", enabled: true })
    .select("id")
    .single();

  if (criada.error !== null) throw new Error(criada.error.message);

  try {
    await login(page, "/notificacoes/preferencias");

    const linha = tabelaDeRegras(page).getByRole("row").nth(1);

    await linha.getByRole("button", { name: "Remover", exact: true }).click();

    const dialogo = page.getByRole("dialog", { name: "Remover regra de notificação" });
    const remover = dialogo.getByRole("button", { name: "Remover regra", exact: true });
    const cancelar = dialogo.getByRole("button", { name: "Cancelar", exact: true });

    await expect(dialogo).toBeVisible();

    const excluida = await r.db.from("notification_preferences").delete().eq("id", criada.data.id);

    expect(excluida.error).toBeNull();

    const resposta = page.waitForResponse(
      (res) => res.request().method() === "POST" && res.request().headers()["next-action"] !== undefined,
    );

    await remover.click();
    expect((await resposta).status()).toBe(200);

    await expect(dialogo).toBeVisible();
    await expect(dialogo.getByRole("alert")).toContainText("Atualize a página para conferir");
    await expect(remover).toBeEnabled();
    await expect(cancelar).toBeEnabled();
    expect(await r.lista()).toHaveLength(0);

    await cancelar.click();
    await expect(dialogo).toHaveCount(0);
    await expect(linha.getByRole("alert")).toHaveCount(0);

    await page.reload();
    await expect(page.getByText("Nenhuma preferência configurada")).toBeVisible();
  } finally {
    await r.limpar();
  }
});
