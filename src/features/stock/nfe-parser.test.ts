import assert from "node:assert/strict";
import test from "node:test";

import { NfeXmlError, parseNfeXml } from "@/features/stock/nfe-parser";

const accessKey = "35260812345678000190550010000001231123456789";

function fixture({
  status = "100",
  productCode = "SKU-13014",
  quantity = "2.0000",
}: {
  status?: string;
  productCode?: string;
  quantity?: string;
} = {}) {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
      <NFe>
        <infNFe Id="NFe${accessKey}" versao="4.00">
          <ide><mod>55</mod><serie>1</serie><nNF>123</nNF><dhEmi>2026-08-16T10:30:00-03:00</dhEmi></ide>
          <emit><CNPJ>12345678000190</CNPJ><xNome>Fornecedor Teste</xNome></emit>
          <dest><CNPJ>98765432000110</CNPJ></dest>
          <det nItem="1"><prod><cProd>${productCode}</cProd><xProd>Produto teste</xProd><uCom>UN</uCom><qCom>${quantity}</qCom><vUnCom>15.50</vUnCom><vProd>31.00</vProd></prod></det>
          <total><ICMSTot><vNF>31.00</vNF></ICMSTot></total>
        </infNFe>
      </NFe>
      <protNFe><infProt><chNFe>${accessKey}</chNFe><cStat>${status}</cStat></infProt></protNFe>
    </nfeProc>`);
}

test("parses an authorized model 55 NF-e while preserving the supplier SKU", () => {
  const parsed = parseNfeXml(fixture());

  assert.equal(parsed.accessKey, accessKey);
  assert.equal(parsed.invoiceNumber, "123");
  assert.equal(parsed.supplierDocument, "12345678000190");
  assert.equal(parsed.recipientDocument, "98765432000110");
  assert.equal(parsed.totalAmount, 31);
  assert.deepEqual(parsed.items[0], {
    lineNumber: 1,
    supplierSku: "SKU-13014",
    description: "Produto teste",
    unit: "UN",
    quantity: 2,
    unitValue: 15.5,
    totalValue: 31,
  });
});

test("rejects an NF-e without an authorization protocol", () => {
  assert.throws(
    () => parseNfeXml(fixture({ status: "101" })),
    (error) => error instanceof NfeXmlError && error.code === "nfe_not_authorized",
  );
});

test("rejects document type declarations before parsing", () => {
  const malicious = Buffer.from(`<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><foo>&xxe;</foo>`);
  assert.throws(
    () => parseNfeXml(malicious),
    (error) => error instanceof NfeXmlError && error.code === "unsafe_xml_declaration",
  );
});
