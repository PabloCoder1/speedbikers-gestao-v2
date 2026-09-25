import { businessDateRangeLength, shiftBusinessDate } from "@sb/domain";
import type { ReactNode } from "react";

import {
  rotuloDaMargemMinima,
  barraDaMargem,
  escalaDasMargens,
  tomDaMargem,
  type DiaFaturamento,
} from "../../lib/faturamento";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../lib/format";

function pct(fracao: number): string {
  return `${(fracao * 100).toFixed(2)}%`;
}

function leituraDoDia(dia: string, dado: DiaFaturamento | undefined): string {
  if (dado === undefined) return `${formatBusinessDate(dia)}: sem venda`;

  const margem =
    dado.margem_venda === null
      ? "sem pedido coberto"
      : `margem ${formatPercent(dado.margem_venda)} sobre ${formatCurrency(dado.receita_coberta)} cobertos`;

  return `${formatBusinessDate(dia)}: ${formatCurrency(dado.receita_bruta)} em ${formatCount(dado.pedidos)} pedidos · ${margem}`;
}

/**
 * Receita e margem por dia (D-356) — duas faixas sobre o MESMO eixo de dias.
 *
 * Duas faixas, e não dois eixos Y num gráfico só: reais e percentual na mesma
 * área seriam duas escalas fingindo uma (a regra do gráfico de `/vendas`). A de
 * cima é a receita de todos os pedidos; a de baixo, a margem dos pedidos
 * cobertos de cada dia — dia sem pedido coberto fica sem barra, e isso não é
 * margem zero.
 *
 * Colunas em HTML com altura em porcentagem: a largura estica e a altura é a do
 * CSS, sem texto deformado. A leitura exata de cada dia está no `title` da
 * coluna, a mesma para as duas faixas.
 */
export function BarrasDiarias({
  dias,
  rangeFrom,
  rangeTo,
  margemMinima,
}: {
  dias: readonly DiaFaturamento[];
  rangeFrom: string;
  rangeTo: string;
  /** A linha de referência e o tom das barras (D-410). */
  margemMinima: number;
}): ReactNode {
  const total = businessDateRangeLength(rangeFrom, rangeTo);
  const porDia = new Map(dias.map((d) => [d.dia, d]));
  const colunas = Array.from({ length: total }, (_unused, offset) => {
    const dia = shiftBusinessDate(rangeFrom, offset);

    return { dia, dado: porDia.get(dia) };
  });

  const maiorReceita = Math.max(0, ...dias.map((d) => d.receita_bruta));
  const escala = escalaDasMargens(
    dias.map((d) => d.margem_venda),
    margemMinima,
  );
  const passo = Math.max(1, Math.ceil(total / 7));
  const diasComMargem = dias.filter((d) => d.margem_venda !== null).length;

  return (
    <div className="sb-barras">
      <div className="sb-barras-cabeca">
        <strong>Receita bruta</strong>
        <span>maior dia: {formatCurrency(maiorReceita)}</span>
      </div>

      <div
        className="sb-barras-plot sb-barras-receita"
        role="img"
        aria-label={`Receita bruta por dia, de ${formatBusinessDate(rangeFrom)} a ${formatBusinessDate(rangeTo)}; o maior dia somou ${formatCurrency(maiorReceita)}`}
      >
        {colunas.map(({ dia, dado }) => (
          <div key={dia} className="sb-barras-col" title={leituraDoDia(dia, dado)}>
            {dado !== undefined && maiorReceita > 0 && (
              <span className="sb-barras-barra" style={{ height: pct(dado.receita_bruta / maiorReceita) }} />
            )}
          </div>
        ))}
      </div>

      <div className="sb-barras-cabeca">
        <strong>Margem sobre a venda</strong>
        <span className="sb-barras-legenda">
          <span className="sb-barras-chave sb-barras-ok">10% ou mais</span>
          <span className="sb-barras-chave sb-barras-atencao">abaixo de 10%</span>
          <span className="sb-barras-chave sb-barras-perigo">negativa</span>
        </span>
      </div>

      {diasComMargem === 0 ? (
        <p className="sb-barras-vazio">Nenhum dia do período tem pedido coberto — não há margem para desenhar.</p>
      ) : (
        <div
          className="sb-barras-plot sb-barras-margem"
          role="img"
          aria-label={`Margem sobre a venda por dia, em ${formatCount(diasComMargem)} dias com pedido coberto; a linha tracejada marca ${rotuloDaMargemMinima(margemMinima)}`}
        >
          <span className="sb-barras-zero" style={{ bottom: pct(escala.zero) }} />
          <span className="sb-barras-meta" style={{ bottom: pct(escala.zero + margemMinima / escala.total) }}>
            <span>{rotuloDaMargemMinima(margemMinima)}</span>
          </span>

          {colunas.map(({ dia, dado }) => {
            const margem = dado?.margem_venda ?? null;
            const barra = margem === null ? null : barraDaMargem(margem, escala);

            return (
              <div key={dia} className="sb-barras-col" title={leituraDoDia(dia, dado)}>
                {barra !== null && (
                  <span
                    className={`sb-barras-barra sb-barras-${tomDaMargem(margem, margemMinima)}`}
                    style={{ bottom: pct(barra.base), height: pct(barra.altura) }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="sb-barras-x" aria-hidden="true">
        {colunas
          .map((coluna, offset) => ({ ...coluna, offset }))
          .filter(({ offset }) => offset % passo === 0)
          .map(({ dia, offset }) => (
            <span key={dia} style={{ left: pct((offset + 0.5) / total) }}>
              {formatBusinessDate(dia).slice(0, 5)}
            </span>
          ))}
      </div>
    </div>
  );
}
