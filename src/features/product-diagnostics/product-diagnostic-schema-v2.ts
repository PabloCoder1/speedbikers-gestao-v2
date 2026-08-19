/**
 * V2 output contract. V1 (product-diagnostic-schema.ts) is untouched —
 * existing V1 runs keep their shape forever, this is an additive sibling.
 */

export const PRODUCT_DIAGNOSTIC_V2_ACTION_CODES = [
  "ADJUST_PRICE",
  "IMPROVE_TITLE",
  "IMPROVE_MAIN_IMAGE",
  "IMPROVE_GALLERY",
  "REVIEW_PROMOTION",
  "REPLENISH_FULL",
  "IMPROVE_SHIPPING",
  "CHECK_LISTING_STATUS",
  "CHECK_PHYSICAL_STOCK",
  "CHECK_MAPPING",
  "CHECK_PURCHASE_PLAN",
  "MONITOR_PRODUCT",
  "INVESTIGATE_EXTERNAL_MARKET",
  "NO_ACTION",
] as const;

export const PRODUCT_DIAGNOSTIC_V2_VERDICTS = [
  "no_sales",
  "sales_drop",
  "account_specific_drop",
  "operational_blocker",
  "mixed",
  "stable",
  "insufficient_data",
] as const;

export const PRODUCT_DIAGNOSTIC_V2_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

/** Part J's closed causal taxonomy — Claude picks one category, never invents a new one. */
export const PRIMARY_CAUSE_CATEGORIES = [
  "PRICE_NOT_COMPETITIVE",
  "NO_PHYSICAL_STOCK",
  "NO_FULL",
  "ALL_LISTINGS_INACTIVE",
  "ACCOUNT_SPECIFIC_PRICE",
  "PROMOTION_ENDED",
  "LISTING_QUALITY",
  "MARKET_DEMAND_WEAK",
  "MIXED",
  "UNKNOWN",
] as const;

/** not_applicable = no market data was ever fetched (trigger conditions in Part G weren't met) — distinct from "unknown", which means data was fetched but was inconclusive. */
export const MARKET_ASSESSMENT_STATUSES = [
  "winning",
  "sharing_first_place",
  "competing",
  "listed",
  "unknown",
  "not_applicable",
] as const;

export const ACTION_SCOPE_TYPES = ["listing", "product"] as const;

export type ProductDiagnosticV2ActionCode = (typeof PRODUCT_DIAGNOSTIC_V2_ACTION_CODES)[number];
export type ProductDiagnosticV2Verdict = (typeof PRODUCT_DIAGNOSTIC_V2_VERDICTS)[number];
export type ProductDiagnosticV2Confidence = (typeof PRODUCT_DIAGNOSTIC_V2_CONFIDENCE_LEVELS)[number];
export type PrimaryCauseCategory = (typeof PRIMARY_CAUSE_CATEGORIES)[number];
export type MarketAssessmentStatus = (typeof MARKET_ASSESSMENT_STATUSES)[number];

export type ActionScope = { type: "listing"; accountCode: string; itemId: string } | { type: "product" };

export type ProductDiagnosticResultV2 = {
  verdict: ProductDiagnosticV2Verdict;
  context: string;
  primaryCause: {
    category: PrimaryCauseCategory;
    title: string;
    explanation: string;
    confidence: ProductDiagnosticV2Confidence;
    evidenceRefs: string[];
  } | null;
  secondaryHypotheses: Array<{
    title: string;
    explanation: string;
    confidence: ProductDiagnosticV2Confidence;
    evidenceRefs: string[];
    missingEvidence: string[];
  }>;
  marketAssessment: {
    status: MarketAssessmentStatus;
    summary: string;
    evidenceRefs: string[];
  };
  actions: Array<{
    priority: "high" | "medium" | "low";
    actionCode: ProductDiagnosticV2ActionCode;
    scope: ActionScope;
    title: string;
    instruction: string;
    suggestedValue: string | null;
    reason: string;
    evidenceRefs: string[];
  }>;
  limitations: string[];
};

