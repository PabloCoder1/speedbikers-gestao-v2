/**
 * Memória de decisões operacionais (Fase 6, `docs/PROMPT_MASTER.md` secao
 * 29) — a peça pura de `apps/worker/src/handlers/measure-decision-outcomes.ts`
 * (job `diagnostics.measure-decision-outcomes`).
 *
 * `baseline_snapshot` é capturado no MOMENTO da decisão (`create_action_decision`,
 * SQL). Esta função só decide QUANDO cada janela de medição (7/15/30 dias)
 * já amadureceu o suficiente pra ser medida — não recalcula uma janela já
 * medida (medição histórica fixa, nunca some depois de gravada).
 */

export const OUTCOME_WINDOWS_DAYS = [7, 15, 30] as const;

export type OutcomeWindowDays = (typeof OUTCOME_WINDOWS_DAYS)[number];

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * `alreadyMeasured` são as janelas que já têm linha em `action_outcomes`
 * pra esta decisão — nunca remedidas. Uma janela entra no resultado quando
 * a decisão já tem idade >= a janela, em dias corridos.
 */
export function computePendingOutcomeWindows(
  decidedAt: Date,
  now: Date,
  alreadyMeasured: readonly number[],
): OutcomeWindowDays[] {
  const ageDays = Math.floor((now.getTime() - decidedAt.getTime()) / MS_PER_DAY);
  const measured = new Set(alreadyMeasured);

  return OUTCOME_WINDOWS_DAYS.filter((window) => ageDays >= window && !measured.has(window));
}
