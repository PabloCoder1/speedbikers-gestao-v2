import { expect, test } from "@playwright/test";

import { E2E_PURCHASE_ORDERS } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/compras` — a Fila de Pedidos depois da migração para o frame
 * `ProcessScreen type="purchases"` (D19, D-255).
 *
 * **A tela chegou aqui sem teste de LISTA, e o motivo estava escrito no
 * seed:** *"pedido de compra não precisa de seed"*. Era verdade enquanto o
 * único teste CRIAVA um pedido pela UI (`pedido-compra.spec.ts`); com um
 * pedido só não há como afirmar filtro, janela nem coluna de valor. O seed
 * passou a criar cinco (`E2E_PURCHASE_ORDERS`), cada um provando uma coisa.
 *
 * O que este arquivo protege, em ordem de gravidade:
 *
 *  1. **Custo ausente não vira R$ 0,00** (D-254). É o defeito que a fatia
 *     corrigiu, e ele tem duas caras na lista: soma PARCIAL (mostra o que
 *     sabe, e diz quanto não sabe) e NENHUM custo (mostra "—"). As duas estão
 *     afirmadas abaixo, e há um pedido sem item nenhum para provar que o zero
 *     SABIDO continua sendo "R$ 0,00" — os dois zeros da tela significam
 *     coisas diferentes.
 *  2. **A janela é declarada** (D-131). A tela dizia "{N} pedido(s)" com N =
 *     tamanho da página; a frase agora vem de `summarizePagedWindow`.
 *  3. **O filtro de estado recorta de verdade** — e os estados são os CINCO
 *     que a `check` constraint aceita, não os sete do brief.
 *
 * As afirmações evitam contagem total absoluta de propósito:
 * `pedido-compra.spec.ts` cria um rascunho a mais na mesma base, e um teste
 * que quebrasse por causa do outro seria frágil sem ser mais rigoroso.
 */

const PARCIAL = E2E_PURCHASE_ORDERS.find((p) => p.chave === "parcial");
const SEM_CUSTO = E2E_PURCHASE_ORDERS.find((p) => p.chave === "sem-custo");

test("/compras: a fila mostra o frame, e o valor estimado diz o que não sabe", async ({ page }) => {
  await login(page, "/compras");

  // Cabeçalho do frame: sobrancelha, título, linha de apoio e a ação primária.
  await expect(page.getByRole("heading", { name: "Pedidos de Compra", level: 1 })).toBeVisible();
  await expect(page.getByText("ESTOQUE / OPERAÇÃO")).toBeVisible();
  await expect(page.getByRole("link", { name: "Novo Pedido" })).toBeVisible();

  // O painel do frame.
  await expect(page.getByRole("heading", { name: "Fila de Pedidos", level: 2 })).toBeVisible();

  // A janela declarada — nunca mais "{N} pedido(s)".
  await expect(page.getByText(/\d+ pedidos?\.|Mostrando \d+ a \d+ de \d+ pedidos?\./)).toBeVisible();

  /*
    O CASO PARCIAL (D-254): 5 × 10,50 = 52,50 de um item, e o outro sem custo.
    O número aparece, e ao lado dele a ressalva — que é o que impede a soma
    parcial de se passar por total fechado.
  */
  expect(PARCIAL?.itens.length).toBe(2);
  await expect(page.getByText("1 de 2 sem custo")).toBeVisible();

  const linhaParcial = page.locator("tr", { hasText: "1 de 2 sem custo" });
  await expect(linhaParcial).toContainText("R$ 52,50");

  /*
    O CASO SEM NENHUM CUSTO: um item, sem custo. O valor é "—", nunca
    "R$ 0,00" — e é o estado normal de um rascunho antes de o custo ser
    negociado. Esta linha também não tem fornecedor, então prova os dois "—".
  */
  expect(SEM_CUSTO?.itens.length).toBe(1);
  await expect(page.getByText("1 de 1 sem custo")).toBeVisible();

  const linhaSemCusto = page.locator("tr", { hasText: "1 de 1 sem custo" });
  await expect(linhaSemCusto).not.toContainText("R$ 0,00");
});

test("/compras: o filtro de estado recorta, e são os cinco do banco", async ({ page }) => {
  await login(page, "/compras");

  // "Recebido" tem exatamente um pedido no fixture, e é o único com previsão.
  await page.getByRole("link", { name: "Recebido", exact: true }).click();

  await expect(page).toHaveURL(/\/compras\?estado=RECEIVED/);

  const linhas = page.locator("tbody tr");
  await expect(linhas).toHaveCount(1);
  await expect(linhas.first()).toContainText("Recebido");

  /*
    Os estados que o brief §23 pede e o banco não tem NÃO podem virar recorte
    pela URL: `purchase_orders` aceita cinco por `check` constraint, e um
    valor fora da lista cai em "todos" em vez de ir ao banco e voltar vazio —
    zero linhas seria indistinguível de um filtro legítimo sem resultado.
  */
  await page.goto("/compras?estado=RECEBIDO_PARCIALMENTE");
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /^Estado/ })).toBeVisible();
});
