import { expect, test } from "@playwright/test";

import { factValue, login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * As duas telas do importador do UpSeller, migradas em D-278.
 *
 * O fixture tem a FORMA do lote real de `LINKS` medido no Dev — total maior
 * que OK, aplicadas iguais a OK —, em escala legível: 100 linhas, 80 OK, 20
 * ignoradas, 80 aplicadas. Sem a linha ignorada os dois números seriam iguais
 * e os casos passariam por acaso (D-197).
 */
test("a lista de importações declara a janela e recorta pela base", async ({ page }) => {
  await login(page, "/importacoes");

  await expect(page.getByRole("heading", { name: "Importações", level: 1 })).toBeVisible();

  const painel = page.getByRole("region", { name: "Histórico de importações" });

  await expect(painel).toContainText("1 importação.");
  await expect(painel).toContainText("fixture-links.xlsx");

  // O seed deixa o único lote como LINKS: filtrar por Estoque tem de esvaziar
  // a tabela E a contagem. Se o `count` ignorasse o filtro, seguiria "1".
  await page.goto("/importacoes?tipo=STOCK");

  await expect(painel).toContainText("Nenhuma importação com estes filtros.");

  // Tipo inventado na URL não vira consulta — cai em "todos" (conjunto fechado).
  await page.goto("/importacoes?tipo=PLANILHAS");

  await expect(painel).toContainText("1 importação.");
});

test("a conferência mede a aplicação sobre as APROVADAS, não sobre o total lido", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/importacoes/${seed.importBatchId}`);

  // Âncora de tela certa antes de qualquer afirmação (a lição de D-276).
  await expect(page.getByRole("heading", { name: "fixture-links.xlsx" })).toBeVisible();

  await expect(factValue(page, "Linhas")).toHaveText("100");
  await expect(factValue(page, "OK")).toHaveText("80");
  await expect(factValue(page, "Ignoradas")).toHaveText("20");
  await expect(factValue(page, "Aplicadas")).toHaveText("80");

  // O denominador é o que este caso existe para guardar: "80 de 80", nunca
  // "80 de 100" — que anunciaria 20% de falha num lote que aplicou tudo o que
  // devia, porque as 20 ignoradas nunca foram candidatas.
  const aplicacao = page.getByRole("listitem").filter({ hasText: "Aplicação" });

  await expect(aplicacao).toContainText("80 de 80");
  await expect(aplicacao).not.toContainText("100");

  // Lote saudável não escreve "0 pendentes".
  await expect(aplicacao).not.toContainText("pendente");
});

test("o filtro de linha recorta, e a janela diz a ordem", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/importacoes/${seed.importBatchId}`);

  const painel = page.getByRole("region", { name: "Linhas da planilha" });

  await expect(painel).toContainText("2 linhas.");

  // "Conteúdo lido" é `reason ?? summarize(payload)`, e a ordem importa: linha
  // não-OK SEMPRE tem motivo (é `erp_import_rows_reason_matches_status` que
  // exige), então o resumo do payload só aparece nas linhas OK. As duas
  // afirmações abaixo fixam esse contrato — e o resumo prova que o fixture usa
  // a FORMA real de um payload de LINKS (`storeLabel` + `ref`), não uma
  // inventada, que deixaria a coluna muda.
  await expect(painel).toContainText("MLBU4818089142");
  await expect(painel).toContainText("SKU sem vinculo na planilha");

  await page.getByRole("link", { name: "Ignorada", exact: true }).click();

  await expect(page).toHaveURL(/status=SKIPPED/);
  await expect(painel).toContainText("1 linha.");
  await expect(painel).toContainText("SKU sem vinculo na planilha");
  // A linha OK saiu do recorte, e com ela o resumo do payload dela.
  await expect(painel).not.toContainText("MLBU4818089142");
});
