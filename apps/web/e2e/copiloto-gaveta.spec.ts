import { expect, test } from "@playwright/test";

import { E2E_LISTING_TRAFFIC, E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";
import { readSeedOutput } from "./seed-output.js";

/**
 * A GAVETA DO COPILOTO (D-294) — o último item aberto da frente visual, e o
 * único elemento do frame que ficou de fora por PRÉ-CONDIÇÃO, não por gosto.
 *
 * D-276 mediu o que faltava: das doze perguntas que o desenho sugere, uma
 * tinha como ser respondida, e o selo "o Copiloto lerá os dados desta tela"
 * ficava sobre uma rota que recebia `{ message }` e nada mais. D-293 pagou as
 * duas metades (contexto na API, ferramentas de estoque e de anúncio); esta
 * suíte guarda o que a web faz com elas.
 *
 * **A API não sobe na suíte de Playwright** (D-276), então nada aqui pergunta
 * de verdade: o que se prova é o contexto, as sugestões que ele produz e as
 * que ele continua recusando. A conversa tem teste próprio em `apps/api`.
 */

test("a gaveta abre de qualquer tela pelo ✦ da barra de topo", async ({ page }) => {
  await login(page, "/produtos?estado=todos");

  await page.getByRole("button", { name: "Copiloto" }).click();

  const gaveta = page.getByRole("dialog", { name: "Copiloto" });

  await expect(gaveta).toBeVisible();

  /*
    A curadoria não publica contexto, e a gaveta DIZ isso em vez de prometer
    leitura de uma tela que ninguém leu — que é exatamente o que o selo do
    frame faria se ninguém cuidasse do caso.
  */
  await expect(gaveta).toContainText("Nenhum — esta tela não publica um SKU nem um anúncio");

  // Sem contexto, as sugestões são as três de venda — as que funcionam de
  // qualquer lugar.
  await expect(gaveta.getByRole("button", { name: "Como foram as vendas nos últimos 7 dias?" })).toBeVisible();

  // A tela cheia continua alcançável: a gaveta é o atalho, não a substituta.
  await expect(gaveta.getByRole("link", { name: "Abrir o Copiloto →" })).toHaveAttribute("href", "/copiloto");

  await page.keyboard.press("Escape");

  await expect(gaveta).toHaveCount(0);
});

test("no SKU, a gaveta traz o contexto e as perguntas já preenchidas", async ({ page }) => {
  const seed = await readSeedOutput();

  await login(page, `/skus/${seed.skuId}`);

  await expect(page.getByRole("heading", { level: 1, name: "Detalhe do SKU" })).toBeVisible();

  await page.getByRole("button", { name: "Copiloto" }).click();

  const gaveta = page.getByRole("dialog", { name: "Copiloto" });

  /*
    ÂNCORA POSITIVA (a lição de D-276 §5: um caso que só afirma ausência passa
    em qualquer página, inclusive na de login). O contexto é o código do SKU,
    não o UUID da rota — é o que a ferramenta usa e o que o operador lê.
  */
  await expect(gaveta).toContainText(`SKU ${E2E_SKU_CODE}`);
  await expect(gaveta.getByRole("button", { name: `Como está o estoque do SKU ${E2E_SKU_CODE}?` })).toBeVisible();
  await expect(gaveta.getByRole("button", { name: `Quanto devo comprar do SKU ${E2E_SKU_CODE}?` })).toBeVisible();

  /*
    AS RECUSAS SOBREVIVEM À GAVETA. O frame sugere "Quanto enviar ao Full?" e
    "Ver histórico de exposição": a primeira não tem política logística atrás
    (D-147) e a segunda pede o dado de tráfego que D-266 mediu como inexistente
    no esquema. Sugestão que o sistema não responde promete e falha DEPOIS de
    gastar uma chamada paga.
  */
  await expect(gaveta.getByRole("button", { name: /enviar ao full/i })).toHaveCount(0);
  await expect(gaveta.getByRole("button", { name: /histórico de exposição/i })).toHaveCount(0);
});

test("no anúncio, o contexto é o MLB — e a conversa é a mesma", async ({ page }) => {
  await login(page, `/anuncios/${E2E_LISTING_TRAFFIC.itemId}`);

  await expect(page.getByRole("heading", { level: 1, name: "Detalhe do anúncio" })).toBeVisible();

  await page.getByRole("button", { name: "Copiloto" }).click();

  const gaveta = page.getByRole("dialog", { name: "Copiloto" });

  await expect(gaveta).toContainText(`Anúncio ${E2E_LISTING_TRAFFIC.itemId}`);
  await expect(
    gaveta.getByRole("button", { name: `Como está a conversão do anúncio ${E2E_LISTING_TRAFFIC.itemId} nos últimos 30 dias?` }),
  ).toBeVisible();

  // O campo é o mesmo da tela cheia: uma implementação de conversa, não duas.
  await expect(gaveta.getByRole("textbox", { name: "Pergunta ao Copiloto" })).toBeVisible();
});

test("o contexto some ao sair da tela que o publicou", async ({ page }) => {
  await login(page, `/anuncios/${E2E_LISTING_TRAFFIC.itemId}`);

  await page.getByRole("button", { name: "Copiloto" }).click();
  await expect(page.getByRole("dialog", { name: "Copiloto" })).toContainText(E2E_LISTING_TRAFFIC.itemId);
  await page.keyboard.press("Escape");

  /*
    Sair do anúncio e continuar afirmando o contexto dele seria a mentira que o
    selo do frame vira sem cuidado — e ela é pior que não ter contexto nenhum,
    porque a resposta viria sobre outra entidade.
  */
  await page.getByRole("link", { name: "Home" }).click();
  await expect(page.getByRole("region", { name: "Atenção necessária" })).toBeVisible();

  await page.getByRole("button", { name: "Copiloto" }).click();

  const gaveta = page.getByRole("dialog", { name: "Copiloto" });

  await expect(gaveta).toContainText("Nenhum");
  await expect(gaveta).not.toContainText(E2E_LISTING_TRAFFIC.itemId);
});
