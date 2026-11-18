import { expect, test } from "@playwright/test";

import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

test("/atendimento/templates: falha de conexão ao criar preserva nome/texto e permite nova tentativa", async ({ page }) => {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const nome = `E2E Template ${crypto.randomUUID().slice(0, 8)}`;
  const texto = "E2E: prazo de postagem em até 24 horas úteis após a compra.";

  const ler = () =>
    db.from("reply_templates").select("id, name, body").eq("organization_id", seed.organizationId).eq("name", nome);

  try {
    await login(page, "/atendimento/templates");

    const campoNome = page.getByLabel("Nome", { exact: true });
    const campoTexto = page.getByLabel("Texto", { exact: true });
    const criar = page.getByRole("button", { name: "Criar template" });

    await campoNome.fill(nome);
    await campoTexto.fill(texto);

    const caiu = await derrubarPrimeiraAcao(page);
    await criar.click();

    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível confirmar a criação" })).toBeVisible();
    expect(caiu()).toBe(true);
    await expect(criar).toBeEnabled();
    await expect(campoNome).toHaveValue(nome);
    await expect(campoTexto).toHaveValue(texto);

    const antes = await ler();
    expect(antes.error).toBeNull();
    expect(antes.data).toEqual([]);

    await criar.click();
    await expect(page.getByText(nome, { exact: true })).toBeVisible();
    await expect(campoNome).toHaveValue("");
    await expect(campoTexto).toHaveValue("");

    const depois = await ler();
    expect(depois.error).toBeNull();
    expect(depois.data?.length).toBe(1);
    expect(depois.data?.[0]?.body).toBe(texto);
  } finally {
    const limpeza = await db
      .from("reply_templates")
      .delete()
      .eq("organization_id", seed.organizationId)
      .eq("name", nome);
    expect.soft(limpeza.error).toBeNull();
  }
});

test("/atendimento/templates: falha de conexão ao editar e excluir libera a linha e limpa erro ao cancelar", async ({ page }) => {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const nomeInicial = `E2E Edição ${crypto.randomUUID().slice(0, 8)}`;
  const nomeNovo = `${nomeInicial} Atualizado`;
  const textoInicial = "Texto original do template temporário.";
  const textoNovo = "Texto revisado que precisa permanecer após erro de rede.";

  const criado = await db
    .from("reply_templates")
    .insert({
      organization_id: seed.organizationId,
      created_by: seed.userId,
      name: nomeInicial,
      body: textoInicial,
    })
    .select("id")
    .single();
  if (criado.error !== null) throw new Error(criado.error.message);
  const templateId = criado.data.id;

  try {
    await login(page, "/atendimento/templates");

    const item = page.locator("li.sb-template-row", { hasText: nomeInicial });
    await item.getByRole("button", { name: "Editar" }).click();

    const itemEditando = page.locator("li.sb-template-row").filter({ has: page.getByLabel("Nome do template") });
    const inputNome = itemEditando.getByLabel("Nome do template");
    const inputTexto = itemEditando.getByLabel("Texto do template");
    await expect(inputNome).toHaveValue(nomeInicial);
    await inputNome.fill(nomeNovo);
    await inputTexto.fill(textoNovo);

    const caiuEdicao = await derrubarPrimeiraAcao(page);
    await itemEditando.getByRole("button", { name: "Salvar" }).click();

    await expect(
      itemEditando.getByRole("alert").filter({ hasText: "Não foi possível confirmar a alteração" }),
    ).toBeVisible();
    expect(caiuEdicao()).toBe(true);
    await expect(itemEditando.getByRole("button", { name: "Salvar" })).toBeEnabled();
    await expect(inputNome).toHaveValue(nomeNovo);
    await expect(inputTexto).toHaveValue(textoNovo);

    const bancoAposFalhaEdicao = await db.from("reply_templates").select("name, body").eq("id", templateId).single();
    expect(bancoAposFalhaEdicao.error).toBeNull();
    expect(bancoAposFalhaEdicao.data).toEqual({ name: nomeInicial, body: textoInicial });

    await itemEditando.getByRole("button", { name: "Salvar" }).click();
    const itemAtualizado = page.locator("li.sb-template-row", { hasText: nomeNovo });
    await expect(itemAtualizado).toBeVisible();
    await expect(itemAtualizado.getByText(textoNovo)).toBeVisible();

    const bancoAposEdicao = await db.from("reply_templates").select("name, body").eq("id", templateId).single();
    expect(bancoAposEdicao.error).toBeNull();
    expect(bancoAposEdicao.data).toEqual({ name: nomeNovo, body: textoNovo });

    await itemAtualizado.getByRole("button", { name: "Apagar" }).click();
    const caiuExclusao = await derrubarPrimeiraAcao(page);
    await itemAtualizado.getByRole("button", { name: "Sim, apagar" }).click();

    await expect(
      itemAtualizado.getByRole("alert").filter({ hasText: "Não foi possível confirmar a exclusão" }),
    ).toBeVisible();
    expect(caiuExclusao()).toBe(true);
    await expect(itemAtualizado.getByRole("button", { name: "Sim, apagar" })).toBeEnabled();

    await itemAtualizado.getByRole("button", { name: "Cancelar" }).click();
    await expect(itemAtualizado.getByRole("alert")).toHaveCount(0);

    await itemAtualizado.getByRole("button", { name: "Apagar" }).click();
    await itemAtualizado.getByRole("button", { name: "Sim, apagar" }).click();
    await expect(page.locator("li.sb-template-row", { hasText: nomeNovo })).toHaveCount(0);

    const bancoAposExclusao = await db.from("reply_templates").select("id").eq("id", templateId).maybeSingle();
    expect(bancoAposExclusao.error).toBeNull();
    expect(bancoAposExclusao.data).toBeNull();
  } finally {
    const limpeza = await db.from("reply_templates").delete().eq("id", templateId);
    expect.soft(limpeza.error).toBeNull();
  }
});
