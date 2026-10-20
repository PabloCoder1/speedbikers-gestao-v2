import { expect, test } from "@playwright/test";

import { factValue, login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";
import { clienteDeServico } from "./loja-shopee-live.js";

/**
 * "Conferência de NF-e" (docs/TESTING.md) — terceira etapa do fluxo
 * `upload -> parse -> CONFERÊNCIA -> aplicação`. O seed já deixa o documento
 * em PARSED com um item sem vínculo (upload/parse são cobertos pela camada
 * de Contrato, não aqui — docs/TESTING.md secao 1); este teste exercita o
 * vínculo humano de verdade, via `link_document_item` (RPC), não um mock.
 *
 * "Confirmar aplicação" fica de fora de propósito: aquele botão chama
 * `apps/api` (`POST /v1/nfe-imports/:id/apply`), que enfileira em Cloud
 * Tasks para o `apps/worker` processar — infraestrutura que não existe no
 * ambiente do Supabase local desta esteira. E2E amplo demais é caro de
 * manter (docs/TESTING.md secao 3); o vínculo por SKU já é o fluxo humano
 * central da tela.
 */
test("vincula um item da NF-e a um SKU pela tela de conferência", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/notas-fiscais/${seed.documentId}`);

  await expect(page).toHaveURL(new RegExp(`/notas-fiscais/${seed.documentId}$`));

  // Âncora de tela CERTA antes de qualquer afirmação: a décima pergunta de
  // D-276 — um caso que só afirma ausência passa na página de login.
  await expect(page.getByRole("heading", { name: "fixture-nfe.xml" })).toBeVisible();

  // O par rótulo/valor saiu do `Stat` inline e virou a grade de fatos do
  // `ObjectHeader` (D-277). O locator acompanhou a tela; o que ele prova é o
  // mesmo de antes: "Vinculados" vai de 0 a 1 pelo vínculo humano.
  await expect(factValue(page, "Vinculados")).toHaveText("0");

  // A etapa em curso declara a fração, e ela sai da MESMA leitura do
  // cabeçalho — indicador de processo e fatos não podem discordar.
  await expect(page.getByRole("listitem").filter({ hasText: "Conferência e vínculo" })).toContainText(
    "0 de 1 vinculados",
  );

  // O campo também busca pelo NOME do SKU desde o lote 3 do pente fino.
  await page.getByPlaceholder(/Buscar SKU/).fill(seed.skuCode);
  await page.getByRole("button", { name: new RegExp(seed.skuCode) }).click();
  await page.getByRole("button", { name: "Vincular", exact: true }).click();

  await expect(page.getByText(seed.skuCode, { exact: true }).first()).toBeVisible();
  await expect(factValue(page, "Vinculados")).toHaveText("1");

  // O item ganha o estado derivado de `sku_id` — os DOIS estados que existem
  // (D-253 mediu: `SUGESTAO` e `CONFLITO` do brief §25 não têm dado).
  await expect(page.getByRole("table")).toContainText("Vinculado");
});

/**
 * A fila (`/notas-fiscais`), migrada em D-253 e refeita em D-375. O que este
 * caso protege é a frase da janela — a tela lia 50 notas e não dizia que eram
 * 50 (classe D-131) —, que o filtro recorta a BASE e não a janela já cortada
 * (D-236), e que o resumo de D-375 sai da mesma leitura.
 */
test("a fila de documentos declara a janela, e o filtro recorta a base", async ({ page }) => {
  await login(page, "/notas-fiscais");

  await expect(page.getByRole("heading", { name: "Notas e Documentos", level: 1 })).toBeVisible();

  // O resumo: a nota do seed está em PARSED, esperando conferência.
  await expect(page.getByRole("region", { name: "Resumo dos documentos" })).toContainText(
    "Esperando conferência",
  );

  // `exact`: sem ele, "Documentos" tambem casa com a regiao "Resumo dos
  // documentos" — o nome acessivel e comparado por trecho.
  const painel = page.getByRole("region", { name: "Documentos", exact: true });

  await expect(painel).toContainText("1 nota.");

  // O seed deixa a única nota em PARSED: filtrar por "Aplicado" tem de esvaziar
  // a tabela E a contagem. Se o `count` ignorasse o filtro, continuaria "1 nota."
  await page.goto("/notas-fiscais?estado=APPLIED");

  await expect(painel).toContainText("Nenhuma nota fiscal com estes filtros.");
});

/**
 * A NOTA RECUSADA POR REGRA (D-612, sobre a D-497 b do A1). A venda do
 * marketplace já mexe no estoque pelo pedido, e o worker recusa a nota dela na
 * leitura, com o motivo em `last_error_code`. A tela não pode dizer "não
 * conseguimos ler" nem pintar de vermelho uma nota que está certa: diz que ela
 * não é aplicada e por quê; e o DANFE de venda pede o XML. As duas notas são
 * gravadas como o worker as grava (FAILED, com o cabeçalho e sem itens) e saem
 * no fim, para não mexer na contagem do caso de cima.
 */
test("/notas-fiscais: a nota de venda do marketplace não é falha, e o DANFE de venda pede o XML (D-612)", async ({ page }) => {
  const db = clienteDeServico();
  const org = await db.from("organizations").select("id").eq("slug", "e2e-speed-bikers").single();

  expect(org.error).toBeNull();

  const base = {
    organization_id: org.data?.id ?? "",
    status: "FAILED",
    operation_type: "SAIDA",
    issuer_name: "Speed Bikers E2E",
  };
  const notas = await db.from("documents").insert([
    {
      ...base,
      file_name: "e2e-d612-venda-ml.xml",
      storage_path: "e2e/d612-venda-ml.xml",
      // O banco pede o hash de 64 caracteres do arquivo.
      content_hash: "e2e-d612-venda-ml".padEnd(64, "0"),
      source_format: "XML",
      document_type: "NFE",
      document_number: "61201",
      intermediary_cnpj: "03007331000141",
      last_error_code: "SAIDA_VENDA_MARKETPLACE",
      last_error: "nota de venda feita pelo Mercado Livre: o estoque já baixa pelo pedido, e a nota baixaria de novo",
    },
    {
      ...base,
      file_name: "e2e-d612-danfe.pdf",
      storage_path: "e2e/d612-danfe.pdf",
      // O banco pede o hash de 64 caracteres do arquivo.
      content_hash: "e2e-d612-danfe".padEnd(64, "0"),
      source_format: "PDF",
      document_type: "DANFE_PDF",
      document_number: "61202",
      last_error_code: "VENDA_PEDE_XML",
      last_error: "nota de venda ou de devolução de venda em PDF: o DANFE não diz se a venda foi pelo marketplace — envie o XML da nota",
    },
  ]).select("id, document_number");

  expect(notas.error).toBeNull();

  const venda = notas.data?.find((n) => n.document_number === "61201")?.id ?? "";
  const danfe = notas.data?.find((n) => n.document_number === "61202")?.id ?? "";

  try {
    await login(page, "/notas-fiscais?estado=FAILED");
    const painel = page.getByRole("region", { name: "Documentos", exact: true });
    const linhaVenda = painel.getByRole("row", { name: /61201/u });

    // Na fila: "Não aplicada" e o motivo, sem a linha vermelha de falha.
    await expect(linhaVenda).toContainText("Não aplicada");
    await expect(linhaVenda).toContainText("Nota de venda do Mercado Livre: não baixa o estoque");
    await expect(linhaVenda).toContainText("Venda do marketplace · sem baixa");
    await expect(linhaVenda).not.toHaveClass(/sb-nf-linha-falha/u);
    await expect(painel.getByRole("row", { name: /61202/u })).toContainText("Pede o XML");

    // No detalhe: o motivo e o intermediador; nada a reenviar, porque a nota está certa.
    await page.goto(`/notas-fiscais/${venda}`);
    const motivo = page.getByRole("status", { name: "Motivo da recusa" });

    await expect(motivo).toContainText("Nota de venda do Mercado Livre: não baixa o estoque");
    await expect(motivo.getByRole("link")).toHaveCount(0);
    await expect(factValue(page, "Intermediador")).toHaveText("Mercado Livre (03007331000141)");
    await expect(page.getByText("Não conseguimos ler este arquivo")).toHaveCount(0);
    // O cabeçalho e as etapas também: lida, sem baixa, e nada de "falhou".
    await expect(page.getByText("Não aplicada", { exact: true })).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Sem baixa: venda do marketplace" })).toBeVisible();

    // O DANFE de venda pede o XML, com o caminho para enviá-lo.
    await page.goto(`/notas-fiscais/${danfe}`);
    const pedeXml = page.getByRole("status", { name: "Motivo da recusa" });

    await expect(pedeXml).toContainText("Nota de venda em PDF: envie o XML");
    await expect(pedeXml.getByRole("link", { name: /Enviar o XML/u })).toHaveAttribute("href", "/notas-fiscais/nova");
  } finally {
    await db.from("documents").delete().in("id", [venda, danfe]);
  }
});
