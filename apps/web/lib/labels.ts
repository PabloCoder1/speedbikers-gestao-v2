/**
 * Rótulos em português para os códigos guardados no banco.
 *
 * O banco guarda o código em inglês (`PARSED`, `LINKS`) porque ele é contrato
 * entre `api`, `worker` e migrations. A tradução é da interface, e viver num
 * lugar só evita que a mesma coisa apareça com dois nomes em telas diferentes.
 */

const BATCH_STATUS: Record<string, string> = {
  UPLOADED: "Enviado",
  PARSING: "Lendo o arquivo",
  PARSED: "Aguardando conferência",
  APPLYING: "Aplicando",
  APPLIED: "Aplicado",
  FAILED: "Falhou",
  CANCELLED: "Cancelado",
};

const ROW_STATUS: Record<string, string> = {
  OK: "OK",
  SKIPPED: "Ignorada",
  INVALID: "Inválida",
};

const KIND: Record<string, string> = {
  PRODUCTS: "Produtos",
  KITS: "Kits",
  LINKS: "Vínculos",
  STOCK: "Estoque",
};

function lookup(table: Record<string, string>, code: string): string {
  return table[code] ?? code;
}

export const batchStatusLabel = (code: string): string => lookup(BATCH_STATUS, code);
export const rowStatusLabel = (code: string): string => lookup(ROW_STATUS, code);
export const kindLabel = (code: string): string => lookup(KIND, code);

/** Cor de destaque por estado. `null` = sem destaque, o padrão da tabela. */
export function statusTone(code: string): "ok" | "warn" | "bad" | null {
  if (code === "APPLIED" || code === "OK") return "ok";
  if (code === "PARSED" || code === "SKIPPED" || code === "PARSING") return "warn";
  if (code === "FAILED" || code === "INVALID" || code === "CANCELLED") return "bad";

  return null;
}
