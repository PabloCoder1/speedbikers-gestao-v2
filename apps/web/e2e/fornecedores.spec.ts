import { expect, test } from "@playwright/test";

import { E2E_SUPPLIER, E2E_SUPPLIER_INATIVO } from "./constants.js";
import { login } from "./helpers.js";

/**
 * `/fornecedores` — a Base de Fornecedores depois da migração para o frame
 * `ProcessScreen type="suppliers"` (D20, D-256).
 *
 * O frame desta variação é o MESMO esboço da `nfe` (D-253): cabeçalho, painel
 * e um parágrafo de reserva no lugar da tabela. Então o que há para afirmar
 * não é composição inventada — é o cabeçalho do frame, o painel, a janela
 * declarada e o filtro que o "Filtros ⌄" promete.
 *
 * **O segundo fornecedor do seed é o que torna este teste possível.** Com um
 * só, "Ativos" e "Inativos" devolveriam o mesmo conjunto e o filtro passaria
 * sem provar nada.
 */

test("/fornecedores: o frame, a janela declarada e o filtro de estado", async ({ page }) => {
  await login(page, "/fornecedores");

  // Cabeçalho do frame.
  await expect(page.getByRole("heading", { name: "Fornecedores", level: 1 })).toBeVisible();
  await expect(page.getByText("ESTOQUE / OPERAÇÃO")).toBeVisible();
  await expect(page.getByRole("link", { name: "Novo Fornecedor" })).toBeVisible();

  /*
    A linha de apoio do frame diz "Lead time, cobertura e relacionamento em uma
    única visão". Lead time e cobertura NÃO existem por fornecedor
    (`replenishment_settings` é escopada por organização, marca ou SKU; e
    `skus.supplier_id` não existe de propósito, D-174), então a frase foi
    recomposta sem elas. Este teste fixa a recomposição: a tela não pode voltar
    a prometer o que não mostra.
  */
  await expect(page.getByText(/Cadastro e relacionamento de compra/)).toBeVisible();
  await expect(page.getByText(/Lead time, cobertura/)).toHaveCount(0);

  // O painel do frame e a janela declarada — a tela lia `.limit(200)` calada.
  await expect(page.getByRole("heading", { name: "Base de Fornecedores", level: 2 })).toBeVisible();
  await expect(page.getByText(/\d+ fornecedores?\.|Mostrando \d+ a \d+ de \d+/)).toBeVisible();

  // Os dois do seed aparecem quando o recorte é "todos".
  await expect(page.getByRole("link", { name: E2E_SUPPLIER.name })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name })).toBeVisible();
});

test("/fornecedores: Ativos e Inativos recortam conjuntos diferentes", async ({ page }) => {
  await login(page, "/fornecedores?estado=inativos");

  await expect(page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_SUPPLIER.name })).toHaveCount(0);

  await page.goto("/fornecedores?estado=ativos");

  await expect(page.getByRole("link", { name: E2E_SUPPLIER.name })).toBeVisible();
  await expect(page.getByRole("link", { name: E2E_SUPPLIER_INATIVO.name })).toHaveCount(0);
});
