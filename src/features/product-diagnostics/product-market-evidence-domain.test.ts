import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildOfficialMarketEvidence,
  computeCompetitorStats,
  computeKnownContribution,
  filterOutOwnSellers,
  normalizeCompetitionStatus,
} from "./product-market-evidence-domain";

// 8. lista competitors exclui nossos próprios seller IDs
test("filterOutOwnSellers removes our own 4 accounts' seller ids from the competitor list", () => {
  const offers = [
    { itemId: "MLB1", sellerId: "our-speedbikers", price: 100 },
    { itemId: "MLB2", sellerId: "competitor-a", price: 90 },
    { itemId: "MLB3", sellerId: "our-gmr", price: 95 },
  ];
  const filtered = filterOutOwnSellers(offers, ["our-speedbikers", "our-gmr", "our-sb", "our-offracer"]);
  assert.deepEqual(filtered, [{ itemId: "MLB2", sellerId: "competitor-a", price: 90 }]);
});

// 9. median/min/max corretos
test("computeCompetitorStats returns correct min/max/median and position", () => {
  const stats = computeCompetitorStats(110, [100, 90, 120]);
  assert.equal(stats.competitorCount, 3);
  assert.equal(stats.lowestCompetitorPrice, 90);
  assert.equal(stats.highestCompetitorPrice, 120);
  assert.equal(stats.medianCompetitorPrice, 100);
  assert.equal(stats.gapToLowest, 20);
  assert.equal(stats.gapPercentToLowest, 22.22);
  assert.equal(stats.ourPositionByPrice, 3); // 90 and 100 are both cheaper than 110
});

test("computeCompetitorStats handles no competitors without dividing by zero", () => {
  const stats = computeCompetitorStats(110, []);
  assert.equal(stats.competitorCount, 0);
  assert.equal(stats.lowestCompetitorPrice, null);
  assert.equal(stats.gapPercentToLowest, null);
});

test("computeCompetitorStats computes an even-length median as the average of the two middle values", () => {
  const stats = computeCompetitorStats(null, [100, 200]);
  assert.equal(stats.medianCompetitorPrice, 150);
});

// never invent a competition status
test("normalizeCompetitionStatus never invents a status the API didn't return", () => {
  assert.equal(normalizeCompetitionStatus("winning"), "winning");
  assert.equal(normalizeCompetitionStatus("something_new_and_unexpected"), "unknown");
  assert.equal(normalizeCompetitionStatus(null), "unknown");
});

// 13. contribution estimate com custo conhecido
test("computeKnownContribution subtracts cost and fees from the suggested price", () => {
  const contribution = computeKnownContribution({ suggestedPrice: 100, averageCost: 40, sellingFees: 15, shippingFees: 10 });
  assert.equal(contribution, 35);
});

// 14. custo ausente => contribution null
test("computeKnownContribution returns null when any cost input is missing, never a guessed margin", () => {
  assert.equal(computeKnownContribution({ suggestedPrice: 100, averageCost: null, sellingFees: 15, shippingFees: 10 }), null);
  assert.equal(computeKnownContribution({ suggestedPrice: 100, averageCost: 40, sellingFees: null, shippingFees: 10 }), null);
});

// 5. catalog item competing + price_to_win => price evidence
// 10. price reference suggested/lowest => evidence
test("official market facts (price_to_win, catalog competitors, price suggestions) become price evidence", () => {
  const evidence = buildOfficialMarketEvidence({
    priceToWin: [{
      itemId: "MLB123", accountCode: "gmr", currentPrice: 119.9, currencyId: "BRL", priceToWin: 106.9,
      status: "competing", catalogProductId: "CATALOG1", winnerPrice: 104.9, boosts: [], visitShare: null,
      competitorsSharingFirstPlace: null, reason: null, fetchedAt: "2026-08-19T10:00:00Z",
    }],
    competitorStatsByCatalogProduct: new Map([["CATALOG1", computeCompetitorStats(119.9, [104.9, 110])]]),
    priceSuggestions: [{
      itemId: "MLB123", accountCode: "gmr", status: "applicable", currentPriceAmount: 119.9, suggestedPriceAmount: 106.9,
      lowestPriceAmount: 104.9, internalPriceAmount: null, percentDifference: 12.2, applicableSuggestion: true,
      sellingFees: 15, shippingFees: 10, lastUpdated: "2026-08-19T10:00:00Z", fetchedAt: "2026-08-19T10:00:00Z",
    }],
    performance: [],
    knownContributionByItemId: new Map([["MLB123", computeKnownContribution({ suggestedPrice: 106.9, averageCost: 40, sellingFees: 15, shippingFees: 10 })]]),
  });

  const statusEvidence = evidence.find((item) => item.id === "market.gmr.MLB123.competition_status");
  assert.ok(statusEvidence);
  assert.equal(statusEvidence!.value, "competing");

  const priceToWinEvidence = evidence.find((item) => item.id === "market.gmr.MLB123.price_to_win");
  assert.ok(priceToWinEvidence);
  assert.equal(priceToWinEvidence!.value, 106.9);

  const catalogEvidence = evidence.find((item) => item.id === "market.catalog.CATALOG1.lowest_competitor_price");
  assert.ok(catalogEvidence);
  assert.equal(catalogEvidence!.value, 104.9);

  const suggestionEvidence = evidence.find((item) => item.id === "market.gmr.MLB123.suggested_price");
  assert.ok(suggestionEvidence);
  assert.equal(suggestionEvidence!.value, 106.9);

  const contributionEvidence = evidence.find((item) => item.id === "market.gmr.MLB123.known_contribution_at_suggested_price");
  assert.ok(contributionEvidence);
  assert.equal(contributionEvidence!.value, 41.9);
});

