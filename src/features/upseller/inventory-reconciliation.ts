export type InventoryLinkMethod =
  | "exact_sku"
  | "ml_item_relationship"
  | "ml_variation_relationship"
  | "ml_user_product_relationship";

export type InventorySourceKind = "simple" | "kit";

export type InventoryLinkCandidate = {
  sourceSku: string;
  sourceSkuKey: string;
  sourceKind: InventorySourceKind;
  linkMethod: InventoryLinkMethod;
  priority: number;
  evidenceKey: string;
};

export type ExactInventorySource = {
  canonicalSku: string;
  canonicalSkuKey: string;
  hasStock: boolean;
  hasCatalog: boolean;
  kitDefinitionSource: "upseller_export" | "derived_dot" | null;
  unresolvedDotted: boolean;
};

export type InventoryReconciliationDecision =
  | { status: "manual"; candidates: [] }
  | { status: "missing"; candidates: [] }
  | { status: "linked"; candidate: InventoryLinkCandidate; candidates: InventoryLinkCandidate[] }
  | { status: "conflict"; sourceSkuKeys: string[]; candidates: InventoryLinkCandidate[] };

function compareText(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareCandidate(left: InventoryLinkCandidate, right: InventoryLinkCandidate) {
  return left.priority - right.priority
    || compareText(left.linkMethod, right.linkMethod)
    || compareText(left.evidenceKey, right.evidenceKey)
    || compareText(left.sourceSku, right.sourceSku);
}

export function buildExactInventoryCandidate(source: ExactInventorySource): InventoryLinkCandidate | null {
  const hasValidatedKit = source.kitDefinitionSource !== null;
  if (!source.hasStock && !source.hasCatalog && !hasValidatedKit) return null;

  return {
    sourceSku: source.canonicalSku,
    sourceSkuKey: source.canonicalSkuKey,
    sourceKind: hasValidatedKit ? "kit" : "simple",
    linkMethod: "exact_sku",
    priority: 1,
    evidenceKey: [
      source.hasStock ? "stock" : "",
      source.hasCatalog ? "catalog" : "",
      source.kitDefinitionSource ?? "",
      source.unresolvedDotted ? "unresolved_dot" : "",
    ].filter(Boolean).join(":"),
  };
}

export function decideInventoryReconciliation({
  manualLinkActive,
  candidates,
}: {
  manualLinkActive: boolean;
  candidates: InventoryLinkCandidate[];
}): InventoryReconciliationDecision {
  if (manualLinkActive) return { status: "manual", candidates: [] };

  const bestBySourceSku = new Map<string, InventoryLinkCandidate>();
  for (const candidate of candidates) {
    const current = bestBySourceSku.get(candidate.sourceSkuKey);
    if (!current || compareCandidate(candidate, current) < 0) {
      bestBySourceSku.set(candidate.sourceSkuKey, candidate);
    }
  }

  const distinctCandidates = [...bestBySourceSku.values()]
    .sort((left, right) => compareText(left.sourceSkuKey, right.sourceSkuKey));

  if (distinctCandidates.length === 0) return { status: "missing", candidates: [] };
  if (distinctCandidates.length > 1) {
    return {
      status: "conflict",
      sourceSkuKeys: distinctCandidates.map((candidate) => candidate.sourceSkuKey),
      candidates: distinctCandidates,
    };
  }

  return {
    status: "linked",
    candidate: distinctCandidates[0]!,
    candidates: distinctCandidates,
  };
}

export function shouldEnqueueInventoryReconciliation({
  operation,
  oldSku,
  newSku,
  oldSkuKey,
  newSkuKey,
}: {
  operation: "insert" | "update";
  oldSku?: string;
  newSku: string;
  oldSkuKey?: string;
  newSkuKey: string;
}) {
  return operation === "insert" || oldSku !== newSku || oldSkuKey !== newSkuKey;
}
