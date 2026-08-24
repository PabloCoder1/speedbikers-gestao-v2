export { diagnoseSalesAnomaly, estimateImpactBrl } from "./sales-anomaly.js";
export type {
  AnomalyDirection,
  CorrelatedEvent,
  DiagnosisCandidateCause,
  DiagnosisConfidence,
  DiagnosisEvidence,
  SalesAnomalyDiagnosis,
  SalesBaselineSignal,
} from "./sales-anomaly.js";

export { computePendingOutcomeWindows, OUTCOME_WINDOWS_DAYS } from "./decision-outcomes.js";
export type { OutcomeWindowDays } from "./decision-outcomes.js";
