"use client";

import type { ReactNode } from "react";

import { NIVEL, ROTULO_DA_FAIXA, type AlertaDeFrete } from "../../../../lib/detector-frete";

function escaparCsv(valor: string): string {
  if (/[";,\n\r]/.test(valor)) {
    return `"${valor.replace(/"/g, '""')}"`;
  }
  return valor;
}

function moedaCsv(valor: number | null): string {
  return valor === null ? "" : valor.toFixed(2).replace(".", ",");
}

function pctCsv(valor: number | null): string {
  return valor === null ? "" : `${(valor * 100).toFixed(2).replace(".", ",")}%`;
}

/**
 * Exporta os anúncios sinalizados pelo Detector de Frete em CSV (UTF-8 BOM, `;`)
 * para revisão operacional de peso/dimensões e abertura de chamados no ML.
 */
export function ExportarFreteCsv({ alertas }: { alertas: readonly AlertaDeFrete[] }): ReactNode {
  if (alertas.length === 0) return null;

  function baixar(): void {
    const cabecalho = [
      "Anúncio",
      "SKU",
      "Título",
      "Conta",
      "Nível",
      "Pontos",
      "Faixa de preço",
      "Pedidos (14d)",
      "Preço atual (R$)",
      "Frete atual (R$)",
      "Frete anterior (R$)",
      "Frete esperado (R$)",
      "Excesso 14d (R$)",
      "Frete / Receita (%)",
      "Margem atual (%)",
    ];

    const corpo = alertas.map((a) => [
      escaparCsv(a.anuncio),
      escaparCsv(a.sku ?? ""),
      escaparCsv(a.titulo),
      escaparCsv(a.conta),
      escaparCsv(NIVEL[a.nivel].rotulo),
      String(a.pontos),
      escaparCsv(ROTULO_DA_FAIXA[a.faixa]),
      String(a.pedidos_atual),
      moedaCsv(a.preco_atual),
      moedaCsv(a.frete_atual),
      moedaCsv(a.frete_antes),
      moedaCsv(a.frete_esperado),
      moedaCsv(a.excesso),
      pctCsv(a.frete_share_atual),
      pctCsv(a.margem_atual),
    ]);

    const csv = `\uFEFF${[cabecalho.join(";"), ...corpo.map((r) => r.join(";"))].join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "detector-frete-speedbikers.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button type="button" className="sb-button" onClick={baixar}>
      Exportar alertas (CSV)
    </button>
  );
}
