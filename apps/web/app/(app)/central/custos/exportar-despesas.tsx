"use client";

import type { ReactNode } from "react";
import { ROTULO_CATEGORIA_DESPESA, type CategoriaDespesa, type ClassificacaoCusto, type MetodoRateio, type StatusDespesa } from "@sb/domain";

export interface DespesaParaCsv {
  readonly name: string;
  readonly category: CategoriaDespesa;
  readonly cost_type: ClassificacaoCusto;
  readonly recurrence: string;
  readonly allocation_method: MetodoRateio;
  readonly marketplace: string | null;
  readonly cost_center: string | null;
  readonly competence_date: string;
  readonly due_date: string | null;
  readonly planned_amount: number | string;
  readonly actual_amount: number | string | null;
  readonly status: StatusDespesa;
  readonly note: string | null;
}

function escapar(v: string): string {
  return /[";,\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function moedaCsv(v: number | string | null): string {
  if (v === null) return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2).replace(".", ",") : "";
}

export function ExportarDespesasCsv({ despesas }: { despesas: readonly DespesaParaCsv[] }): ReactNode {
  if (despesas.length === 0) return null;

  function baixar(): void {
    const cabecalho = [
      "Despesa",
      "Categoria",
      "Classificação",
      "Recorrência",
      "Rateio",
      "Marketplace",
      "Centro de Custo",
      "Competência",
      "Vencimento",
      "Previsto (R$)",
      "Realizado (R$)",
      "Status",
      "Observação",
    ];

    const linhas = despesas.map((d) => [
      escapar(d.name),
      escapar(ROTULO_CATEGORIA_DESPESA[d.category]),
      d.cost_type === "fixo" ? "Fixo" : "Variável",
      escapar(d.recurrence),
      escapar(d.allocation_method),
      escapar(d.marketplace ?? "TODOS"),
      escapar(d.cost_center ?? ""),
      d.competence_date,
      d.due_date ?? "",
      moedaCsv(d.planned_amount),
      moedaCsv(d.actual_amount),
      d.status,
      escapar(d.note ?? ""),
    ]);

    const csv = `\uFEFF${[cabecalho.join(";"), ...linhas.map((l) => l.join(";"))].join("\r\n")}`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `despesas-operacionais-speedbikers-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <button type="button" className="sb-button" onClick={baixar}>
      Exportar despesas (CSV)
    </button>
  );
}
