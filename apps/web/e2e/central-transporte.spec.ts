import { expect, test, type Locator } from "@playwright/test";

import { E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD } from "./constants.js";
import { derrubarPrimeiraAcao, login, loginAs } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

async function bancoLocal() {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  return { db: clienteDeServico(), seed: await readSeedOutput() };
}

const casos = [
  { tipo: "meta geral", formulario: "Cadastrar meta do mês", tabela: "monthly_goals", chave: "month", data: "2096-04-01", campoData: "Mês", digitado: "2096-04", campoValor: "Meta de faturamento (R$)", valor: "1.234,56", botao: "Salvar meta", sucesso: "Meta salva.", esperado: { revenue_goal: 1234.56 } },
  { tipo: "meta por marketplace", formulario: "Cadastrar meta por marketplace", tabela: "monthly_goals_marketplace", chave: "month", data: "2096-04-01", campoData: "Mês", digitado: "2096-04", campoValor: "Meta do marketplace (R$)", valor: "7.654,32", botao: "Salvar meta do marketplace", sucesso: "Meta da Shopee salva.", esperado: { revenue_goal: 7654.32, marketplace: "SHOPEE" } },
  { tipo: "alíquota", formulario: "Cadastrar alíquota de imposto", tabela: "tax_rates", chave: "valid_from", data: "2096-04-01", campoData: "Vale a partir de", digitado: "2096-04-01", campoValor: "Alíquota efetiva (%)", valor: "6,75", botao: "Salvar alíquota", sucesso: "Alíquota salva.", esperado: { rate: 0.0675 } },
] as const;

for (const c of casos) {
  test(`Central: falha de conexão ao salvar ${c.tipo} conserva todos os campos e permite nova tentativa`, async ({ page }) => {
    const { db, seed } = await bancoLocal();
    const nota = `e2e-central-transporte-${crypto.randomUUID()}`;
    const ler = () => c.tabela === "tax_rates"
      ? db.from("tax_rates").select("*").eq("organization_id", seed.organizationId).eq("valid_from", c.data).maybeSingle()
      : c.tabela === "monthly_goals_marketplace"
        ? db.from("monthly_goals_marketplace").select("*").eq("organization_id", seed.organizationId).eq("month", c.data).eq("marketplace", "SHOPEE").maybeSingle()
        : db.from("monthly_goals").select("*").eq("organization_id", seed.organizationId).eq("month", c.data).maybeSingle();
    const antes = await ler();
    expect(antes.error).toBeNull();
    expect(antes.data).toBeNull();
    try {
      await login(page, "/central/metas");
      const form = page.getByRole("form", { name: c.formulario, exact: true });
      const dataInicial = await form.getByLabel(c.campoData, { exact: true }).inputValue();
      await form.getByLabel(c.campoData, { exact: true }).fill(c.digitado);
      await form.getByLabel(c.campoValor, { exact: true }).fill(c.valor);
      await form.getByLabel("Observação (opcional)", { exact: true }).fill(nota);
      if (c.tabela === "monthly_goals_marketplace") await form.getByLabel("Marketplace", { exact: true }).selectOption("SHOPEE");
      const salvar = form.getByRole("button", { name: c.botao, exact: true });
      const caiu = await derrubarPrimeiraAcao(page);
      await salvar.click();
      await expect(form.getByRole("alert")).toContainText("Não foi possível confirmar o salvamento");
      await expect(salvar).toBeEnabled();
      await expect(form.getByLabel(c.campoData, { exact: true })).toHaveValue(c.digitado);
      await expect(form.getByLabel(c.campoValor, { exact: true })).toHaveValue(c.valor);
      await expect(form.getByLabel("Observação (opcional)", { exact: true })).toHaveValue(nota);
      if (c.tabela === "monthly_goals_marketplace") await expect(form.getByLabel("Marketplace", { exact: true })).toHaveValue("SHOPEE");
      expect(caiu()).toBe(true);
      const falha = await ler();
      expect(falha.error).toBeNull();
      expect(falha.data).toBeNull();
      await salvar.click();
      await expect(form.getByRole("status")).toHaveText(c.sucesso);
      const depois = await ler();
      expect(depois.error).toBeNull();
      expect(depois.data).toMatchObject({ organization_id: seed.organizationId, [c.chave]: c.data, note: nota, ...c.esperado });
      await expect(form.getByLabel(c.campoValor, { exact: true })).toHaveValue("");
      await expect(form.getByLabel("Observação (opcional)", { exact: true })).toHaveValue("");
      await expect(form.getByLabel(c.campoData, { exact: true })).toHaveValue(dataInicial);
      if (c.tabela === "monthly_goals_marketplace") await expect(form.getByLabel("Marketplace", { exact: true })).toHaveValue("ML");
    } finally {
      const limpeza = await db.from(c.tabela).delete().eq("organization_id", seed.organizationId).eq("note", nota);
      expect.soft(limpeza.error).toBeNull();
    }
  });
}

