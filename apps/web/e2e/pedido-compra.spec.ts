import type { Database } from "@sb/db";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { E2E_SUPPLIER } from "./constants.js";
import { factValue, login } from "./helpers.js";
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
test("cria um pedido de compra com item em texto livre e mostra o resumo certo", async ({ page }) => {
  await login(page, "/compras/novo");

  await expect(page).toHaveURL(/\/compras\/novo$/);

  const row = page.locator("tbody tr").first();

  await row.getByPlaceholder("SKU ou nome…").fill("PEDIDO-E2E-001");
  await row.locator('input[type="number"]').first().fill("5");
  await row.locator('input[type="number"]').nth(1).fill("10.5");

  await page.getByRole("button", { name: "Criar pedido (rascunho)" }).click();

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

/*
  FALHA DE TRANSPORTE NA SERVER ACTION (D-864). Sem o `try`, o botão ficava em
  "Salvando…" para sempre quando a ação não respondia, e a saída era recarregar
  a tela e perder o rascunho.
*/

function banco(): ReturnType<typeof createClient<Database>> {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");

  return createClient<Database>(url.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false },
  });
}

/** Os pedidos que têm um item com este código — o código é único por execução. */
async function pedidosCom(codigo: string): Promise<string[]> {
  const { data, error } = await banco()
    .from("purchase_order_items")
    .select("purchase_order_id")
    .eq("sku_snapshot", codigo);

  if (error !== null) throw new Error(error.message);

  return [...new Set(data.map((linha) => linha.purchase_order_id))];
}

/**
 * Item COM custo de propósito: um pedido sem custo entraria na contagem
 * "N de N sem custo" que `compras.spec.ts` afirma sobre a fila.
 */
async function preencherItem(page: Page, codigo: string, quantidade: string): Promise<void> {
  const linha = page.locator("tbody tr").first();

  await linha.getByPlaceholder("SKU ou nome…").fill(codigo);
  await linha.locator('input[type="number"]').first().fill(quantidade);
  await linha.locator('input[type="number"]').nth(1).fill("12.5");
}

test("novo pedido: resposta perdida libera o formulário, e a nova tentativa abre o MESMO pedido (D-864)", async ({
  page,
}) => {
  const codigo = `TRANSPORTE-E2E-${String(Date.now())}`;

  await login(page, "/compras/novo");
  await preencherItem(page, codigo, "3");

  let perdida = false;

  // O servidor RECEBE e cria o pedido; a resposta é que não chega ao navegador.
  // É o caso que importa para a idempotência: o pedido existe e a tela não sabe.
  await page.route(
    (endereco) => endereco.pathname === "/compras/novo",
    async (rota) => {
      const pedido = rota.request();

      if (!perdida && pedido.method() === "POST" && pedido.headers()["next-action"] !== undefined) {
        perdida = true;
        await rota.fetch();
        await rota.abort("failed");
      } else {
        await rota.continue();
      }
    },
  );

  const criar = page.getByRole("button", { name: "Criar pedido (rascunho)" });

  await criar.click();
  await expect(page.getByText("Não foi possível confirmar a criação do pedido.")).toBeVisible();
  await expect(criar).toBeEnabled();
  await expect(page.locator("tbody tr").first().getByPlaceholder("SKU ou nome…")).toHaveValue(codigo);
  expect(perdida).toBe(true);
  expect(await pedidosCom(codigo)).toHaveLength(1);

  // A nova tentativa leva o mesmo `requestId` (D-722): abre o pedido que já
  // existe, e não cria um segundo.
  await criar.click();
  await expect(page).toHaveURL(/\/compras\/[0-9a-f-]{36}$/);

  const pedidos = await pedidosCom(codigo);

  expect(pedidos).toHaveLength(1);
  expect(page.url()).toContain(pedidos[0] ?? "sem-pedido");
});