// 8 (hotfix). priceToWin null (listing fora de competicao de catalogo) nunca vira "R$0,00" falso na evidence
test("a null priceToWin (no real price context) never renders as a fabricated R$0,00 in evidence", () => {
  const evidence = buildOfficialMarketEvidence({
    priceToWin: [{
      itemId: "MLB1", accountCode: "gmr", currentPrice: null, currencyId: null, priceToWin: null,
      status: "unknown", catalogProductId: null, winnerPrice: null, boosts: [], visitShare: null,
      competitorsSharingFirstPlace: null, reason: null, fetchedAt: "2026-08-20T10:00:00Z",
    }],
    competitorStatsByCatalogProduct: new Map(),
    priceSuggestions: [],
    performance: [],
    knownContributionByItemId: new Map(),
  });
  const priceToWinEvidence = evidence.find((item) => item.id === "market.gmr.MLB1.price_to_win");
  assert.ok(priceToWinEvidence);
  assert.equal(priceToWinEvidence!.value, null);
  assert.doesNotMatch(priceToWinEvidence!.displayText, /R\$\s?0[,.]00/);
  assert.match(priceToWinEvidence!.displayText, /indisponivel/i);
});

// 15. performance picture pending => pode recomendar imagem (a evidência existe para Claude agir)
test("a pending 'picture' performance bucket becomes its own evidence item", () => {
  const evidence = buildOfficialMarketEvidence({
    priceToWin: [],
    competitorStatsByCatalogProduct: new Map(),
    priceSuggestions: [],
    performance: [{ itemId: "MLB1", accountCode: "gmr", score: 60, level: "yellow", levelWording: "Regular", pendingBuckets: ["picture"], fetchedAt: "2026-08-19T10:00:00Z" }],
    knownContributionByItemId: new Map(),
  });
  assert.ok(evidence.some((item) => item.id === "market.gmr.MLB1.performance.picture"));
});

// 16. performance saudável => não força troca de imagem (nenhuma pendência = nenhuma evidência de pendência)
test("a healthy performance (no pending buckets) never fabricates a pending-image evidence item", () => {
  const evidence = buildOfficialMarketEvidence({
    priceToWin: [],
    competitorStatsByCatalogProduct: new Map(),
    priceSuggestions: [],
    performance: [{ itemId: "MLB1", accountCode: "gmr", score: 95, level: "green", levelWording: "Otimo", pendingBuckets: [], fetchedAt: "2026-08-19T10:00:00Z" }],
    knownContributionByItemId: new Map(),
  });
  assert.equal(evidence.some((item) => item.id.includes(".performance.")), false);
});

// 7 (data side): mesmo preço, oportunidade de boost por fulfillment é registrada como evidência distinta do preço
test("a fulfillment boost opportunity is recorded as its own evidence, separate from price_to_win", () => {
  const evidence = buildOfficialMarketEvidence({
    priceToWin: [{
      itemId: "MLB999", accountCode: "sb", currentPrice: 99.9, currencyId: "BRL", priceToWin: 99.9,
      status: "competing", catalogProductId: null, winnerPrice: 99.9, boosts: ["fulfillment"], visitShare: null,
      competitorsSharingFirstPlace: null, reason: null, fetchedAt: "2026-08-19T10:00:00Z",
    }],
    competitorStatsByCatalogProduct: new Map(),
    priceSuggestions: [],
    performance: [],
    knownContributionByItemId: new Map(),
  });
  const boostEvidence = evidence.find((item) => item.id === "market.sb.MLB999.boost_opportunities");
  assert.ok(boostEvidence);
  assert.deepEqual(boostEvidence!.value, ["fulfillment"]);
});
