import type { Evidence } from "@/features/product-diagnostics/product-diagnostic-domain";

/** Raw price_to_win facts for one of our listings — GET /items/{ITEM_ID}/price_to_win?version=v2. */
export type PriceToWinRaw = {
  itemId: string;
  accountCode: string;
  currentPrice: number | null;
  currencyId: string | null;
  priceToWin: number | null;
  status: "winning" | "sharing_first_place" | "competing" | "listed" | "unknown";
  catalogProductId: string | null;
  winnerPrice: number | null;
  boosts: string[];
  visitShare: number | null;
  competitorsSharingFirstPlace: number | null;
  reason: string | null;
  fetchedAt: string;
};

/** One competing offer for the same catalog product — GET /products/{PRODUCT_ID}/items, our own seller_ids excluded. */
export type CatalogCompetitorOffer = {
  itemId: string;
  sellerId: string;
  price: number;
};

/** GET /suggestions/items/{ITEM_ID}/details */
export type PriceSuggestionRaw = {
  itemId: string;
  accountCode: string;
  status: string;
  currentPriceAmount: number | null;
  suggestedPriceAmount: number | null;
  lowestPriceAmount: number | null;
  internalPriceAmount: number | null;
  percentDifference: number | null;
  applicableSuggestion: boolean;
  sellingFees: number | null;
  shippingFees: number | null;
  lastUpdated: string | null;
  fetchedAt: string;
};

/** GET /item/{ITEM_ID}/performance */
export type ItemPerformanceRaw = {
  itemId: string;
  accountCode: string;
  score: number | null;
  level: string | null;
  levelWording: string | null;
  pendingBuckets: string[];
  fetchedAt: string;
};

export type ExternalMarketResult = {
  title: string;
  url: string;
  domain: string;
  priceObserved: number | null;
  currencyObserved: string | null;
  matchConfidence: "exact" | "probable" | "weak";
  fetchedAt: string;
};

export type CompetitorStats = {
  competitorCount: number;
  lowestCompetitorPrice: number | null;
  highestCompetitorPrice: number | null;
  medianCompetitorPrice: number | null;
  ourLowestPrice: number | null;
  gapToLowest: number | null;
  gapPercentToLowest: number | null;
  ourPositionByPrice: number | null;
};

