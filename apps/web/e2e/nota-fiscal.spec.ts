import { expect, test } from "@playwright/test";

import { login, statValue } from "./helpers.js";
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

  await expect(statValue(page, "Vinculados")).toContainText("0");

  await page.getByPlaceholder("Buscar SKU…").fill(seed.skuCode);
  await page.getByRole("button", { name: new RegExp(seed.skuCode) }).click();
  await page.getByRole("button", { name: "Vincular", exact: true }).click();

  await expect(page.getByText(seed.skuCode, { exact: true }).first()).toBeVisible();
  await expect(statValue(page, "Vinculados")).toContainText("1");
});
