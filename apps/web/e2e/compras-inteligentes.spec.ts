import { expect, test } from "@playwright/test";

import { E2E_ANOMALIA, E2E_SKU_CODE } from "./constants.js";
import { factValue, login } from "./helpers.js";

/**
 * A jornada de compras inteligentes (D-720 a D-725), com o seed de sempre:
 * Reposição (margem e análise) → novo pedido → revisão (retirar e manter) →
 * criação → aprovação → pedido feito → etapa → recebimento parcial → histórico.
 *
 * O seed não tem regra de reposição nem 84 dias de histórico, então a avaliação
 * responde "dados insuficientes" — e é isso que se afirma: a revisão aparece,
 * não inventa recomendação e deixa o comprador decidir. As regras de
 * recomendação (retirar, reduzir, margem × giro) estão provadas no domínio
 * (`purchase-fit.test.ts`) e no banco (`compras-inteligentes.integration.test.ts`).
 */

test("reposição: margem por período e o painel de análise por SKU", async ({ page }) => {
  await login(page, `/reposicao?busca=${E2E_SKU_CODE}`);

  await expect(page.getByRole("columnheader", { name: /Margem 30d/ })).toBeVisible();

  const linha = page.locator("tbody tr", { hasText: E2E_SKU_CODE }).first();
  const analise = linha.locator("details.sb-cmp-detalhes");

  // O SKU do seed começou a vender há ~40 dias: "produto recente" (D-721), sem conclusão por vender pouco.
  await expect(analise.locator("summary")).toContainText(/Produto recente|Dados insuficientes/);
  await analise.locator("summary").click();
  await expect(analise.getByRole("heading", { name: /^Margem/ })).toBeVisible();
  // A ressalva do que a margem NÃO é vem junto do número.
  await expect(analise.getByText(/Não é lucro líquido/)).toBeVisible();

  await page.locator("summary", { hasText: "Margem: 30 dias" }).click();
  await page.getByRole("link", { name: "Margem dos últimos 90 dias" }).click();
  await expect(page).toHaveURL(/margem=90/);
  await expect(page.getByRole("columnheader", { name: /Margem 90d/ })).toBeVisible();
});

test("pedido: revisão antes de confirmar, decisão gravada, recebimento parcial e histórico", async ({ page }) => {
  await login(page, "/compras/novo");

  await page.getByRole("button", { name: "Colar lista" }).click();
  await page.getByLabel(/Uma linha por item/).fill([`${E2E_SKU_CODE}\t5\t10,00`, `${E2E_ANOMALIA.sku}\t3\t20,00`].join("\n"));
  await page.getByRole("button", { name: "Adicionar à lista" }).click();

  const revisao = page.locator("section.sb-rev");
  // Só a tabela de ITENS: os painéis de análise têm tabelas próprias no DOM, mesmo fechados.
  const linhasDoPedido = page.locator("section[aria-labelledby='pco-itens'] tbody tr");

  await expect(revisao.getByRole("heading", { name: "Revisão antes de confirmar" })).toBeVisible();
  // Sem regra nem histórico no seed (e os SKUs são recentes): os dois caem em "sem dados", e nada é retirado sozinho.
  await expect(revisao.locator(".sb-rev-classe-sem_dados strong")).toHaveText("2", { timeout: 15_000 });
  await expect(linhasDoPedido).toHaveCount(2);

  const anomalia = revisao.locator("li.sb-rev-item", { hasText: E2E_ANOMALIA.sku });

  await anomalia.getByRole("button", { name: "Retirar do pedido" }).click();
  await expect(linhasDoPedido).toHaveCount(1);
  await expect(revisao.getByText("Retirados deste pedido")).toBeVisible();
  await expect(revisao.getByText(/É redução do pedido planejado, não economia realizada/)).toBeVisible();

  const resumo = page.getByRole("complementary", { name: "Resumo do pedido" });

  await expect(resumo.getByText("R$ 50,00")).toBeVisible();

  await page.getByRole("button", { name: "Criar pedido (rascunho)" }).click();
  await expect(page).toHaveURL(/\/compras\/[0-9a-f-]{36}$/);

  const decisoes = page.locator(".sb-pod-section", { has: page.getByRole("heading", { name: "Decisões da revisão" }) });

  await expect(decisoes.getByRole("row", { name: new RegExp(E2E_ANOMALIA.sku) })).toContainText("Retirar");
  await expect(decisoes.getByRole("row", { name: new RegExp(E2E_ANOMALIA.sku) })).toContainText("3 → 0");

  await page.getByRole("button", { name: "Aprovar" }).click();
  await page.getByRole("button", { name: "Marcar como enviado pelo fornecedor" }).click();
  await expect(page.getByRole("button", { name: "Receber parte do pedido" })).toBeVisible();

  await page.getByLabel("Etapa logística").selectOption("EMBARCADO");
  await page.getByRole("button", { name: "Atualizar etapa" }).click();
  await expect(factValue(page, "Etapa")).toHaveText("Embarcado");

  await page.getByRole("button", { name: "Receber parte do pedido" }).click();
  await page.getByLabel(`Quantidade recebida agora de ${E2E_SKU_CODE}`).fill("2");
  await page.getByRole("button", { name: "Registrar recebimento" }).click();

  await expect(factValue(page, "Recebido")).toHaveText("2 de 5 un");
  await expect(page.getByText("Recebido em parte").first()).toBeVisible();

  // Receber acima do que falta é recusado com a mensagem em português.
  await page.getByRole("button", { name: "Receber parte do pedido" }).click();
  await page.getByLabel(`Quantidade recebida agora de ${E2E_SKU_CODE}`).fill("9");
  await page.getByRole("button", { name: "Registrar recebimento" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "passa do que falta chegar" })).toBeVisible();

  /*
    Cancelar fecha só o trânsito AINDA pendente (D-724): +5 pedido, −2 recebido,
    −3 cancelado. E é também o que deixa o saldo do SKU do seed como estava —
    os specs seguintes (`reposicao`, `estoque`) recalculam o aproveitável pelas
    constantes do seed.
  */
  await page.getByRole("button", { name: "Fechar" }).click();
  await page.getByRole("button", { name: "Cancelar pedido" }).click();
  await page.getByLabel("Motivo do cancelamento (opcional)").fill("e2e: fecha o trânsito pendente");
  await page.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect(page.getByText(/Cancelado:/)).toBeVisible();
  await expect(factValue(page, "Recebido")).toHaveText("2 de 5 un");
});
