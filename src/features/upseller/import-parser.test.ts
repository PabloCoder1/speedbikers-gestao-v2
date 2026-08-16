import assert from "node:assert/strict";
import test from "node:test";

import ExcelJS from "exceljs";

import { parseProductWorkbook } from "@/features/upseller/import-parser";

test("UpSeller category is preserved as the canonical brand", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Produtos");
  worksheet.addRow([
    "SKU",
    "SPU",
    "Código do Produto",
    "Título",
    "Categorias",
    "Preço de varejo",
    "Custo de Compra",
    "Marca",
  ]);
  worksheet.addRow([
    "SKU-999",
    "SPU-1",
    "PROD-1",
    "Produto com categoria numérica",
    "999",
    100,
    40,
    "Marca que não deve prevalecer",
  ]);
  worksheet.addRow([
    "SKU-INATIVO",
    "SPU-2",
    "PROD-2",
    "Produto inativo",
    "ESTOQUE INATIVO",
    80,
    20,
    null,
  ]);

  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const parsed = await parseProductWorkbook(buffer);

  assert.deepEqual(parsed.blockingIssues, []);
  assert.equal(parsed.rows[0]?.category, "999");
  assert.equal(parsed.rows[0]?.brand, "999");
  assert.equal(parsed.rows[1]?.category, "ESTOQUE INATIVO");
  assert.equal(parsed.rows[1]?.brand, "ESTOQUE INATIVO");
});