/** GET /products/{PRODUCT_ID}/items returns every seller including us — our own 4 accounts must never count as "competitors." Generic so callers with a richer offer shape (e.g. including a thumbnail) keep their extra fields after filtering. */
export function filterOutOwnSellers<T extends { sellerId: string }>(offers: T[], ownSellerIds: string[]): T[] {
  const excluded = new Set(ownSellerIds);
  return offers.filter((offer) => !excluded.has(offer.sellerId));
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function median(sorted: number[]) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : round2((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Claude never computes these — deterministic, server-side, from catalog competitor offers plus our own lowest listed price. */
export function computeCompetitorStats(ourLowestPrice: number | null, competitorPrices: number[]): CompetitorStats {
  const sorted = [...competitorPrices].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return {
      competitorCount: 0,
      lowestCompetitorPrice: null,
      highestCompetitorPrice: null,
      medianCompetitorPrice: null,
      ourLowestPrice,
      gapToLowest: null,
      gapPercentToLowest: null,
      ourPositionByPrice: null,
    };
  }
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];
  const gapToLowest = ourLowestPrice !== null ? round2(ourLowestPrice - lowest) : null;
  const gapPercentToLowest = ourLowestPrice !== null && lowest > 0 ? round2((gapToLowest! / lowest) * 100) : null;
  const ourPositionByPrice = ourLowestPrice !== null ? sorted.filter((price) => price < ourLowestPrice).length + 1 : null;
  return {
    competitorCount: sorted.length,
    lowestCompetitorPrice: lowest,
    highestCompetitorPrice: highest,
    medianCompetitorPrice: median(sorted),
    ourLowestPrice,
    gapToLowest,
    gapPercentToLowest,
    ourPositionByPrice,
  };
}

/** null when any cost input is missing — never invent a margin. Explicitly "known contribution before taxes/other unmodeled costs." */
export function computeKnownContribution(params: {
  suggestedPrice: number | null;
  averageCost: number | null;
  sellingFees: number | null;
  shippingFees: number | null;
}): number | null {
  const { suggestedPrice, averageCost, sellingFees, shippingFees } = params;
  if (suggestedPrice === null || averageCost === null || sellingFees === null || shippingFees === null) return null;
  return round2(suggestedPrice - averageCost - sellingFees - shippingFees);
}

const VALID_COMPETITION_STATUSES = new Set(["winning", "sharing_first_place", "competing", "listed", "unknown"]);

/** Never invent a status the API didn't return. */
export function normalizeCompetitionStatus(rawStatus: string | null | undefined): "winning" | "sharing_first_place" | "competing" | "listed" | "unknown" {
  if (rawStatus && VALID_COMPETITION_STATUSES.has(rawStatus)) return rawStatus as ReturnType<typeof normalizeCompetitionStatus>;
  return "unknown";
}

class MarketEvidenceCollector {
  private readonly items: Evidence[] = [];
  private readonly usedIds = new Set<string>();

  push(item: Omit<Evidence, "id"> & { id: string }) {
    let id = item.id;
    let suffix = 2;
    while (this.usedIds.has(id)) {
      id = `${item.id}#${suffix}`;
      suffix += 1;
    }
    this.usedIds.add(id);
    this.items.push({ ...item, id });
  }

  all() {
    return this.items;
  }
}

const currencyFormatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Builds market.* evidence from the official ML APIs (Parte B/C) plus the
 * deterministic competitor stats above. Does NOT decide what action to
 * take — that's Claude's job, constrained to these facts.
 */
export function buildOfficialMarketEvidence(params: {
  priceToWin: PriceToWinRaw[];
  competitorStatsByCatalogProduct: Map<string, CompetitorStats>;
  priceSuggestions: PriceSuggestionRaw[];
  performance: ItemPerformanceRaw[];
  knownContributionByItemId: Map<string, number | null>;
}): Evidence[] {
  const collector = new MarketEvidenceCollector();

  for (const entry of params.priceToWin) {
    const status = normalizeCompetitionStatus(entry.status);
    collector.push({
      id: `market.${entry.accountCode}.${entry.itemId}.competition_status`,
      category: "price",
      label: `Status de competicao - ${entry.itemId} (${entry.accountCode})`,
      value: status,
      displayText: `Status de competicao na conta ${entry.accountCode} (${entry.itemId}): ${status}`,
      occurredAt: entry.fetchedAt,
      source: "ml_price_to_win",
    });
    collector.push({
      id: `market.${entry.accountCode}.${entry.itemId}.price_to_win`,
      category: "price",
      label: `Price to win - ${entry.itemId} (${entry.accountCode})`,
      value: entry.priceToWin,
      displayText: entry.priceToWin !== null ? `Price to win (${entry.accountCode}, ${entry.itemId}): ${currencyFormatter.format(entry.priceToWin)}` : `Price to win indisponivel (${entry.accountCode}, ${entry.itemId})`,
      occurredAt: entry.fetchedAt,
      source: "ml_price_to_win",
    });
    if (entry.boosts.length > 0) {
      collector.push({
        id: `market.${entry.accountCode}.${entry.itemId}.boost_opportunities`,
        category: "price",
        label: `Oportunidades de boost - ${entry.itemId} (${entry.accountCode})`,
        value: entry.boosts,
        displayText: `Oportunidades de melhoria nao relacionadas a preco (${entry.accountCode}, ${entry.itemId}): ${entry.boosts.join(", ")}`,
        occurredAt: entry.fetchedAt,
        source: "ml_price_to_win",
      });
    }
  }

  for (const [catalogProductId, stats] of params.competitorStatsByCatalogProduct) {
    collector.push({
      id: `market.catalog.${catalogProductId}.competitor_count`,
      category: "price",
      label: `Concorrentes no catalogo ${catalogProductId}`,
      value: stats.competitorCount,
      displayText: `${stats.competitorCount} concorrente(s) no mesmo produto de catalogo`,
      occurredAt: null,
      source: "ml_catalog_items",
    });
    if (stats.lowestCompetitorPrice !== null) {
      collector.push({
        id: `market.catalog.${catalogProductId}.lowest_competitor_price`,
        category: "price",
        label: `Menor preco concorrente - catalogo ${catalogProductId}`,
        value: stats.lowestCompetitorPrice,
        displayText: `Menor preco concorrente: ${currencyFormatter.format(stats.lowestCompetitorPrice)} (nosso menor: ${stats.ourLowestPrice !== null ? currencyFormatter.format(stats.ourLowestPrice) : "?"}, gap ${stats.gapPercentToLowest ?? "?"}%)`,
        occurredAt: null,
        source: "ml_catalog_items",
      });
    }
  }

  for (const suggestion of params.priceSuggestions) {
    if (suggestion.applicableSuggestion && suggestion.suggestedPriceAmount !== null) {
      collector.push({
        id: `market.${suggestion.accountCode}.${suggestion.itemId}.suggested_price`,
        category: "price",
        label: `Preco sugerido oficial - ${suggestion.itemId} (${suggestion.accountCode})`,
        value: suggestion.suggestedPriceAmount,
        displayText: `Referencia oficial de preco (${suggestion.accountCode}, ${suggestion.itemId}): ${currencyFormatter.format(suggestion.suggestedPriceAmount)}${suggestion.percentDifference !== null ? ` (nosso preco ${suggestion.percentDifference >= 0 ? "+" : ""}${suggestion.percentDifference}% vs. referencia)` : ""}`,
        occurredAt: suggestion.fetchedAt,
        source: "ml_price_suggestions",
      });
    }
    const contribution = params.knownContributionByItemId.get(suggestion.itemId) ?? null;
    collector.push({
      id: `market.${suggestion.accountCode}.${suggestion.itemId}.known_contribution_at_suggested_price`,
      category: "price",
      label: `Margem conhecida ao preco sugerido - ${suggestion.itemId}`,
      value: contribution,
      displayText: contribution !== null
        ? `Margem conhecida (antes de impostos e outros custos nao modelados) ao preco sugerido: ${currencyFormatter.format(contribution)}`
        : "Margem conhecida indisponivel (custo ou taxas nao mapeados)",
      occurredAt: suggestion.fetchedAt,
      source: "ml_price_suggestions",
    });
  }

  for (const performance of params.performance) {
    collector.push({
      id: `market.${performance.accountCode}.${performance.itemId}.performance_score`,
      category: "listing",
      label: `Performance do anuncio - ${performance.itemId} (${performance.accountCode})`,
      value: performance.score,
      displayText: `Performance (${performance.accountCode}, ${performance.itemId}): ${performance.levelWording ?? performance.level ?? "indisponivel"}${performance.score !== null ? ` (score ${performance.score})` : ""}`,
      occurredAt: performance.fetchedAt,
      source: "ml_item_performance",
    });
    for (const bucket of performance.pendingBuckets) {
      collector.push({
        id: `market.${performance.accountCode}.${performance.itemId}.performance.${bucket.toLowerCase()}`,
        category: "listing",
        label: `Pendencia de performance: ${bucket}`,
        value: bucket,
        displayText: `Pendencia de qualidade do anuncio (${performance.accountCode}, ${performance.itemId}): ${bucket}`,
        occurredAt: performance.fetchedAt,
        source: "ml_item_performance",
      });
    }
  }

  return collector.all();
}

/** Only exact/probable results may influence the diagnosis — weak ones only ever surface as limitations/context (enforced by the prompt, not filtered here, so the evidence stays fully auditable). */
export function buildExternalMarketEvidence(results: ExternalMarketResult[]): Evidence[] {
  const collector = new MarketEvidenceCollector();
  results.forEach((result, index) => {
    collector.push({
      id: `external.market.result.${index + 1}`,
      category: "price",
      label: `Resultado externo ${index + 1} (${result.matchConfidence})`,
      value: { title: result.title, url: result.url, priceObserved: result.priceObserved, matchConfidence: result.matchConfidence },
      displayText: `[${result.matchConfidence}] ${result.title} (${result.domain})${result.priceObserved !== null ? ` — ${currencyFormatter.format(result.priceObserved)}` : ""}`,
      occurredAt: result.fetchedAt,
      source: "web_search",
    });
  });
  return collector.all();
}
