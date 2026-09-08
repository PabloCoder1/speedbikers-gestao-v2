import { expect, test } from "@playwright/test";

import { E2E_ANOMALIA, E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/full` — Central Full depois da migração para o frame `IntelligenceScreen
 * type="full"` (D25, D-265): faixa de situações + painel "Monitoramento de
 * Fulfillment".
 *
 * **O frame esconde o maior estado.** Ele desenha três cartões (Em Ruptura,
 * Parados, Saudáveis) que somam exatamente o total — 17 + 84 + 427 = 528 —,
 * assumindo que só existem três situações. São quatro: `ausente` ("Fora do
 * Full") tem 778 dos 1.915 SKUs no Dev, 41% do conjunto. A faixa aqui tem cinco
 * células, e elas fecham.
 *
 * O que mais este arquivo protege:
 *
 *  1. **as duas recusas** — "Últ. Envio" (não existe tabela de envio ao Full) e
 *     "Repor Full" (escrita sem política logística por trás);
 *  2. **o link não tem filtro fantasma**: a ação do frame é "Ver cobertura", mas
 *     `/cobertura` só aceita `?marca=` — mandar `?busca=SKU` para lá cairia na
 *     lista inteira com o parâmetro ignorado (D-154);
 *  3. **a linha-sentinela**, que mantém a faixa de pé quando o recorte esvazia;
 *  4. **Full e Local nunca se somam** — autoridades diferentes, regra do PRD.
 */

test("/full: a faixa tem as QUATRO situações, não as três do frame", async ({ page }) => {
  await login(page, "/full");

  await expect(page.getByRole("heading", { name: "Central Full", level: 1 })).toBeVisible();
  await expect(page.getByText("ESTOQUE / FULL")).toBeVisible();

  const faixa = page.locator(".sb-kpi-strip");

  /*
    Cinco células: o total e as quatro situações. O seed tem um SKU saudável e
    um em ruptura; "Parado" e "Fora do Full" ficam em ZERO — e o zero aparece,
    porque esconder a linha é que seria a mentira (D-250).
  */
  await expect(faixa.locator(".sb-kpi", { hasText: "SKUs no Full" }).locator(".sb-kpi-value")).toHaveText("2");
  await expect(faixa.locator(".sb-kpi", { hasText: "Saudável" }).locator(".sb-kpi-value")).toHaveText("1");
  await expect(faixa.locator(".sb-kpi", { hasText: "Ruptura" }).locator(".sb-kpi-value")).toHaveText("1");
  await expect(faixa.locator(".sb-kpi", { hasText: "Parado" }).locator(".sb-kpi-value")).toHaveText("0");

  // A célula que o frame NÃO tem, e que no Dev é o maior estado de todos.
  await expect(faixa.locator(".sb-kpi", { hasText: "Fora do Full" }).locator(".sb-kpi-value")).toHaveText("0");

  // As duas linhas do seed, com o Full de cada uma.
  await expect(page.getByRole("link", { name: E2E_SKU_CODE })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_ANOMALIA.sku })).toBeVisible();
});

test("/full: as recusas ao frame, e o link sem filtro fantasma", async ({ page }) => {
  await login(page, "/full");

  /*
    "Últ. Envio" não tem fonte — não existe tabela de envio ao Full em lugar
    nenhum do esquema. No lugar dela fica "Capturado", que é o que sustenta a
    regra dos 3 dias.
  */
  await expect(page.getByRole("columnheader", { name: "Capturado" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: /Envio/i })).toHaveCount(0);

  // "Repor Full" é escrita, e não há política logística (custo, lote, prazo).
  await expect(page.getByRole("button", { name: /Repor/i })).toHaveCount(0);

  /*
    D-154 — só se aponta para tela que existe, COM O FILTRO QUE ELA TEM.
    `/cobertura` aceita apenas `?marca=`; `/reposicao` aceita `busca`.
  */
  const acao = page.getByRole("link", { name: "Ver reposição →" }).first();

  await expect(acao).toBeVisible();
  await expect(acao).toHaveAttribute("href", new RegExp(`^/reposicao\\?busca=`));

  // A ressalva que impede o erro que o PRD veta por escrito.
  await expect(page.locator(".sb-note")).toContainText(
    "Full é por conta; estoque local é da organização",
  );
});

test("/full: recorte vazio esvazia a tabela e MANTÉM a faixa", async ({ page }) => {
  await login(page, "/full");

  const faixa = page.locator(".sb-kpi-strip");

  /*
    "Parado" tem zero linhas no seed. Sem a linha-sentinela, a página vazia
    devolveria zero linhas e a faixa sumiria junto — o operador ficaria sem
    contagem e sem caminho de volta, exatamente quando precisa dos dois.
  */
  await faixa.locator(".sb-kpi", { hasText: "Parado" }).getByRole("link", { name: "ver lista" }).click();

  await expect(page).toHaveURL(/situacao=parado/);
  await expect(page.locator("tbody tr")).toHaveCount(0);

  // A faixa continua de pé, com as contagens do conjunto inteiro.
  await expect(faixa.locator(".sb-kpi", { hasText: "SKUs no Full" }).locator(".sb-kpi-value")).toHaveText("2");
  await expect(faixa.locator(".sb-kpi", { hasText: "Ruptura" }).locator(".sb-kpi-value")).toHaveText("1");

  // E o critério da situação escolhida aparece — "parado" sem a regra ao lado
  // seria um julgamento sem base declarada.
  await expect(page.getByText("tem saldo no Full", { exact: false })).toBeVisible();
});
