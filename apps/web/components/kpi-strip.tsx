import Link from "next/link";
import type { ReactNode } from "react";

import { TOM, type Tom } from "./tone";

/**
 * Faixa de indicadores do Figma (`.kpi-strip`).
 *
 * **É UM cartão dividido em células, não vários cartões lado a lado** — essa é
 * a diferença de composição que mais muda a leitura da tela: a faixa se lê como
 * um bloco só, e o olho percorre os números em vez de tropeçar em seis molduras.
 *
 * `ancora` pinta a primeira célula de navy, como no Figma. É OPCIONAL de
 * propósito: a tela renderizada mostrou que, com três faixas empilhadas, três
 * células navy transformam ênfase em ruído. Só a faixa principal a recebe.
 *
 * As linhas divisórias vêm do `gap` sobre um fundo de borda, e não de
 * `border-right` por célula. É o que faz a faixa continuar certa quando ela
 * quebra em duas linhas na tela estreita — com borda por célula, a última de
 * cada linha ficaria com traço sobrando.
 *
 * ## O que esta faixa carrega além do Figma, e por quê
 *
 * O `.kpi` do Figma tem três linhas: rótulo, valor e uma **variação
 * percentual**. Aqui a terceira linha é o **valor do período anterior**, não a
 * variação: `variacao_percentual_periodo` está pendente de definição em
 * `docs/METRICS.md` 5.4, e D-023 proíbe exibir número sintetizado sem
 * `metric_definitions` por trás. Os dois valores lado a lado dizem a mesma
 * coisa sem inventar a terceira.
 *
 * E cada célula mostra o **id da métrica** em monoespaçado, mais a **ressalva**
 * quando existe. A ressalva é exigência de `docs/METRICS.md` 5C.2 — "visível ao
 * lado do número, nunca só em tooltip" —, e o id é a rastreabilidade que
 * permite achar a definição canônica. Nenhum dos dois está no Figma; nenhum dos
 * dois sai.
 */
export interface KpiCellData {
  /**
   * Id catalogado em `metric_definitions` — a rastreabilidade da métrica.
   *
   * **Opcional de propósito.** Nem toda faixa mostra métrica de negócio: a
   * curadoria de `/produtos`, por exemplo, conta ESTADOS do catálogo ("não
   * classificados", "a revisar"), que não estão no catálogo de métricas. Pôr um
   * id ali seria apontar para uma definição que não existe — pior do que não
   * apontar. Sem id, a linha não sai.
   */
  readonly metricId?: string;
  readonly label: string;
  /** Fórmula canônica ou explicação da contagem, no `title` da célula. */
  readonly formula: string;
  readonly value: string;
  /** `null` quando a comparação não se aplica (a seção "hoje" não compara). */
  readonly previous: string | null;
  /** Ressalva obrigatória de METRICS 5C.2, quando a métrica tem uma. */
  readonly ressalva?: string;
  /**
   * O chip "ver lista" do `.ops-metric` do Figma — a terceira linha da célula
   * na variante de OPERAÇÃO da faixa (o frame `Listings` usa `<Status>ver
   * lista</Status>` em todas as seis).
   *
   * Aqui ele é um LINK de verdade, para o recorte que produziu o número. É a
   * diferença entre um enfeite e a promessa que a célula faz: se a contagem diz
   * 17 sem estoque, clicar tem de mostrar os 17 — e mostra, porque contagem e
   * lista saem da mesma consulta filtrada.
   */
  readonly href?: string;
  /** Tom do chip, como no frame: cada estado tem o seu. */
  readonly tom?: Tom;
}

export function KpiStrip({
  cells,
  ancora = false,
}: {
  cells: readonly KpiCellData[];
  ancora?: boolean;
}): ReactNode {
  // Colunas FIXAS, como `.kpi-strip{repeat(5,1fr)}` do export: a faixa declara
  // quantas células tem e o CSS nunca deixa uma órfã. Faixas de 5 ou mais
  // descem a 3 colunas em 1150px (o degrau do `.ops-metrics`); todas descem a
  // 2 em 850px.
  const classes = ["sb-kpi-strip", ancora ? "sb-kpi-strip-ancora" : null, cells.length >= 5 ? "sb-kpi-strip-larga" : null]
    .filter((c): c is string => c !== null)
    .join(" ");

  return (
    <div className={classes} style={{ ["--sb-kpi-cols" as string]: String(cells.length) }}>
      {cells.map((cell) => (
        <div className="sb-kpi" key={cell.metricId ?? cell.label} title={cell.formula}>
          <span className="sb-kpi-label">{cell.label}</span>
          <strong className="sb-kpi-value">{cell.value}</strong>

          {cell.previous !== null && (
            <span className="sb-kpi-prev">período anterior: {cell.previous}</span>
          )}

          {cell.ressalva !== undefined && <span className="sb-kpi-note">{cell.ressalva}</span>}

          {cell.metricId !== undefined && <span className="sb-kpi-id">{cell.metricId}</span>}

          {cell.href !== undefined && (
            <Link className="sb-kpi-link" href={cell.href} style={TOM[cell.tom ?? "info"]}>
              ver lista
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}
