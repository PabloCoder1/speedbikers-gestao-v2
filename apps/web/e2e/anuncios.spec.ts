import { type Page, expect, test } from "@playwright/test";

import { E2E_LISTINGS, E2E_LISTING_FULL, E2E_LISTING_TRAFFIC } from "./constants.js";
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
  // "No Full" (D-243): só o primeiro anúncio tem snapshot no seed. O desvio
  // anterior dizia que Full era grão de SKU; o snapshot carrega o MLB.
  await expect(celula(page, "No Full").locator(".sb-kpi-value")).toHaveText("1");
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
  // A coluna Full mostra a quantidade do snapshot no anúncio que tem um…
  await expect(comTrafego.locator("td").nth(7)).toHaveText(String(E2E_LISTING_FULL));

  const semTrafego = E2E_LISTINGS.find((a) => a.itemId !== E2E_LISTING_TRAFFIC.itemId && a.vinculo === "nenhum");
  const linhaSemTrafego = page.locator("tbody tr", { hasText: semTrafego?.itemId ?? "" });

  // …e "—" (não "0") no que nunca teve snapshot, ao lado de visitas e
  // conversão também indefinidas. Colunas: Anúncio, MLB, SKU, Conta, Status,
  // Preço, Estoque, Full, Unidades, Faturamento, Visitas, Obs., Conversão.
  await expect(linhaSemTrafego.locator("td").nth(7)).toHaveText("—");
  await expect(linhaSemTrafego.locator("td").nth(11)).toHaveText("—");
  await expect(linhaSemTrafego.locator("td").nth(12)).toHaveText("—");
});


/**
 * PERÍODO E "COM/SEM VENDA" (D-308) — os dois controles que
 * `docs/PRODUCT_REQUIREMENTS.md` pedia desde sempre e que a tela não tinha.
 * O predicado `p_sold` existia na RPC desde D-259, sem nenhuma tela que o
 * expusesse.
 *
 * O que este caso guarda são as duas coisas que dão errado sozinhas:
 *
 *  1. **filtro que descarta o vizinho.** É a classe que já mordeu `/vendas`
 *     duas vezes (a métrica sumindo no formulário de período, e depois a
 *     marca). Por isso a afirmação é de COMPOSIÇÃO: os dois juntos, na URL e
 *     na tela;
 *  2. **janela que muda o número sem mudar o rótulo.** "12/30" e "12/7" são
 *     leituras diferentes do mesmo dado; se o denominador não acompanhar o
 *     seletor, a tela mente sobre a cobertura da observação.
 */
test("/anuncios: venda e período compõem, e a janela muda o denominador observado", async ({ page }) => {
  await login(page, "/anuncios");

  await expect(page.locator("tbody tr")).toHaveCount(ESPERADO.total);

  const menus = page.locator("details.sb-menu");
  const menuVenda = menus.filter({ hasText: "Com ou sem venda" });

  // "Vendeu no período": só os dois do fixture com métrica de venda — o
  // primeiro (tem visita) e o quinto (vendeu sem vínculo).
  await menuVenda.locator("summary").click();
  await menuVenda.getByRole("link", { name: "Vendeu no período" }).click();

  await expect(page).toHaveURL(/venda=with/);
  await expect(page.locator("tbody tr")).toHaveCount(2);
  await expect(page.getByText(E2E_LISTING_TRAFFIC.itemId)).toBeVisible();

  // O complemento fecha com o total: 2 + 3 = 5. Se o predicado não chegasse ao
  // Postgres, os dois recortes devolveriam cinco.
  const menuVendaAtivo = menus.filter({ hasText: "Vendeu no período" });

  await menuVendaAtivo.locator("summary").click();
  await menuVendaAtivo.getByRole("link", { name: "Sem venda no período" }).click();

  await expect(page).toHaveURL(/venda=without/);
  await expect(page.locator("tbody tr")).toHaveCount(ESPERADO.total - 2);

  /*
    A RESSALVA APARECE SÓ AQUI, e é por isso que ela é afirmada aqui: "sem
    venda" é ausência de MÉTRICA no período, e o recálculo só materializa dias
    tocados pela reconciliação. Sem a frase, a tela leria "não vendeu" onde
    pode ser "não foi calculado".
  */
  await expect(page.getByText(/sem venda = nenhuma métrica de venda no período/)).toBeVisible();

  // Agora o período, com o recorte de venda de pé.
  const menuPeriodo = menus.filter({ hasText: "Últimos 30 dias" });

  await menuPeriodo.locator("summary").click();
  await menuPeriodo.getByRole("link", { name: "Últimos 7 dias" }).click();

  // OS DOIS JUNTOS — a linha que pega o recorte descartado em silêncio.
  await expect(page).toHaveURL(/dias=7/);
  await expect(page).toHaveURL(/venda=without/);

  // E o rótulo do menu diz o estado: filtro aplicado e invisível é pior que
  // filtro nenhum.
  await expect(menus.filter({ hasText: "Últimos 7 dias" }).locator("summary")).toContainText("Últimos 7 dias");
});

/**
 * O DENOMINADOR SEGUE A JANELA. O fixture observa UM dia de visita; com 30
 * dias a célula diz "1/30" e com 7 diz "1/7" — o mesmo dado, duas leituras de
 * cobertura.
 */
test("/anuncios: os dias observados são contados contra a janela escolhida", async ({ page }) => {
  await login(page, "/anuncios");

  const linhaComTrafego = page.locator("tbody tr", { hasText: E2E_LISTING_TRAFFIC.itemId });

  await expect(linhaComTrafego.getByText("1/30")).toBeVisible();

  // `goto`, não `login`: a sessão já está de pé, e o helper esperaria por um
  // formulário de entrada que não existe mais.
  await page.goto("/anuncios?dias=7");

  await expect(page.locator("tbody tr", { hasText: E2E_LISTING_TRAFFIC.itemId }).getByText("1/7")).toBeVisible();
});
