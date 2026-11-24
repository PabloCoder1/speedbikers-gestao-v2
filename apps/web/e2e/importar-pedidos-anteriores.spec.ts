import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";

import { E2E_SKU_CODE } from "./constants.js";
import { login } from "./helpers.js";

/**
 * Importar pedidos anteriores (D-764), pela tela, com um .xlsx gerado aqui no
 * formato do "Controle de chegada": código, descrição, uma coluna de
 * quantidade com a referência no cabeçalho, uma SEM cabeçalho com "200 + 200",
 * uma observação e uma imagem embutida (a leitura não pode depender dela).
 *
 * As planilhas reais da empresa nunca entram no repositório. O pedido criado
 * é cancelado no fim pela tela, o que zera o trânsito que ele abriu.
 */

const REFERENCIA = `E2E-IMP-${String(Date.now()).slice(-6)}`;
// Código novo a cada execução: o SKU criado pela conferência (D-792) fica no catálogo.
const NOVO = `NOVO-${REFERENCIA}`;

// PNG 1×1 transparente: o bastante para o .xlsx carregar uma imagem em xl/media.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");

async function planilha(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const pecas = wb.addWorksheet("PEÇAS");

  pecas.addRow(["CÓDIGO", "DESCRIÇÃO", REFERENCIA, "", "OBS"]);
  pecas.addRow([E2E_SKU_CODE, "Produto de teste E2E", 7, "200 + 200", "NÃO VENDE"]);
  pecas.addRow([NOVO, "Item fora do catálogo", 3, "", ""]);
  // O tipo do exceljs ainda é o Buffer antigo do Node: o conteúdo é o mesmo.
  pecas.addImage(wb.addImage({ buffer: PNG as unknown as ExcelJS.Buffer, extension: "png" }), "G2:H4");

  const catalogo = wb.addWorksheet("CATALOGO");

  catalogo.addRow(["CÓDIGO", "DESCRIÇÃO", "VALOR FOB"]);
  catalogo.addRow([E2E_SKU_CODE, "Produto de teste E2E", 1.25]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

test("importar pedidos anteriores: ler, conferir, registrar uma referência e não duplicar", async ({ page }) => {
  test.setTimeout(120_000);
  const arquivo = await planilha();

  await login(page, "/compras");
  await page.getByRole("link", { name: "Importar pedidos anteriores" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Importar pedidos anteriores" })).toBeVisible();

  await page.getByLabel("Planilha de pedidos (.xlsx ou .xls)").setInputFiles({
    name: "controle-e2e.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: arquivo,
  });

  // A referência do cabeçalho é reconhecida; a coluna sem cabeçalho espera a do usuário.
  await expect(page.getByLabel("Referência do pedido da coluna C")).toHaveValue(REFERENCIA);
  await expect(page.getByLabel("Referência do pedido da coluna D")).toHaveValue("");
  // O catálogo (sem quantidade) começa fora.
  await expect(page.locator("details.sb-imp-aba", { hasText: "CATALOGO" })).toContainText("parece catálogo");
  await expect(page.locator(".sb-imp-envio")).toContainText("3 quantidades");
  await expect(page.locator(".sb-imp-envio")).toContainText("1 a confirmar");

  await page.getByRole("button", { name: "3. Enviar para conferência" }).click();
  await expect(page).toHaveURL(/\/compras\/importar\/[0-9a-f-]{36}/);
  const lote = page.url().split("?")[0] ?? "";

  const cartao = (rotulo: string) => page.locator(".sb-imp-cartao", { hasText: rotulo }).locator("strong");

  await expect(cartao("Não encontradas")).toHaveText("1");
  await expect(cartao("Quantidade a confirmar")).toHaveText("1");
  await expect(cartao("Sem referência")).toHaveText("1");

  // A referência da planilha: 1 vinculada (exata), e a situação é obrigatória.
  const grupo = page.locator("article.sb-imp-grupo", { hasText: REFERENCIA });

  await grupo.getByRole("button", { name: "Registrar pedido" }).click();
  await expect(grupo.getByText("Escolha a situação")).toBeVisible();
  await grupo.getByLabel("Pedido realizado").check();
  await grupo.getByRole("button", { name: "Registrar pedido" }).click();
  // Se o SKU já tem pedido em aberto (de outro spec), o banco pergunta antes: é outra compra.
  const outra = grupo.getByRole("button", { name: "É outra compra: registrar" });
  const registrado = grupo.getByText(/Pedido nº \d+ registrado\./);

  await expect(outra.or(registrado)).toBeVisible();
  if (await outra.isVisible()) await outra.click();
  await expect(registrado).toBeVisible();

  await page.reload();
  await expect(cartao("Registradas")).toHaveText("1");
  const linkPedido = page.locator("article.sb-imp-grupo", { hasText: REFERENCIA }).getByRole("link", { name: /Pedido nº/ });
  const pedidoHref = await linkPedido.getAttribute("href");

  // O mesmo arquivo de novo cai no mesmo lote.
  await page.goto("/compras/importar");
  // Anexar antes da hidratação perde o onChange (navegação completa, não suave).
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Planilha de pedidos (.xlsx ou .xls)").setInputFiles({
    name: "controle-e2e (copia).xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: arquivo,
  });
  await page.getByRole("button", { name: "3. Enviar para conferência" }).click();
  await expect(page.getByText(/Este arquivo já tinha sido importado/)).toBeVisible();
  expect(page.url().split("?")[0]).toBe(lote);

  // O pedido nasceu como importado de planilha; cancelar fecha o trânsito.
  await page.goto(pedidoHref ?? "/compras");
  await expect(page.getByText("Importado de planilha")).toBeVisible();
  await expect(page.getByText(REFERENCIA).first()).toBeVisible();
  await page.getByRole("button", { name: "Cancelar pedido" }).click();
  await page.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect(page.getByText(/Cancelado/).first()).toBeVisible();

  // D-792: o produto que não existe nasce da própria linha, com o código e o nome dela.
  await page.goto(lote);
  await page.getByRole("button", { name: "Criar SKU das 1 não encontradas" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 SKU(s) criados" })).toBeVisible();
  await expect(cartao("Não encontradas")).toHaveText("0");
  await expect(page.locator("tr", { hasText: NOVO }).getByRole("button", { name: /^Criar SKU/ })).toHaveCount(0);
});
