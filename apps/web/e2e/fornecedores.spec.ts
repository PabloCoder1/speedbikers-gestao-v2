import { expect, test } from "@playwright/test";

import { E2E_PURCHASE_ORDERS, E2E_SUPPLIER, E2E_SUPPLIER_INATIVO } from "./constants.js";
import { derrubarPrimeiraAcao, login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

async function criarFornecedorTemporario(ativo: boolean) {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");
  const db = clienteDeServico();
  const seed = await readSeedOutput();
  const criado = await db.from("suppliers").insert({
    organization_id: seed.organizationId,
    name: `E2E Transporte ${crypto.randomUUID()}`,
    is_active: ativo,
    contact_name: "Contato preservado",
    email: "transporte@example.test",
    notes: "Condições preservadas após falha de conexão",
  }).select("id,name,is_active,contact_name,email,notes").single();
  if (criado.error !== null) throw new Error(criado.error.message);
  return { db, fornecedor: criado.data };
}

for (const novoAtivo of [true, false]) {
  test(`fornecedor: falha de conexão ao ${novoAtivo ? "reativar" : "inativar"} conserva a edição e permite nova tentativa`, async ({ page }) => {
    const { db, fornecedor } = await criarFornecedorTemporario(!novoAtivo);
    const ler = () => db.from("suppliers").select("id,name,is_active,contact_name,email,notes").eq("id", fornecedor.id).single();
    const rascunho = `${fornecedor.name} pendente`;
    try {
      await login(page, `/fornecedores/${fornecedor.id}/editar`);
      await page.getByLabel("Nome").fill(rascunho);
      if (!novoAtivo) await page.getByRole("button", { name: "Inativar", exact: true }).click();
      const acao = novoAtivo
        ? page.getByRole("button", { name: "Reativar", exact: true })
        : page.getByRole("group", { name: "Confirmar inativação" }).getByRole("button", { name: "Inativar", exact: true });
      const caiu = await derrubarPrimeiraAcao(page);
      await acao.click();
      await expect(page.getByRole("alert").filter({ hasText: "Não foi possível confirmar a alteração" })).toBeVisible();
      await expect(acao).toBeEnabled();
      await expect(page.getByLabel("Nome")).toHaveValue(rascunho);
      if (!novoAtivo) await expect(page.getByRole("group", { name: "Confirmar inativação" }).getByRole("button", { name: "Cancelar" })).toBeEnabled();
      expect(caiu()).toBe(true);
      const falha = await ler();
      expect(falha.error).toBeNull();
      expect(falha.data).toEqual(fornecedor);

      await acao.click();
      await expect(page.getByRole("button", { name: novoAtivo ? "Inativar" : "Reativar", exact: true })).toBeVisible();
      const depois = await ler();
      expect(depois.error).toBeNull();
      expect(depois.data).toEqual({ ...fornecedor, is_active: novoAtivo });
    } finally {
      const limpeza = await db.from("suppliers").delete().eq("id", fornecedor.id);
      expect.soft(limpeza.error).toBeNull();
    }
  });
}

test("fornecedor: falha de conexão ao excluir mantém a confirmação e permite nova tentativa", async ({ page }) => {
  const { db, fornecedor } = await criarFornecedorTemporario(true);
  const rascunho = `${fornecedor.name} pendente`;
  try {
    await login(page, `/fornecedores/${fornecedor.id}/editar`);
    await page.getByLabel("Nome").fill(rascunho);
    await page.getByRole("button", { name: "Excluir", exact: true }).click();
    const confirmacao = page.getByRole("group", { name: "Confirmar exclusão" });
    const excluir = confirmacao.getByRole("button", { name: "Excluir de vez", exact: true });
    const caiu = await derrubarPrimeiraAcao(page);
    await excluir.click();
    await expect(confirmacao.getByRole("alert")).toContainText("Não foi possível confirmar a exclusão");
    await expect(excluir).toBeEnabled();
    await expect(confirmacao.getByRole("button", { name: "Cancelar" })).toBeEnabled();
    await expect(page.getByLabel("Nome")).toHaveValue(rascunho);
    expect(caiu()).toBe(true);
    const falha = await db.from("suppliers").select("id,name,is_active,contact_name,email,notes").eq("id", fornecedor.id).single();
    expect(falha.error).toBeNull();
    expect(falha.data).toEqual(fornecedor);

    await excluir.click();
    await expect(page).toHaveURL(/\/fornecedores$/u);
    const depois = await db.from("suppliers").select("id").eq("id", fornecedor.id).maybeSingle();
    expect(depois.error).toBeNull();
    expect(depois.data).toBeNull();
  } finally {
    const limpeza = await db.from("suppliers").delete().eq("id", fornecedor.id);
    expect.soft(limpeza.error).toBeNull();
  }
});

/**
 * `/fornecedores` — a Base de Fornecedores depois da migração para o frame
 * `ProcessScreen type="suppliers"` (D20, D-256).
 *
 * O frame desta variação é o MESMO esboço da `nfe` (D-253): cabeçalho, painel
 * e um parágrafo de reserva no lugar da tabela. Então o que há para afirmar
 * não é composição inventada — é o cabeçalho do frame, o painel, a janela
 * declarada e o filtro que o "Filtros ⌄" promete.
 *
 * **O segundo fornecedor do seed é o que torna este teste possível.** Com um
 * só, "Ativos" e "Inativos" devolveriam o mesmo conjunto e o filtro passaria
 * sem provar nada.
 */

test("/fornecedores: o frame, a janela declarada e o filtro de estado", async ({ page }) => {
  await login(page, "/fornecedores");

  // Cabeçalho do frame.
  await expect(page.getByRole("heading", { name: "Fornecedores", level: 1 })).toBeVisible();
  await expect(page.getByText("ESTOQUE / OPERAÇÃO")).toBeVisible();
  await expect(page.getByRole("link", { name: "Novo Fornecedor" })).toBeVisible();

  /*
    A linha de apoio do frame diz "Lead time, cobertura e relacionamento em uma
    única visão". Lead time e cobertura NÃO existem por fornecedor
    (`replenishment_settings` é escopada por organização, marca ou SKU; e
    `skus.supplier_id` não existe de propósito, D-174), então a frase foi
    recomposta sem elas. Este teste fixa a recomposição: a tela não pode voltar
    a prometer o que não mostra.
  */
  await expect(page.getByText(/Cadastro e relacionamento de compra/)).toBeVisible();
  await expect(page.getByText(/Lead time, cobertura/)).toHaveCount(0);

  // O painel do frame e a janela declarada — a tela lia `.limit(200)` calada.
  await expect(page.getByRole("heading", { name: "Base de Fornecedores", level: 2 })).toBeVisible();
  await expect(page.getByText(/\d+ fornecedores?\.|Mostrando \d+ a \d+ de \d+/)).toBeVisible();

  /*
    `exact: true` NAO e detalhe: `getByRole` casa o nome por SUBSTRING, e
    "Fornecedor E2E" acha tambem "Fornecedor E2E Inativo" -- duas linhas, e o
    strict mode do Playwright reprova. O nome do segundo fixture conter o do
    primeiro e proposital (eles sao par), entao a exatidao mora aqui.
  */
  // Os dois do seed aparecem quando o recorte é "todos".
  await expect(page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name, exact: true })).toBeVisible();
});