const DIGITADOS = { change_neutral: "4", change_strong: "14", points_neutral: "0,4", points_strong: "1,4", goal_delay_warning: "8", margin_floor: "22", margin_after_ads_low: "11", ads_roas_floor: "85", min_orders_sample: "33" };
const GRAVADOS = { change_neutral: 0.04, change_strong: 0.14, points_neutral: 0.004, points_strong: 0.014, goal_delay_warning: 0.08, margin_floor: 0.22, margin_after_ads_low: 0.11, ads_roas_floor: 0.85, min_orders_sample: 33 };

async function preencherLimites(form: Locator, valores: Readonly<Record<string, string>>): Promise<void> {
  for (const [nome, valor] of Object.entries(valores)) await form.locator(`input[name="${nome}"]`).fill(valor);
}

async function conferirLimites(form: Locator, valores: Readonly<Record<string, string>>): Promise<void> {
  for (const [nome, valor] of Object.entries(valores)) await expect(form.locator(`input[name="${nome}"]`)).toHaveValue(valor);
}

for (const transporte of [true, false]) {
  test(`Central: ${transporte ? "falha de conexão" : "recusa de validação"} ao salvar limites conserva os nove campos`, async ({ page }) => {
    const { db, seed } = await bancoLocal();
    const ler = () => db.from("central_thresholds").select("*").eq("organization_id", seed.organizationId).maybeSingle();
    const antes = await ler();
    if (antes.error !== null) throw new Error(antes.error.message);
    try {
      await login(page, "/central/limites");
      const form = page.getByRole("form", { name: "Limites da central", exact: true });
      const padroes: Record<string, string> = {};
      for (const nome of Object.keys(DIGITADOS)) padroes[nome] = await form.locator(`input[name="${nome}"]`).inputValue();
      const valores = transporte ? DIGITADOS : { ...DIGITADOS, change_strong: "2" };
      await preencherLimites(form, valores);
      const salvar = form.getByRole("button", { name: "Salvar limites", exact: true });
      const caiu = transporte ? await derrubarPrimeiraAcao(page) : null;
      await salvar.click();
      await expect(form.getByRole("alert")).toContainText(transporte ? "Não foi possível confirmar o salvamento" : "A variação forte precisa ser maior que a estável.");
      await expect(salvar).toBeEnabled();
      await conferirLimites(form, valores);
      if (caiu !== null) expect(caiu()).toBe(true);
      const falha = await ler();
      expect(falha.error).toBeNull();
      expect(falha.data).toEqual(antes.data);
      if (!transporte) await form.locator('input[name="change_strong"]').fill("14");
      await salvar.click();
      await expect(form.getByRole("status")).toHaveText("Limites salvos. A central já julga com eles.");
      const depois = await ler();
      expect(depois.error).toBeNull();
      expect(depois.data).toMatchObject(GRAVADOS);
      await conferirLimites(form, DIGITADOS);
      if (transporte && antes.data === null) {
        await page.getByRole("button", { name: "Voltar aos padrões", exact: true }).click();
        await page.getByRole("group", { name: "Confirmar: Voltar aos padrões", exact: true }).getByRole("button", { name: "Voltar aos padrões", exact: true }).click();
        await expect(page.getByText("Os padrões do sistema: nenhum limite foi mudado ainda.")).toBeVisible();
        await conferirLimites(form, padroes);
        const restaurado = await ler();
        expect(restaurado.error).toBeNull();
        expect(restaurado.data).toBeNull();
      }
    } finally {
      const volta = antes.data === null
        ? await db.from("central_thresholds").delete().eq("organization_id", seed.organizationId)
        : await db.from("central_thresholds").upsert(antes.data, { onConflict: "organization_id" });
      expect.soft(volta.error).toBeNull();
    }
  });
}

