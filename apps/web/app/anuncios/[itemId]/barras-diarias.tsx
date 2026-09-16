import { businessDateRangeLength, shiftBusinessDate } from "@sb/domain";
import type { ReactNode } from "react";

import { formatBusinessDate } from "../../../lib/format";

export interface DiaObservado {
  readonly data: string;
  readonly valor: number;
}

/**
 * BARRAS POR DIA do Dashboard do Anúncio — uma coluna por dia do período.
 *
 * Barras, e não a linha de `SalesChart`: aqui cada dia é um fato discreto e
 * isolado, e a ausência precisa APARECER. `daily_listing_metrics` só
 * materializa dia com venda e `daily_listing_visits` só tem dia com coleta —
 * uma linha ligaria dois pontos por cima do buraco e desenharia uma tendência
 * que ninguém mediu. Dia sem linha vira um tracinho pontilhado, nunca uma
 * barra de altura zero: "sem registro" e "zero" são afirmações diferentes
 * (D-067, D-123).
 *
 * Server Component e CSS puro, como o gráfico de `/vendas`: o hover de cada
 * coluna abre a leitura sem JavaScript, e o `title` carrega o mesmo texto para
 * quem não usa ponteiro.
 */
export function BarrasDiarias({
  dias,
  inicio,
  fim,
  formatar,
  rotulo,
  semRegistro,
  total,
  tom = "primaria",
}: {
  dias: readonly DiaObservado[];
  inicio: string;
  fim: string;
  formatar: (valor: number) => string;
  /** Nome da série, para o `aria-label` e a leitura. */
  rotulo: string;
  /** O que dizer do dia sem linha — "sem venda registrada", "sem coleta". */
  semRegistro: string;
  /**
   * O total JÁ FORMATADO, vindo da RPC de resumo — somado no banco, não aqui
   * (agregação em SQL, nunca em JavaScript). `null` quando o resumo não veio.
   */
  total: string | null;
  tom?: "primaria" | "secundaria";
}): ReactNode {
  const comprimento = businessDateRangeLength(inicio, fim);
  const porDia = new Map(dias.map((dia) => [dia.data, dia.valor]));
  const maximo = Math.max(0, ...dias.map((dia) => dia.valor));
  const passoRotulo = Math.max(1, Math.ceil(comprimento / 6));

  return (
    <figure
      className={`sb-bars sb-bars-${tom}`}
      role="img"
      aria-label={`${rotulo} por dia, de ${formatBusinessDate(inicio)} a ${formatBusinessDate(fim)}: ${String(dias.length)} dia(s) com registro`}
    >
      <div className="sb-bars-plot" style={{ ["--sb-bars-n" as string]: String(comprimento) }}>
        <span className="sb-bars-max" aria-hidden="true">
          {maximo === 0 ? "" : formatar(maximo)}
        </span>

        {dias.length === 0 && (
          <span className="sb-bars-sem-dado">
            <span>Nenhum dia com registro no período — {semRegistro} em todos os dias.</span>
          </span>
        )}

        {Array.from({ length: comprimento }, (_unused, offset) => {
          const dia = shiftBusinessDate(inicio, offset);
          const valor = porDia.get(dia);
          const leitura = `${formatBusinessDate(dia)} · ${valor === undefined ? semRegistro : `${rotulo}: ${formatar(valor)}`}`;
          const altura = valor === undefined || maximo === 0 ? 0 : Math.max(4, (valor / maximo) * 100);
          const lado = offset < comprimento / 2 ? "sb-bars-tip-dir" : "sb-bars-tip-esq";

          return (
            <div key={dia} className="sb-bars-col" title={leitura}>
              {valor === undefined ? (
                <span className="sb-bars-vazio" />
              ) : (
                <span className="sb-bars-barra" style={{ height: `${altura.toFixed(1)}%` }} />
              )}
              <span className={`sb-bars-tip ${lado}`} aria-hidden="true">
                <b>{formatBusinessDate(dia)}</b>
                {valor === undefined ? semRegistro : formatar(valor)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="sb-bars-x" aria-hidden="true">
        {Array.from({ length: comprimento }, (_unused, offset) => offset)
          .filter((offset) => offset % passoRotulo === 0 || offset === comprimento - 1)
          .map((offset) => (
            <span key={offset} style={{ left: `${(((offset + 0.5) / comprimento) * 100).toFixed(2)}%` }}>
              {formatBusinessDate(shiftBusinessDate(inicio, offset)).slice(0, 5)}
            </span>
          ))}
      </div>

      <figcaption className="sb-bars-legenda">
        <span>
          <i className="sb-bars-legenda-barra" /> {rotulo}
          {total === null ? "" : ` · total ${total}`}
        </span>
        <span>
          <i className="sb-bars-legenda-vazio" /> {semRegistro}
        </span>
      </figcaption>
    </figure>
  );
}
