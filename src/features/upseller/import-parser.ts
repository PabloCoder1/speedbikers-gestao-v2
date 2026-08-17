import ExcelJS from "exceljs";
import JSZip from "jszip";

import {
  classifyStoreName,
  normalizeKey,
  normalizeSku,
  parseBoolean,
  parseDecimal,
  sha256,
  splitValues,
  stableJson,
  stockStateHash,
  type JsonRecord,
} from "@/features/stock/stock-domain";

const MAX_ZIP_ENTRIES = 10;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

export type ImportIssue = {
  code: string;
  message: string;
  row?: number;
  field?: string;
  details?: JsonRecord;
};

export type StockImportRow = {
  rowNumber: number;
  sourceSku: string;
  skuKey: string;
  title: string | null;
  warehouseName: string;
  warehouseKey: string;
  shelf: string | null;
  lowStockThreshold: number;
  purchaseInTransit: number;
  transferInTransit: number;
  occupiedQuantity: number;
  availableQuantity: number;
  currentQuantity: number;
  averageCost: number | null;
  stockValue: number | null;
  sourceCreatedAtRaw: string | null;
  stateHash: string;
  rowHash: string;
  rawPayload: JsonRecord;
};

export type ProductImportRow = {
  rowNumber: number;
  sourceSku: string;
  skuKey: string;
  spu: string | null;
  productCode: string | null;
  title: string | null;
  productAlias: string | null;
  invoiceAliasEnabled: boolean | null;
  category: string | null;
  variantDimensions: { name: string; value: string }[];
  launchDateRaw: string | null;
  isActive: boolean | null;
  seller: string | null;
  retailPrice: number | null;
  purchaseCost: number | null;
  description: string | null;
  brand: string | null;
  barcodes: string[];
  skuAlias: string | null;
  images: string[];
  weightG: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  ncm: string | null;
  cest: string | null;
  unit: string | null;
  origin: string | null;
  supplierUrl: string | null;
  rowHash: string;
  rawPayload: JsonRecord;
};

export type RelationshipImportRow = {
  rowNumber: number;
  sourceSku: string;
  sourceSkuKey: string;
  mappedListingSku: string | null;
  mappedListingSkuKey: string | null;
  variantLabel: string | null;
  listingExternalId: string | null;
  variantExternalId: string | null;
  storeName: string;
  storeNameKey: string;
  channel: ReturnType<typeof classifyStoreName>["channel"];
  accountCode: ReturnType<typeof classifyStoreName>["accountCode"];
  sourceUpdatedAtRaw: string | null;
  rowHash: string;
  rawPayload: JsonRecord;
};

export type KitImportRow = {
  rowNumber: number;
  kitSku: string;
  kitSkuKey: string;
  title: string | null;
  alias: string | null;
  invoiceAliasEnabled: boolean | null;
  category: string | null;
  isActive: boolean | null;
  imageUrl: string | null;
  componentSku: string;
  componentSkuKey: string;
  requiredQuantity: number;
  definitionSource: "upseller_export";
  rowHash: string;
  rawPayload: JsonRecord;
};

export type DerivedKitDefinition = {
  kitSku: string;
  kitSkuKey: string;
  components: { componentSku: string; componentSkuKey: string; requiredQuantity: number }[];
};

export type UnresolvedDottedKit = {
  sourceSku: string;
  sourceSkuKey: string;
  missingComponentSkuKeys: string[];
  reason: "invalid_dot_pattern" | "components_missing";
};

type ParsedRows<T> = { rows: T[]; blockingIssues: ImportIssue[]; warnings: ImportIssue[] };
type SheetKind = "stock" | "relationships" | "products" | "kits";

const REQUIRED_HEADERS: Record<SheetKind, string[]> = {
  stock: [
    "SKU", "ARMAZEM", "ESTOQUE BAIXO", "EM TRANSITO COMPRA",
    "EM TRANSITO TRANSFERENCIA", "OCUPADO", "DISPONIVEL", "ESTOQUE ATUAL", "CUSTO MEDIO",
  ],
  relationships: ["SKU", "MAPEADO SKU DO ANUNCIO", "ID DO ANUNCIO", "NOME DA LOJA"],
  products: ["SKU", "SPU", "CODIGO DO PRODUTO", "TITULO", "PRECO DE VAREJO", "CUSTO DE COMPRA"],
  kits: ["KIT SKU", "SKU DE PRODUTO", "QTD SKU DE PRODUTO"],
};