test("/fornecedores: Ativos e Inativos recortam conjuntos diferentes", async ({ page }) => {
  await login(page, "/fornecedores?estado=inativos");

  await expect(page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true })).toHaveCount(0);

  await page.goto("/fornecedores?estado=ativos");

  await expect(page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name, exact: true })).toHaveCount(0);
});

/*
  D-366 — busca, recortes dos pedidos, edição e ativação.

  O seed tem dois fornecedores: o ativo, com pedidos (um deles em rascunho, logo
  EM ABERTO), e o inativo, sem pedido nenhum. É o par que faz cada recorte novo
  provar alguma coisa.
*/

test("/fornecedores: a busca acha pelo CNPJ digitado com pontuação, e diz quando não acha", async ({ page }) => {
  // O seed guarda o documento SEM pontuação; a busca compara só os dígitos.
  await login(page, "/fornecedores?busca=12.345.678%2F0001");

  await expect(page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name, exact: true })).toHaveCount(0);

  await page.goto("/fornecedores?busca=nao-existe-fornecedor");
  await expect(page.getByText("Nenhum fornecedor com estes filtros.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ver todos" })).toBeVisible();
});

test("/fornecedores: 'com pedido em aberto' e 'sem pedido' recortam pelos pedidos de compra", async ({ page }) => {
  await login(page, "/fornecedores?estado=em_aberto");

  await expect(page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name, exact: true })).toHaveCount(0);
  // O selo da linha diz quantos estão em aberto.
  await expect(page.locator("tbody tr", { hasText: E2E_SUPPLIER.name }).getByText(/\d+ em aberto/)).toBeVisible();

  await page.goto("/fornecedores?estado=sem_pedido");

  await expect(page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true })).toHaveCount(0);
});

