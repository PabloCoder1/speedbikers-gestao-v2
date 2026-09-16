import type { ReactNode } from "react";

import type { DegrauDaCascata } from "../../lib/faturamento";
import { formatCurrency, formatPercent } from "../../lib/format";

function pct(fracao: number): string {
  return `${(fracao * 100).toFixed(2)}%`;
}

/**
 * "Para onde vai o dinheiro" (D-356): da receita ao resultado, degrau a degrau.
 *
 * Server Component e CSS puro, como o gráfico de `/vendas`. A geometria vem
 * pronta de `montarCascata` — aqui só se desenha. Cada linha carrega o texto
 * inteiro (rótulo, valor e percentual), então a barra é decoração: quem não a vê
 * não perde nada.
 */
export function Cascata({ degraus }: { degraus: readonly DegrauDaCascata[] }): ReactNode {
  return (
    <ol className="sb-cascata">
      {degraus.map((degrau) => {
        const negativo = degrau.tipo !== "deducao" && degrau.valor < 0;
        const classes = ["sb-cascata-degrau", `sb-cascata-${degrau.tipo}`, negativo ? "sb-cascata-negativo" : null]
          .filter((c): c is string => c !== null)
          .join(" ");

        return (
          <li key={degrau.chave} className={classes}>
            <span className="sb-cascata-rotulo">
              <strong>{degrau.rotulo}</strong>
              <span>{degrau.metricId}</span>
            </span>

            <span className="sb-cascata-trilha" aria-hidden="true">
              <span className="sb-cascata-barra" style={{ left: pct(degrau.inicio), width: pct(degrau.largura) }} />
            </span>

            <span className="sb-cascata-valor">
              {degrau.tipo === "deducao" ? `− ${formatCurrency(Math.abs(degrau.valor))}` : formatCurrency(degrau.valor)}
            </span>

            <span className="sb-cascata-pct">
              {degrau.tipo === "deducao" ? formatPercent(Math.abs(degrau.fracao)) : formatPercent(degrau.fracao)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