function cellScalar(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if ("result" in value) return cellScalar(value.result as ExcelJS.CellValue);
  if ("richText" in value) return value.richText.map((part) => part.text).join("");
  if ("text" in value) return value.text;
  if ("error" in value) return value.error;
  return String(value);
}

function text(value: unknown) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

async function loadWorkbook(buffer: Buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  return workbook;
}

function findSheet(workbook: ExcelJS.Workbook, kind: SheetKind) {
  for (const worksheet of workbook.worksheets) {
    for (let rowNumber = 1; rowNumber <= Math.min(20, worksheet.rowCount); rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const headerByColumn = new Map<number, string>();
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        const value = text(cellScalar(cell.value));
        if (value) headerByColumn.set(column, normalizeKey(value));
      });
      const available = new Set(headerByColumn.values());
      if (REQUIRED_HEADERS[kind].every((header) => available.has(header))) {
        return { worksheet, headerRow: rowNumber, headerByColumn };
      }
    }
  }
  return null;
}

function readTable(workbook: ExcelJS.Workbook, kind: SheetKind) {
  const found = findSheet(workbook, kind);
  if (!found) throw new Error(`UPS_FILE_HEADERS_NOT_RECOGNIZED:${kind}`);
  const records: { rowNumber: number; normalized: JsonRecord; raw: JsonRecord }[] = [];
  for (let rowNumber = found.headerRow + 1; rowNumber <= found.worksheet.rowCount; rowNumber += 1) {
    const row = found.worksheet.getRow(rowNumber);
    const normalized: JsonRecord = {};
    const raw: JsonRecord = {};
    let hasValue = false;
    for (const [column, header] of found.headerByColumn) {
      const originalHeader = text(cellScalar(found.worksheet.getRow(found.headerRow).getCell(column).value)) ?? header;
      const value = cellScalar(row.getCell(column).value);
      if (value !== null && value !== "") hasValue = true;
      normalized[header] = value;
      raw[originalHeader] = value;
    }
    if (hasValue) records.push({ rowNumber, normalized, raw });
  }
  return records;
}

function requiredNumber(
  record: { rowNumber: number; normalized: JsonRecord },
  header: string,
  blockingIssues: ImportIssue[],
) {
  const parsed = parseDecimal(record.normalized[header]);
  if (parsed === null || parsed < 0) {
    blockingIssues.push({
      code: "invalid_non_negative_quantity",
      message: `Valor inválido ou negativo em ${header}.`,
      row: record.rowNumber,
      field: header,
    });
    return 0;
  }
  return parsed;
}

