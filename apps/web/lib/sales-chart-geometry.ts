/**
 * A GEOMETRIA do gráfico de vendas, em PORCENTAGEM da área de plotagem (A14,
 * D-322).
 *
 * O gráfico desenhava tudo num `viewBox` de 900×260 com `height: auto`: a altura
 * seguia a largura, e o TEXTO dentro do SVG também — medido, o eixo caía a
 * 2,4px numa tela de 375px e a 7px na Home a 1440px. O frame tem altura FIXA e
 * estica só a largura (`preserveAspectRatio="none"`), com os rótulos fora do SVG.
 *
 * Esticar só a largura deforma o que tem forma: texto e círculo. Então a
 * geometria passa a ser dita em porcentagem — o SVG (`viewBox 0 0 100 100`)
 * desenha só LINHAS, e texto e pontos viram HTML posicionado pelas mesmas
 * contas. Elas moram aqui, sem React, para serem testáveis.
 */

export interface Ponto {
  /** 0 = início do período, 100 = fim. */
  x: number;
  /** 0 = topo da escala, 100 = linha de base. */
  y: number;
}

/**
 * O teto da escala: 10% acima do maior valor, para o pico não encostar na borda.
 *
 * Série inteira em zero devolve 1 — o teto é divisor, e zero não desenharia
 * nada. Valores das DUAS séries entram juntos: escala compartilhada (D-137).
 */
export function tetoDaEscala(valores: readonly number[]): number {
  const maior = Math.max(0, ...valores);

  return maior === 0 ? 1 : maior * 1.1;
}

/** Posição horizontal do dia `offset` num período de `diasNoPeriodo` dias. */
export function xPct(offset: number, diasNoPeriodo: number): number {
  if (diasNoPeriodo <= 1) return 50;

  return (100 * offset) / (diasNoPeriodo - 1);
}

/** Posição vertical de um valor contra o teto: o teto no topo, o zero na base. */
export function yPct(valor: number, teto: number): number {
  return 100 - (100 * valor) / teto;
}

/**
 * A faixa de hover do dia: meia distância para cada lado do ponto, CORTADA nas
 * bordas. Sem o corte, a faixa do primeiro e do último dia sairia da área de
 * plotagem — e em HTML, ao contrário do SVG, sair da caixa é ocupar espaço de
 * outro elemento.
 */
export function faixaDoDia(offset: number, diasNoPeriodo: number): { esquerda: number; largura: number } {
  if (diasNoPeriodo <= 1) return { esquerda: 0, largura: 100 };

  const passo = 100 / (diasNoPeriodo - 1);
  const centro = xPct(offset, diasNoPeriodo);
  const esquerda = Math.max(0, centro - passo / 2);
  const direita = Math.min(100, centro + passo / 2);

  return { esquerda, largura: direita - esquerda };
}

/** O `d` de um `<path>` que liga os pontos na ordem dada. */
export function caminho(pontos: readonly Ponto[]): string {
  return pontos.map((ponto, indice) => `${indice === 0 ? "M" : "L"}${ponto.x.toFixed(2)},${ponto.y.toFixed(2)}`).join(" ");
}
