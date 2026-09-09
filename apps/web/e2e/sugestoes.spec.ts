import { expect, test } from "@playwright/test";

import { E2E_SUGESTOES } from "./constants.js";
import { login } from "./helpers.js";

/**
 * Central de Sugestões (`/sugestoes`) pelo frame `CentralScreen` na variação de
 * ideias (D30, D-270).
 *
 * **Este é o PRIMEIRO spec desta tela**, que tem duas escritas — mudar o status
 * e estruturar com IA (D-112) — e nunca foi visitada por teste nenhum.
 *
 * O que este arquivo protege:
 *
 *  1. **o mestre-detalhe com seleção na URL** — sem isso o link para uma
 *     sugestão não existiria e o voltar do navegador não funcionaria;
 *  2. **o texto original preservado**, que é a promessa escrita da página: a
 *     versão estruturada pela IA acompanha, nunca substitui;
 *  3. **a sugestão AINDA NÃO estruturada diz isso**, em vez de abrir um painel
 *     vazio — a estruturação é sob demanda, não automática;
 *  4. **a janela declarada**, que a tela não tinha: ela lia SEM LIMITE e
 *     imprimia `rows.length` como total (a forma do defeito de D-263).
 */

test("/sugestoes: o detalhe abre na mais recente e diz que ela não foi estruturada", async ({ page }) => {
  await login(page, "/sugestoes");

  await expect(page.getByRole("heading", { name: "Sugestões de Melhoria", level: 1 })).toBeVisible();
  await expect(page.getByText("CENTRAL / EVOLUÇÃO DO PRODUTO")).toBeVisible();

  const detalhe = page.getByRole("region", { name: "Detalhe da sugestão" });

  /*
    Sem `?sugestao=` o detalhe abre na primeira da lista — a mais recente, que
    no seed é a CRUA. Prova o caminho que o frame não desenha: estruturação é
    sob demanda (D-112), então uma sugestão recém-escrita não tem os nove
    campos, e a tela diz isso em vez de abrir vazia.
  */
  await expect(detalhe).toContainText(E2E_SUGESTOES.crua.originalText);
  await expect(detalhe).toContainText("Ainda não estruturada");

  // O texto original aparece sempre, sob o rótulo que o separa da versão da IA.
  await expect(detalhe).toContainText("COMO FOI ESCRITO");

  // A JANELA que a tela não tinha.
  await expect(page.getByText(/2 sugestões registradas/)).toBeVisible();
});

test("/sugestoes: escolher no mestre abre o detalhe, e a seleção mora na URL", async ({ page }) => {
  await login(page, "/sugestoes");

  await page.getByRole("link", { name: new RegExp(E2E_SUGESTOES.estruturada.title) }).click();

  // Sem a seleção na URL, este link não existiria e o voltar não funcionaria.
  await expect(page).toHaveURL(/sugestao=/);

  const detalhe = page.getByRole("region", { name: "Detalhe da sugestão" });

  /*
    Os campos estruturados, com os rótulos da casa. O frame desenha CINCO
    (Problema, Objetivo, Benefício, Critério de aceite, Dependências); a tabela
    tem NOVE, e esconder os preenchidos por não estarem no desenho seria jogar
    fora trabalho que a IA já fez.
  */
  await expect(detalhe.getByText("Problema", { exact: true })).toBeVisible();
  await expect(detalhe.getByText(E2E_SUGESTOES.estruturada.problem)).toBeVisible();
  await expect(detalhe.getByText(E2E_SUGESTOES.estruturada.objective)).toBeVisible();

  /*
    E O TEXTO ORIGINAL CONTINUA LÁ. É a promessa que a página faz por escrito —
    a versão da IA acompanha, nunca substitui a palavra da pessoa.
  */
  await expect(detalhe).toContainText(E2E_SUGESTOES.estruturada.originalText);

  // Como ADMIN, o seletor de status oferece os SETE estados, não os três que o
  // frame desenha.
  const seletor = detalhe.getByLabel("Status da sugestão");

  await expect(seletor).toBeVisible();
  await expect(seletor.locator("option")).toHaveCount(7);
});