test("editar fornecedor: erro no campo, contato vira link, e o cadastro volta como estava", async ({ page }) => {
  await login(page, "/fornecedores");
  await page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true }).click();
  await page.getByRole("link", { name: "Editar" }).click();

  await expect(page.getByRole("heading", { name: `Editar ${E2E_SUPPLIER.name}`, level: 1 })).toBeVisible();

  /*
    O documento do seed NÃO passa na conferência de dígitos — e continua
    editável: só documento novo ou alterado é conferido. Sem isso, cadastro
    antigo ficaria preso até alguém consertar um CNPJ que ninguém tocou.
  */
  await expect(page.getByLabel("CNPJ ou CPF")).toHaveValue("12.345.678/0001-99");

  // O erro aparece NO campo, e nada é gravado.
  await page.getByLabel("E-mail").fill("vendas-sem-arroba");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByText("E-mail inválido.")).toBeVisible();
  // O que a pessoa digitou FICA no campo — o `<form action>` do React o apagava.
  await expect(page.getByLabel("E-mail")).toHaveValue("vendas-sem-arroba");

  await page.getByLabel("E-mail").fill("");
  await page.getByLabel("WhatsApp").fill("(11) 98765-4321");
  await page.getByRole("button", { name: "Salvar alterações" }).click();

  // De volta ao dashboard, o WhatsApp é um link para a conversa.
  await expect(page.getByRole("link", { name: "(11) 98765-4321" })).toHaveAttribute(
    "href",
    "https://wa.me/5511987654321",
  );

  // Desfaz: outras specs leem este fornecedor sem canal de contato.
  await page.getByRole("link", { name: "Editar" }).click();
  await page.getByLabel("WhatsApp").fill("");
  await page.getByRole("button", { name: "Salvar alterações" }).click();
  await expect(page.getByText("Nenhum canal de contato cadastrado.")).toBeVisible();
});

test("ativar e inativar: reativar é um clique, inativar pede confirmação na linha", async ({ page }) => {
  await login(page, "/fornecedores?estado=inativos");
  await page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name, exact: true }).click();
  await page.getByRole("link", { name: "Editar" }).click();

  await page.getByRole("button", { name: "Reativar" }).click();
  await expect(page.getByRole("button", { name: "Inativar" })).toBeVisible();

  // O primeiro clique só pergunta; a mudança exige o segundo.
  await page.getByRole("button", { name: "Inativar" }).click();
  const confirmacao = page.getByRole("group", { name: "Confirmar inativação" });

  await expect(confirmacao).toBeVisible();
  await confirmacao.getByRole("button", { name: "Inativar" }).click();

  // Volta ao estado do seed: a spec de recortes conta com ele inativo.
  await expect(page.getByRole("button", { name: "Reativar" })).toBeVisible();
});

