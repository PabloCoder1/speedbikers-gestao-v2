import { expect, test } from "@playwright/test";

import { login } from "./helpers.js";

/**
 * CONFIGURAÇÃO DE REPOSIÇÃO (D-361) — a tela que nenhum caso olhava.
 *
 * O seed não tem regra nenhuma, que é exatamente o estado de produção no dia da
 * fatia (1.650 SKUs na reposição, zero regras). O caso percorre o caminho que a
 * tela propõe e afirma o que ela promete a cada passo:
 *
 * 1. sem regra, o resumo diz 0% e os primeiros passos apontam o padrão;
 * 2. a gaveta não envia número inválido, e o teto abaixo da janela diz a janela;
 * 3. a régua e a frase aparecem com os números, e a referência preenche só no
 *    clique (D-144: nada vem de fábrica);
 * 4. criar, editar e remover — e a remoção diz a consequência antes.
 *
 * O caso DESFAZ o que cria. `reposicao.spec.ts` roda depois deste (ordem
 * alfabética: `-` vem antes de `.`) e afirma "sem configuração" numa linha do
 * seed; um padrão esquecido aqui reprovaria aquele caso sem ele ter mudado.
 */
test("configuração de reposição: do zero ao padrão, com régua, impacto e remoção que avisa", async ({ page }) => {
  await login(page, "/reposicao/configuracoes");

  await expect(page.getByRole("heading", { level: 1, name: "Configuração de reposição" })).toBeVisible();

  // 1. O estado vazio fala do catálogo inteiro e aponta por onde começar.
  const resumo = page.getByRole("region", { name: "Resumo da configuração" });

  await expect(resumo.getByText("SKUs com política")).toBeVisible();
  await expect(resumo.getByText("0%")).toBeVisible();
  await expect(page.getByRole("heading", { name: /Nenhuma regra ainda — a reposição recusa sugestão/ })).toBeVisible();

  await page.getByRole("button", { name: "Definir o padrão da organização" }).click();

  const gaveta = page.getByRole("dialog", { name: "Nova regra de reposição" });

  await expect(gaveta).toBeVisible();

  // D-144: nada pré-preenchido, e sem números não há régua para desenhar.
  await expect(gaveta.getByLabel("Prazo do fornecedor")).toHaveValue("");
  await expect(gaveta.getByText("Preencha prazo e cobertura para ver o que a regra faz.")).toBeVisible();

  // 2. Enviar vazio não fecha a gaveta: o erro aparece no campo.
  await gaveta.getByRole("button", { name: "Criar regra" }).click();
  await expect(gaveta.getByText("Informe o prazo em dias inteiros, de 1 a 365.")).toBeVisible();
  await expect(gaveta).toBeVisible();

  // 3. A referência preenche SÓ no clique.
  await gaveta.getByRole("button", { name: "nacional · prazo 15 dias" }).click();
  await expect(gaveta.getByLabel("Prazo do fornecedor")).toHaveValue("15");

  await gaveta.getByLabel("Segurança").fill("5");
  await gaveta.getByLabel("Cobertura desejada").fill("30");

  await expect(gaveta.getByRole("img", { name: /janela de 50 dias/ })).toBeVisible();
  await expect(gaveta.getByText(/O pedido sai quando a cobertura chega a 20 dias/)).toBeVisible();
  await expect(gaveta.getByText(/Passam a ter política/)).toBeVisible();

  // O teto abaixo da janela é recusado com a janela na frase (max_covers_window).
  await gaveta.getByLabel("Teto de cobertura").fill("40");
  await gaveta.getByRole("button", { name: "Criar regra" }).click();
  await expect(gaveta.getByText(/O teto precisa ser de pelo menos 50 dias/)).toBeVisible();

  await gaveta.getByLabel("Teto de cobertura").fill("90");
  await gaveta.getByRole("button", { name: "Criar regra" }).click();

  await expect(gaveta).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Padrão da organização criado." })).toBeVisible();

  // O padrão cobre tudo: 100% e a janela no cartão.
  await expect(resumo.getByText("100%")).toBeVisible();
  await expect(resumo.getByText("Janela 50d")).toBeVisible();

  const painelPadrao = page.getByRole("region", { name: "Padrão da organização" });

  await expect(painelPadrao.getByText(/Cada compra repõe até 50 dias de venda\. Acima de 90 dias, é excesso\./)).toBeVisible();

  // 4a. Editar: o escopo é identidade, só os números mudam.
  await painelPadrao.getByRole("button", { name: "Editar padrão" }).click();

  const edicao = page.getByRole("dialog", { name: "Padrão da organização" });

  await expect(edicao.getByText("O escopo não muda depois de criado")).toBeVisible();
  await edicao.getByLabel("Cobertura desejada").fill("60");
  await edicao.getByRole("button", { name: "Salvar alterações" }).click();

  await expect(edicao).toBeHidden();
  await expect(painelPadrao.getByText(/Cada compra repõe até 80 dias de venda/)).toBeVisible();

  // 4b. Remover pede confirmação e diz para onde os SKUs vão.
  await painelPadrao.getByRole("button", { name: "Editar padrão" }).click();
  await page.getByRole("button", { name: "Remover regra" }).click();

  const confirmacao = page.getByRole("alertdialog", { name: "Confirmar remoção da regra" });

  await expect(confirmacao).toContainText("ficam sem sugestão de compra");
  await confirmacao.getByRole("button", { name: "Sim, remover" }).click();

  // De volta ao começo — e o seed fica como estava para reposicao.spec.ts.
  await expect(page.getByRole("heading", { name: /Nenhuma regra ainda/ })).toBeVisible();
  await expect(resumo.getByText("0%")).toBeVisible();
});

test("configuração de reposição: a reposição leva à configuração e volta", async ({ page }) => {
  await login(page, "/reposicao");

  /*
    Pelo DESTINO, não pelo nome: "Configurações" também é o link do menu
    lateral para o hub `/configuracoes`, e a primeira versão deste caso clicou
    nele. Os links de `/reposicao` para cá são todos o mesmo destino — o do
    cabeçalho é o primeiro.
  */
  await page.locator('main a[href="/reposicao/configuracoes"]').first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Configuração de reposição" })).toBeVisible();

  await page.getByRole("link", { name: "← Cobertura e reposição" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Cobertura e reposição" })).toBeVisible();
});
