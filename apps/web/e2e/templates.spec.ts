import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * Templates de resposta (`/atendimento/templates`, D-111 e D-392).
 *
 * **Este é o PRIMEIRO spec desta tela.** Ela tem quatro escritas — criar,
 * editar, duplicar e apagar — e nunca foi visitada por teste nenhum, apesar de
 * ser a origem do texto que a operação manda para cliente.
 *
 * O spec NÃO depende do seed: ele cria o que precisa e apaga no fim. Templates
 * têm `unique (organization_id, name)`, então um nome fixo deixado para trás
 * faria a rodada seguinte falhar na criação — o nome carrega o carimbo da
 * execução, e o teste termina limpando o que criou.
 *
 * O que este arquivo protege:
 *
 *  1. **o orçamento da caixa de resposta** — a tela diz quanto dos 2.000
 *     caracteres cada template ocupa e marca como APERTADO o que passa de
 *     1.500. É o número que separa um template usável de um que o
 *     `applyTemplate` vai recusar no meio de um atendimento;
 *  2. **a busca por NOME e por TEXTO**, igual à da barra dentro da resposta:
 *     quem procura "garantia" quer o template que fala de garantia, mesmo que
 *     o nome não diga;
 *  3. **duplicar sem colidir com o nome único** — a cópia nasce com sufixo, e
 *     é ela que permite escrever uma variante sem copiar texto na mão;
 *  4. **apagar em dois tempos**, que é a única ação sem volta da tela.
 */

const CARIMBO = Date.now().toString(36);
const NOME = `E2E Garantia ${CARIMBO}`;
const TEXTO = "Sua garantia cobre defeito de fabricacao por 90 dias. Envie o video do problema.";

function cartao(page: Page, nome: string) {
  return page.locator("li.sb-template-card").filter({ hasText: nome });
}

async function criar(page: Page, nome: string, texto: string): Promise<void> {
  await page.getByRole("button", { name: "Novo template" }).click();

  const modal = page.getByRole("dialog");
  await modal.getByLabel("Nome").fill(nome);
  await modal.getByLabel("Texto").fill(texto);
  await modal.getByRole("button", { name: "Criar template" }).click();

  await expect(modal.getByText("Template criado")).toBeVisible();
  await modal.getByRole("button", { name: "Concluído" }).click();
  await page.reload();
  await expect(cartao(page, nome)).toBeVisible();
}

async function apagar(page: Page, nome: string): Promise<void> {
  const alvo = cartao(page, nome);

  // ESPERA o cartão em vez de contar e desistir. Contar logo depois de uma
  // navegação devolve zero porque a lista ainda não renderizou, e a limpeza
  // passaria em silêncio deixando lixo para a rodada seguinte — foi o que
  // aconteceu ao escrever este arquivo, com um `if (count === 0) return`.
  await expect(alvo.first()).toBeVisible({ timeout: 15_000 });

  await alvo.first().getByRole("button", { name: "Apagar", exact: true }).click();
  await alvo.first().getByRole("button", { name: "Sim, apagar" }).click();
  await expect(cartao(page, nome)).toHaveCount(0, { timeout: 15_000 });
}

test("templates: criar, medir o espaço na caixa, buscar pelo texto, duplicar e apagar", async ({ page }) => {
  await login(page, "/atendimento/templates");

  await expect(page.getByRole("heading", { name: "Templates de resposta", level: 1 })).toBeVisible();
  await expect(page.getByText("ATENDIMENTO / OPERAÇÃO")).toBeVisible();

  await criar(page, NOME, TEXTO);

  // 1. O ORÇAMENTO DA CAIXA: o template curto ocupa pouco e não é apertado.
  const meu = cartao(page, NOME);
  await expect(meu.getByText("da caixa")).toBeVisible();
  await expect(meu.getByText("APERTADO")).toHaveCount(0);
  await expect(meu.getByText(/atualizado em/)).toBeVisible();

  // 2. A BUSCA OLHA O TEXTO, não só o nome: "video" só existe no corpo.
  const busca = page.getByRole("search");

  await busca.getByRole("searchbox").fill("video");
  await busca.getByRole("button", { name: "Buscar" }).click();
  await expect(cartao(page, NOME)).toBeVisible();
  await expect(page.getByRole("link", { name: "Limpar busca" })).toBeVisible();

  // Termo que não existe: estado vazio próprio, com a saída de volta.
  await busca.getByRole("searchbox").fill(`nao-existe-${CARIMBO}`);
  await busca.getByRole("button", { name: "Buscar" }).click();
  await expect(page.getByText("Nenhum template com esse termo")).toBeVisible();
  await page.getByRole("link", { name: "Ver todos" }).click();
  await expect(cartao(page, NOME)).toBeVisible();

  // 3. DUPLICAR: a cópia nasce com sufixo, sem esbarrar no nome único.
  await meu.getByRole("button", { name: "Duplicar" }).click();
  await expect(meu.getByText("Cópia criada")).toBeVisible();
  await page.reload();
  await expect(cartao(page, `${NOME} (cópia)`)).toBeVisible();

  // 4. APAGAR EM DOIS TEMPOS: o primeiro clique só pede confirmação.
  const copia = cartao(page, `${NOME} (cópia)`);
  await copia.getByRole("button", { name: "Apagar", exact: true }).click();
  await expect(copia.getByText("Não dá para desfazer")).toBeVisible();
  await copia.getByRole("button", { name: "Cancelar" }).click();
  await expect(cartao(page, `${NOME} (cópia)`)).toBeVisible();

  await apagar(page, `${NOME} (cópia)`);
  await apagar(page, NOME);
});

test("templates: o texto longo avisa que não cabe junto de um rascunho", async ({ page }) => {
  const nomeLongo = `E2E Longo ${CARIMBO}`;

  await login(page, "/atendimento/templates");

  // 1.600 caracteres: passa do limiar de 1.500 e ocupa 80% da caixa.
  await criar(page, nomeLongo, "L".repeat(1_600));

  const longo = cartao(page, nomeLongo);
  await expect(longo.getByText("APERTADO")).toBeVisible();
  await expect(longo.getByText("80,0% da caixa")).toBeVisible();

  // O corpo nasce dobrado e abre por clique — o texto nunca é cortado no dado.
  await expect(longo.getByRole("button", { name: "Ver texto inteiro" })).toBeVisible();
  await longo.getByRole("button", { name: "Ver texto inteiro" }).click();
  await expect(longo.getByRole("button", { name: "Ver menos" })).toBeVisible();

  // O indicador do topo conta o apertado que acabou de entrar.
  await expect(page.getByText("Apertados")).toBeVisible();

  await apagar(page, nomeLongo);
});
