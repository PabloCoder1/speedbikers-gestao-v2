export const OPPORTUNITY_TYPES = [
  "SALES_DROP",
  "NO_SALES_WITH_AVAILABILITY",
  "ACCOUNT_SPECIFIC_DROP",
  "PHYSICAL_STOCKOUT_WITH_DEMAND",
  "FULL_ZERO_WITH_PHYSICAL",
  "PURCHASE_URGENT",
  "GROWTH_LOW_COVERAGE",
  "PROMOTION_ENDED_SALES_DROP",
  "PRICE_NOT_COMPETITIVE",
  "LISTING_QUALITY",
  "MAPPING_BLOCKER",
] as const;
export type OpportunityType = (typeof OPPORTUNITY_TYPES)[number];

export const OPPORTUNITY_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type OpportunityPriority = (typeof OPPORTUNITY_PRIORITIES)[number];

export const OPPORTUNITY_STATUSES = ["open", "snoozed", "dismissed", "resolved"] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const OPPORTUNITY_TYPE_LABEL: Record<OpportunityType, string> = {
  SALES_DROP: "Queda de vendas",
  NO_SALES_WITH_AVAILABILITY: "Sem vendas com disponibilidade",
  ACCOUNT_SPECIFIC_DROP: "Queda em conta especifica",
  PHYSICAL_STOCKOUT_WITH_DEMAND: "Estoque fisico zerado",
  FULL_ZERO_WITH_PHYSICAL: "Full zerado",
  PURCHASE_URGENT: "Compra urgente",
  GROWTH_LOW_COVERAGE: "Crescimento com cobertura baixa",
  PROMOTION_ENDED_SALES_DROP: "Queda apos promocao",
  PRICE_NOT_COMPETITIVE: "Preco pouco competitivo",
  LISTING_QUALITY: "Qualidade do anuncio",
  MAPPING_BLOCKER: "Bloqueio de mapeamento",
};

export const OPPORTUNITY_PRIORITY_LABEL: Record<OpportunityPriority, string> = {
  critical: "Critica",
  high: "Alta",
  medium: "Media",
  low: "Baixa",
};

export const OPPORTUNITY_STATUS_LABEL: Record<OpportunityStatus, string> = {
  open: "Aberta",
  snoozed: "Adiada",
  dismissed: "Dispensada",
  resolved: "Resolvida",
};

/** Groups types into the filter categories the UI shows (Vendas/Preco/Estoque/Full/Compra/Anuncio/Mapeamento). */
export const OPPORTUNITY_TYPE_CATEGORY: Record<OpportunityType, "sales" | "price" | "stock" | "full" | "purchase" | "listing" | "mapping"> = {
  SALES_DROP: "sales",
  NO_SALES_WITH_AVAILABILITY: "sales",
  ACCOUNT_SPECIFIC_DROP: "sales",
  PROMOTION_ENDED_SALES_DROP: "sales",
  PHYSICAL_STOCKOUT_WITH_DEMAND: "stock",
  FULL_ZERO_WITH_PHYSICAL: "full",
  PURCHASE_URGENT: "purchase",
  GROWTH_LOW_COVERAGE: "purchase",
  PRICE_NOT_COMPETITIVE: "price",
  LISTING_QUALITY: "listing",
  MAPPING_BLOCKER: "mapping",
};

/** Part "Principal Action": deterministic fallback when no fresh Claude diagnostic is linked. Claude's action[0] takes priority when available (resolved by the caller, not here). */
export const OPPORTUNITY_DEFAULT_ACTION: Record<OpportunityType, { code: string; text: string }> = {
  SALES_DROP: { code: "MONITOR_PRODUCT", text: "Investigar a causa da queda de vendas" },
  NO_SALES_WITH_AVAILABILITY: { code: "INVESTIGATE_EXTERNAL_MARKET", text: "Investigar por que o produto parou de vender" },
  ACCOUNT_SPECIFIC_DROP: { code: "CHECK_LISTING_STATUS", text: "Revisar o anuncio da conta com queda" },
  PHYSICAL_STOCKOUT_WITH_DEMAND: { code: "CHECK_PHYSICAL_STOCK", text: "Verificar reposicao de estoque fisico" },
  FULL_ZERO_WITH_PHYSICAL: { code: "REPLENISH_FULL", text: "Reabastecer o Full a partir do estoque fisico" },
  PURCHASE_URGENT: { code: "CHECK_PURCHASE_PLAN", text: "Abrir pedido de compra" },
  GROWTH_LOW_COVERAGE: { code: "CHECK_PURCHASE_PLAN", text: "Antecipar compra para sustentar o crescimento" },
  PROMOTION_ENDED_SALES_DROP: { code: "REVIEW_PROMOTION", text: "Avaliar reativar a promocao" },
  PRICE_NOT_COMPETITIVE: { code: "ADJUST_PRICE", text: "Revisar preco para ficar competitivo" },
  LISTING_QUALITY: { code: "IMPROVE_TITLE", text: "Melhorar a qualidade do anuncio" },
  MAPPING_BLOCKER: { code: "CHECK_MAPPING", text: "Resolver o mapeamento de estoque" },
};

/** True for the types the spec allows auto-Claude to spend on (when organization_ai_settings.auto_opportunity_diagnostics_enabled). */
export const AUTO_CLAUDE_ELIGIBLE_TYPES: readonly OpportunityType[] = [
  "SALES_DROP",
  "NO_SALES_WITH_AVAILABILITY",
  "ACCOUNT_SPECIFIC_DROP",
  "PROMOTION_ENDED_SALES_DROP",
  "PRICE_NOT_COMPETITIVE",
  "LISTING_QUALITY",
];

export function isAutoClaudeEligible(type: OpportunityType): boolean {
  return AUTO_CLAUDE_ELIGIBLE_TYPES.includes(type);
}
