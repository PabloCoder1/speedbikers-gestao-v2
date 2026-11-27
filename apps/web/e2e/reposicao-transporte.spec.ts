import { expect, test, type Locator } from "@playwright/test";

import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

const COLUNAS = "id,organization_id,supplier_brand,sku_id,lead_time_days,target_coverage_days,safety_stock_days,max_coverage_days,policy_note";

async function bancoLocal() {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  return { db, seed };
}

async function criarRegraTemporaria(nota: string) {
  const f = await bancoLocal();
  const regra = await f.db.from("replenishment_settings").insert({
    organization_id: f.seed.organizationId,
    supplier_brand: null,
    sku_id: null,
    lead_time_days: 15,
    safety_stock_days: 5,
    target_coverage_days: 30,
    max_coverage_days: 90,
    policy_note: nota,
  }).select(COLUNAS).single();
  if (regra.error !== null) throw new Error(regra.error.message);
  return { ...f, regra: regra.data };
}

async function preencher(gaveta: Locator, nota: string): Promise<void> {
  await gaveta.getByLabel("Prazo do fornecedor").fill("20");
  await gaveta.getByLabel("Segurança").fill("7");
  await gaveta.getByLabel("Cobertura desejada").fill("40");
  await gaveta.getByLabel("Teto de cobertura").fill("100");
  await gaveta.getByLabel(/^Nota/u).fill(nota);
}

async function conferirCampos(gaveta: Locator, nota: string): Promise<void> {
  await expect(gaveta.getByLabel("Prazo do fornecedor")).toHaveValue("20");
  await expect(gaveta.getByLabel("Segurança")).toHaveValue("7");
  await expect(gaveta.getByLabel("Cobertura desejada")).toHaveValue("40");
  await expect(gaveta.getByLabel("Teto de cobertura")).toHaveValue("100");
  await expect(gaveta.getByLabel(/^Nota/u)).toHaveValue(nota);
}

for (const editando of [false, true]) {
  test(`regra de reposição: falha de conexão ao ${editando ? "editar" : "criar"} conserva os campos e permite nova tentativa`, async ({ page }) => {
    const marcador = `e2e-regra-transporte-${crypto.randomUUID()}`;
    const inicial = editando ? await criarRegraTemporaria(marcador) : null;
    const { db, seed } = inicial ?? await bancoLocal();
    const nota = `${marcador} alterada`;
    const ler = () => db.from("replenishment_settings").select(COLUNAS).eq("organization_id", seed.organizationId).is("supplier_brand", null).is("sku_id", null).maybeSingle();
    try {
      await login(page, "/reposicao/configuracoes");
      if (editando) await page.getByRole("region", { name: "Padrão da organização", exact: true }).getByRole("button", { name: "Editar padrão" }).click();
      else await page.getByRole("button", { name: "Definir o padrão da organização" }).click();
      const gaveta = page.getByRole("dialog", { name: editando ? "Padrão da organização" : "Nova regra de reposição", exact: true });
      await preencher(gaveta, nota);
      const salvar = gaveta.getByRole("button", { name: editando ? "Salvar alterações" : "Criar regra", exact: true });
      const caiu = await derrubarPrimeiraAcao(page);
      await salvar.click();
      await expect(gaveta.getByRole("alert")).toContainText("Não foi possível confirmar o salvamento");
      await expect(salvar).toBeEnabled();
      await expect(gaveta.getByRole("button", { name: "Cancelar", exact: true })).toBeEnabled();
      await conferirCampos(gaveta, nota);
      if (!editando) await expect(gaveta.getByLabel("Escopo")).toHaveValue("");
      expect(caiu()).toBe(true);
      const falha = await ler();
      expect(falha.error).toBeNull();
      expect(falha.data).toEqual(inicial?.regra ?? null);

      await salvar.click();
      await expect(gaveta).toBeHidden();
      const depois = await ler();
      expect(depois.error).toBeNull();
      expect(depois.data).toMatchObject({ organization_id: seed.organizationId, supplier_brand: null, sku_id: null, lead_time_days: 20, safety_stock_days: 7, target_coverage_days: 40, max_coverage_days: 100, policy_note: nota });
      if (editando) expect(depois.data?.id).toBe(inicial?.regra.id);
      await expect(page.getByRole("status").filter({ hasText: editando ? "Regra atualizada." : "Padrão da organização criado." })).toBeVisible();
    } finally {
      const limpeza = await db.from("replenishment_settings").delete().eq("organization_id", seed.organizationId).in("policy_note", [marcador, nota]);
      expect.soft(limpeza.error).toBeNull();
    }
  });
}