export async function parseStockWorkbook(buffer: Buffer): Promise<ParsedRows<StockImportRow>> {
  const blockingIssues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const workbook = await loadWorkbook(buffer);
  const records = readTable(workbook, "stock");
  const identities = new Set<string>();
  const rows = records.map((record) => {
    const sourceSku = text(record.normalized.SKU) ?? "";
    const warehouseName = text(record.normalized.ARMAZEM) ?? "";
    if (!sourceSku) blockingIssues.push({ code: "blank_stock_sku", message: "SKU vazio na Lista de Estoque.", row: record.rowNumber });
    if (!warehouseName) blockingIssues.push({ code: "blank_warehouse", message: "Armazém vazio na Lista de Estoque.", row: record.rowNumber });
    const skuKey = normalizeSku(sourceSku);
    const warehouseKey = normalizeKey(warehouseName);
    const identity = `${skuKey}\u0000${warehouseKey}`;
    if (identities.has(identity)) {
      blockingIssues.push({ code: "duplicate_stock_row", message: "SKU e armazém duplicados na Lista de Estoque.", row: record.rowNumber });
    }
    identities.add(identity);

    const lowStockThreshold = requiredNumber(record, "ESTOQUE BAIXO", blockingIssues);
    const purchaseInTransit = requiredNumber(record, "EM TRANSITO COMPRA", blockingIssues);
    const transferInTransit = requiredNumber(record, "EM TRANSITO TRANSFERENCIA", blockingIssues);
    const occupiedQuantity = requiredNumber(record, "OCUPADO", blockingIssues);
    const availableQuantity = requiredNumber(record, "DISPONIVEL", blockingIssues);
    const currentQuantity = requiredNumber(record, "ESTOQUE ATUAL", blockingIssues);
    const averageCost = parseDecimal(record.normalized["CUSTO MEDIO"]);
    const explicitStockValue = parseDecimal(record.normalized.SUBTOTAL);
    const stockValue = explicitStockValue ?? (averageCost === null ? null : currentQuantity * averageCost);
    if (Math.abs(currentQuantity - (availableQuantity + occupiedQuantity)) > 0.000001) {
      blockingIssues.push({
        code: "inconsistent_current_quantity",
        message: "Estoque Atual difere de Disponível + Ocupado.",
        row: record.rowNumber,
        details: { currentQuantity, availableQuantity, occupiedQuantity },
      });
    }
    if ((averageCost !== null && averageCost < 0) || (stockValue !== null && stockValue < 0)) {
      blockingIssues.push({ code: "invalid_stock_cost", message: "Custo médio ou subtotal negativo.", row: record.rowNumber });
    }
    const material = {
      skuKey, warehouseKey, lowStockThreshold, purchaseInTransit, transferInTransit,
      occupiedQuantity, availableQuantity, currentQuantity, averageCost, stockValue,
    };
    return {
      rowNumber: record.rowNumber,
      sourceSku,
      skuKey,
      title: text(record.normalized.TITULO),
      warehouseName,
      warehouseKey,
      shelf: text(record.normalized.ESTANTE),
      lowStockThreshold,
      purchaseInTransit,
      transferInTransit,
      occupiedQuantity,
      availableQuantity,
      currentQuantity,
      averageCost,
      stockValue,
      sourceCreatedAtRaw: text(record.normalized.CRIADO),
      stateHash: stockStateHash(material),
      rowHash: sha256(stableJson(record.raw)),
      rawPayload: record.raw,
    };
  });
  return { rows, blockingIssues, warnings };
}

export async function parseRelationshipWorkbook(buffer: Buffer): Promise<ParsedRows<RelationshipImportRow>> {
  const blockingIssues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const records = readTable(await loadWorkbook(buffer), "relationships");
  const rows = records.flatMap((record) => {
    const sourceSku = text(record.normalized.SKU);
    const storeName = text(record.normalized["NOME DA LOJA"]);
    if (!sourceSku || !storeName) {
      warnings.push({ code: "incomplete_relationship", message: "Relação sem SKU físico ou loja foi preservada apenas no diagnóstico.", row: record.rowNumber });
      return [];
    }
    const mappedListingSku = text(record.normalized["MAPEADO SKU DO ANUNCIO"]);
    const classification = classifyStoreName(storeName);
    if (!mappedListingSku) warnings.push({ code: "blank_mapped_listing_sku", message: "Relação sem SKU mapeado do anúncio.", row: record.rowNumber });
    if (classification.channel === "unknown" || (classification.channel === "mercado_livre" && !classification.accountCode)) {
      warnings.push({ code: "unknown_store", message: `Loja sem alias funcional: ${storeName}.`, row: record.rowNumber });
    }
    return [{
      rowNumber: record.rowNumber,
      sourceSku,
      sourceSkuKey: normalizeSku(sourceSku),
      mappedListingSku,
      mappedListingSkuKey: mappedListingSku ? normalizeSku(mappedListingSku) : null,
      variantLabel: text(record.normalized.VARIANTE),
      listingExternalId: text(record.normalized["ID DO ANUNCIO"]),
      variantExternalId: text(record.normalized["ID DA VARIANTE"]),
      storeName,
      storeNameKey: normalizeKey(storeName),
      channel: classification.channel,
      accountCode: classification.accountCode,
      sourceUpdatedAtRaw: text(record.normalized.ATUALIZADO),
      rowHash: sha256(stableJson(record.raw)),
      rawPayload: record.raw,
    }];
  });
  return { rows, blockingIssues, warnings };
}

