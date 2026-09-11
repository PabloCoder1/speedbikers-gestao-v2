import { type Page, expect, test } from "@playwright/test";

import { E2E_LISTINGS, E2E_LISTING_SOLD_UNLINKED, E2E_ML_ACCOUNT, E2E_SKU_CODE } from "./constants.js";
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

  // Escopado ao painel: a tela tem uma SEGUNDA tabela (comparação entre
  // contas), e `tbody tr` solto passaria a contar as linhas das duas.
  const linhas = page.getByRole("region", { name: "Tabela de Vinculações" }).locator("tbody tr");
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

/**
 * O DEFEITO QUE ESTE BLOCO IMPEDE DE VOLTAR (D-313).
 *
 * D-284 trocou `style` inline por classe do design system no formulário e
 * apagou JUNTO dois campos — "Variação" e "SKU de destino". Sem o campo de SKU,
 * `skuSearch.query` nunca muda, `selected` fica null para sempre e o botão
 * "Vincular" nasce desabilitado: a tela cujo NOME é vinculação parou de
 * vincular, e nenhum teste viu, porque todos afirmavam sobre a faixa e a
 * tabela. Este afirma sobre o CAMINHO INTEIRO — da linha até o botão habilitado.
 */
test("/vinculacoes: a linha sem vínculo leva ao formulário, e o formulário vincula", async ({ page }) => {
  await login(page, "/vinculacoes?estado=sem-vinculo");

  const tabela = page.getByRole("region", { name: "Tabela de Vinculações" });
  const linha = tabela.locator("tbody tr").filter({ hasText: E2E_LISTING_SOLD_UNLINKED.itemId });

  // O caminho de volta: a linha que expõe o problema oferece a saída.
  await linha.getByRole("link", { name: "Vincular" }).click();

  // A conta viaja como slug e o MLB como `item` — um link, as duas coisas.
  await expect(page).toHaveURL(new RegExp(`conta=${E2E_ML_ACCOUNT.slug}&item=${E2E_LISTING_SOLD_UNLINKED.itemId}`));
  await expect(page.getByLabel("MLB do anúncio")).toHaveValue(E2E_LISTING_SOLD_UNLINKED.itemId);

  // Os dois campos que D-284 apagou.
  await expect(page.getByLabel("Variação (opcional)")).toBeVisible();

  const vincular = page.getByRole("button", { name: "Vincular" });
  await expect(vincular).toBeDisabled();

  await page.getByLabel("SKU de destino").fill(E2E_SKU_CODE);
  await page.getByRole("button", { name: new RegExp(E2E_SKU_CODE) }).click();

  // Com conta, MLB e SKU escolhidos, a ação existe de verdade.
  await expect(vincular).toBeEnabled();
});

/**
 * As duas leituras POR CONTA que o reenquadramento de D-259 perdeu: o recorte
 * (ver uma conta só) e a comparação (ver as contas lado a lado). A RPC sempre
 * aceitou `p_ml_account_id` e `get_link_integrity` sempre devolveu uma linha por
 * conta — o que faltava era tela.
 */
test("/vinculacoes: dá para recortar numa conta e comparar as contas entre si", async ({ page }) => {
  await login(page, "/vinculacoes");

  const comparacao = page.getByRole("region", { name: "Comparação entre contas" });
  await expect(comparacao).toBeVisible();

  const linhaDaConta = comparacao.locator("tbody tr").filter({ hasText: E2E_ML_ACCOUNT.label });

  /*
    E A COMPARAÇÃO SOMA COM A FAIXA — a afirmação que custou uma migration.

    `get_link_integrity.com_vinculo` contava só o vínculo gravado em
    `sku_listing_links` e ignorava o vínculo DIRETO (`listings.sku_id`): a faixa
    dizia 3 sem vínculo e a comparação, dois painéis abaixo, dizia 4. Duas
    definições da mesma palavra na mesma tela. D-313 alinhou a função com D-122;
    estas três células ficam vermelhas se alguém desalinhar de novo.
  */
  const celulas = linhaDaConta.locator("td");
  await expect(celulas.nth(1)).toHaveText(String(ESPERADO.total));
  await expect(celulas.nth(2)).toHaveText(String(ESPERADO.vinculados));
  await expect(celulas.nth(3)).toHaveText(String(ESPERADO.semVinculo));

  // Da comparação para o recorte: clicar na conta filtra a tabela acima.
  await linhaDaConta.getByRole("link", { name: E2E_ML_ACCOUNT.label }).click();

  await expect(page).toHaveURL(new RegExp(`conta=${E2E_ML_ACCOUNT.slug}`));
  await expect(page.getByRole("region", { name: "Tabela de Vinculações" }).locator("tbody tr")).toHaveCount(
    ESPERADO.total,
  );

  // A faixa acompanha o recorte: cabeçalho e corpo falam da mesma conta (D-236).
  await expect(celula(page, "Anúncios sincronizados")).toContainText(String(ESPERADO.total));
});
