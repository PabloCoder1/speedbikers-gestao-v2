"use client";

import type { ReactNode } from "react";
import type { LinhaDre } from "@sb/domain";

function escaparCsv(valor: string): string {
  if (/[";,\n\r]/.test(valor)) {
    return `"${valor.replace(/"/g, '""')}"`;
  }
  return valor;
}

/**
 * Exporta a DRE Gerencial do período selecionado em CSV (separador `;`, UTF-8 BOM
 * compatível com Excel em português). Apenas leitura — respeita exatamente o
 * recorte que o usuário tem permissão para ver na tela.
 */
export function ExportarDreCsv({
  linhas,
  linhasAnterior = null,
  periodoRotulo,
}: {
  linhas: readonly LinhaDre[];
  linhasAnterior?: readonly LinhaDre[] | null;
  periodoRotulo: string;
}): ReactNode {
  function baixar(): void {
    const mapaAnterior = new Map((linhasAnterior ?? []).map((l) => [l.id, l]));
    const cabecalho = [
      "Etapa",
      "Tipo",
      "Origem",
      "Valor Atual (R$)",
      "% sobre Bruto",
      "Valor Anterior (R$)",
      "Variação (R$)",
      "Explicação",
    ];
    const corpo = linhas.map((l) => {
      const ant = mapaAnterior.get(l.id) ?? null;
      const variacao = l.valor !== null && ant !== null && ant.valor !== null ? l.valor - ant.valor : null;

      return [
        escaparCsv(l.rotulo),
        escaparCsv(l.tipo),
        escaparCsv(l.origem),
        l.valor === null ? "" : l.valor.toFixed(2).replace(".", ","),
        l.percentualSobreBruto === null ? "" : `${(l.percentualSobreBruto * 100).toFixed(2).replace(".", ",")}%`,
        ant?.valor == null ? "" : ant.valor.toFixed(2).replace(".", ","),
        variacao === null ? "" : variacao.toFixed(2).replace(".", ","),
        escaparCsv(l.explicacao),
      ];
    });

    const csv = `\uFEFF${[cabecalho.join(";"), ...corpo.map((r) => r.join(";"))].join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const slug = periodoRotulo.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();

    link.href = url;
    link.download = `dre-gerencial-speedbikers-${slug || "periodo"}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button type="button" className="sb-button" onClick={baixar}>
      Exportar DRE (CSV)
    </button>
  );
}