export async function parseProductWorkbook(buffer: Buffer): Promise<ParsedRows<ProductImportRow>> {
  const blockingIssues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const records = readTable(await loadWorkbook(buffer), "products");
  const seen = new Set<string>();
  const rows = records.flatMap((record) => {
    const sourceSku = text(record.normalized.SKU);
    if (!sourceSku) {
      warnings.push({ code: "blank_product_sku", message: "Produto sem SKU ignorado.", row: record.rowNumber });
      return [];
    }
    const skuKey = normalizeSku(sourceSku);
    if (seen.has(skuKey)) blockingIssues.push({ code: "duplicate_product_row", message: `SKU de produto duplicado: ${sourceSku}.`, row: record.rowNumber });
    seen.add(skuKey);
    const variantDimensions: { name: string; value: string }[] = [];
    for (let index = 1; index <= 5; index += 1) {
      const name = text(record.normalized[`VARIANTES${index}`]);
      const value = text(record.normalized[`VARIANTE${index}`]);
      if (name || value) variantDimensions.push({ name: name ?? `Variante ${index}`, value: value ?? "" });
    }
    const categoryBrand = text(record.normalized.CATEGORIAS);
    const row = {
      rowNumber: record.rowNumber,
      sourceSku,
      skuKey,
      spu: text(record.normalized.SPU),
      productCode: text(record.normalized["CODIGO DO PRODUTO"]),
      title: text(record.normalized.TITULO),
      productAlias: text(record.normalized["APELIDO DO PRODUTO"]),
      invoiceAliasEnabled: parseBoolean(record.normalized["USAR O APELIDO DO PRODUTO NA NF E"]),
      category: categoryBrand,
      variantDimensions,
      launchDateRaw: text(record.normalized["DATA DE LANCAMENTO"]),
      isActive: parseBoolean(record.normalized["O PRODUTO ESTA ATIVO"]),
      seller: text(record.normalized.VENDEDOR),
      retailPrice: parseDecimal(record.normalized["PRECO DE VAREJO"]),
      purchaseCost: parseDecimal(record.normalized["CUSTO DE COMPRA"]),
      description: text(record.normalized["DESCRICAO DO ANUNCIO"]),
      brand: categoryBrand,
      barcodes: splitValues(record.normalized["CODIGO DE BARRAS"]),
      skuAlias: text(record.normalized["APELIDO DE SKU"]),
      images: splitValues(record.normalized.IMAGEM),
      weightG: parseDecimal(record.normalized["PESO G"]),
      lengthCm: parseDecimal(record.normalized["COMPRIMENTO CM"]),
      widthCm: parseDecimal(record.normalized["LARGURA CM"]),
      heightCm: parseDecimal(record.normalized["ALTURA CM"]),
      ncm: text(record.normalized.NCM),
      cest: text(record.normalized.CEST),
      unit: text(record.normalized.UNIDADE),
      origin: text(record.normalized.ORIGEM),
      supplierUrl: text(record.normalized["LINK DO FORNECEDOR"]),
      rowHash: sha256(stableJson(record.raw)),
      rawPayload: record.raw,
    } satisfies ProductImportRow;
    return [row];
  });
  return { rows, blockingIssues, warnings };
}

export async function parseKitWorkbook(buffer: Buffer): Promise<ParsedRows<KitImportRow>> {
  const blockingIssues: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const records = readTable(await loadWorkbook(buffer), "kits");
  const identities = new Set<string>();
  const rows = records.flatMap((record) => {
    const kitSku = text(record.normalized["KIT SKU"]);
    const componentSku = text(record.normalized["SKU DE PRODUTO"]);
    const quantity = parseDecimal(record.normalized["QTD SKU DE PRODUTO"]);
    if (!kitSku || !componentSku) {
      blockingIssues.push({ code: "invalid_kit_component", message: "KIT SKU e SKU de Produto são obrigatórios.", row: record.rowNumber });
      return [];
    }
    if (quantity === null || !Number.isInteger(quantity) || quantity <= 0) {
      blockingIssues.push({ code: "invalid_kit_quantity", message: "Quantidade de componente do kit deve ser inteira e maior que zero.", row: record.rowNumber });
    }
    const kitSkuKey = normalizeSku(kitSku);
    const componentSkuKey = normalizeSku(componentSku);
    const identity = `${kitSkuKey}\u0000${componentSkuKey}`;
    if (identities.has(identity)) blockingIssues.push({ code: "duplicate_kit_component", message: "Componente duplicado no mesmo kit.", row: record.rowNumber });
    identities.add(identity);
    return [{
      rowNumber: record.rowNumber,
      kitSku,
      kitSkuKey,
      title: text(record.normalized.TITULO),
      alias: text(record.normalized["APELIDO DO PRODUTO"]),
      invoiceAliasEnabled: parseBoolean(record.normalized["USAR O APELIDO DO PRODUTO NA NF E"]),
      category: text(record.normalized.CATEGORIAS),
      isActive: parseBoolean(record.normalized["O PRODUTO ESTA ATIVO"]),
      imageUrl: text(record.normalized.IMAGEM),
      componentSku,
      componentSkuKey,
      requiredQuantity: quantity && quantity > 0 ? Math.floor(quantity) : 1,
      definitionSource: "upseller_export" as const,
      rowHash: sha256(stableJson(record.raw)),
      rawPayload: record.raw,
    }];
  });

  const kitKeys = new Set(rows.map((row) => row.kitSkuKey));
  for (const row of rows) {
    if (kitKeys.has(row.componentSkuKey)) {
      blockingIssues.push({
        code: "nested_kit_unsupported",
        message: `Kit aninhado não suportado: ${row.kitSku} usa ${row.componentSku}.`,
        row: row.rowNumber,
      });
    }
  }
  return { rows, blockingIssues, warnings };
}

