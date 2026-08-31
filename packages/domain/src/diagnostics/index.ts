export { diagnoseSalesAnomaly, estimateImpactBrl } from "./sales-anomaly.js";
export type {
  AnomalyDirection,
  SupportSignal,
  CorrelatedEvent,
  DiagnosisCandidateCause,
  DiagnosisConfidence,
  DiagnosisEvidence,
  SalesAnomalyDiagnosis,
  SalesBaselineSignal,
} from "./sales-anomaly.js";

export { computePendingOutcomeWindows, OUTCOME_WINDOWS_DAYS } from "./decision-outcomes.js";
export type { OutcomeWindowDays } from "./decision-outcomes.js";

export { SUPPORT_PATTERN_MIN_OPEN_CLAIMS, detectSupportPatterns } from "./support-patterns.js";
export type { SkuClaimAggregate, SupportPatternFinding } from "./support-patterns.js";

export { describeActionEvidence } from "./action-evidence.js";
export type { ActionCandidateCause, ActionEvidenceItem, ActionEvidenceView, ActionTone } from "./action-evidence.js";
