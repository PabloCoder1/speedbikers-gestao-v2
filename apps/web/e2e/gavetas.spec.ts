import { expect, test, type Page } from "@playwright/test";

import {
  E2E_LISTING_PRICE_EVENT,
  E2E_LISTING_RELIST,
  E2E_LISTING_TRAFFIC,
  E2E_ORDER,
  E2E_PURCHASE_ORDERS,
  E2E_SKU_CODE,
  E2E_SUPPLIER,
} from "./constants.js";
import { login } from "./helpers.js";

/**
 * As QUATRO gavetas que fecharam a composição do Figma (D39, D-282).
 *
 * A gaveta de "Inspeção Rápida" (D38) tem caso próprio em `produtos.spec.ts`;
 * este arquivo cobre as outras quatro — anúncio, fornecedor, usuário e pedido.
 *
 * **O que cada caso protege é a mesma coisa, e não é o layout:** que a gaveta
 * mostra o que a LISTA não mostra, e que ela não inventa o que o esquema não
 * tem. Uma gaveta que repetisse a linha passaria despercebida num teste de
 * "abre e fecha"; por isso cada afirmação aqui é sobre um dado que só a gaveta
 * expõe.
 */

async function abrirGaveta(page: Page, linha: string, botao = "Inspecionar"): Promise<void> {
  await page.locator("tbody tr", { hasText: linha }).first().getByRole("button", { name: botao }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

test("gaveta do anúncio: mostra republicação e mudança de preço — o que a linha não tem", async ({ page }) => {
  await login(page, "/anuncios");

  await abrirGaveta(page, E2E_LISTING_TRAFFIC.itemId);

  const gaveta = page.getByRole("dialog");

  await expect(gaveta.getByText(E2E_LISTING_TRAFFIC.itemId)).toBeVisible();

  // A republicação e o motivo da falha: `listing_relists` não aparece em
  // NENHUMA coluna de `/anuncios`.
  await expect(gaveta.getByText(E2E_LISTING_RELIST.status)).toBeVisible();
  await expect(gaveta.getByText(E2E_LISTING_RELIST.failureReason)).toBeVisible();

  // O evento de preço, com o diff dos dois lados (`formatEventDiff`).
  await expect(gaveta.getByText("Preço do anúncio alterado")).toBeVisible();
  await expect(gaveta.getByText(/199,90.*189,90/)).toBeVisible();
  expect(E2E_LISTING_PRICE_EVENT.de).toBeGreaterThan(E2E_LISTING_PRICE_EVENT.para);

  // E ela APONTA para o dashboard em vez de reproduzir as oito abas dele.
  await expect(gaveta.getByRole("link", { name: /Abrir dashboard do anúncio/ })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("gaveta do fornecedor: a decomposição por estado FECHA com o total", async ({ page }) => {
  await login(page, "/fornecedores");

  await abrirGaveta(page, E2E_SUPPLIER.name);

  const gaveta = page.getByRole("dialog");

  /*
    Os números saem do próprio fixture — mudar `E2E_PURCHASE_ORDERS` muda os
    dois lados juntos. A afirmação que importa é a ARITMÉTICA: em aberto +
    recebidos + cancelados = total. Uma partição que não fecha esconde estado,
    que é o defeito que D-265 achou no frame da Central Full.
  */
  const doFornecedor = E2E_PURCHASE_ORDERS.filter((pedido) => pedido.comFornecedor);
  const recebidos = doFornecedor.filter((pedido) => pedido.status === "RECEIVED").length;
  const cancelados = doFornecedor.filter((pedido) => pedido.status === "CANCELLED").length;
  const emAberto = doFornecedor.length - recebidos - cancelados;

  // A linha inteira, não o texto solto: o valor e a ressalva moram no mesmo
  // `<b>`, então `getByText("4", { exact: true })` não casa nada.
  const linha = (rotulo: string) => gaveta.locator(".sb-detail-row").filter({ hasText: rotulo }).first();

  await expect(linha("Total").locator("b")).toContainText(String(doFornecedor.length));
  await expect(linha("Em aberto").locator("b")).toContainText(String(emAberto));
  await expect(linha("Recebidos").locator("b")).toContainText(String(recebidos));
  await expect(linha("Cancelados").locator("b")).toContainText(String(cancelados));

  // A ressalva de custo ausente sobrevive na gaveta (D-254).
  await expect(gaveta.getByText(/sem custo/)).toBeVisible();

  await expect(gaveta.getByRole("link", { name: /Abrir página completa/ })).toBeVisible();
});

test("gaveta do usuário: a proteção do último ADMIN é dita, e o e-mail agora existe", async ({ page }) => {
  await login(page, "/usuarios");

  /*
    O GATILHO É O NOME desde D-297, como a linha clicável do frame — antes era
    um botão "Inspecionar" em coluna própria, e o frame não tem essa coluna. A
    primeira linha é o ADMIN (a tabela ordena por papel).
  */
  await page.locator("tbody tr").first().getByRole("button", { name: "E2E", exact: true }).click();

  const gaveta = page.getByRole("dialog");

  await expect(gaveta).toBeVisible();

  /*
    A PROTEÇÃO: o seed tem um ADMIN e um GESTOR, então o ADMIN é o último —
    e é o trigger `guard_last_admin` que recusa a mudança, não a tela. Se um
    dia o seed criar o segundo ADMIN, este caso fica vermelho e a mensagem
    deixa de ser verdade, que é exatamente o aviso que se quer.
  */
  await expect(gaveta.getByText("Proteção ativa")).toBeVisible();
  await expect(gaveta.getByText(/único ADMIN da organização/)).toBeVisible();

  /*
    O E-MAIL DO FRAME ENTROU (D-296), e este caso mudou de sinal: ele afirmava
    a recusa de D-271 ("não há e-mail aqui"), que era verdadeira enquanto a
    JANELA para `auth.users` não existia. Agora existe, e o que se guarda é o
    contrário — o endereço aparece sob o nome, como o desenho manda.
  */
  await expect(gaveta.getByText("e2e@speedbikers.test")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // E a segunda linha (GESTOR) NÃO carrega a proteção.
  await page.locator("tbody tr").nth(1).getByRole("button", { name: "E2E Gestor", exact: true }).click();
  await expect(page.getByRole("dialog").getByText("Proteção ativa")).toHaveCount(0);
});

test("gaveta do pedido: a primeira superfície de venda da V3, com item vinculado e item sem vínculo", async ({
  page,
}) => {
  await login(page, "/atendimento");

  const primeiroCaso = page.locator('tbody a[href^="/atendimento/"]').first();
  const href = await primeiroCaso.getAttribute("href");

  expect(href).not.toBeNull();

  await page.goto(href ?? "/atendimento");

  // O número do pedido era texto morto: não existe página de pedido de venda.
  await expect(page.getByText(String(E2E_ORDER.id))).toBeVisible();

  await page.getByRole("button", { name: "Ver pedido" }).click();

  const gaveta = page.getByRole("dialog");

  await expect(gaveta).toBeVisible();
  await expect(gaveta.getByText("Pago", { exact: true })).toBeVisible();

  /*
    Os DOIS itens, e a diferença entre eles é o teste: o primeiro é link para o
    dashboard do SKU; o segundo mostra o `seller_sku` cru, porque `sku_id` é
    nulo — a linha que `/vinculacoes` conta como "vendido sem vínculo".
  */
  await expect(gaveta.getByRole("link", { name: E2E_ORDER.itens[0].title })).toBeVisible();
  await expect(gaveta.getByText(E2E_SKU_CODE)).toBeVisible();
  await expect(gaveta.getByRole("link", { name: E2E_ORDER.itens[1].title })).toHaveCount(0);
  await expect(gaveta.getByText("E2E-SEM-VINCULO")).toBeVisible();

  // O silêncio do histórico é declarado, não deixado em branco.
  await expect(gaveta.getByText(/o silêncio aqui é o curso normal/)).toBeVisible();
});