export function deriveDottedKitDefinition(
  sourceSku: string,
  availableSkuKeys: ReadonlySet<string>,
): { definition: DerivedKitDefinition | null; unresolved: UnresolvedDottedKit | null } {
  const sourceSkuKey = normalizeSku(sourceSku);
  if (!sourceSku.includes(".")) return { definition: null, unresolved: null };

  const rawSegments = sourceSku.split(".");
  const segments = rawSegments.map((segment) => segment.trim()).filter(Boolean);
  if (rawSegments.some((segment) => !segment.trim()) || segments.length < 2) {
    return {
      definition: null,
      unresolved: { sourceSku, sourceSkuKey, missingComponentSkuKeys: [], reason: "invalid_dot_pattern" },
    };
  }

  const componentByKey = new Map<string, { componentSku: string; componentSkuKey: string; requiredQuantity: number }>();
  for (const segment of segments) {
    const componentSkuKey = normalizeSku(segment);
    const current = componentByKey.get(componentSkuKey);
    if (current) current.requiredQuantity += 1;
    else componentByKey.set(componentSkuKey, { componentSku: segment, componentSkuKey, requiredQuantity: 1 });
  }
  const missingComponentSkuKeys = [...componentByKey.keys()].filter((skuKey) => !availableSkuKeys.has(skuKey));
  if (missingComponentSkuKeys.length > 0) {
    return {
      definition: null,
      unresolved: { sourceSku, sourceSkuKey, missingComponentSkuKeys, reason: "components_missing" },
    };
  }

  return {
    definition: { kitSku: sourceSku, kitSkuKey: sourceSkuKey, components: [...componentByKey.values()] },
    unresolved: null,
  };
}

export function deriveDottedKitDefinitions(input: {
  products: ProductImportRow[];
  stock: StockImportRow[];
  explicitKits: KitImportRow[];
}) {
  const explicitKitKeys = new Set(input.explicitKits.map((row) => row.kitSkuKey));
  const availableSkuKeys = new Set([
    ...input.products.map((row) => row.skuKey),
    ...input.stock.map((row) => row.skuKey),
  ]);
  const definitions: DerivedKitDefinition[] = [];
  const unresolved: UnresolvedDottedKit[] = [];
  for (const product of input.products) {
    if (explicitKitKeys.has(product.skuKey)) continue;
    const result = deriveDottedKitDefinition(product.sourceSku, availableSkuKeys);
    if (result.definition) definitions.push(result.definition);
    if (result.unresolved) unresolved.push(result.unresolved);
  }
  return { definitions, unresolved };
}

