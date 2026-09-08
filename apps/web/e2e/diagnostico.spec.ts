import { expect, test } from "@playwright/test";

import { E2E_ANOMALIA } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/diagnostico` — Diagnóstico depois da migração para o frame `Diagnostic`
 * (D22, D-260). É a primeira tela da frente visual que NÃO é cabeçalho +
 * faixa + tabela: o frame é mestre-detalhe.
 *
 * **A tela nascia VAZIA, e a primeira captura provou.** `get_sku_sales_baseline`
 * exige 4 amostras do mesmo dia da semana e `diagnoseSalesAnomaly` exige
 * |z| >= 2 — nenhum SKU do seed chegava perto, e a tela dizia "0 SKU(s) com
 * histórico suficiente". `E2E_ANOMALIA` existe para isso.
 *
 * O que este arquivo protege:
 *
 *  1. **O percentual de confiança do frame NÃO aparece.** Ele mostra
 *     "Alta · 91%"; `DiagnosisConfidence` tem dois valores por limiar de
 *     z-score, e 91% seria número sintetizado sem definição catalogada
 *     (D-023). A tela mostra o z-score, que é o insumo real;
 *  2. a seleção do mestre-detalhe mora na URL (`?sku=`), não em estado React;
 *  3. o impacto sai de `unitsDelta × preço médio` e é "—" sem preço (D-067).
 */

test("/diagnostico: o mestre-detalhe mostra a anomalia, com o insumo da confiança", async ({ page }) => {
  await login(page, "/diagnostico");

  await expect(page.getByRole("heading", { name: "Diagnóstico", level: 1 })).toBeVisible();
  await expect(page.getByText("INTELIGÊNCIA / DETECÇÃO")).toBeVisible();

  // A lista (mestre) traz a anomalia do fixture.
  await expect(page.getByRole("link", { name: new RegExp(E2E_ANOMALIA.sku) })).toBeVisible();

  // O detalhe abre nela sem `?sku=`, porque é a de maior |z|.
  await expect(page.getByRole("heading", { name: E2E_ANOMALIA.titulo, level: 2 })).toBeVisible();

  /*
    O PERCENTUAL DO FRAME NÃO EXISTE. A confiança é categórica, e o que a tela
    mostra ao lado dela é o z-score — o insumo REAL da classificação.
  */
  await expect(page.getByText("z =", { exact: false })).toBeVisible();
  await expect(page.getByText(/Confiança[\s\S]{0,40}\d+%/)).toHaveCount(0);

  /*
    Impacto: 10 unidades a menos × preço médio do fixture = 1.499,00.
    A primeira versão montava a string à mão (`toFixed().replace()`) e errou o
    separador de MILHAR — o teste discordava da tela por formatação, não por
    valor. `Intl` é quem sabe formatar; o teste só afirma o número.
  */
  const esperado = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    10 * E2E_ANOMALIA.precoMedio,
  );
  await expect(page.getByText(esperado).first()).toBeVisible();

  // A análise do Copiloto é SOB DEMANDA — nada é calculado sem pedir.
  await expect(page.getByText("ANÁLISE DO COPILOTO")).toBeVisible();
  await expect(page.getByRole("button", { name: "O que aconteceu?" })).toBeVisible();
});

test("/diagnostico: a seleção mora na URL, e o filtro de confiança recorta", async ({ page }) => {
  await login(page, "/diagnostico");

  await page.getByRole("link", { name: new RegExp(E2E_ANOMALIA.sku) }).click();
  await expect(page).toHaveURL(/\/diagnostico\?sku=/);

  /*
    "Confiança média" tira a anomalia do recorte — ela é de confiança ALTA
    (|z| ~ 11). O vazio precisa distinguir "não há anomalia" de "não há
    anomalia COM ESTA confiança".
  */
  await page.goto("/diagnostico?confianca=media");
  await expect(page.getByText("Nenhuma anomalia com esta confiança.")).toBeVisible();

  await page.goto("/diagnostico?confianca=alta");
  await expect(page.getByRole("heading", { name: E2E_ANOMALIA.titulo, level: 2 })).toBeVisible();
});