test("regra de reposição: falha de conexão ao remover mantém a confirmação e permite nova tentativa", async ({ page }) => {
  const marcador = `e2e-regra-transporte-${crypto.randomUUID()}`;
  const f = await criarRegraTemporaria(marcador);
  try {
    await login(page, "/reposicao/configuracoes");
    await page.getByRole("region", { name: "Padrão da organização", exact: true }).getByRole("button", { name: "Editar padrão" }).click();
    const gaveta = page.getByRole("dialog", { name: "Padrão da organização", exact: true });
    await preencher(gaveta, `${marcador} rascunho`);
    await gaveta.getByRole("button", { name: "Remover regra", exact: true }).click();
    const confirmacao = gaveta.getByRole("alertdialog", { name: "Confirmar remoção da regra" });
    const remover = confirmacao.getByRole("button", { name: "Sim, remover", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await remover.click();
    await expect(confirmacao.getByRole("alert")).toContainText("Não foi possível confirmar a remoção");
    await expect(remover).toBeEnabled();
    await expect(confirmacao.getByRole("button", { name: "Manter a regra" })).toBeEnabled();
    await conferirCampos(gaveta, `${marcador} rascunho`);
    expect(caiu()).toBe(true);
    const falha = await f.db.from("replenishment_settings").select(COLUNAS).eq("id", f.regra.id).single();
    expect(falha.error).toBeNull();
    expect(falha.data).toEqual(f.regra);
    await remover.click();
    await expect(gaveta).toBeHidden();
    await expect(page.getByRole("status").filter({ hasText: "Regra removida." })).toBeVisible();
    const depois = await f.db.from("replenishment_settings").select("id").eq("id", f.regra.id).maybeSingle();
    expect(depois.error).toBeNull();
    expect(depois.data).toBeNull();
  } finally {
    const limpeza = await f.db.from("replenishment_settings").delete().eq("id", f.regra.id);
    expect.soft(limpeza.error).toBeNull();
  }
});

test("regra de reposição: a recusa de salvar uma regra removida conserva o formulário", async ({ page }) => {
  const f = await criarRegraTemporaria(`e2e-regra-transporte-${crypto.randomUUID()}`);
  try {
    await login(page, "/reposicao/configuracoes");
    await page.getByRole("region", { name: "Padrão da organização", exact: true }).getByRole("button", { name: "Editar padrão" }).click();
    const gaveta = page.getByRole("dialog", { name: "Padrão da organização", exact: true });
    await preencher(gaveta, "Rascunho após remoção concorrente");
    const retirada = await f.db.from("replenishment_settings").delete().eq("id", f.regra.id);
    expect(retirada.error).toBeNull();
    const salvar = gaveta.getByRole("button", { name: "Salvar alterações", exact: true });
    await salvar.click();
    await expect(gaveta.getByRole("alert")).toContainText("A regra não foi alterada: ela foi removida por outra pessoa ou você não tem permissão.");
    await expect(salvar).toBeEnabled();
    await conferirCampos(gaveta, "Rascunho após remoção concorrente");
    const depois = await f.db.from("replenishment_settings").select("id").eq("id", f.regra.id).maybeSingle();
    expect(depois.error).toBeNull();
    expect(depois.data).toBeNull();
  } finally {
    const limpeza = await f.db.from("replenishment_settings").delete().eq("id", f.regra.id);
    expect.soft(limpeza.error).toBeNull();
  }
});
