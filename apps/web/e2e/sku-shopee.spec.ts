import { expect, test } from "@playwright/test";

import { E2E_SHOPEE_ITEMS, E2E_SHOPEE_SHOP } from "./constants.js";
import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * O painel "Anúncios da Shopee" da página do SKU (D-429).
 *
 * O SKU principal do seed tem UM anúncio Shopee: o capacete, cujo SKU do
 * ITEM chega em minúsculas e com espaços — vinculado só porque a régua
 * normaliza como `skus.sku_key`. O selim apagado pelo vendedor tem o MESMO SKU
 * e não pode aparecer: item apagado não é anúncio.
 *
 * O vínculo MANUAL nesta página é provado no spec de `/anuncios/shopee`, que
 * cria um, vem até aqui conferir e o desfaz.
 */
test("Dashboard do SKU: o painel Anúncios da Shopee mostra o item vinculado pelo SKU do anúncio", async ({ page }) => {
  const seed = await readSeedOutput();
  const { skuNoItem, apagado } = E2E_SHOPEE_ITEMS;

  await login(page, `/skus/${seed.skuId}?aba=anuncios`);

  const painel = page.getByRole("region", { name: "Anúncios da Shopee" });

  await expect(painel).toBeVisible();

  const linha = painel.getByRole("row", { name: new RegExp(skuNoItem.nome) });

  await expect(linha).toContainText("pelo SKU do anúncio");
  await expect(linha).toContainText(E2E_SHOPEE_SHOP.name);
  // O número do item leva à lista da Shopee já buscada por ele.
  await expect(linha.getByRole("link", { name: String(skuNoItem.itemId), exact: true })).toHaveAttribute(
    "href",
    `/anuncios/shopee?q=${String(skuNoItem.itemId)}`,
  );

  // Uma linha de dados só (mais o cabeçalho): o apagado fica de fora.
  await expect(painel.getByRole("row")).toHaveCount(2);
  await expect(painel).not.toContainText(apagado.nome);

  // E o painel do Mercado Livre continua onde estava, antes deste.
  await expect(page.getByRole("region", { name: "Anúncios vinculados" })).toBeVisible();
});
