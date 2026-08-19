import type { OpportunityType } from "@/features/opportunities/opportunity-domain";
import { isAutoClaudeEligible } from "@/features/opportunities/opportunity-domain";

const MUTATE_ROLES = new Set(["admin", "gestor", "analista"]);
const SNOOZE_ROLES = new Set(["admin", "gestor", "analista", "operador"]);

/** ADMIN/GESTOR/ANALISTA can dismiss or trigger a Claude analysis; OPERADOR can view and snooze only; VISUALIZADOR is read-only. */
export function canDismissOrAnalyzeOpportunity(role: string, mustChangePassword: boolean): boolean {
  return !mustChangePassword && MUTATE_ROLES.has(role);
}

export function canSnoozeOpportunity(role: string, mustChangePassword: boolean): boolean {
  return !mustChangePassword && SNOOZE_ROLES.has(role);
}

/** Auto-Claude configuration (organization_ai_settings) is ADMIN-only per spec preference. */
export function canConfigureAutoClaude(role: string, mustChangePassword: boolean): boolean {
  return !mustChangePassword && role === "admin";
}

/** How many auto-Claude jobs may still be enqueued today, given the org's daily limit and how many were already enqueued. Never negative. */
export function remainingAutoClaudeBudget(dailyLimit: number, alreadyEnqueuedToday: number): number {
  return Math.max(0, dailyLimit - alreadyEnqueuedToday);
}

/**
 * Auto-Claude only ever spends on critical/high opportunities of types that
 * genuinely benefit from an AI read (never PURCHASE_URGENT, MAPPING_BLOCKER,
 * PHYSICAL_STOCKOUT_WITH_DEMAND, FULL_ZERO_WITH_PHYSICAL, or GROWTH_LOW_COVERAGE
 * — those already have a fully deterministic cause/action), respecting the
 * remaining daily budget. Pure so the selection logic is testable without a DB.
 */
export function selectAutoClaudeCandidates<T extends { id: string; opportunityType: OpportunityType; priority: string }>(
  opportunities: T[],
  remainingBudget: number,
): T[] {
  if (remainingBudget <= 0) return [];
  const eligible = opportunities.filter((opportunity) => (opportunity.priority === "critical" || opportunity.priority === "high") && isAutoClaudeEligible(opportunity.opportunityType));
  const priorityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...eligible].sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority]);
  return sorted.slice(0, remainingBudget);
}

/** Top-level gate: when auto-Claude is disabled for the organization, never select anything — zero jobs, regardless of what opportunities exist. */
export function resolveAutoClaudeEnqueueList<T extends { id: string; opportunityType: OpportunityType; priority: string }>(
  settings: { autoOpportunityDiagnosticsEnabled: boolean; dailyOpportunityDiagnosticLimit: number },
  opportunities: T[],
  alreadyEnqueuedToday: number,
): T[] {
  if (!settings.autoOpportunityDiagnosticsEnabled) return [];
  return selectAutoClaudeCandidates(opportunities, remainingAutoClaudeBudget(settings.dailyOpportunityDiagnosticLimit, alreadyEnqueuedToday));
}
