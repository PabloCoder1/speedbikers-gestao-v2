import type { Database } from "@sb/db";
import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";
import { expect, test, type Page } from "@playwright/test";

import { login } from "./helpers.js";

/*
  FALHA DE TRANSPORTE NA IMPORTAÇÃO DE PEDIDOS ANTERIORES (D-867). A planilha
  tem só um código novo, fora do catálogo: nenhum pedido é registrado, e o
  saldo e a sugestão do SKU do seed, que outras specs contam, não mudam. O SKU
  criado pela conferência fica no catálogo, como em
  `importar-pedidos-anteriores.spec.ts`, com código novo a cada execução.
*/

const CODIGO = `TRANSP-IMP-${String(Date.now()).slice(-7)}`;

function banco(): ReturnType<typeof createClient<Database>> {
  const url = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321");

  if (!["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Este teste exige Supabase local.");

  return createClient<Database>(url.href, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", {
    auth: { persistSession: false },
  });
}

async function planilha(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const pecas = wb.addWorksheet("PEÇAS");

  pecas.addRow(["CÓDIGO", "DESCRIÇÃO", `REF-${CODIGO}`]);
  pecas.addRow([CODIGO, "Item de teste de transporte", 4]);

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Deixa o servidor receber a PRIMEIRA Server Action da página e corta a resposta. */
async function perderPrimeiraResposta(page: Page, caminho: string): Promise<() => boolean> {
  let perdida = false;

  await page.route(
    (endereco) => endereco.pathname === caminho,
    async (rota) => {
      const pedido = rota.request();

      if (!perdida && pedido.method() === "POST" && pedido.headers()["next-action"] !== undefined) {
        perdida = true;
        await rota.fetch();
        await rota.abort("failed");
      } else {
        await rota.continue();
      }
    },
  );

  return () => perdida;
}

test("importação: resposta perdida no envio e na criação do SKU avisa, e a nova tentativa não duplica (D-867)", async ({ page }) => {
  test.setTimeout(120_000);
  const arquivo = await planilha();

  await login(page, "/compras/importar");
  // Anexar antes da hidratação perde o onChange.
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Planilha de pedidos (.xlsx ou .xls)").setInputFiles({
    name: "transporte-e2e.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: arquivo,
  });

  // 1) Envio: o servidor cria o lote e a resposta se perde.
  const envioPerdido = await perderPrimeiraResposta(page, "/compras/importar");
  const enviar = page.getByRole("button", { name: "3. Enviar para conferência" });

  await enviar.click();
  await expect(page.getByText("Não foi possível confirmar o envio da planilha.")).toBeVisible();
  await expect(enviar).toBeEnabled();
  expect(envioPerdido()).toBe(true);

  // A nova tentativa reconhece o arquivo pelo SHA-256 e abre o MESMO lote.
  await enviar.click();
  await expect(page).toHaveURL(/\/compras\/importar\/[0-9a-f-]{36}\?existente=1/);

  // A chave de serviço não lê `purchase_import_rows` (sem GRANT, de propósito):
  // a prova é a da tela, a mesma de `importar-pedidos-anteriores.spec.ts`.
  await expect(page.getByText(/Este arquivo já tinha sido importado/)).toBeVisible();

  const caminhoLote = new URL(page.url()).pathname;

  // 2) Criar o SKU do lote: o servidor cria e a resposta se perde.
  const criacaoPerdida = await perderPrimeiraResposta(page, caminhoLote);
  const criar = page.getByRole("button", { name: "Criar SKU das 1 não encontradas" });

  await criar.click();
  await expect(page.getByText("Não foi possível confirmar a criação dos SKUs.")).toBeVisible();
  await expect(criar).toBeEnabled();
  expect(criacaoPerdida()).toBe(true);

  // A nova tentativa só vincula o código que já existe: um SKU só no catálogo.
  await criar.click();
  await expect(page.getByText("Não foi possível confirmar a criação dos SKUs.")).toBeHidden();

  const { data: skus, error: erroSkus } = await banco().from("skus").select("id").eq("sku", CODIGO);

  expect(erroSkus).toBeNull();
  expect(skus).toHaveLength(1);
});
