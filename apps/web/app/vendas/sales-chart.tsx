import type { ReactNode } from "react";

import { formatBusinessDate, formatCurrency } from "../../lib/format";

interface DailyPoint {
  metric_date: string;
  gross_revenue: number;
}

const WIDTH = 800;
const HEIGHT = 220;
const PADDING_LEFT = 64;
const PADDING_RIGHT = 16;
const PADDING_TOP = 16;
const PADDING_BOTTOM = 28;

/**
 * Gráfico de tendência de receita bruta — SVG estático, sem biblioteca de
 * gráficos: `packages/ui` não existe (regra de contenção,
 * docs/ARCHITECTURE.md secao 3 — só vira package quando dois apps
 * importam), e uma dependência nova só para uma linha simples não passa no
 * "teste da dor medida" (docs/ARCHITECTURE.md secao 1).
 *
 * Eixo X espaça os pontos por ÍNDICE, não por data corrida: dias sem linha
 * em `daily_account_metrics` ficam ausentes (`get_sales_daily_series` não
 * fabrica zero, ver o comentário da migration), então espaçar por
 * calendário exageraria visualmente uma lacuna de dado ainda não
 * calculado como se fosse zero vendido. Simplificação aceita para a
 * primeira versão — ver docs/HANDOFF.md.
 */
export function SalesChart({ points }: { points: DailyPoint[] }): ReactNode {
  if (points.length === 0) return null;

  const values = points.map((p) => p.gross_revenue);
  const maxValue = Math.max(...values, 0);
  const chartMax = maxValue === 0 ? 1 : maxValue * 1.1;

  const innerWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const innerHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  function xAt(index: number): number {
    if (points.length === 1) return PADDING_LEFT + innerWidth / 2;

    return PADDING_LEFT + (innerWidth * index) / (points.length - 1);
  }

  function yAt(value: number): number {
    return PADDING_TOP + innerHeight - (innerHeight * value) / chartMax;
  }

  const linePath = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(point.gross_revenue).toFixed(1)}`)
    .join(" ");

  const gridLines = [0, 0.5, 1].map((fraction) => chartMax * fraction);

  // No máximo ~7 rótulos no eixo X, mesmo com 90 pontos — mais que isso
  // empilha texto ilegível.
  const labelStep = Math.max(1, Math.ceil(points.length / 7));

  return (
    <svg
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      role="img"
      aria-label="Receita bruta por dia no período selecionado"
      style={{ width: "100%", height: "auto", maxWidth: `${String(WIDTH)}px`, display: "block" }}
    >
      {gridLines.map((value) => {
        const yPos = yAt(value);

        return (
          <g key={value}>
            <line
              x1={PADDING_LEFT}
              x2={WIDTH - PADDING_RIGHT}
              y1={yPos}
              y2={yPos}
              stroke="var(--sb-border)"
              strokeWidth={1}
            />
            <text x={PADDING_LEFT - 8} y={yPos + 4} textAnchor="end" fontSize={10} fill="var(--sb-text-soft)">
              {formatCurrency(value)}
            </text>
          </g>
        );
      })}

      <path d={linePath} fill="none" stroke="var(--sb-primary)" strokeWidth={2} />

      {points.map((point, index) => (
        <g key={point.metric_date}>
          <circle cx={xAt(index)} cy={yAt(point.gross_revenue)} r={3} fill="var(--sb-primary)">
            {/*
              Um filho de texto só, não vários interpolados — vários filhos
              dentro de <title> de SVG produziu divergência de hidratação
              (servidor x cliente viam a mesma string dividida diferente).
            */}
            <title>{`${formatBusinessDate(point.metric_date)}: ${formatCurrency(point.gross_revenue)}`}</title>
          </circle>

          {index % labelStep === 0 && (
            <text x={xAt(index)} y={HEIGHT - 8} textAnchor="middle" fontSize={10} fill="var(--sb-text-soft)">
              {formatBusinessDate(point.metric_date).slice(0, 5)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