/** Length/count caps from the spec. The JSON Schema hints these; run-product-diagnostic-v2.ts enforces them server-side regardless (never trust the model to self-limit). */
export const PRODUCT_DIAGNOSTIC_V2_LIMITS = {
  contextMaxChars: 400,
  primaryCauseTitleMaxChars: 120,
  primaryCauseExplanationMaxChars: 500,
  secondaryHypothesesMax: 2,
  actionsMax: 4,
  limitationsMax: 3,
  actionReasonMaxChars: 300,
} as const;

const scopeSchema = {
  type: "object",
  additionalProperties: false,
  required: ["type"],
  properties: {
    type: { type: "string", enum: [...ACTION_SCOPE_TYPES] },
    accountCode: { type: "string" },
    itemId: { type: "string" },
  },
} as const;

export const PRODUCT_DIAGNOSTIC_V2_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "context", "primaryCause", "secondaryHypotheses", "marketAssessment", "actions", "limitations"],
  properties: {
    verdict: { type: "string", enum: [...PRODUCT_DIAGNOSTIC_V2_VERDICTS] },
    context: { type: "string", maxLength: PRODUCT_DIAGNOSTIC_V2_LIMITS.contextMaxChars },
    primaryCause: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["category", "title", "explanation", "confidence", "evidenceRefs"],
      properties: {
        category: { type: "string", enum: [...PRIMARY_CAUSE_CATEGORIES] },
        title: { type: "string", maxLength: PRODUCT_DIAGNOSTIC_V2_LIMITS.primaryCauseTitleMaxChars },
        explanation: { type: "string", maxLength: PRODUCT_DIAGNOSTIC_V2_LIMITS.primaryCauseExplanationMaxChars },
        confidence: { type: "string", enum: [...PRODUCT_DIAGNOSTIC_V2_CONFIDENCE_LEVELS] },
        evidenceRefs: { type: "array", items: { type: "string" } },
      },
    },
    secondaryHypotheses: {
      type: "array",
      maxItems: PRODUCT_DIAGNOSTIC_V2_LIMITS.secondaryHypothesesMax,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "explanation", "confidence", "evidenceRefs", "missingEvidence"],
        properties: {
          title: { type: "string" },
          explanation: { type: "string" },
          confidence: { type: "string", enum: [...PRODUCT_DIAGNOSTIC_V2_CONFIDENCE_LEVELS] },
          evidenceRefs: { type: "array", items: { type: "string" } },
          missingEvidence: { type: "array", items: { type: "string" } },
        },
      },
    },
    marketAssessment: {
      type: "object",
      additionalProperties: false,
      required: ["status", "summary", "evidenceRefs"],
      properties: {
        status: { type: "string", enum: [...MARKET_ASSESSMENT_STATUSES] },
        summary: { type: "string" },
        evidenceRefs: { type: "array", items: { type: "string" } },
      },
    },
    actions: {
      type: "array",
      maxItems: PRODUCT_DIAGNOSTIC_V2_LIMITS.actionsMax,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "actionCode", "scope", "title", "instruction", "suggestedValue", "reason", "evidenceRefs"],
        properties: {
          priority: { type: "string", enum: ["high", "medium", "low"] },
          actionCode: { type: "string", enum: [...PRODUCT_DIAGNOSTIC_V2_ACTION_CODES] },
          scope: scopeSchema,
          title: { type: "string" },
          instruction: { type: "string" },
          suggestedValue: { type: ["string", "null"] },
          reason: { type: "string", maxLength: PRODUCT_DIAGNOSTIC_V2_LIMITS.actionReasonMaxChars },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    limitations: { type: "array", maxItems: PRODUCT_DIAGNOSTIC_V2_LIMITS.limitationsMax, items: { type: "string" } },
  },
} as const;
