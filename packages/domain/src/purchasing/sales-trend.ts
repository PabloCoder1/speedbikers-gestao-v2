/**
 * Tendência determinística de venda (D-145, Fase 5D) — fórmula canônica.
 * Definição normativa em `docs/METRICS.md` §5D; qualquer versão SQL futura é
 * derivada daqui com teste de equivalência (regra da fórmula única).
 *
 * ## A fórmula, e por que ela é assim
 *
 * Compara a taxa diária dos últimos 30 dias com a taxa dos 60 dias
 * ANTERIORES a eles — janelas que **não se sobrepõem**. Comparar "últimos 15"
 * com "últimos 90" contaria as mesmas vendas recentes nos dois lados e
 * diluiria o sinal. As janelas de 15 e 60 dias são expostas como contexto
 * (o PRD pede a análise das quatro), mas a CLASSIFICAÇÃO usa 30×(30–90].
 *
 * Limiares: ±25%, TESTADOS contra o dado real antes de fixados (2026-08-30,
 * pós-reparo do histórico): 239 crescendo / 174 caindo / 152 estável em 565
 * SKUs classificáveis — um corte com significado, não degenerado.
 *
 * ## As duas recusas, e elas são o desenho
 *
 * 1. **AMOSTRA_INSUFICIENTE** (menos de 12 unidades em 90 dias, ≈1/semana):
 *    com 5 vendas no trimestre, qualquer razão entre janelas é ruído — 2
 *    vendas viram "+100%". Medido: 1.144 dos 1.715 SKUs com venda caem aqui,
 *    e é a resposta certa para eles.
 * 2. **HISTORICO_INCOMPLETO** (menos de 84 dos 90 dias com métrica na
 *    organização): a tendência que motivou esta função nasceu MENTINDO —
 *    junho tinha 13 de 30 dias recomputados e 86% dos SKUs apareciam
 *    "crescendo" por artefato. O buraco foi consertado (rebuild idempotente),
 *    mas a guarda fica: se ele voltar, a tendência se recusa em vez de
 *    repetir a mentira.
 */

export type SalesTrend =
  | "CRESCENDO"
  | "ESTAVEL"
  | "CAINDO"
  | "AMOSTRA_INSUFICIENTE"
  | "HISTORICO_INCOMPLETO";

export interface SalesTrendInput {
  /** Unidades vendidas nas janelas encerradas hoje (todas TRAILING). */
  readonly units15: number;
  readonly units30: number;
  readonly units60: number;
  readonly units90: number;
  /** Dias com métrica calculada na organização dentro da janela de 90. */
  readonly historyDays90: number;
}

export interface SalesTrendResult {
  readonly trend: SalesTrend;
  /** Unidades/dia nos últimos 30 dias. */
  readonly rateRecent: number;
  /** Unidades/dia no intervalo (30, 90] dias atrás. */
  readonly ratePrior: number;
  /** `rateRecent / ratePrior`; nulo quando o anterior é zero. */
  readonly ratio: number | null;
}

const MIN_UNITS_90D = 12;
const MIN_HISTORY_DAYS = 84;
const GROWTH_THRESHOLD = 1.25;
const FALL_THRESHOLD = 0.75;

export function classifySalesTrend(input: SalesTrendInput): SalesTrendResult {
  const rateRecent = input.units30 / 30;
  const ratePrior = (input.units90 - input.units30) / 60;
  const ratio = ratePrior > 0 ? rateRecent / ratePrior : null;

  if (input.historyDays90 < MIN_HISTORY_DAYS) {
    return { trend: "HISTORICO_INCOMPLETO", rateRecent, ratePrior, ratio };
  }

  if (input.units90 < MIN_UNITS_90D) {
    return { trend: "AMOSTRA_INSUFICIENTE", rateRecent, ratePrior, ratio };
  }

  // Sem venda no período anterior e com venda agora: o SKU COMEÇOU a vender.
  // É crescimento por definição — e o caso é real (6 SKUs na medição).
  if (ratio === null) {
    return { trend: rateRecent > 0 ? "CRESCENDO" : "ESTAVEL", rateRecent, ratePrior, ratio };
  }

  if (ratio >= GROWTH_THRESHOLD) {
    return { trend: "CRESCENDO", rateRecent, ratePrior, ratio };
  }

  if (ratio <= FALL_THRESHOLD) {
    return { trend: "CAINDO", rateRecent, ratePrior, ratio };
  }

  return { trend: "ESTAVEL", rateRecent, ratePrior, ratio };
}
