export type PurchaseOrderExportMode = "WITH_VALUES" | "WITHOUT_VALUES";

/** Documento de fornecedor não carrega custo histórico por padrão. */
export function purchaseOrderExportMode(request: Request): PurchaseOrderExportMode {
  return new URL(request.url).searchParams.get("valores") === "com" ? "WITH_VALUES" : "WITHOUT_VALUES";
}

export function includesPurchaseOrderValues(mode: PurchaseOrderExportMode): boolean {
  return mode === "WITH_VALUES";
}
