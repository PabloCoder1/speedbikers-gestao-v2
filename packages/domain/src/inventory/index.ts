export {
  alignedAt,
  computeSaleDeductions,
  ESTORNO_KEY_PREFIX,
  estornadoKeyOf,
  estornoKeyOf,
  estornaVendaGravada,
  isValidSaleStatus,
  preCaptureEstornoOf,
  saleInstant,
} from "./sale-deduction.js";
export type {
  ErpCutoff,
  PreCaptureCutoffs,
  RecordedSale,
  SaleDeductionItem,
  SaleDeductionOrder,
  SaleDeductionResult,
  StockMovementDraft,
} from "./sale-deduction.js";

export {
  CANCELAMENTO_KEY_PREFIX,
  cancellationKeyOf,
  DEVOLUCAO_KEY_PREFIX,
  excessReversed,
  remainingToReverse,
  returnKeyOf,
  revertedSaleKeyOf,
  reversedQuantity,
} from "./reversal-limit.js";
export type { RecordedReversal } from "./reversal-limit.js";

export { computeCancellationMovements, computeCancellationReversals } from "./cancellation-reversal.js";
export type {
  CancellationMovements,
  CancellationMovementsInput,
  CancellationPreCapture,
  CancellationReversalOrder,
  ObservedSaleTransition,
  RecordedSaleMovement,
} from "./cancellation-reversal.js";

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