test("novo fornecedor: a prévia acompanha o que se digita, e o duplicado é avisado antes de salvar (D-367)", async ({ page }) => {
  await login(page, "/fornecedores/novo");

  await expect(page.getByRole("heading", { name: "Novo fornecedor", level: 1 })).toBeVisible();

  const previa = page.getByRole("complementary", { name: "Prévia do fornecedor" });
  await expect(previa.getByText("Nome do fornecedor")).toBeVisible();
  await expect(previa.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");

  // O mesmo nome com outra caixa: o banco aceitaria (a unicidade é exata), a tela avisa.
  await page.getByLabel("Nome").fill(E2E_SUPPLIER.name.toUpperCase());
  await expect(page.getByRole("status").filter({ hasText: "Já existe" })).toContainText(E2E_SUPPLIER.name);
  await expect(previa.getByText(E2E_SUPPLIER.name.toUpperCase())).toBeVisible();

  // O documento do seed, com máscara: aviso de duplicado. O selo diz que os dígitos não fecham.
  await page.getByLabel("CNPJ ou CPF").fill("12.345.678/0001-99");
  await expect(page.getByRole("status").filter({ hasText: "Este documento já está em" })).toBeVisible();
  await expect(page.getByText("CNPJ não confere")).toBeVisible();

  // Um CNPJ válido e novo: selo verde, sem aviso.
  await page.getByLabel("CNPJ ou CPF").fill("11222333000181");
  await expect(page.getByText("CNPJ válido")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Este documento já está em" })).toHaveCount(0);

  // Telefone formatado ao sair, e o atalho que o copia para o WhatsApp.
  await page.getByLabel("Telefone").fill("11987654321");
  await page.getByLabel("Telefone").blur();
  await expect(page.getByLabel("Telefone")).toHaveValue("(11) 98765-4321");
  await page.getByRole("button", { name: "usar o número do telefone" }).click();
  await expect(page.getByLabel("WhatsApp")).toHaveValue("(11) 98765-4321");

  // O atalho de condição escreve a linha nas observações.
  await page.getByRole("button", { name: "Prazo de entrega" }).click();
  await expect(page.getByRole("textbox", { name: "Observações" })).toHaveValue("Prazo de entrega: ");

  // Nome, documento válido, fone e condições: 4 de 7.
  await expect(previa.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "57");
});

/** Um PNG de 1×1 — o menor arquivo que o navegador decodifica de verdade. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

test("logo do fornecedor: sobe ao salvar, aparece no painel e sai ao remover (D-370)", async ({ page }) => {
  await login(page, "/fornecedores");
  await page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true }).click();
  await expect(page).toHaveURL(/\/fornecedores\/[0-9a-f-]{36}$/);

  const painel = page.url();
  const cabecalho = page.getByRole("region", { name: E2E_SUPPLIER.name });

  await expect(cabecalho.locator("img")).toHaveCount(0);

  await page.getByRole("link", { name: "Editar" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_1X1, "base64"),
  });

  // A logo fica pronta no formulário e só sobe quando o cadastro é salvo.
  await expect(page.getByText("Pronta — sobe quando você salvar.")).toBeVisible();
  await page.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(page).toHaveURL(painel);
  await expect(cabecalho.locator("img")).toHaveAttribute("src", /\/storage\/v1\/object\/public\/supplier-logos\//);

  // Desfaz: as outras specs leem este fornecedor com as iniciais.
  await page.getByRole("link", { name: "Editar" }).click();
  await page.getByRole("button", { name: "Remover", exact: true }).click();
  await expect(page.getByText("Será removida quando você salvar.")).toBeVisible();
  await page.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(page).toHaveURL(painel);
  await expect(cabecalho.locator("img")).toHaveCount(0);
});

test("excluir fornecedor: some de vez quando não tem pedido, e com pedido explica e aponta para inativar (D-372)", async ({ page }) => {
  // Com pedido: o seed dá pedidos ao "Fornecedor E2E".
  await login(page, "/fornecedores");
  await page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true }).click();
  await page.getByRole("button", { name: "Excluir" }).click();
  await expect(page.getByText(/Não dá para excluir: há \d+ pedidos? de compra/)).toBeVisible();
  await page.getByRole("button", { name: "Entendi" }).click();

  // Sem pedido: cadastra um, e exclui pela edição.
  const nome = `E2E Excluir ${String(Date.now())}`;

  await page.goto("/fornecedores/novo");
  await page.getByLabel("Nome").fill(nome);
  await page.getByRole("button", { name: "Cadastrar fornecedor" }).click();
  await expect(page.getByRole("heading", { name: nome, level: 2 })).toBeVisible();

  // A página do fornecedor TAMBÉM tem "Excluir". Sem esperar a edição carregar,
  // o clique às vezes caía na página antiga: a confirmação abria lá, a
  // navegação terminava e "Excluir de vez" saía do DOM — falhou na CI da main
  // três vezes em 24/09 com "element was detached from the DOM, retrying".
  await page.getByRole("link", { name: "Editar" }).click();
  await expect(page).toHaveURL(/\/fornecedores\/[0-9a-f-]{36}\/editar$/);
  await page.getByRole("button", { name: "Excluir" }).click();
  await page.getByRole("group", { name: "Confirmar exclusão" }).getByRole("button", { name: "Excluir de vez" }).click();

  await expect(page).toHaveURL(/\/fornecedores$/);
  await expect(page.getByRole("link", { name: nome, exact: true })).toHaveCount(0);
});

test("painel do fornecedor: o pedido de compra abre ao clicar e a volta preserva o fornecedor", async ({ page }) => {
  const prefetches: string[] = [];

  page.on("request", (request) => {
    const headers = request.headers();
    const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;
    const { pathname } = new URL(request.url());

    if (prefetch && /^\/compras\/[0-9a-f-]{36}$/.test(pathname)) prefetches.push(request.url());
  });

  await login(page, "/fornecedores");
  await page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true }).click();
  await expect(page).toHaveURL(/\/fornecedores\/[0-9a-f-]{36}$/);

  const fornecedor = page.url();
  const pedido = page.getByRole("region", { name: "Pedidos de compra" }).getByRole("link", { name: /^#\d+$/ }).first();
  const destino = await pedido.getAttribute("href");
  const numero = await pedido.innerText();

  expect(destino).toMatch(/^\/compras\/[0-9a-f-]{36}$/);
  await pedido.scrollIntoViewIfNeeded();
  await page.waitForLoadState("networkidle");
  expect(prefetches).toEqual([]);

  await pedido.click();
  await expect(page).toHaveURL((url) => url.pathname === destino);
  await expect(page.getByRole("heading", { level: 1, name: "Pedido de compra" })).toBeVisible();
  await expect(page.getByText(`PEDIDO ${numero}`, { exact: true })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(fornecedor);
  await expect(pedido).toBeVisible();
});

/**
 * O seed não tem item de pedido com SKU vinculado, e um pedido novo não pode
 * ser apagado (o histórico do pedido é só de inclusão): sobraria na gaveta do
 * fornecedor de `gavetas.spec.ts`. O caso vincula um item do seed ao SKU de
 * teste e desfaz no fim.
 */
test("painel do fornecedor: o SKU comprado abre ao clicar e o retorno mostra o mesmo fornecedor", async ({ page }) => {
  const { skuId, skuCode, organizationId } = await readSeedOutput();
  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(supabase.hostname)) throw new Error("Este teste exige Supabase local.");

  const db = clienteDeServico();
  const [primeiroItem] = E2E_PURCHASE_ORDERS[0].itens;

  const item = await db
    .from("purchase_order_items")
    .select("id, sku_id")
    .eq("organization_id", organizationId)
    .eq("sku_snapshot", primeiroItem.sku)
    .single();

  if (item.error !== null) throw new Error(item.error.message);

  const vinculado = await db.from("purchase_order_items").update({ sku_id: skuId }).eq("id", item.data.id);

  if (vinculado.error !== null) throw new Error(vinculado.error.message);

  try {
    await login(page, "/fornecedores");
    await page.getByRole("link", { name: E2E_SUPPLIER.name, exact: true }).click();
    await expect(page).toHaveURL(/\/fornecedores\/[0-9a-f-]{36}$/);

    const fornecedor = page.url();
    const destino = `/skus/${skuId}`;
    const prefetches: string[] = [];

    page.on("request", (request) => {
      const headers = request.headers();
      const prefetch = headers["next-router-prefetch"] !== undefined || headers["next-router-segment-prefetch"] !== undefined;

      if (prefetch && new URL(request.url()).pathname === destino) prefetches.push(request.url());
    });

    const sku = page.getByRole("region", { name: "SKUs já comprados" }).getByRole("link", { name: skuCode, exact: true });

    await expect(sku).toHaveAttribute("href", destino);
    await sku.scrollIntoViewIfNeeded();
    await page.waitForLoadState("networkidle");
    expect(prefetches).toEqual([]);

    await sku.click();
    await expect(page).toHaveURL((url) => url.pathname === destino);
    await expect(page.getByText(`SKU ${skuCode}`, { exact: true })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(fornecedor);
    await expect(sku).toBeVisible();
  } finally {
    const restaurado = await db.from("purchase_order_items").update({ sku_id: item.data.sku_id }).eq("id", item.data.id);

    expect.soft(restaurado.error).toBeNull();
  }
});
