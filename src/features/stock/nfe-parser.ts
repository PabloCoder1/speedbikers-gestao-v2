import { XMLParser, XMLValidator } from "fast-xml-parser";

export const MAX_NFE_XML_BYTES = 5 * 1024 * 1024;
export const MAX_NFE_ITEMS = 500;

type XmlRecord = Record<string, unknown>;

export type NfeReceiptItem = {
  lineNumber: number;
  supplierSku: string;
  description: string | null;
  unit: string | null;
  quantity: number;
  unitValue: number | null;
  totalValue: number | null;
};

export type ParsedNfeReceipt = {
  accessKey: string;
  invoiceNumber: string;
  invoiceSeries: string | null;
  issuedAt: string | null;
  protocolStatus: string;
  supplierName: string | null;
  supplierDocument: string | null;
  recipientDocument: string | null;
  totalAmount: number | null;
  items: NfeReceiptItem[];
};

export class NfeXmlError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NfeXmlError";
  }
}

function record(value: unknown): XmlRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as XmlRecord
    : null;
}

function array(value: unknown) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function text(value: unknown) {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function decimal(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function documentNumber(node: XmlRecord | null) {
  return text(node?.CNPJ) ?? text(node?.CPF);
}

function issuedAt(value: unknown) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function invoiceRoot(parsed: unknown) {
  const root = record(parsed);
  if (!root) return null;
  const processed = record(root.nfeProc);
  const nfe = record(processed?.NFe) ?? record(root.NFe);
  return { processed, nfe };
}

export function parseNfeXml(buffer: Buffer): ParsedNfeReceipt {
  if (buffer.byteLength === 0) {
    throw new NfeXmlError("empty_xml", "O arquivo XML está vazio.");
  }
  if (buffer.byteLength > MAX_NFE_XML_BYTES) {
    throw new NfeXmlError("xml_too_large", "O XML ultrapassa o limite de 5 MB.");
  }

  const xml = buffer.toString("utf8").replace(/^\uFEFF/, "").trim();
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new NfeXmlError(
      "unsafe_xml_declaration",
      "O XML contém uma declaração externa que não é aceita por segurança.",
    );
  }

  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new NfeXmlError("invalid_xml", "O arquivo não contém um XML válido.");
  }

  let parsed: unknown;
  try {
    parsed = new XMLParser({
      ignoreAttributes: false,
      removeNSPrefix: true,
      parseTagValue: false,
      parseAttributeValue: false,
      processEntities: false,
      trimValues: true,
      maxNestedTags: 60,
      isArray: (tagName) => tagName === "det",
    }).parse(xml);
  } catch {
    throw new NfeXmlError("invalid_xml", "Não foi possível interpretar o XML da NF-e.");
  }

  const roots = invoiceRoot(parsed);
  const infNFe = record(roots?.nfe?.infNFe);
  const ide = record(infNFe?.ide);
  const protocol = record(record(roots?.processed?.protNFe)?.infProt);
  const model = text(ide?.mod);

  if (!infNFe || model !== "55") {
    throw new NfeXmlError(
      "unsupported_fiscal_document",
      "Envie o XML processado de uma NF-e modelo 55.",
    );
  }

  const protocolStatus = text(protocol?.cStat);
  if (protocolStatus !== "100" && protocolStatus !== "150") {
    throw new NfeXmlError(
      "nfe_not_authorized",
      "A NF-e não contém um protocolo de autorização válido.",
    );
  }

  const idAccessKey = text(infNFe["@_Id"])?.replace(/^NFe/i, "") ?? null;
  const protocolAccessKey = text(protocol?.chNFe);
  const accessKey = protocolAccessKey ?? idAccessKey;

  if (!accessKey || !/^[0-9]{44}$/.test(accessKey)) {
    throw new NfeXmlError(
      "invalid_access_key",
      "A chave de acesso da NF-e está ausente ou inválida.",
    );
  }
  if (idAccessKey && protocolAccessKey && idAccessKey !== protocolAccessKey) {
    throw new NfeXmlError(
      "access_key_mismatch",
      "A chave da nota não corresponde ao protocolo de autorização.",
    );
  }

  const invoiceNumber = text(ide?.nNF);
  if (!invoiceNumber) {
    throw new NfeXmlError("missing_invoice_number", "O número da NF-e não foi encontrado.");
  }

  const detailNodes = array(infNFe.det);
  if (detailNodes.length === 0 || detailNodes.length > MAX_NFE_ITEMS) {
    throw new NfeXmlError(
      "invalid_item_count",
      `A NF-e deve conter entre 1 e ${MAX_NFE_ITEMS} itens.`,
    );
  }

  const usedLines = new Set<number>();
  const items = detailNodes.map((node, index) => {
    const detail = record(node);
    const product = record(detail?.prod);
    const supplierSku = text(product?.cProd);
    const quantity = decimal(product?.qCom);
    const lineNumber = Number(text(detail?.["@_nItem"]) ?? index + 1);

    if (
      !supplierSku ||
      supplierSku.length > 120 ||
      !Number.isInteger(lineNumber) ||
      lineNumber <= 0 ||
      usedLines.has(lineNumber) ||
      quantity === null ||
      quantity <= 0 ||
      quantity > 1_000_000_000
    ) {
      throw new NfeXmlError(
        "invalid_invoice_item",
        `O item ${index + 1} possui SKU, quantidade ou numeração inválida.`,
      );
    }

    usedLines.add(lineNumber);
    const unitValue = decimal(product?.vUnCom);
    const totalValue = decimal(product?.vProd);
    if ((unitValue !== null && unitValue < 0) || (totalValue !== null && totalValue < 0)) {
      throw new NfeXmlError(
        "invalid_invoice_item_value",
        `O item ${lineNumber} possui valor inválido.`,
      );
    }

    return {
      lineNumber,
      supplierSku,
      description: text(product?.xProd),
      unit: text(product?.uCom),
      quantity,
      unitValue,
      totalValue,
    };
  });

  const supplier = record(infNFe.emit);
  const recipient = record(infNFe.dest);
  const total = record(record(infNFe.total)?.ICMSTot);

  return {
    accessKey,
    invoiceNumber,
    invoiceSeries: text(ide?.serie),
    issuedAt: issuedAt(ide?.dhEmi ?? ide?.dEmi),
    protocolStatus,
    supplierName: text(supplier?.xNome),
    supplierDocument: documentNumber(supplier),
    recipientDocument: documentNumber(recipient),
    totalAmount: decimal(total?.vNF),
    items,
  };
}
