/** Part G: when external web research is worth the cost/latency. Pure, no I/O. */
export function shouldTriggerExternalMarketResearch(params: {
  hasCatalogProductId: boolean;
  hasPriceReference: boolean;
  internalAndOfficialDataExplainDrop: boolean;
  userRequestedMarketResearch: boolean;
}): boolean {
  if (params.userRequestedMarketResearch) return true;
  if (!params.hasCatalogProductId) return true;
  if (!params.hasPriceReference) return true;
  if (!params.internalAndOfficialDataExplainDrop) return true;
  return false;
}

/** Strong identifiers only — never a bare generic title when better identifiers exist. */
export function buildMarketResearchQuery(params: {
  brand: string | null;
  partNumber: string | null;
  ean: string | null;
  sku: string | null;
  skuCommerciallySignificant: boolean;
  name: string;
  compatibility: string | null;
}): string {
  const parts: string[] = [];
  if (params.brand) parts.push(params.brand);
  if (params.partNumber) parts.push(params.partNumber);
  if (params.ean) parts.push(params.ean);
  if (params.sku && params.skuCommerciallySignificant) parts.push(params.sku);
  parts.push(params.name);
  if (params.compatibility) parts.push(params.compatibility);
  return `${parts.join(" ")} preço mercado livre brasil`;
}
