/**
 * Exportação CSV da Central Full (D-380) — o recorte da tela, para montar o
 * envio ao Full numa planilha.
 *
 * Formato do Excel brasileiro: `;` como separador, vírgula decimal e BOM UTF-8
 * no começo — sem o BOM, o Excel abre "Saudável" como "SaudÃ¡vel". Função
 * pura, separada da rota, para o formato ter teste.
 */

import { csvCell as cell, csvNumber as numero } from "./csv";
import { formatDateTime } from "./format";
import { formatCoverage, fullSituationLabel } from "./full-filters";

export interface FullExportRow {
  sku: string;
  sku_title: string | null;
  account_label: string;
  situation: string;
  units_sold: number;
  daily_rate: number | null;
  full_quantity: number;
  coverage_days: number | null;
  local_quantity: number;
  captured_at: string;
}

/** Teto da exportação. A rota diz no nome do arquivo quando o recorte passou dele. */
export const EXPORT_LIMIT = 5000;

const HEADER = [
  "SKU",
  "Produto",
  "Conta",
  "Situação",
  "Venda 30 dias",
  "Venda média por dia",
  "Estoque Full",
  "Cobertura (dias)",
  "Estoque local",
  "Capturado em",
];

export function fullRowsToCsv(rows: readonly FullExportRow[]): string {
  const linhas = rows.map((row) =>
    [
      cell(row.sku),
      cell(row.sku_title ?? ""),
      cell(row.account_label),
      cell(fullSituationLabel(row.situation)),
      numero(row.units_sold),
      numero(row.daily_rate),
      numero(row.full_quantity),
      // Sem venda não há cobertura: a célula diz isso em vez de ficar vazia.
      row.coverage_days === null ? cell(formatCoverage(null)) : numero(row.coverage_days),
      numero(row.local_quantity),
      cell(formatDateTime(row.captured_at)),
    ].join(";"),
  );

  return `\uFEFF${[HEADER.join(";"), ...linhas].join("\r\n")}\r\n`;
}
