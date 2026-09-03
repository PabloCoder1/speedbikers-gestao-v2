import { businessDateRangeLength } from "@sb/domain";
import type { ReactNode } from "react";

import { formatBusinessDate, formatCount, formatCurrency } from "../../lib/format";
import type { SalesMetric } from "../../lib/sales-metric";
import { indexByOffset, offsetInPeriod } from "../../lib/series-alignment";

interface DailyPoint {
  metric_date: string;
  gross_revenue: number;
  units_sold: number;
  orders_count: number;
  /** NULL sob recorte de marca (D-237) — ver a recusa logo abaixo. */
  purchases_count: number | null;
}

const WIDTH = 800;
const HEIGHT = 220;
const PADDING_LEFT = 64;
const PADDING_RIGHT = 16;
const PADDING_TOP = 16;
const PADDING_BOTTOM = 28;

/**
 * Gráfico de tendência de `/vendas` — SVG estático, sem biblioteca de
 * gráficos: `packages/ui` não existe (regra de contenção,
 * docs/ARCHITECTURE.md secao 3 — só vira package quando dois apps
 * importam), e uma dependência nova só para duas linhas simples não passa
 * no "teste da dor medida" (docs/ARCHITECTURE.md secao 1).
 *
 * A métrica plotada é PARÂMETRO desde a Fase 5C (D-136): a RPC já devolvia
 * as quatro colunas e a tela descartava três. O componente não escolhe nem
 * valida — recebe a métrica já resolvida (`lib/sales-metric.ts`), porque
 * quem decide é a URL e a validação precisa ser testável sem React.
 *
 * ## Eixo X: OFFSET DE DIA, não índice do array (D-137)
 *
 * A primeira versão espaçava por índice, com o argumento de que dias sem
 * linha em `daily_account_metrics` ficam ausentes (`get_sales_daily_series`
 * não fabrica zero) e espaçar por calendário exageraria a lacuna.
 *
 * **A comparação de período derrubou esse desenho.** Com duas séries, índice
 * deixa de significar a mesma coisa nas duas: se a janela atual tem 28 dias
 * com métrica e a anterior tem 30, o índice 5 de uma é um dia relativo
 * DIFERENTE do índice 5 da outra — e o gráfico afirmaria "este dia contra o
 * mesmo dia do período anterior" sobre dois dias que não se correspondem.
 *
 * Medido em 2026-08-29: hoje as duas janelas estão completas (30/30 dias
 * cada), então o alinhamento por índice funcionaria — **por sorte**. É a
 * classe de defeito que este projeto persegue: correto hoje, silenciosamente
 * errado no primeiro dia em que uma janela tiver lacuna e a outra não. A
 * própria tela já prevê esse estado, exibindo "Só N dias têm métrica
 * calculada" quando a série vem incompleta.
 *
 * As duas janelas têm o MESMO comprimento por construção
 * (`previousBusinessDateRange`), então o offset `0..length-1` mapeia 1:1
 * entre elas e o alinhamento é bem definido.
 */
