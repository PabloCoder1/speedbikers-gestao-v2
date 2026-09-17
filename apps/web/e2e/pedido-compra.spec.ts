import { expect, test } from "@playwright/test";

import { E2E_SUPPLIER } from "./constants.js";
import { factValue, login } from "./helpers.js";

/**
 * "Pedido de compra" (docs/TESTING.md) — cria um rascunho do zero pela UI.
 * Não precisa de seed: o item aceita SKU em texto livre sem cadastro prévio
 * (`apps/web/app/compras/novo/item-row.tsx`), então o próprio teste já cobre
 * o caminho mais comum na prática (fornecedor manda um código que ainda não
 * está catalogado).
 *
 * A asserção de "Itens: 1" e do valor estimado na tela de detalhe é
 * deliberada: D-067 (Nível 1) corrigiu um bug real em que falha silenciosa
 * de leitura fazia esse resumo mostrar "0 itens, R$ 0,00" num pedido que
 * tinha itens de verdade — este teste é a guarda de regressão daquele bug.
 */
test("cria um pedido de compra com item em texto livre e mostra o resumo certo", async ({ page }) => {
  await login(page, "/compras/novo");

  await expect(page).toHaveURL(/\/compras\/novo$/);

  const row = page.locator("tbody tr").first();

  await row.getByPlaceholder("SKU ou nome…").fill("PEDIDO-E2E-001");
  await row.locator('input[type="number"]').first().fill("5");
  await row.locator('input[type="number"]').nth(1).fill("10.5");

  await page.getByRole("button", { name: "Criar pedido (rascunho)" }).click();

  await expect(page).toHaveURL(/\/compras\/[0-9a-f-]{36}$/);

  // O par rótulo/valor saiu do `Stat` inline e virou a grade de fatos do
  // `ObjectHeader` na migração de D-277. O locator acompanhou; a guarda de
  // regressão de D-067 continua sendo a mesma afirmação.
  await expect(factValue(page, "Itens")).toContainText("1");
  await expect(factValue(page, "Valor estimado")).toContainText("52,50");

  // O rascunho recém-criado está na primeira etapa, e a aprovação é a
  // próxima — indicador de processo e selo de estado têm de concordar.
  await expect(page.getByRole("listitem").filter({ hasText: "Aprovado" })).toHaveAttribute(
    "aria-current",
    "step",
  );
});

/*
  D-368 — o formulário novo, SEM gravar nada: o resumo soma ao vivo com a mesma
  regra do pedido salvo (item sem custo fica fora e é contado), a lista colada
  vira linhas, o atalho de prazo preenche a data e o fornecedor escolhido
  aparece como ficha.
*/
test("novo pedido: lista colada, resumo ao vivo, atalho de prazo e ficha do fornecedor", async ({ page }) => {
  await login(page, "/compras/novo");

  await page.getByRole("button", { name: "Colar lista" }).click();
  await page.getByLabel(/Uma linha por item/).fill(["COLA-E2E-1\t2\t10,00", "COLA-E2E-2;3"].join("\n"));
  await page.getByRole("button", { name: "Adicionar à lista" }).click();

  await expect(page.getByRole("status").filter({ hasText: /2 item\(ns\) adicionados/ })).toBeVisible();
  // A linha vazia do começo dá lugar à lista.
  await expect(page.locator("tbody tr")).toHaveCount(2);

  const resumo = page.getByRole("complementary", { name: "Resumo do pedido" });

  await expect(resumo.getByText("R$ 20,00")).toBeVisible();
  await expect(resumo.getByText(/soma parcial — 1 item\(ns\) sem custo/)).toBeVisible();

  await page.getByRole("button", { name: "+15 dias" }).click();
  await expect(page.getByLabel("Previsão de chegada")).not.toHaveValue("");
  await expect(page.getByText(/Chega em 15 dias/)).toBeVisible();

  // O rótulo da opção carrega "· N em aberto": escolhe pelo valor.
  const opcao = page.locator("#pco-supplier option", { hasText: E2E_SUPPLIER.name }).first();
  const valor = await opcao.getAttribute("value");

  await page.locator("#pco-supplier").selectOption(valor ?? "");
  await expect(page.getByRole("link", { name: /Ver fornecedor/ })).toBeVisible();
  await expect(page.getByText(/pedido\(s\) em aberto/)).toBeVisible();
});
