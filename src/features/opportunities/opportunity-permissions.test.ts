import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canConfigureAutoClaude,
  canDismissOrAnalyzeOpportunity,
  canSnoozeOpportunity,
  remainingAutoClaudeBudget,
  resolveAutoClaudeEnqueueList,
  selectAutoClaudeCandidates,
} from "./opportunity-permissions";

// 36. visualizador não dispara análise
test("visualizador cannot dismiss or analyze an opportunity", () => {
  assert.equal(canDismissOrAnalyzeOpportunity("visualizador", false), false);
});

test("operador can snooze but not dismiss/analyze", () => {
  assert.equal(canSnoozeOpportunity("operador", false), true);
  assert.equal(canDismissOrAnalyzeOpportunity("operador", false), false);
});

test("admin/gestor/analista can dismiss and analyze", () => {
  for (const role of ["admin", "gestor", "analista"]) assert.equal(canDismissOrAnalyzeOpportunity(role, false), true);
});

test("only admin can configure auto-Claude", () => {
  assert.equal(canConfigureAutoClaude("admin", false), true);
  assert.equal(canConfigureAutoClaude("gestor", false), false);
});

// 32. auto Claude OFF => zero Claude jobs
test("auto-Claude disabled selects nothing, regardless of eligible opportunities", () => {
  const opportunities = [{ id: "1", opportunityType: "SALES_DROP" as const, priority: "critical" }];
  const selected = resolveAutoClaudeEnqueueList({ autoOpportunityDiagnosticsEnabled: false, dailyOpportunityDiagnosticLimit: 5 }, opportunities, 0);
  assert.deepEqual(selected, []);
});

// 33. auto Claude ON => somente tipos permitidos
test("auto-Claude enabled only selects eligible types at critical/high priority", () => {
  const opportunities = [
    { id: "1", opportunityType: "SALES_DROP" as const, priority: "critical" },
    { id: "2", opportunityType: "PURCHASE_URGENT" as const, priority: "critical" }, // deterministic already, never Claude
    { id: "3", opportunityType: "MAPPING_BLOCKER" as const, priority: "critical" }, // deterministic already, never Claude
    { id: "4", opportunityType: "SALES_DROP" as const, priority: "medium" }, // priority too low
  ];
  const selected = resolveAutoClaudeEnqueueList({ autoOpportunityDiagnosticsEnabled: true, dailyOpportunityDiagnosticLimit: 5 }, opportunities, 0);
  assert.deepEqual(selected.map((o) => o.id), ["1"]);
});

// 34. daily limit respeitado
test("the daily limit caps how many opportunities are selected, highest priority first", () => {
  const opportunities = [
    { id: "1", opportunityType: "SALES_DROP" as const, priority: "high" },
    { id: "2", opportunityType: "ACCOUNT_SPECIFIC_DROP" as const, priority: "critical" },
    { id: "3", opportunityType: "PRICE_NOT_COMPETITIVE" as const, priority: "high" },
  ];
  const selected = resolveAutoClaudeEnqueueList({ autoOpportunityDiagnosticsEnabled: true, dailyOpportunityDiagnosticLimit: 2 }, opportunities, 0);
  assert.equal(selected.length, 2);
  assert.equal(selected[0].id, "2"); // critical goes first
});

test("remainingAutoClaudeBudget never goes negative once the limit is exceeded", () => {
  assert.equal(remainingAutoClaudeBudget(5, 5), 0);
  assert.equal(remainingAutoClaudeBudget(5, 8), 0);
  assert.equal(remainingAutoClaudeBudget(5, 2), 3);
});

test("selectAutoClaudeCandidates returns nothing when the budget is already exhausted", () => {
  const opportunities = [{ id: "1", opportunityType: "SALES_DROP" as const, priority: "critical" }];
  assert.deepEqual(selectAutoClaudeCandidates(opportunities, 0), []);
});