test("editar pedido: falha de transporte ao salvar avisa, libera o botão e a nova tentativa grava (D-864)", async ({
  page,
}) => {
  const codigo = `TRANSPORTE-EDICAO-E2E-${String(Date.now())}`;

  await login(page, "/compras/novo");
  await preencherItem(page, codigo, "2");
  await page.getByRole("button", { name: "Criar pedido (rascunho)" }).click();
  await expect(page).toHaveURL(/\/compras\/[0-9a-f-]{36}$/);

  const id = new URL(page.url()).pathname.split("/").pop() ?? "";
  const destino = `/compras/${id}/editar`;

  await page.goto(destino);

  const salvar = page.getByRole("button", { name: "Salvar alterações" });

  await expect(salvar).toBeVisible();
  await page.locator("tbody tr").first().locator('input[type="number"]').first().fill("4");

  let bloqueada = false;

  // Aqui a ação NÃO chega ao servidor: a nova tentativa grava normalmente.
  await page.route(
    (endereco) => endereco.pathname === destino,
    async (rota) => {
      const pedido = rota.request();

      if (!bloqueada && pedido.method() === "POST" && pedido.headers()["next-action"] !== undefined) {
        bloqueada = true;
        await rota.abort("failed");
      } else {
        await rota.continue();
      }
    },
  );

  await salvar.click();
  await expect(page.getByText("Não foi possível confirmar se as alterações foram salvas.")).toBeVisible();
  await expect(salvar).toBeEnabled();
  expect(bloqueada).toBe(true);

  await salvar.click();
  await expect(page).toHaveURL(new RegExp(`/compras/${id}$`));

  const { data, error } = await banco()
    .from("purchase_order_items")
    .select("quantity_ordered")
    .eq("purchase_order_id", id)
    .eq("sku_snapshot", codigo);

  expect(error).toBeNull();
  expect(data?.map((linha) => linha.quantity_ordered)).toEqual([4]);
});

/*
  FALHA DE TRANSPORTE NO DETALHE DO PEDIDO (D-865). Os itens são texto livre de
  propósito: sem SKU do catálogo, receber não lança movimento de estoque, e as
  specs que contam o saldo do SKU do seed ficam intactas. A idempotência do
  recebimento aparece em `quantity_received` e nos eventos, que saem do mesmo
  laço da RPC que grava o estoque.
*/

/**
 * Derruba a PRIMEIRA Server Action da página `caminho`. Com `perderResposta`,
 * o servidor recebe e grava, e só a resposta não chega ao navegador.
 */
async function derrubarPrimeiraAcao(page: Page, caminho: string, perderResposta: boolean): Promise<() => boolean> {
  let derrubada = false;

  await page.route(
    (endereco) => endereco.pathname === caminho,
    async (rota) => {
      const pedido = rota.request();

      if (!derrubada && pedido.method() === "POST" && pedido.headers()["next-action"] !== undefined) {
        derrubada = true;

        if (perderResposta) await rota.fetch();

        await rota.abort("failed");
      } else {
        await rota.continue();
      }
    },
  );

  return () => derrubada;
}

/** Cria um rascunho com um item em texto livre e devolve o caminho do detalhe. */
async function criarRascunho(page: Page, codigo: string, quantidade: string): Promise<string> {
  await login(page, "/compras/novo");
  await preencherItem(page, codigo, quantidade);
  await page.getByRole("button", { name: "Criar pedido (rascunho)" }).click();
  await expect(page).toHaveURL(/\/compras\/[0-9a-f-]{36}$/);

  return new URL(page.url()).pathname;
}

test("detalhe do pedido: falha de transporte ao aprovar avisa, libera o botão e a nova tentativa aprova (D-865)", async ({
  page,
}) => {
  const caminho = await criarRascunho(page, `TRANSPORTE-APROVAR-E2E-${String(Date.now())}`, "2");
  const derrubada = await derrubarPrimeiraAcao(page, caminho, false);
  const aprovar = page.getByRole("button", { name: "Aprovar" });

  await aprovar.click();
  await expect(page.getByText("Não foi possível confirmar a ação.")).toBeVisible();
  await expect(aprovar).toBeEnabled();
  expect(derrubada()).toBe(true);

  await aprovar.click();
  await expect(page.getByRole("button", { name: "Marcar como enviado pelo fornecedor" })).toBeVisible();
});