function safeZipEntry(name: string) {
  const normalized = name.replace(/\\/g, "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:/.test(normalized) && !normalized.split("/").includes("..");
}

export async function parseWarehouseZip(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error("UPS_ZIP_TOO_MANY_ENTRIES");
  let uncompressedBytes = 0;
  let productResult: ParsedRows<ProductImportRow> | null = null;
  let kitResult: ParsedRows<KitImportRow> | null = null;
  for (const entry of entries) {
    if (!safeZipEntry(entry.name)) throw new Error("UPS_ZIP_PATH_TRAVERSAL");
    if (!entry.name.toLowerCase().endsWith(".xlsx")) throw new Error("UPS_ZIP_UNSUPPORTED_ENTRY");
    const content = await entry.async("nodebuffer");
    uncompressedBytes += content.byteLength;
    if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) throw new Error("UPS_ZIP_UNCOMPRESSED_TOO_LARGE");
    const workbook = await loadWorkbook(content);
    if (findSheet(workbook, "products")) {
      if (productResult) throw new Error("UPS_ZIP_DUPLICATE_PRODUCT_WORKBOOK");
      productResult = await parseProductWorkbook(content);
    } else if (findSheet(workbook, "kits")) {
      if (kitResult) throw new Error("UPS_ZIP_DUPLICATE_KIT_WORKBOOK");
      kitResult = await parseKitWorkbook(content);
    }
  }
  if (!productResult || !kitResult) throw new Error("UPS_ZIP_REQUIRED_WORKBOOKS_MISSING");
  return { products: productResult, kits: kitResult };
}

export async function parseUpsellerPackage(input: {
  stock: Buffer;
  relationships: Buffer;
  products: Buffer;
  kits: Buffer;
}) {
  const [stock, relationships, products, kits] = await Promise.all([
    parseStockWorkbook(input.stock),
    parseRelationshipWorkbook(input.relationships),
    parseProductWorkbook(input.products),
    parseKitWorkbook(input.kits),
  ]);
  const blockingIssues = [
    ...stock.blockingIssues,
    ...relationships.blockingIssues,
    ...products.blockingIssues,
    ...kits.blockingIssues,
  ];
  const warnings = [
    ...stock.warnings,
    ...relationships.warnings,
    ...products.warnings,
    ...kits.warnings,
  ];
  const stockSkuKeys = new Set(stock.rows.map((row) => row.skuKey));
  const missingKitComponents = [...new Set(
    kits.rows
      .filter((row) => !stockSkuKeys.has(row.componentSkuKey))
      .map((row) => row.componentSku),
  )];
  for (const component of missingKitComponents) {
    warnings.push({ code: "kit_component_stock_unknown", message: `Componente sem linha de estoque: ${component}.` });
  }
  const unknownStores = [...new Set(
    relationships.rows
      .filter((row) => row.channel === "unknown" || (row.channel === "mercado_livre" && !row.accountCode))
      .map((row) => row.storeName),
  )].sort();
  const dottedKits = deriveDottedKitDefinitions({
    products: products.rows,
    stock: stock.rows,
    explicitKits: kits.rows,
  });
  for (const unresolved of dottedKits.unresolved) {
    warnings.push({
      code: "KIT_DOTTED_COMPONENTS_UNRESOLVED",
      message: `Kit por ponto não resolvido: ${unresolved.sourceSku}.`,
      details: {
        sourceSku: unresolved.sourceSku,
        missingComponentSkuKeys: unresolved.missingComponentSkuKeys,
        reason: unresolved.reason,
      },
    });
  }
  const summary = {
    stockRows: stock.rows.length,
    stockUniqueSkus: new Set(stock.rows.map((row) => row.skuKey)).size,
    warehouses: [...new Set(stock.rows.map((row) => row.warehouseName))].sort(),
    productRows: products.rows.length,
    productUniqueSkus: new Set(products.rows.map((row) => row.skuKey)).size,
    relationshipRows: relationships.rows.length,
    relationshipUniqueSkus: new Set(relationships.rows.map((row) => row.sourceSkuKey)).size,
    relationshipStoreNames: [...new Set(relationships.rows.map((row) => row.storeName))].sort(),
    unknownStores,
    blankRelationships: relationships.rows.filter((row) => !row.mappedListingSku).length,
    aliasRelationshipRows: relationships.rows.filter(
      (row) => row.mappedListingSkuKey && row.mappedListingSkuKey !== row.sourceSkuKey,
    ).length,
    kitRows: kits.rows.length,
    kitCount: new Set(kits.rows.map((row) => row.kitSkuKey)).size,
    kitComponentCount: kits.rows.length,
    kitMissingStockComponents: missingKitComponents,
    derivedKitCount: dottedKits.definitions.length,
    unresolvedDottedKitCount: dottedKits.unresolved.length,
    blockingIssues,
    warnings,
  };
  return { stock, relationships, products, kits, dottedKits, summary };
}
