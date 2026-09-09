import { expect, test } from "@playwright/test";

import { factValue, login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

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

  await page.getByPlaceholder("Buscar SKU…").fill(seed.skuCode);
  await page.getByRole("button", { name: new RegExp(seed.skuCode) }).click();
  await page.getByRole("button", { name: "Vincular", exact: true }).click();

  await expect(page.getByText(seed.skuCode, { exact: true }).first()).toBeVisible();
  await expect(factValue(page, "Vinculados")).toHaveText("1");

  // O item ganha o estado derivado de `sku_id` — os DOIS estados que existem
  // (D-253 mediu: `SUGESTAO` e `CONFLITO` do brief §25 não têm dado).
  await expect(page.getByRole("table")).toContainText("Vinculado");
});

/**
 * O histórico (`/notas-fiscais`), migrado em D-253. O que este caso protege é
 * a frase da janela — a tela lia 50 notas e não dizia que eram 50 (classe
 * D-131) — e que o filtro recorta a BASE, não a janela já cortada (D-236).
 */
test("o histórico de NF-e declara a janela, e o filtro recorta a base", async ({ page }) => {
  await login(page, "/notas-fiscais");

  await expect(page.getByRole("heading", { name: "NF-e / Entradas", level: 1 })).toBeVisible();

  const painel = page.getByRole("region", { name: "Histórico de Notas" });

  await expect(painel).toContainText("1 nota.");

  // O seed deixa a única nota em PARSED: filtrar por "Aplicado" tem de esvaziar
  // a tabela E a contagem. Se o `count` ignorasse o filtro, continuaria "1 nota."
  await page.goto("/notas-fiscais?estado=APPLIED");

  await expect(painel).toContainText("Nenhuma nota fiscal com estes filtros.");
});
