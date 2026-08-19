export const PRODUCT_DIAGNOSTIC_ACTION_CODES = [
  "REVIEW_EFFECTIVE_PRICE",
  "REVIEW_PROMOTION",
  "REPLENISH_FULL",
  "CHECK_PHYSICAL_STOCK",
  "CHECK_LISTING_STATUS",
  "CHECK_MAPPING",
  "CHECK_PURCHASE_PLAN",
  "MONITOR_PRODUCT",
  "INVESTIGATE_EXTERNAL_COMPETITION",
  "NO_ACTION",
] as const;

export const PRODUCT_DIAGNOSTIC_VERDICTS = [
  "no_sales",
  "sales_drop",
  "account_specific_drop",
  "operational_blocker",
  "mixed",
  "stable",
  "insufficient_data",
] as const;

export const PRODUCT_DIAGNOSTIC_CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;

export type ProductDiagnosticActionCode = (typeof PRODUCT_DIAGNOSTIC_ACTION_CODES)[number];
export type ProductDiagnosticVerdict = (typeof PRODUCT_DIAGNOSTIC_VERDICTS)[number];
export type ProductDiagnosticConfidence = (typeof PRODUCT_DIAGNOSTIC_CONFIDENCE_LEVELS)[number];

export type ProductDiagnosticResult = {
  verdict: ProductDiagnosticVerdict;
  executiveSummary: string;
  confidence: ProductDiagnosticConfidence;
  correlations: Array<{ statement: string; evidenceRefs: string[] }>;
  hypotheses: Array<{
    title: string;
    confidence: ProductDiagnosticConfidence;
    explanation: string;
    evidenceRefs: string[];
    counterEvidenceRefs: string[];
    missingEvidence: string[];
  }>;
  recommendedActions: Array<{
    priority: "high" | "medium" | "low";
    actionCode: ProductDiagnosticActionCode;
    title: string;
    reason: string;
    evidenceRefs: string[];
  }>;
  limitations: string[];
};

/**
 * Explicit JSON Schema for output_config.format (SDK's stable, non-beta
 * JSONOutputFormat) — zod is not a project dependency, so this is hand
 * written rather than derived via zodOutputFormat().
 */
export const PRODUCT_DIAGNOSTIC_RESULT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "executiveSummary", "confidence", "correlations", "hypotheses", "recommendedActions", "limitations"],
  properties: {
    verdict: { type: "string", enum: [...PRODUCT_DIAGNOSTIC_VERDICTS] },
    executiveSummary: { type: "string" },
    confidence: { type: "string", enum: [...PRODUCT_DIAGNOSTIC_CONFIDENCE_LEVELS] },
    correlations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "evidenceRefs"],
        properties: {
          statement: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    hypotheses: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "confidence", "explanation", "evidenceRefs", "counterEvidenceRefs", "missingEvidence"],
        properties: {
          title: { type: "string" },
          confidence: { type: "string", enum: [...PRODUCT_DIAGNOSTIC_CONFIDENCE_LEVELS] },
          explanation: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
          counterEvidenceRefs: { type: "array", items: { type: "string" } },
          missingEvidence: { type: "array", items: { type: "string" } },
        },
      },
    },
    recommendedActions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["priority", "actionCode", "title", "reason", "evidenceRefs"],
        properties: {
          priority: { type: "string", enum: ["high", "medium", "low"] },
          actionCode: { type: "string", enum: [...PRODUCT_DIAGNOSTIC_ACTION_CODES] },
          title: { type: "string" },
          reason: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
      },
    },
    limitations: { type: "array", items: { type: "string" } },
  },
} as const;
