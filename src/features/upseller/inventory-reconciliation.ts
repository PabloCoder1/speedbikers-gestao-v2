export type InventoryLinkMethod =
  | "exact_sku"
  | "mapped_listing_sku_relationship"
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

export type MappedSkuRelationship = {
  sourceSku: string;
  sourceSkuKey: string;
  sourceKind: InventorySourceKind;
  mappedListingSkuKey: string | null;
  mlAccountId: string | null;
  channel: string;
  isCurrent: boolean;
};

export type SellerSkuTarget = {
  sellerSku: string | null;
  mlAccountId: string;
  isCurrent: boolean;
  targetId: string;
};

export type InventorySourceSuggestion = {
  candidateSourceSku: string;
  candidateTitle: string | null;
  similarity: null;
  reason: "normalized_sku_candidate";
  ambiguous: boolean;
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

export function normalizeDeterministicSku(value: string | null) {
  return value?.trim().toUpperCase() ?? "";
}

export function buildMappedSkuCandidates({
  productSkuKey,
  listings,
  variations,
  relationships,
}: {
  productSkuKey: string;
  listings: SellerSkuTarget[];
  variations: SellerSkuTarget[];
  relationships: MappedSkuRelationship[];
}) {
  const candidates: InventoryLinkCandidate[] = [];
  const normalizedProductSku = normalizeDeterministicSku(productSkuKey);

  for (const relationship of relationships) {
    const mappedSkuKey = normalizeDeterministicSku(relationship.mappedListingSkuKey);
    if (!relationship.isCurrent || relationship.channel !== "mercado_livre" || !mappedSkuKey) continue;

    const evidenceKeys: string[] = [];
    if (normalizedProductSku === mappedSkuKey) evidenceKeys.push("product_sku");

    for (const listing of listings) {
      if (listing.isCurrent
        && listing.mlAccountId === relationship.mlAccountId
        && normalizeDeterministicSku(listing.sellerSku) === mappedSkuKey) {
        evidenceKeys.push(`listing_seller_sku:${listing.targetId}`);
      }
    }

    for (const variation of variations) {
      if (variation.isCurrent
        && variation.mlAccountId === relationship.mlAccountId
        && normalizeDeterministicSku(variation.sellerSku) === mappedSkuKey) {
        evidenceKeys.push(`variation_seller_sku:${variation.targetId}`);
      }
    }

    for (const evidenceKey of evidenceKeys) {
      candidates.push({
        sourceSku: relationship.sourceSku,
        sourceSkuKey: relationship.sourceSkuKey,
        sourceKind: relationship.sourceKind,
        linkMethod: "mapped_listing_sku_relationship",
        priority: 2,
        evidenceKey,
      });
    }
  }

  return candidates;
}

export function normalizedSuggestionKey(value: string) {
  return normalizeDeterministicSku(value).replace(/[^A-Z0-9]+/g, "");
}

export function buildNormalizedSkuSuggestions({
  productSku,
  sources,
}: {
  productSku: string;
  sources: Array<{ sourceSku: string; title: string | null }>;
}): InventorySourceSuggestion[] {
  const productExactKey = normalizeDeterministicSku(productSku);
  const productSearchKey = normalizedSuggestionKey(productSku);
  const matching = sources
    .filter((source) => normalizeDeterministicSku(source.sourceSku) !== productExactKey)
    .filter((source) => normalizedSuggestionKey(source.sourceSku) === productSearchKey)
    .sort((left, right) => compareText(left.sourceSku, right.sourceSku));
  const distinct = [...new Map(matching.map((source) => [source.sourceSku, source])).values()];

  return distinct.slice(0, 3).map((source) => ({
    candidateSourceSku: source.sourceSku,
    candidateTitle: source.title,
    similarity: null,
    reason: "normalized_sku_candidate",
    ambiguous: distinct.length > 1,
  }));
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