test("Central: meta recusada conserva mês, valor e observação até a correção", async ({ page }) => {
  const { db, seed } = await bancoLocal();
  const nota = `e2e-central-transporte-${crypto.randomUUID()}`;
  const ler = () => db.from("monthly_goals").select("*").eq("organization_id", seed.organizationId).eq("month", "2096-05-01").maybeSingle();
  const antes = await ler();
  expect(antes.error).toBeNull();
  expect(antes.data).toBeNull();
  try {
    await login(page, "/central/metas");
    const form = page.getByRole("form", { name: "Cadastrar meta do mês", exact: true });
    await form.getByLabel("Mês", { exact: true }).fill("2096-05");
    await form.getByLabel("Meta de faturamento (R$)", { exact: true }).fill("0");
    await form.getByLabel("Observação (opcional)", { exact: true }).fill(nota);
    const salvar = form.getByRole("button", { name: "Salvar meta", exact: true });
    await salvar.click();
    await expect(form.getByRole("alert")).toHaveText("A meta precisa ser maior que zero.");
    await expect(form.getByLabel("Mês", { exact: true })).toHaveValue("2096-05");
    await expect(form.getByLabel("Meta de faturamento (R$)", { exact: true })).toHaveValue("0");
    await expect(form.getByLabel("Observação (opcional)", { exact: true })).toHaveValue(nota);
    const falha = await ler();
    expect(falha.error).toBeNull();
    expect(falha.data).toBeNull();
    await form.getByLabel("Meta de faturamento (R$)", { exact: true }).fill("222,33");
    await salvar.click();
    await expect(form.getByRole("status")).toHaveText("Meta salva.");
    const depois = await ler();
    expect(depois.error).toBeNull();
    expect(depois.data).toMatchObject({ month: "2096-05-01", revenue_goal: 222.33, note: nota });
  } finally {
    const limpeza = await db.from("monthly_goals").delete().eq("organization_id", seed.organizationId).eq("month", "2096-05-01").eq("note", nota);
    expect.soft(limpeza.error).toBeNull();
  }
});

