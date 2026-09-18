export {
  alignedAt,
  computeSaleDeductions,
  ESTORNO_KEY_PREFIX,
  estornadoKeyOf,
  estornoKeyOf,
  estornaVendaGravada,
  excessReversalEstornosOf,
  FULL_LOGISTIC_TYPE,
  fullEstornoOf,
  fullReversalEstornosOf,
  isFullLogistic,
  isValidSaleStatus,
  preCaptureEstornoOf,
  saleInstant,
} from "./sale-deduction.js";
export type {
  ErpCutoff,
  OrderLogisticType,
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
  excessReversalShares,
  excessReversed,
  remainingToReverse,
  returnKeyOf,
  revertedSaleKeyOf,
  reversedQuantity,
} from "./reversal-limit.js";
export type { ExcessReversalShare, RecordedReversal, TimedRecordedReversal } from "./reversal-limit.js";

export {
  cancelledInSheetKeys,
  computeCancellationMovements,
  computeCancellationReversals,
  sheetContainsCancellation,
} from "./cancellation-reversal.js";
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
export type {
  ReturnedOrder,
  ReturnedOrderItem,
  ReturnedSaleMovement,
  ReturnReversal,
} from "./return-reversal.js";

export { simulateCoverageDays, simulateRequiredQuantity, simulateRuptureDate } from "./coverage-simulation.js";
export type { CoverageSimulation, RequiredQuantitySimulation, RuptureDateSimulation } from "./coverage-simulation.js";
