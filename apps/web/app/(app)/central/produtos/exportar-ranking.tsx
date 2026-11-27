"use client";

import type { ReactNode } from "react";
import type { ProdutoDoRanking } from "../../../../lib/ranking-produtos";

function escapar(v: string): string {
  return /[";,\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function num(v: number | null, casas = 2): string {
  if (v === null || !Number.isFinite(v)) return "";
  return v.toFixed(casas).replace(".", ",");
}

function pct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "";
  return `${(v * 100).toFixed(2).replace(".", ",")}%`;
}

export function ExportarRankingCsv({
  itens,
  periodoRotulo,
}: {
  itens: readonly ProdutoDoRanking[];
  periodoRotulo: string;
}): ReactNode {
  if (itens.length === 0) return null;

  function baixar(): void {
    const cabecalho = [
      "SKU",
      "Produto",
      "Pedidos",
      "Pedidos Cobertos",
      "Unidades",
      "Receita Bruta (R$)",
      "Receita Coberta (R$)",
      "Comissão (R$)",
      "Frete Vendedor (R$)",
      "Custo / CMV (R$)",
      "Custo Atual?",
      "Resultado (R$)",
      "Margem do Produto (%)",
      "Resultado após Imposto (R$)",
      "Margem após Imposto (%)",
    ];

    const linhas = itens.map((p) => [
      escapar(p.sku),
      escapar(p.title ?? p.sku),
      String(p.pedidos),
      String(p.pedidos_cobertos),
      String(p.unidades),
      num(p.receita_bruta),
      num(p.receita_coberta),
      num(p.taxas_ml),
      num(p.frete_vendedor),
      num(p.custo_produtos),
      p.custo_atual ? "Sim" : "Não",
      num(p.resultado_venda),
      pct(p.margem_venda),
      num(p.resultado_apos_imposto),
      pct(p.margem_apos_imposto),
    ]);

    const csv = `\uFEFF${[cabecalho.join(";"), ...linhas.map((l) => l.join(";"))].join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const slug = periodoRotulo.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase();

    link.href = url;
    link.download = `rentabilidade-produtos-speedbikers-${slug || "periodo"}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button type="button" className="sb-button" onClick={baixar}>
      Exportar página (CSV)
    </button>
  );
}
