import type { ReactNode } from "react";

import { classifySalesTrend } from "@sb/domain";
import type { SalesTrend, SalesTrendInput } from "@sb/domain";

/**
 * O selo de tendência de venda (D-145), compartilhado por `/cobertura` e
 * `/reposicao` (D-147) — extraído quando o segundo consumidor apareceu, a
 * regra de contenção de D-141. A CLASSIFICAÇÃO continua em `@sb/domain`
 * (`classifySalesTrend`); aqui mora só a aparência e o tooltip com as quatro
 * janelas.
 *
 * As duas recusas têm texto próprio e tom apagado: "sem amostra" e
 * "histórico incompleto" são respostas, não erros — mesmo princípio do
 * "estoque virtual" na cobertura.
 */
const TREND_TONE: Record<SalesTrend, { label: string; color: string }> = {
  CRESCENDO: { label: "▲ Crescendo", color: "var(--sb-secondary)" },
  ESTAVEL: { label: "◆ Estável", color: "var(--sb-text-soft)" },
  CAINDO: { label: "▼ Caindo", color: "var(--sb-danger)" },
  AMOSTRA_INSUFICIENTE: { label: "sem amostra", color: "var(--sb-muted-ink)" },
  HISTORICO_INCOMPLETO: { label: "histórico incompleto", color: "var(--sb-muted-ink)" },
};

export function TrendBadge(input: SalesTrendInput): ReactNode {
  const result = classifySalesTrend(input);
  const tone = TREND_TONE[result.trend];

  return (
    <span
      style={{ color: tone.color, fontSize: "0.8125rem", whiteSpace: "nowrap" }}
      title={`15d: ${String(input.units15)} · 30d: ${String(input.units30)} · 60d: ${String(input.units60)} · 90d: ${String(input.units90)}${result.ratio === null ? "" : ` · razão 30d÷(30–90d): ${result.ratio.toFixed(2)}`}`}
    >
      {tone.label}
    </span>
  );
}
