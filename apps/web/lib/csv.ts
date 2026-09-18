/**
 * CSV no formato do Excel brasileiro: `;` como separador, vírgula decimal, BOM
 * UTF-8 no começo e CRLF entre linhas. Saiu de `full-export.ts` (D-380) quando
 * `/anuncios` ganhou a segunda exportação (D-385) — as duas tinham de proteger
 * as células do mesmo jeito.
 */

const DECIMAL = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2, useGrouping: false });

/**
 * Aspas sempre que houver separador, aspas ou quebra de linha (RFC 4180). E o
 * prefixo "'" neutraliza fórmula (=, +, -, @) vinda de título de anúncio —
 * injeção de fórmula ao abrir no Excel.
 */
export function csvCell(value: string): string {
  const seguro = /^[=+\-@]/.test(value) ? `'${value}` : value;

  return /[";\n\r]/.test(seguro) ? `"${seguro.replace(/"/g, '""')}"` : seguro;
}

/** Número com vírgula decimal e sem separador de milhar; ausente vira célula vazia. */
export function csvNumber(value: number | null): string {
  return value === null ? "" : DECIMAL.format(value);
}

/** O arquivo inteiro: BOM, cabeçalho e linhas já montadas. */
export function csvDocument(header: readonly string[], linhas: readonly string[][]): string {
  return `\uFEFF${[header.join(";"), ...linhas.map((linha) => linha.join(";"))].join("\r\n")}\r\n`;
}
