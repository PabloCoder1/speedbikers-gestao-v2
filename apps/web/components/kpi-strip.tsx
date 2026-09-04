import type { ReactNode } from "react";

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
}

export function KpiStrip({
  cells,
  ancora = false,
}: {
  cells: readonly KpiCellData[];
  ancora?: boolean;
}): ReactNode {
  return (
    <div className={ancora ? "sb-kpi-strip sb-kpi-strip-ancora" : "sb-kpi-strip"}>
      {cells.map((cell) => (
        <div className="sb-kpi" key={cell.metricId ?? cell.label} title={cell.formula}>
          <span className="sb-kpi-label">{cell.label}</span>
          <strong className="sb-kpi-value">{cell.value}</strong>

          {cell.previous !== null && (
            <span className="sb-kpi-prev">período anterior: {cell.previous}</span>
          )}

          {cell.ressalva !== undefined && <span className="sb-kpi-note">{cell.ressalva}</span>}

          {cell.metricId !== undefined && <span className="sb-kpi-id">{cell.metricId}</span>}
        </div>
      ))}
    </div>
  );
}
