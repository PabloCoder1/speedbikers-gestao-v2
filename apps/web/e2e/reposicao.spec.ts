import { expect, test } from "@playwright/test";

import { E2E_LISTING_FULL, E2E_LOCAL_STOCK, E2E_SKU_CODE, E2E_SKU_SALES } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/reposicao` — a tela FUNDIDA (D-288).
 *
 * `/cobertura` e `/reposicao` eram duas telas medindo a mesma coisa com
 * definições diferentes de ruptura, e o frame sempre as tratou como uma
 * (D-261). A fusão escolheu a definição da REPOSIÇÃO — aproveitável
 * (local + Full + trânsito) contra a venda média, com lead time e cobertura
 * alvo —, e este arquivo existe para que essa escolha não volte atrás em
 * silêncio.
 *
 * **O caso central é aritmético, e é a prova da definição:** com 50 de saldo
 * local e 3 no Full, a cobertura é `53 ÷ venda média`, não `50 ÷ venda média`.
 * Se alguém repontar a coluna para o estoque local, a conta muda e este teste
 * fica vermelho.
 */

test("/cobertura foi fundida: a rota redireciona e leva o recorte junto", async ({ page }) => {
  await login(page, "/cobertura?marca=VAZ");

  await expect(page).toHaveURL(/\/reposicao\?marca=VAZ/);
  await expect(page.getByRole("heading", { level: 1, name: "Cobertura e reposição" })).toBeVisible();
});

test("/reposicao: a cobertura em dias conta o APROVEITÁVEL, não o estoque local", async ({ page }) => {
  await login(page, "/reposicao");

  // A coluna que veio de `/cobertura` na fusão.
  await expect(page.getByRole("columnheader", { name: /Cobertura \(dias\)/ })).toBeVisible();

  const vendaDiaria = E2E_SKU_SALES.reduce((total, dia) => total + dia.units, 0) / 30;
  const aproveitavel = E2E_LOCAL_STOCK + E2E_LISTING_FULL;

  const pelaReposicao = aproveitavel / vendaDiaria;
  const peloEstoqueLocal = E2E_LOCAL_STOCK / vendaDiaria;

  // As duas definições PRECISAM divergir, senão o caso não prova nada.
  expect(Math.round(pelaReposicao)).not.toBe(Math.round(peloEstoqueLocal));

  const linha = page.locator("tbody tr", { hasText: E2E_SKU_CODE });

  await expect(linha).toContainText(String(aproveitavel));
  await expect(linha).toContainText(pelaReposicao.toFixed(2).replace(".", ","));
  await expect(linha).not.toContainText(peloEstoqueLocal.toFixed(2).replace(".", ","));
});

test("/reposicao: SKU com saldo sentinela não recebe número de cobertura", async ({ page }) => {
  await login(page, "/reposicao");

  /*
    O SKU da anomalia é `stock_is_virtual` no seed: o saldo do ERP é sentinela,
    não contagem (D-127). A coluna fica em branco de propósito — um número ali
    seria resposta errada com cara de precisa.
  */
  const linha = page.locator("tbody tr", { hasText: "E2E-ANOMALIA-001" });

  await expect(linha).toContainText("estoque virtual");
  await expect(linha).toContainText("sem configuração");
});

test("a navegação tem UMA entrada para cobertura e reposição, não duas", async ({ page }) => {
  await login(page, "/reposicao");

  const nav = page.getByRole("navigation");

  await expect(nav.getByRole("link", { name: "Cobertura e reposição" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Cobertura", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "Reposição", exact: true })).toHaveCount(0);
});
