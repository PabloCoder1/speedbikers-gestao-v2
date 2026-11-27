"use client";

import type { ReactNode } from "react";

import { estimar, NIVEL_ADS, type CampanhaSinal } from "../../../../lib/sinais-ads";

function escaparCsv(valor: string): string {
  if (/[";,\n\r]/.test(valor)) {
    return `"${valor.replace(/"/g, '""')}"`;
  }
  return valor;
}

function numCsv(valor: number | null): string {
  return valor === null ? "" : valor.toFixed(2).replace(".", ",");
}

function pctCsv(valor: number | null): string {
  return valor === null ? "" : `${(valor * 100).toFixed(2).replace(".", ",")}%`;
}

/**
 * Exporta todas as campanhas da semana consolidada de Mercado Ads em CSV (UTF-8 BOM, `;`)
 * com ROAS, ACOS, margem estimada após Ads e lucro estimado.
 */
export function ExportarAdsCsv({
  campanhas,
  margemMedia,
}: {
  campanhas: readonly CampanhaSinal[];
  margemMedia: number | null;
}): ReactNode {
  if (campanhas.length === 0) return null;

  function baixar(): void {
    const cabecalho = [
      "Campanha",
      "Conta",
      "Sinal",
      "Status",
      "Investimento (R$)",
      "Vendas com Ads (R$)",
      "Unidades",
      "ROAS",
      "ROAS Alvo",
      "ACOS",
      "CPC (R$)",
      "CTR",
      "Conversão",
      "Orçamento Diário (R$)",
      "Margem Após Ads",
      "Lucro Estimado (R$)",
    ];

    const corpo = campanhas.map((c) => {
      const { lucro, margemAposAds } = estimar(c, margemMedia);
      return [
        escaparCsv(c.nome),
        escaparCsv(c.conta),
        escaparCsv(NIVEL_ADS[c.nivel].rotulo),
        escaparCsv(c.status ?? ""),
        numCsv(c.investimento),
        numCsv(c.receita_ads),
        String(c.unidades),
        numCsv(c.roas),
        numCsv(c.roas_alvo),
        pctCsv(c.acos),
        numCsv(c.cpc),
        pctCsv(c.ctr),
        pctCsv(c.conversao),
        numCsv(c.orcamento),
        pctCsv(margemAposAds),
        numCsv(lucro),
      ];
    });

    const csv = `\uFEFF${[cabecalho.join(";"), ...corpo.map((r) => r.join(";"))].join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "sinais-ads-speedbikers.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button type="button" className="sb-button" onClick={baixar}>
      Exportar campanhas (CSV)
    </button>
  );
}
