import { type Page, expect, test } from "@playwright/test";

import { E2E_LISTINGS, E2E_LISTING_SOLD_UNLINKED } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/vinculacoes` — Integridade de Catálogo, depois da migração para o frame
 * `ProcessScreen type="links"` (D21, D-259).
 *
 * **A tela mudou de assunto, e é isso que este arquivo protege.** Era uma fila
 * de `link_candidates`; virou uma visão de integridade sobre ANÚNCIOS, com
 * candidato como um estado entre outros. É também a primeira tela de processo
 * com faixa de KPIs desenhada no frame.
 *
 * O que ele afirma, em ordem de gravidade:
 *
 *  1. **"Sem vínculo" não é `sku_id is null`** (D-122). O quarto anúncio do
 *     seed tem vínculo por VARIAÇÃO e `sku_id` nulo — se alguém trocar a
 *     contagem pelo atalho, a célula passa de 3 para 4 e este teste fica
 *     vermelho. No Dev a diferença é 863 contra 1.876.
 *  2. **A célula "Vendidos sem vínculo" é a interseção de dois predicados**, e
 *     clicar nela mostra exatamente aquelas linhas (D-242). O quinto anúncio
 *     do seed existe só para esse caso.
 *  3. **O zero de candidatos diz POR QUE é zero.** Um "0" cru leria como "não
 *     há trabalho", que é afirmação diferente de "toda linha resolveu"
 *     (lição dos cartões de D-250).
 */

const ESPERADO = {
  total: E2E_LISTINGS.length,
  // `vinculo: "sku"` e `vinculo: "variacao"` contam como VINCULADO.
  vinculados: E2E_LISTINGS.filter((a) => a.vinculo !== "nenhum").length,
  semVinculo: E2E_LISTINGS.filter((a) => a.vinculo === "nenhum").length,
};

function celula(page: Page, rotulo: string) {
  return page.locator(".sb-kpi", { has: page.getByText(rotulo, { exact: true }) });
}

test("/vinculacoes: a faixa conta o que a tabela mostra, e vínculo por variação é vinculado", async ({
  page,
}) => {
  await login(page, "/vinculacoes");

  await expect(page.getByRole("heading", { name: "Integridade de Catálogo", level: 1 })).toBeVisible();
  await expect(page.getByText("ESTOQUE / VINCULAÇÕES")).toBeVisible();

  await expect(celula(page, "Anúncios sincronizados")).toContainText(String(ESPERADO.total));
  await expect(celula(page, "Vinculados")).toContainText(String(ESPERADO.vinculados));

  /*
    O CASO DE D-122: são 3 sem vínculo, não 4. O anúncio de vínculo por
    variação tem `sku_id` nulo e NÃO é fila de trabalho.
  */
  await expect(celula(page, "Sem vínculo")).toContainText(String(ESPERADO.semVinculo));
  await expect(celula(page, "Sem vínculo")).toContainText("vínculo por variação conta como vinculado");
});

test("/vinculacoes: clicar em 'Vendidos sem vínculo' mostra exatamente aquelas linhas", async ({ page }) => {
  await login(page, "/vinculacoes");

  // Um só no fixture, e é o quinto anúncio — o único sem vínculo COM venda.
  await expect(celula(page, "Vendidos sem vínculo")).toContainText("1");

  await celula(page, "Vendidos sem vínculo").getByRole("link", { name: "ver lista" }).click();

  await expect(page).toHaveURL(/estado=sem-vinculo&venda=vendeu/);

  const linhas = page.locator("tbody tr");
  await expect(linhas).toHaveCount(1);
  await expect(linhas.first()).toContainText(E2E_LISTING_SOLD_UNLINKED.itemId);
  await expect(linhas.first()).toContainText("Sem vínculo");
});

test("/vinculacoes: o zero de candidatos diz por que é zero, e a vinculação manual continua", async ({
  page,
}) => {
  await login(page, "/vinculacoes");

  /*
    O seed não cria candidato — como o Dev, onde toda linha do ERP resolveu.
    O que a tela não pode fazer é mostrar "0" mudo.
  */
  await expect(celula(page, "Candidatos pendentes")).toContainText("0");
  await expect(celula(page, "Candidatos pendentes")).toContainText("nenhuma linha do ERP ficou sem SKU");

  await expect(page.getByText(/toda linha do ERP encontrou o seu SKU/)).toBeVisible();

  // Funcionalidade que o frame não desenha e a tela real tem: ela sobrevive.
  await expect(page.getByRole("heading", { name: "Vincular um anúncio à mão" })).toBeVisible();
});
