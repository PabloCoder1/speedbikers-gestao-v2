import { type Page, expect, test } from "@playwright/test";

import { E2E_LISTINGS, E2E_LISTING_TRAFFIC } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/anuncios` — o Dashboard de Anúncios depois da migração da composição para o
 * frame `Listings` (D-242).
 *
 * **Esta tela chegou até aqui sem teste nenhum**, e o motivo era invisível: o
 * seed de e2e não criava anúncios. Os que existiam no banco local eram resíduo
 * da suíte de integração, então depois de um `db reset` a tela ficava vazia e
 * não havia o que afirmar. O seed passou a criar quatro (`E2E_LISTINGS`), e é
 * deles que este teste deriva TODAS as contagens — mudar o fixture muda os dois
 * lados juntos.
 *
 * O que ele protege, em ordem de gravidade:
 *
 *  1. **A faixa não pode divergir da lista.** Cada célula promete um recorte;
 *     clicar tem de mostrar exatamente aquela quantidade. Contagem e lista saem
 *     da mesma função com o mesmo predicado, e é isso que o teste verifica —
 *     não que o número seja "algum número".
 *  2. **"Sem vínculo" não é `sku_id is null`** (D-122). O anúncio de vínculo por
 *     variação tem `sku_id` nulo e NÃO é fila de trabalho. Se alguém trocar a
 *     contagem pelo atalho, ela dirá 3 e este teste fica vermelho.
 *  3. **Conversão sem visita é "—", não 0%** (D-123). O segundo anúncio existe
 *     no seed sem tráfego justamente para provar isso na tela.
 */

/** As contagens que a faixa deve mostrar, derivadas do fixture. */
const ESPERADO = {
  total: E2E_LISTINGS.length,
  ativos: E2E_LISTINGS.filter((a) => a.status === "active").length,
  pausados: E2E_LISTINGS.filter((a) => a.status === "paused").length,
  semEstoque: E2E_LISTINGS.filter((a) => a.available === 0).length,
  // Vínculo por variação NÃO conta como sem vínculo — é a regra de D-122.
  semVinculo: E2E_LISTINGS.filter((a) => a.vinculo === "nenhum").length,
};

function celula(page: Page, rotulo: string) {
  return page.locator(".sb-kpi", { has: page.getByText(rotulo, { exact: true }) });
}

test("/anuncios: a faixa de estados conta o que a lista mostra", async ({ page }) => {
  await login(page, "/anuncios");

  await expect(page.getByRole("heading", { level: 1, name: "Dashboard de anúncios" })).toBeVisible();

  // A faixa, célula a célula.
  await expect(celula(page, "Anúncios monitorados").locator(".sb-kpi-value")).toHaveText(String(ESPERADO.total));
  await expect(celula(page, "Ativos").locator(".sb-kpi-value")).toHaveText(String(ESPERADO.ativos));
  await expect(celula(page, "Pausados").locator(".sb-kpi-value")).toHaveText(String(ESPERADO.pausados));
  await expect(celula(page, "Sem estoque").locator(".sb-kpi-value")).toHaveText(String(ESPERADO.semEstoque));
  await expect(celula(page, "Sem vínculo").locator(".sb-kpi-value")).toHaveText(String(ESPERADO.semVinculo));

  // Nenhuma célula pode ter falhado em silêncio virando zero (D-067): "—" é o
  // que aparece quando a leitura falha, e aqui nenhuma falhou.
  await expect(page.locator(".sb-kpi-value", { hasText: "—" })).toHaveCount(0);

  // A tabela mostra os quatro, e a janela declara o total (D-138). Com uma
  // página só o rótulo é o total nu — "4 anúncios." —, e é isso que se afirma;
  // a forma "1 a 50 de 5.085" só aparece quando há mais de uma página.
  const linhas = page.locator("tbody tr");

  await expect(linhas).toHaveCount(ESPERADO.total);
  await expect(page.getByText(`${String(ESPERADO.total)} anúncios.`, { exact: true })).toBeVisible();
});

test("/anuncios: clicar numa célula filtra a lista para exatamente aquela contagem", async ({ page }) => {
  await login(page, "/anuncios");

  // "Sem estoque" é a célula que só existe porque a RPC ganhou `p_stock`
  // (D-242) — se o filtro não chegar ao Postgres, a lista volta com os quatro.
  await celula(page, "Sem estoque").getByRole("link", { name: "ver lista" }).click();

  await expect(page).toHaveURL(/estoque=out/);
  await expect(page.locator("tbody tr")).toHaveCount(ESPERADO.semEstoque);

  const semEstoque = E2E_LISTINGS.find((a) => a.available === 0);

  await expect(page.getByText(semEstoque?.title ?? "")).toBeVisible();

  // O painel declara o recorte ativo, como no frame.
  await expect(page.getByText(/Filtros ativos:.*sem estoque/)).toBeVisible();

  // E a faixa continua contando o ESCOPO, não a página filtrada: o total segue
  // sendo quatro mesmo com um anúncio na tabela.
  await expect(celula(page, "Anúncios monitorados").locator(".sb-kpi-value")).toHaveText(String(ESPERADO.total));
});

test("/anuncios: vínculo por variação não é fila de trabalho, e conversão sem visita é indefinida", async ({
  page,
}) => {
  await login(page, "/anuncios");

  const porVariacao = E2E_LISTINGS.find((a) => a.vinculo === "variacao");
  const linhaVariacao = page.locator("tbody tr", { hasText: porVariacao?.itemId ?? "" });

  // D-122: a coluna SKU distingue os dois estados. "por variação" não é "sem
  // vínculo" — mostrar "—" nos dois dobra o tamanho aparente da fila.
  await expect(linhaVariacao.getByText("por variação", { exact: true })).toBeVisible();

  // ...e ele não aparece no recorte "Sem vínculo".
  await celula(page, "Sem vínculo").getByRole("link", { name: "ver lista" }).click();

  await expect(page).toHaveURL(/vinculo=unlinked/);
  await expect(page.getByText(porVariacao?.itemId ?? "")).toHaveCount(0);
  await expect(page.locator("tbody tr")).toHaveCount(ESPERADO.semVinculo);

  await page.goto("/anuncios");

  // D-123: o anúncio COM tráfego mostra taxa; o sem tráfego mostra "—", nunca
  // 0%. As duas afirmações são diferentes e a tela não pode confundi-las.
  const comTrafego = page.locator("tbody tr", { hasText: E2E_LISTING_TRAFFIC.itemId });

  await expect(comTrafego).toContainText("250");
  await expect(comTrafego).toContainText(`1/30`);

  const semTrafego = E2E_LISTINGS.find((a) => a.itemId !== E2E_LISTING_TRAFFIC.itemId && a.vinculo === "nenhum");
  const linhaSemTrafego = page.locator("tbody tr", { hasText: semTrafego?.itemId ?? "" });

  await expect(linhaSemTrafego.locator("td").nth(10)).toHaveText("—");
  await expect(linhaSemTrafego.locator("td").nth(11)).toHaveText("—");
});
