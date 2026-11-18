import { expect, test } from "@playwright/test";

import { E2E_SUPPLIER } from "./constants.js";
import { derrubarPrimeiraAcao, factValue, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * "Pedido de compra" (docs/TESTING.md) — cria um rascunho do zero pela UI.
 * Não precisa de seed: o item aceita SKU em texto livre sem cadastro prévio
 * (`apps/web/app/(app)/compras/novo/item-row.tsx`), então o próprio teste já cobre
 * o caminho mais comum na prática (fornecedor manda um código que ainda não
 * está catalogado).
 *
 * A asserção de "Itens: 1" e do valor estimado na tela de detalhe é
 * deliberada: D-067 (Nível 1) corrigiu um bug real em que falha silenciosa
 * de leitura fazia esse resumo mostrar "0 itens, R$ 0,00" num pedido que
 * tinha itens de verdade — este teste é a guarda de regressão daquele bug.
 */
function bancoLocal() {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  return clienteDeServico();
}

test("cria um pedido após falha de conexão e mostra o resumo certo", async ({ page }) => {
  const db = bancoLocal();
  const seed = await readSeedOutput();
  const contar = () => db.from("purchase_orders").select("id", { count: "exact", head: true }).eq("organization_id", seed.organizationId);
  const antes = await contar();
  expect(antes.error).toBeNull();
  await login(page, "/compras/novo");

  await expect(page).toHaveURL(/\/compras\/novo$/);

  const row = page.locator("tbody tr").first();

  await row.getByPlaceholder("SKU ou nome…").fill("PEDIDO-E2E-001");
  await row.locator('input[type="number"]').first().fill("5");
  await row.locator('input[type="number"]').nth(1).fill("10.5");

  const criar = page.getByRole("button", { name: "Criar pedido (rascunho)" });
  const caiu = await derrubarPrimeiraAcao(page);
  await criar.click();
  await expect(page.getByRole("alert").filter({ hasText: "Não foi possível confirmar a criação" })).toBeVisible();
  await expect(criar).toBeEnabled();
  await expect(row.getByPlaceholder("SKU ou nome…")).toHaveValue("PEDIDO-E2E-001");
  await expect(row.locator('input[type="number"]').first()).toHaveValue("5");
  await expect(row.locator('input[type="number"]').nth(1)).toHaveValue("10.5");
  expect(caiu()).toBe(true);
  const depoisDaFalha = await contar();
  expect(depoisDaFalha.error).toBeNull();
  expect(depoisDaFalha.count).toBe(antes.count);

  const detalhe = (url: URL) => /^\/compras\/[0-9a-f-]{36}$/u.test(url.pathname) && url.searchParams.has("_rsc");
  await page.route(detalhe, async (route) => {
    await new Promise((pronto) => setTimeout(pronto, 1_500));
    await route.continue();
  });
  const navegando = page.waitForRequest((request) => detalhe(new URL(request.url())));
  await criar.click();
  await navegando;
  await expect(page.getByRole("button", { name: "Salvando…", exact: true })).toBeDisabled();

  await expect(page).toHaveURL(/\/compras\/[0-9a-f-]{36}$/);

  // O par rótulo/valor saiu do `Stat` inline e virou a grade de fatos do
  // `ObjectHeader` na migração de D-277. O locator acompanhou; a guarda de
  // regressão de D-067 continua sendo a mesma afirmação.
  await expect(factValue(page, "Itens")).toContainText("1");
  await expect(factValue(page, "Valor estimado")).toContainText("52,50");

  // O rascunho recém-criado está na primeira etapa, e a aprovação é a
  // próxima — indicador de processo e selo de estado têm de concordar.
  await expect(page.getByRole("listitem").filter({ hasText: "Aprovado" })).toHaveAttribute(
    "aria-current",
    "step",
  );
});

test("editar pedido: falha de conexão conserva o rascunho e permite nova tentativa", async ({ page }) => {
  const db = bancoLocal();
  const seed = await readSeedOutput();
  const pedido = await db.from("purchase_orders").select("id,destination_warehouse_name,status")
    .eq("organization_id", seed.organizationId).eq("notes", "e2e:compras:sem-custo").single();
  if (pedido.error !== null) throw new Error(pedido.error.message);
  const item = () => db.from("purchase_order_items").select("id,sku_snapshot,quantity_ordered,unit_cost")
    .eq("purchase_order_id", pedido.data.id).single();
  const antes = await item();
  if (antes.error !== null) throw new Error(antes.error.message);
  const destino = "E2E destino após falha de conexão";

  try {
    await login(page, `/compras/${pedido.data.id}/editar`);
    await page.getByLabel("Armazém de destino", { exact: true }).fill(destino);
    const salvar = page.getByRole("button", { name: "Salvar alterações", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await salvar.click();
    await expect(page.getByRole("alert").filter({ hasText: "Não foi possível confirmar as alterações" })).toBeVisible();
    await expect(salvar).toBeEnabled();
    await expect(page.getByLabel("Armazém de destino", { exact: true })).toHaveValue(destino);
    expect(caiu()).toBe(true);
    const depoisDaFalha = await item();
    expect(depoisDaFalha.error).toBeNull();
    expect(depoisDaFalha.data).toEqual(antes.data);
    const cabecalho = await db.from("purchase_orders").select("destination_warehouse_name,status").eq("id", pedido.data.id).single();
    expect(cabecalho.error).toBeNull();
    expect(cabecalho.data).toEqual({ destination_warehouse_name: pedido.data.destination_warehouse_name, status: pedido.data.status });

    await salvar.click();
    await expect(page).toHaveURL((u) => u.pathname === `/compras/${pedido.data.id}`);
    const depois = await db.from("purchase_orders").select("destination_warehouse_name,status").eq("id", pedido.data.id).single();
    expect(depois.error).toBeNull();
    expect(depois.data).toEqual({ destination_warehouse_name: destino, status: "DRAFT" });
    const itemDepois = await item();
    expect(itemDepois.error).toBeNull();
    expect(itemDepois.data?.sku_snapshot).toBe(antes.data.sku_snapshot);
    expect(itemDepois.data?.quantity_ordered).toBe(antes.data.quantity_ordered);
    expect(itemDepois.data?.unit_cost).toBe(antes.data.unit_cost);
  } finally {
    const volta = await db.from("purchase_orders").update({ destination_warehouse_name: pedido.data.destination_warehouse_name }).eq("id", pedido.data.id);
    expect.soft(volta.error).toBeNull();
  }
});

test("detalhe do pedido: o SKU vinculado carrega ao clicar e o retorno abre o mesmo pedido", async ({ page }) => {
  const { skuId, skuCode } = await readSeedOutput();
  const destino = `/skus/${skuId}`;
  const prefetches: string[] = [];

  page.on("request", (request) => {
    const headers = request.headers();
    const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;

    if (prefetch && new URL(request.url()).pathname === destino) prefetches.push(request.url());
  });

  await login(page, "/compras/novo");
  const linha = page.locator("tbody tr").first();

  await linha.getByPlaceholder("SKU ou nome…").fill(skuCode);
  await page.getByRole("option").filter({ hasText: skuCode }).first().click();
  await linha.locator('input[type="number"]').first().fill("2");
  await page.getByRole("button", { name: "Criar pedido (rascunho)" }).click();
  await expect(page).toHaveURL(/\/compras\/[0-9a-f-]{36}$/);

  const pedido = page.url();
  const sku = page.getByRole("region", { name: "Itens do pedido" }).getByRole("link", { name: skuCode, exact: true });

  await expect(sku).toHaveAttribute("href", destino);
  await sku.scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle");
  expect(prefetches).toEqual([]);

  await sku.click();
  await expect(page).toHaveURL((url) => url.pathname === destino);
  await expect(page.getByRole("heading", { level: 1, name: "Detalhe do SKU" })).toBeVisible();
  await expect(page.getByText(`SKU ${skuCode}`, { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(pedido);
  await expect(sku).toBeVisible();
});

/*
  D-368 — o formulário novo, SEM gravar nada: o resumo soma ao vivo com a mesma
  regra do pedido salvo (item sem custo fica fora e é contado), a lista colada
  vira linhas, o atalho de prazo preenche a data e o fornecedor escolhido
  aparece como ficha.
*/
test("novo pedido: lista colada, resumo ao vivo, atalho de prazo e ficha do fornecedor", async ({ page }) => {
  await login(page, "/compras/novo");

  await page.getByRole("button", { name: "Colar lista" }).click();
  await page.getByLabel(/Uma linha por item/).fill(["COLA-E2E-1\t2\t10,00", "COLA-E2E-2;3"].join("\n"));
  await page.getByRole("button", { name: "Adicionar à lista" }).click();

  await expect(page.getByRole("status").filter({ hasText: /2 item\(ns\) adicionados/ })).toBeVisible();
  // A linha vazia do começo dá lugar à lista.
  await expect(page.locator("tbody tr")).toHaveCount(2);

  const resumo = page.getByRole("complementary", { name: "Resumo do pedido" });

  await expect(resumo.getByText("R$ 20,00")).toBeVisible();
  await expect(resumo.getByText(/soma parcial — 1 item\(ns\) sem custo/)).toBeVisible();

  await page.getByRole("button", { name: "+15 dias" }).click();
  await expect(page.getByLabel("Previsão de chegada")).not.toHaveValue("");
  await expect(page.getByText(/Chega em 15 dias/)).toBeVisible();

  // O rótulo da opção carrega "· N em aberto": escolhe pelo valor.
  const opcao = page.locator("#pco-supplier option", { hasText: E2E_SUPPLIER.name }).first();
  const valor = await opcao.getAttribute("value");

  await page.locator("#pco-supplier").selectOption(valor ?? "");
  await expect(page.getByRole("link", { name: /Ver fornecedor/ })).toBeVisible();
  await expect(page.getByText(/pedido\(s\) em aberto/)).toBeVisible();
});

/*
  D-371 — o voltar vira botão, e a coluna SUGESTÃO responde para o SKU do
  catálogo. O seed não tem configuração de reposição, então o que se afirma é
  que a célula sai do "lendo…" para uma resposta da reposição — nunca fica
  presa nem mostra "indisponível" (que seria a função ausente ou quebrada).
*/
test("novo pedido: voltar como botão e a coluna Sugestão responde pelo SKU escolhido", async ({ page }) => {
  await login(page, "/compras/novo");

  await expect(page.getByRole("link", { name: "Pedidos de compra" })).toHaveAttribute("href", "/compras");

  const linha = page.locator("tbody tr").first();

  await linha.getByPlaceholder("SKU ou nome…").fill("E2E-SKU");
  await page.getByRole("option").filter({ hasText: "E2E-SKU-001" }).first().click();

  const sugestao = linha.locator(".sb-pco-sugestao");

  await expect(sugestao).toHaveText(/sem sugestão|coberto|\d+ un/, { timeout: 15_000 });
  await expect(sugestao).not.toContainText("indisponível");
});