export function SalesChart({
  points,
  previousPoints,
  metric,
  rangeFrom,
  rangeTo,
  previousRangeFrom,
  previousRangeTo,
}: {
  points: DailyPoint[];
  previousPoints: DailyPoint[];
  metric: SalesMetric;
  rangeFrom: string;
  rangeTo: string;
  previousRangeFrom: string;
  previousRangeTo: string;
}): ReactNode {
  if (points.length === 0) return null;

  // RECUSA EM VEZ DE ZERO (D-237). Sob recorte de marca, `purchases_count` vem
  // NULL: pack atravessa SKU e não existe "compras da marca X". Plotar `?? 0`
  // desenharia uma linha rente ao eixo — visualmente idêntica a "esta marca
  // não teve compras", que é afirmação diferente e falsa. Mesma disciplina de
  // D-127 com cobertura de estoque virtual.
  const indisponivel = [...points, ...previousPoints].some((p) => p[metric.field] === null);

  if (indisponivel) {
    return (
      <p style={{ margin: 0, color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
        <strong>{metric.label}</strong> não tem série por marca: a compra é contada por <em>pack</em>, e um pack
        pode atravessar SKUs de marcas diferentes — somá-la por marca contaria o mesmo pack duas vezes. Escolha
        outra métrica, ou tire o recorte de marca.
      </p>
    );
  }

  // Contagem NUNCA é formatada como moeda: "R$ 12" numa série de unidades
  // vendidas seria um número errado com aparência de certo — a classe de
  // defeito que este projeto persegue desde D-131.
  const formatValue = metric.format === "currency" ? formatCurrency : formatCount;
  // Depois da recusa acima, o campo é numérico em todos os pontos.
  const valueAt = (point: DailyPoint): number => point[metric.field] ?? 0;

  const periodLength = businessDateRangeLength(rangeFrom, rangeTo);

  // Escala COMPARTILHADA pelas duas séries. São a mesma métrica na mesma
  // unidade, então dois eixos Y seriam mentira visual; e usar só o máximo da
  // série atual faria a linha anterior sair do quadro sempre que o período
  // passado tivesse vendido mais — justamente o caso que a comparação existe
  // para mostrar.
  const allValues = [...points.map(valueAt), ...previousPoints.map(valueAt)];
  const maxValue = Math.max(...allValues, 0);
  const chartMax = maxValue === 0 ? 1 : maxValue * 1.1;

  const innerWidth = WIDTH - PADDING_LEFT - PADDING_RIGHT;
  const innerHeight = HEIGHT - PADDING_TOP - PADDING_BOTTOM;

  function xAt(offset: number): number {
    if (periodLength === 1) return PADDING_LEFT + innerWidth / 2;

    return PADDING_LEFT + (innerWidth * offset) / (periodLength - 1);
  }

  function yAt(value: number): number {
    return PADDING_TOP + innerHeight - (innerHeight * value) / chartMax;
  }

  function pathFor(series: DailyPoint[], periodStart: string): string {
    return series
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${xAt(offsetInPeriod(point.metric_date, periodStart)).toFixed(1)},${yAt(valueAt(point)).toFixed(1)}`,
      )
      .join(" ");
  }

  // Valor do período anterior no MESMO offset, para a dica de cada ponto.
  // `undefined` (não 0) quando o dia não existe do outro lado: "sem dado" e
  // "vendeu zero" são afirmações diferentes, e a RPC não fabrica zero.
  const previousByOffset = indexByOffset(previousPoints, previousRangeFrom);

  const hasComparison = previousPoints.length > 0;

  const gridLines = [0, 0.5, 1].map((fraction) => chartMax * fraction);
  const gridLabel = (value: number): string =>
    metric.format === "count" ? formatValue(Math.round(value)) : formatValue(value);

  // No máximo ~7 rótulos no eixo X, mesmo com 90 dias — mais que isso
  // empilha texto ilegível.
  const labelStep = Math.max(1, Math.ceil(periodLength / 7));

  return (
    <figure style={{ margin: 0 }}>
      <svg
        viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
        role="img"
        aria-label={
          hasComparison
            ? `${metric.heading} no período selecionado, comparado com o período anterior`
            : `${metric.heading} no período selecionado`
        }
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
                {gridLabel(value)}
              </text>
            </g>
          );
        })}

        {/*
          Período anterior ANTES do atual no DOM: em SVG a ordem é a ordem de
          pintura, então desenhar depois colocaria a linha de referência por
          cima da linha que interessa. Tracejada e em cor apagada porque é
          contexto, não o assunto — hierarquia visual, docs/PROMPT_MASTER.md §19.
        */}
        {hasComparison && (
          <path
            d={pathFor(previousPoints, previousRangeFrom)}
            fill="none"
            stroke="var(--sb-muted)"
            strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        )}

        <path d={pathFor(points, rangeFrom)} fill="none" stroke="var(--sb-primary)" strokeWidth={2} />

        {points.map((point) => {
          const offset = offsetInPeriod(point.metric_date, rangeFrom);
          const previousPoint = previousByOffset.get(offset);
          const comparison =
            previousPoint === undefined
              ? "sem dado no período anterior"
              : `período anterior (${formatBusinessDate(previousPoint.metric_date)}): ${formatValue(valueAt(previousPoint))}`;

          return (
            <g key={point.metric_date}>
              <circle cx={xAt(offset)} cy={yAt(valueAt(point))} r={3} fill="var(--sb-primary)">
                {/*
                  Um filho de texto só, não vários interpolados — vários filhos
                  dentro de <title> de SVG produziu divergência de hidratação
                  (servidor x cliente viam a mesma string dividida diferente).
                */}
                <title>
                  {`${formatBusinessDate(point.metric_date)}: ${formatValue(valueAt(point))} · ${comparison}`}
                </title>
              </circle>

              {offset % labelStep === 0 && (
                <text x={xAt(offset)} y={HEIGHT - 8} textAnchor="middle" fontSize={10} fill="var(--sb-text-soft)">
                  {formatBusinessDate(point.metric_date).slice(0, 5)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/*
        A legenda só existe quando há o que legendar. Sem dado no período
        anterior, anunciar uma linha tracejada que não foi desenhada faria a
        tela descrever algo que não está lá.
      */}
      {hasComparison && (
        <figcaption
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--sb-space-3)",
            marginTop: "var(--sb-space-2)",
            fontSize: "0.75rem",
            color: "var(--sb-text-soft)",
          }}
        >
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}>
            <svg width="18" height="8" aria-hidden="true" style={{ flexShrink: 0 }}>
              <line x1="0" y1="4" x2="18" y2="4" stroke="var(--sb-primary)" strokeWidth={2} />
            </svg>
            Período atual
          </span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}>
            <svg width="18" height="8" aria-hidden="true" style={{ flexShrink: 0 }}>
              <line
                x1="0"
                y1="4"
                x2="18"
                y2="4"
                stroke="var(--sb-muted)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            </svg>
            {/*
              A janela REAL, não a data do último ponto com dado: se o último
              dia do período anterior não tiver métrica calculada, rotular
              pelo último ponto encolheria a janela na legenda e o usuário
              compararia 30 dias contra "28 dias" sem saber.
            */}
            Período anterior ({formatBusinessDate(previousRangeFrom)} a {formatBusinessDate(previousRangeTo)})
          </span>
        </figcaption>
      )}
    </figure>
  );
}
