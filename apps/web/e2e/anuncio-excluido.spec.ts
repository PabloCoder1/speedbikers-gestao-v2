import { expect, test } from "@playwright/test";

import { E2E_LISTINGS } from "./constants.js";
import { login } from "./helpers.js";
import { clienteDeServico } from "./loja-shopee-live.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * O ANÚNCIO EXCLUÍDO NO MERCADO LIVRE NAS TELAS QUE LEEM `listings` DIRETO
 * (D-634, sobre a D-631 do A1).
 *
 * O pausado do seed é marcado como o worker marca o 404: só `deleted_at`, e o
 * status fica o ÚLTIMO VISTO (`paused`, com estoque). É o pior caso, porque é
 * exatamente o que a contagem "Anúncios pausados" da Home conta: sem a regra
 * por `deleted_at`, ela diria 1 e a `/anuncios`, 0.
 *
 * A linha não se apaga (`listings` é história, e a chave de serviço não tem
 * `delete` nela): a marca sai no fim, de volta a nulo. A suíte roda num worker
 * só, em série, e nenhum outro spec vê o anúncio marcado.
 */
const PAUSADO = E2E_LISTINGS.find((anuncio) => anuncio.status === "paused");

test("o anúncio excluído no ML: a Home não o conta, o detalhe o diz e os vínculos o recusam (D-634)", async ({ page }) => {
  expect(PAUSADO).toBeDefined();
  const itemId = PAUSADO?.itemId ?? "";
  const db = clienteDeServico();
  const seed = await readSeedOutput();

  // Visto excluído ontem, às 12:00 UTC: o mesmo dia em São Paulo.
  const ontem = new Date(Date.now() - 24 * 3_600_000);
  ontem.setUTCHours(12, 0, 0, 0);
  const diaDaExclusao = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "America/Sao_Paulo" }).format(ontem);

  const marcado = await db.from("listings").update({ deleted_at: ontem.toISOString() }).eq("item_id", itemId).select("status");

  expect(marcado.error).toBeNull();
  // O status continua o velho, como no 404.
  expect(marcado.data).toEqual([{ status: "paused" }]);

  try {
    // 1. A Home: o único pausado com estoque do seed foi excluído, e o cartão
    // vai para "medidos e limpos" com zero, como a `/anuncios`.
    await login(page, "/");
    await expect(page.locator(".sb-attention-clean").getByRole("link", { name: "0 Anúncios pausados" })).toBeVisible();

    // 2. O detalhe, pelo link antigo: o selo de excluído no lugar do status
    // velho, a data da leitura, uma checagem só e nada de "Ver no Mercado Livre".
    await page.goto(`/anuncios/${itemId}`);

    await expect(page.getByText(`excluído no Mercado Livre · a V3 viu a exclusão em ${diaDaExclusao}`)).toBeVisible();
    await expect(page.getByText("0 de 1 em ordem")).toBeVisible();
    await expect(page.getByText("Anúncio pausado", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Sem vínculo de SKU", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /Ver no Mercado Livre/u })).toHaveCount(0);

    // 3. A republicação: a explicação, e nenhum pedido.
    await page.goto(`/anuncios/${itemId}?aba=historico`);

    await expect(page.getByText("a V3 não oferece republicá-lo")).toBeVisible();
    await expect(page.getByRole("button", { name: "Pedir republicação" })).toHaveCount(0);

    // 4. O vínculo pela `/vinculacoes`: o diálogo acha a linha e a recusa.
    await page.goto("/vinculacoes");
    await page.getByRole("button", { name: "Vincular um MLB" }).click();

    const popup = page.getByRole("dialog");

    await popup.getByLabel("MLB do anúncio").fill(itemId);
    await popup.getByRole("button", { name: "Procurar", exact: true }).click();
    await expect(popup.getByRole("alert")).toContainText(`${itemId} foi excluído no Mercado Livre`);
    await expect(popup.getByRole("alert")).toContainText("Não vinculamos anúncio que não existe mais");

    // 5. E pelo SKU: a mesma recusa, sem o botão de confirmar.
    await page.goto(`/skus/${seed.skuId}?aba=anuncios`);
    await page.getByRole("button", { name: "+ Vincular anúncio" }).click();

    const modal = page.getByRole("dialog", { name: "Vincular anúncio" });

    await modal.getByLabel("MLB / id do anúncio").fill(itemId);
    await modal.getByRole("button", { name: "Procurar anúncio" }).click();
    await expect(modal.getByText(`${itemId} foi excluído no Mercado Livre`)).toBeVisible();
    await expect(modal.getByRole("button", { name: "Confirmar vinculação" })).toHaveCount(0);
  } finally {
    const desfeito = await db.from("listings").update({ deleted_at: null }).eq("item_id", itemId);

    // Sem `expect` aqui: uma falha no corpo do teste não pode ser trocada pela
    // da limpeza. A limpeza que falha aparece no próximo spec que conta.
    if (desfeito.error !== null) console.error(`D-634: o deleted_at de ${itemId} não voltou a nulo: ${desfeito.error.message}`);
  }
});