test("recebimento parcial: resposta perdida avisa, e a nova tentativa não recebe duas vezes (D-865)", async ({
  page,
}) => {
  const codigo = `TRANSPORTE-RECEBER-E2E-${String(Date.now())}`;
  const caminho = await criarRascunho(page, codigo, "5");
  const id = caminho.split("/").pop() ?? "";

  await page.getByRole("button", { name: "Aprovar" }).click();
  await page.getByRole("button", { name: "Marcar como enviado pelo fornecedor" }).click();
  await page.getByRole("button", { name: "Receber parte do pedido" }).click();
  await page.getByLabel(`Quantidade recebida agora de ${codigo}`).fill("2");

  const derrubada = await derrubarPrimeiraAcao(page, caminho, true);
  const registrar = page.getByRole("button", { name: "Registrar recebimento" });

  await registrar.click();
  await expect(page.getByText("Não foi possível confirmar o recebimento.")).toBeVisible();
  await expect(registrar).toBeEnabled();
  await expect(page.getByLabel(`Quantidade recebida agora de ${codigo}`)).toHaveValue("2");
  expect(derrubada()).toBe(true);

  // O servidor gravou a primeira tentativa: 2 recebidas.
  const recebido = async (): Promise<number[]> => {
    const { data, error } = await banco()
      .from("purchase_order_items")
      .select("quantity_received")
      .eq("purchase_order_id", id);

    if (error !== null) throw new Error(error.message);

    return data.map((linha) => linha.quantity_received);
  };

  expect(await recebido()).toEqual([2]);

  // A nova tentativa leva o mesmo `requestId` (D-724): é reconhecida e não
  // recebe de novo.
  await registrar.click();
  await expect(registrar).toBeHidden();
  expect(await recebido()).toEqual([2]);

  const { data: eventos, error } = await banco()
    .from("purchase_order_events")
    .select("event_type")
    .eq("purchase_order_id", id)
    .in("event_type", ["PARTIALLY_RECEIVED", "RECEIVED"]);

  expect(error).toBeNull();
  expect(eventos).toHaveLength(1);
});

test("custo do pedido: resposta perdida avisa, relê a lista e não deixa o formulário preso (D-865)", async ({
  page,
}) => {
  const caminho = await criarRascunho(page, `TRANSPORTE-CUSTO-E2E-${String(Date.now())}`, "1");
  const id = caminho.split("/").pop() ?? "";

  await page.getByText("Custos adicionais (frete, seguro, tributos, desembaraço)").click();
  await page.getByLabel("Valor", { exact: true }).fill("150");

  const derrubada = await derrubarPrimeiraAcao(page, caminho, true);
  const incluir = page.getByRole("button", { name: "Incluir custo" });

  await incluir.click();
  await expect(page.getByText("Não foi possível confirmar o lançamento do custo.")).toBeVisible();
  await expect(incluir).toBeEnabled();
  expect(derrubada()).toBe(true);

  // O custo foi gravado uma vez, e a releitura o mostra na tela: é o que a
  // pessoa precisa ver para NÃO lançar de novo (lançar custo não é idempotente).
  const { data, error } = await banco().from("purchase_order_costs").select("amount").eq("purchase_order_id", id);

  expect(error).toBeNull();
  expect(data?.map((linha) => linha.amount)).toEqual([150]);
  await expect(page.getByRole("cell", { name: "R$ 150,00" })).toBeVisible();

  // Com o primeiro custo, a releitura troca o `<details>` pelo painel e monta
  // outro formulário: o aviso tem de continuar na tela (a CI do #394 pegou a
  // releitura apagando o aviso antes da conferência).
  await expect(page.getByText("Não foi possível confirmar o lançamento do custo.")).toBeVisible();
});

test("previsão do pedido: falha de transporte avisa e libera o botão (D-865)", async ({ page }) => {
  const caminho = await criarRascunho(page, `TRANSPORTE-PREVISAO-E2E-${String(Date.now())}`, "1");

  await page.getByRole("button", { name: "Atualizar previsão ou referência" }).click();
  await page.getByLabel("Previsão de chegada").fill("2026-12-20");

  const derrubada = await derrubarPrimeiraAcao(page, caminho, false);
  const salvar = page.getByRole("button", { name: "Salvar previsão" });

  await salvar.click();
  await expect(page.getByText("Não foi possível confirmar se a previsão foi salva.")).toBeVisible();
  await expect(salvar).toBeEnabled();
  await expect(page.getByLabel("Previsão de chegada")).toHaveValue("2026-12-20");
  expect(derrubada()).toBe(true);

  await salvar.click();
  await expect(page.getByText("Previsão atualizada.")).toBeVisible();
});
