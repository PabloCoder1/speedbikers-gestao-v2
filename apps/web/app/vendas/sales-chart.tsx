import { businessDateRangeLength, shiftBusinessDate } from "@sb/domain";
import type { ReactNode } from "react";

import { formatBusinessDate, formatCount, formatCurrency } from "../../lib/format";
import { caminho, faixaDoDia, tetoDaEscala, xPct, yPct, type Ponto } from "../../lib/sales-chart-geometry";
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
 * As duas janelas têm o MESMO comprimento por construção
 * (`previousBusinessDateRange`), então o offset `0..length-1` mapeia 1:1
 * entre elas e o alinhamento é bem definido.
 *
 * ## D5 da frente visual — o que mudou, e por quê
 *
 * **1. A série de comparação era invisível, e isso é defeito medido, não
 * gosto.** Ela usava `--sb-muted` (`#ccc5d5`), que dá **1,68:1** contra o
 * cartão branco — a WCAG 1.4.11 pede **3:1** de objeto gráfico que carrega
 * informação. Agora usa `--sb-muted-ink` (`#746d88`, **4,90:1**), e a
 * hierarquia se mantém por PESO e TRAÇO (1,5px tracejada contra 2px sólida),
 * não por apagamento.
 *
 * **2. Hover por FAIXA, não por ponto.** Cada dia tem uma faixa invisível de
 * altura inteira; passar em qualquer altura da coluna acende a linha vertical,
 * engorda o ponto e abre a leitura. **É CSS puro, sem componente cliente** —
 * `:hover` sobre o grupo do dia faz tudo, e o componente continua sendo Server
 * Component como o resto da tela.
 *
 * **3. As faixas cobrem o PERÍODO, não os pontos.** Dia sem métrica calculada
 * também tem faixa, e a leitura dele diz isso em vez de nada.
 *
 * **O que o hover NÃO resolve:** quem não usa ponteiro continua com o `title` de
 * cada ponto e com o `aria-label` do gráfico. Leitura ponto a ponto por teclado
 * exigiria 30 a 90 paradas de foco; a saída boa é uma tabela equivalente, e ela
 * é fatia própria.
 *
 * ## A14 — altura fixa, e o texto sai do SVG (D-322)
 *
 * O `viewBox` era 900×260 com `height: auto`: a altura seguia a largura, e o
 * texto de dentro do SVG TAMBÉM. Medido antes de mexer: em `/vendas` o gráfico
 * tinha 313px de altura a 1440px e **70px a 375px**, com o eixo em **2,4px**; na
 * Home, o eixo já estava em **7px a 1440px**. O frame tem altura FIXA (224px em
 * `/vendas`, 165px na Home) e estica só a largura.
 *
 * Esticar só a largura deforma o que tem forma, então a anatomia passou a ser a
 * do frame: o SVG (`viewBox 0 0 100 100`, `preserveAspectRatio="none"`) desenha
 * só LINHAS, com `vector-effect: non-scaling-stroke` para o traço não engordar;
 * eixos, pontos, linha de hover e caixa de leitura são HTML posicionado pelas
 * mesmas contas em porcentagem (`lib/sales-chart-geometry.ts`). O texto tem
 * tamanho de CSS — 9px nos eixos e 11px na leitura, em qualquer largura.
 */