for (const acessoRevogado of [false, true]) {
  for (const tabela of ["monthly_goals", "monthly_goals_marketplace", "tax_rates", "central_thresholds"] as const) {
    test(`Central: confirmação de ${tabela} conserva os dados após ${acessoRevogado ? "acesso revogado" : "falha"} e permite nova tentativa`, async ({ page }) => {
      const { db, seed } = await bancoLocal();
      const gestor = acessoRevogado
        ? await db.from("organization_members").select("user_id, role").eq("organization_id", seed.organizationId).eq("role", "GESTOR").single()
        : null;
      expect(gestor?.error ?? null).toBeNull();
      async function restaurarAcesso(): Promise<void> {
        if (gestor?.data !== undefined && gestor.data !== null) {
          const volta = await db.from("organization_members").update({ role: gestor.data.role }).eq("organization_id", seed.organizationId).eq("user_id", gestor.data.user_id).select("role").single();
          expect.soft(volta.error).toBeNull();
          expect.soft(volta.data?.role).toBe(gestor.data.role);
        }
      }
      const nota = `e2e-central-remover-${crypto.randomUUID()}`;
      const limites = tabela === "central_thresholds";
      const anteriores = limites
        ? await db.from("central_thresholds").select("*").eq("organization_id", seed.organizationId).maybeSingle()
        : null;
      expect(anteriores?.error ?? null).toBeNull();
      const criada = tabela === "central_thresholds"
        ? await db.from(tabela).upsert({ organization_id: seed.organizationId, ...GRAVADOS }, { onConflict: "organization_id" }).select("*").single()
        : tabela === "tax_rates"
          ? await db.from(tabela).insert({ organization_id: seed.organizationId, valid_from: "2096-07-01", rate: 0.0675, note: nota }).select("*").single()
          : tabela === "monthly_goals_marketplace"
            ? await db.from(tabela).insert({ organization_id: seed.organizationId, month: "2096-07-01", revenue_goal: 1234.56, note: nota, marketplace: "SHOPEE" }).select("*").single()
            : await db.from(tabela).insert({ organization_id: seed.organizationId, month: "2096-07-01", revenue_goal: 1234.56, note: nota }).select("*").single();
      expect(criada.error).toBeNull();
      if (criada.data === null) throw new Error("Fixture de confirmação não foi criada.");
      const ler = () => limites
        ? db.from("central_thresholds").select("*").eq("organization_id", seed.organizationId).maybeSingle()
        : db.from(tabela).select("*").eq("organization_id", seed.organizationId).eq("note", nota).maybeSingle();
      try {
        if (acessoRevogado) await loginAs(page, E2E_GESTOR_EMAIL, E2E_GESTOR_PASSWORD, limites ? "/central/limites" : "/central/metas");
        else await login(page, limites ? "/central/limites" : "/central/metas");
        const abrir = limites
          ? page.getByRole("button", { name: "Voltar aos padrões", exact: true })
          : page.getByRole("row").filter({ hasText: nota }).getByRole("button", { name: /^Remover a /u });
        await abrir.click();
        const grupo = limites
          ? page.getByRole("group", { name: "Confirmar: Voltar aos padrões", exact: true })
          : page.getByRole("row").filter({ hasText: nota }).getByRole("group");
        await expect(grupo).toBeFocused();
        const confirmar = grupo.getByRole("button", { name: limites ? "Voltar aos padrões" : "Remover", exact: true });
        const cancelar = grupo.getByRole("button", { name: "Cancelar", exact: true });
        if (gestor?.data !== undefined && gestor.data !== null) {
          const revogacao = await db.from("organization_members").update({ role: "OPERADOR" }).eq("organization_id", seed.organizationId).eq("user_id", gestor.data.user_id).select("role").single();
          expect(revogacao.error).toBeNull();
          expect(revogacao.data?.role).toBe("OPERADOR");
        }
        const caiu = acessoRevogado ? null : await derrubarPrimeiraAcao(page);
        const resposta = acessoRevogado ? page.waitForResponse((r) => r.request().method() === "POST" && r.request().headers()["next-action"] !== undefined) : null;
        await confirmar.click();
        if (resposta !== null) expect((await resposta).status()).toBe(200);
        const falha = await ler();
        expect(falha.error).toBeNull();
        expect(falha.data).toEqual(criada.data);
        await expect(grupo.getByRole("alert")).toContainText(acessoRevogado ? "seu acesso foi alterado" : "Não foi possível confirmar a alteração");
        await expect(confirmar).toBeEnabled();
        await expect(cancelar).toBeEnabled();
        if (caiu !== null) expect(caiu()).toBe(true);
        await restaurarAcesso();
        // A falha não fecha a confirmação nem dispara uma segunda tentativa.
        await cancelar.click();
        await expect(abrir).toBeFocused();
        await abrir.click();
        if (tabela === "monthly_goals") {
          let liberar!: () => void;
          const espera = new Promise<void>((resolve) => { liberar = resolve; });
          await page.route("**/*", async (rota) => {
            const pedido = rota.request();
            if (pedido.method() === "POST" && pedido.headers()["next-action"] !== undefined) await espera;
            await rota.continue();
          });
          const pedido = page.waitForRequest((r) => r.method() === "POST" && r.headers()["next-action"] !== undefined);
          try {
            await confirmar.click();
            await pedido;
            await expect(grupo.getByRole("button", { name: "Removendo…", exact: true })).toBeDisabled();
            await expect(cancelar).toBeDisabled();
          } finally {
            liberar();
          }
        } else {
          await confirmar.click();
        }
        await expect(grupo).not.toBeVisible();
        const depois = await ler();
        expect(depois.error).toBeNull();
        expect(depois.data).toBeNull();
        if (limites) await expect(page.getByText("Os padrões do sistema: nenhum limite foi mudado ainda.")).toBeVisible();
      } finally {
        await restaurarAcesso();
        if (tabela === "central_thresholds") {
          const dadosAnteriores = anteriores?.data ?? null;
          const limpeza = dadosAnteriores === null
            ? await db.from("central_thresholds").delete().eq("organization_id", seed.organizationId)
            : await db.from("central_thresholds").upsert(dadosAnteriores, { onConflict: "organization_id" });
          expect.soft(limpeza.error).toBeNull();
        } else {
          const limpeza = await db.from(tabela).delete().eq("organization_id", seed.organizationId).eq("note", nota);
          expect.soft(limpeza.error).toBeNull();
        }
      }
    });
  }
}
