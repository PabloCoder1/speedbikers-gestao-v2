export { computeSaleDeductions } from "./sale-deduction.js";
export type { SaleDeductionItem, SaleDeductionOrder, StockMovementDraft } from "./sale-deduction.js";

export { computeCancellationReversals } from "./cancellation-reversal.js";
export type { CancellationReversalOrder, RecordedSaleMovement } from "./cancellation-reversal.js";

export { computeNfeApplicationMovements } from "./nfe-application.js";
export type { NfeApplicationDocument, NfeApplicationItem } from "./nfe-application.js";

export { computeReconciliationAdjustments } from "./reconciliation.js";
export type { ReconciliationAdjustment, ReconciliationBalance } from "./reconciliation.js";

export { computeLedgerIntegrityDivergences } from "./ledger-integrity.js";
export type { LedgerBalance } from "./ledger-integrity.js";

export { computeReturnReversal, computeUnreversedReturn } from "./return-reversal.js";
export type { ReturnedOrderItem, ReturnReversal } from "./return-reversal.js";

export { simulateCoverageDays, simulateRequiredQuantity, simulateRuptureDate } from "./coverage-simulation.js";
export type { CoverageSimulation, RequiredQuantitySimulation, RuptureDateSimulation } from "./coverage-simulation.js";