export function SalesChart({
  points,
  previousPoints,
  metric,
  rangeFrom,
  rangeTo,
  previousRangeFrom,
  previousRangeTo,
  area = false,
  altura = "grande",
}: {
  points: DailyPoint[];
  previousPoints: DailyPoint[];
  metric: SalesMetric;
  rangeFrom: string;
  rangeTo: string;
  previousRangeFrom: string;
  previousRangeTo: string;
  /**
   * Preenchimento sob a linha, com o degradê do frame `Home` do Figma
   * (`#373993` de 20% a 0%). Lá a Home usa área e `/vendas` usa linha — a
   * área diz "volume" num relance, e a linha diz "variação" com precisão.
   */
  area?: boolean;
  /**
   * As duas alturas do frame (A14, D-322): `grande` é a de `/vendas` (224px),
   * `compacta` a da Home (165px). Separada de `area` de propósito — o que o
   * gráfico preenche e quanto espaço ele ocupa são duas escolhas.
   */
  altura?: "grande" | "compacta";
}): ReactNode {
  if (points.length === 0) return null;

  // RECUSA EM VEZ DE ZERO (D-237). Sob recorte de marca, `purchases_count` vem
  // NULL: pack atravessa SKU e não existe "compras da marca X". Plotar `?? 0`
  // desenharia uma linha rente ao eixo — visualmente idêntica a "esta marca
  // não teve compras", que é afirmação diferente e falsa.
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
  // vendidas seria um número errado com aparência de certo (D-131).
  const formatValue = metric.format === "currency" ? formatCurrency : formatCount;
  // Depois da recusa acima, o campo é numérico em todos os pontos.
  const valueAt = (point: DailyPoint): number => point[metric.field] ?? 0;

  const periodLength = businessDateRangeLength(rangeFrom, rangeTo);

  // Escala COMPARTILHADA pelas duas séries: dois eixos Y seriam mentira visual,
  // e usar só o máximo da série atual faria a linha anterior sair do quadro
  // justamente quando o período passado vendeu mais.
  const chartMax = tetoDaEscala([...points.map(valueAt), ...previousPoints.map(valueAt)]);

  function pontoDe(point: DailyPoint, inicio: string): Ponto {
    return { x: xPct(offsetInPeriod(point.metric_date, inicio), periodLength), y: yPct(valueAt(point), chartMax) };
  }

  // Valor do período anterior no MESMO offset, para a leitura de cada dia.
  // `undefined` (não 0) quando o dia não existe do outro lado: "sem dado" e
  // "vendeu zero" são afirmações diferentes, e a RPC não fabrica zero.
  const previousByOffset = indexByOffset(previousPoints, previousRangeFrom);
  const currentByOffset = indexByOffset(points, rangeFrom);

  const hasComparison = previousPoints.length > 0;

  // Do topo para a base, na ordem em que a coluna do eixo Y os empilha.
  const gridLines = [1, 0.5, 0].map((fraction) => chartMax * fraction);
  const gridLabel = (value: number): string =>
    metric.format === "count" ? formatValue(Math.round(value)) : formatValue(value);

  // No máximo ~7 rótulos no eixo X, mesmo com 90 dias — mais que isso empilha
  // texto ilegível.
  const labelStep = Math.max(1, Math.ceil(periodLength / 7));
  const offsets = Array.from({ length: periodLength }, (_unused, offset) => offset);

  const atuais = points.map((point) => pontoDe(point, rangeFrom));
  const linhaAtual = caminho(atuais);

  return (
    <figure className={`sb-chart sb-chart-${altura}`}>
      {/*
        O EIXO Y FORA DO SVG, como a `.chart-y` do frame. Três rótulos nas três
        linhas de grade; a coluna tem a largura do maior deles, e cada rótulo
        fica centrado na linha que nomeia.
      */}
      <div className="sb-chart-y" aria-hidden="true">
        {gridLines.map((value, indice) => (
          <span key={indice} style={{ gridRow: indice * 2 + 1 }}>
            {gridLabel(value)}
          </span>
        ))}
      </div>

      <div className="sb-chart-plot">
        <svg
          className="sb-chart-svg"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          role="img"
          aria-label={
            hasComparison
              ? `${metric.heading} no período selecionado, comparado com o período anterior`
              : `${metric.heading} no período selecionado`
          }
        >
          {gridLines.map((value, indice) => (
            <line
              key={indice}
              x1={0}
              x2={100}
              y1={yPct(value, chartMax)}
              y2={yPct(value, chartMax)}
              stroke="var(--sb-border)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {/*
            Período anterior ANTES do atual no DOM: em SVG a ordem é a ordem de
            pintura. Tracejada e mais fina porque é contexto — mas NÃO apagada.
          */}
          {hasComparison && (
            <path
              d={caminho(previousPoints.map((point) => pontoDe(point, previousRangeFrom)))}
              fill="none"
              stroke="var(--sb-muted-ink)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {area && atuais.length > 0 && (
            <>
              <defs>
                <linearGradient id="sb-chart-area" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="var(--sb-secondary)" stopOpacity="0.2" />
                  <stop offset="1" stopColor="var(--sb-secondary)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* A área fecha o traço até a linha de base: último x, primeiro x, chão. */}
              <path
                d={`${linhaAtual} L${(atuais[atuais.length - 1]?.x ?? 0).toFixed(2)},100 L${(atuais[0]?.x ?? 0).toFixed(2)},100 Z`}
                fill="url(#sb-chart-area)"
                stroke="none"
              />
            </>
          )}

          <path d={linhaAtual} fill="none" stroke="var(--sb-primary)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>

        {points.map((point, indice) => {
          const anterior = previousByOffset.get(offsetInPeriod(point.metric_date, rangeFrom));
          const ponto = atuais[indice];
          // O `title` carrega a MESMA informação que a caixa de hover: quem não
          // usa ponteiro não pode receber menos.
          const comparacao =
            anterior === undefined
              ? "sem dado no período anterior"
              : `período anterior (${formatBusinessDate(anterior.metric_date)}): ${formatValue(valueAt(anterior))}`;

          return ponto === undefined ? null : (
            <span
              key={point.metric_date}
              className="sb-chart-point"
              aria-hidden="true"
              style={{ left: `${ponto.x.toFixed(2)}%`, top: `${ponto.y.toFixed(2)}%` }}
              title={`${formatBusinessDate(point.metric_date)}: ${formatValue(valueAt(point))} · ${comparacao}`}
            />
          );
        })}

        {offsets.map((offset) => {
          const x = xPct(offset, periodLength);
          const faixa = faixaDoDia(offset, periodLength);
          const dia = shiftBusinessDate(rangeFrom, offset);
          const atual = currentByOffset.get(offset);
          const anterior = previousByOffset.get(offset);

          return (
            /*
              O grupo do dia não tem caixa própria: os filhos são absolutos em
              relação à ÁREA DE PLOTAGEM, e `:hover` no grupo vale quando o
              ponteiro está sobre o alvo dele. Assim a linha e a caixa de leitura
              são posicionadas contra o gráfico inteiro, não contra a faixa
              estreita do dia.
            */
            <div key={dia} className="sb-chart-band">
              <div
                className="sb-chart-alvo"
                style={{ left: `${faixa.esquerda.toFixed(2)}%`, width: `${faixa.largura.toFixed(2)}%` }}
              />

              <div className="sb-chart-hover" aria-hidden="true">
                <div className="sb-chart-hover-linha" style={{ left: `${x.toFixed(2)}%` }} />

                {atual !== undefined && (
                  <div
                    className="sb-chart-hover-ponto"
                    style={{ left: `${x.toFixed(2)}%`, top: `${yPct(valueAt(atual), chartMax).toFixed(2)}%` }}
                  />
                )}

                {/*
                  A caixa foge do ponto: na metade esquerda ela abre à direita, e
                  vice-versa — senão cobriria o trecho que a pessoa está olhando.
                */}
                <div className="sb-chart-leitura" style={offset < periodLength / 2 ? { right: "0.5rem" } : { left: "0.5rem" }}>
                  <b>{formatBusinessDate(dia)}</b>
                  <span>
                    {atual === undefined
                      ? "sem métrica calculada neste dia"
                      : `${metric.label}: ${formatValue(valueAt(atual))}`}
                  </span>
                  <span className="sb-chart-leitura-anterior">
                    {anterior === undefined
                      ? "período anterior: sem dado"
                      : `período anterior (${formatBusinessDate(anterior.metric_date)}): ${formatValue(valueAt(anterior))}`}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="sb-chart-x" aria-hidden="true">
        {offsets
          .filter((offset) => offset % labelStep === 0)
          .map((offset) => (
            <span key={offset} style={{ left: `${xPct(offset, periodLength).toFixed(2)}%` }}>
              {formatBusinessDate(shiftBusinessDate(rangeFrom, offset)).slice(0, 5)}
            </span>
          ))}
      </div>

      {/*
        A legenda só existe quando há o que legendar. Sem dado no período
        anterior, anunciar uma linha tracejada que não foi desenhada faria a
        tela descrever algo que não está lá.
      */}
      {hasComparison && (
        <figcaption
          style={{
            gridColumn: "1 / -1",
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
                stroke="var(--sb-muted-ink)"
                strokeWidth={1.5}
                strokeDasharray="4 3"
              />
            </svg>
            {/*
              A janela REAL, não a data do último ponto com dado: se o último
              dia do período anterior não tiver métrica calculada, rotular
              pelo último ponto encolheria a janela na legenda.
            */}
            Período anterior ({formatBusinessDate(previousRangeFrom)} a {formatBusinessDate(previousRangeTo)})
          </span>
          <span>Passe o ponteiro sobre um dia para ver os dois valores.</span>
        </figcaption>
      )}
    </figure>
  );
}
