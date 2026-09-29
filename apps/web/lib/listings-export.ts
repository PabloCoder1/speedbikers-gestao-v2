/**
 * Exportação CSV de `/anuncios` (D-385) — o MESMO recorte da tela, sem página.
 * Formato do Excel brasileiro (`lib/csv.ts`). Função pura, separada da rota,
 * para o formato ter teste.
 */
import { csvCell, csvDocument, csvNumber } from "./csv";
import { formatDateTime } from "./format";
import { listingStatusLabel } from "./labels";

export interface ListingExportRow {
  item_id: string;
  title: string;
  sku: string | null;
  link_state: string;
  account_label: string;
  status: string;
  price: number;
  available_quantity: number;
  full_quantity: number | null;
  units_sold: number;
  gross_revenue: number;
  visits: number | null;
  days_observed: number;
  conversion_rate: number | null;
  synced_at: string;
  permalink?: string | null;
  /** D-419: AUSENTES com o banco anterior a 20260929120000 — células vazias. */
  in_promotion?: boolean | null;
  promotional_price?: number | null;
}

/** Teto da exportação. A rota diz no nome do arquivo quando o recorte passou dele (D-131). */
export const EXPORT_LIMIT = 5000;

const HEADER = [
  "MLB",
  "Título",
  "SKU",
  "Vínculo",
  "Conta",
  "Status",
  "Preço",
  "Em promoção",
  "Preço promocional",
  "Estoque do anúncio",
  "Full",
  "Unidades",
  "Faturamento",
  "Visitas",
  "Dias com visita observada",
  "Conversão (%)",
  "Sincronizado em",
  "Link no Mercado Livre",
];

const VINCULO: Record<string, string> = {
  linked: "Vinculado",
  linked_variation: "Por variação",
  unlinked: "Sem vínculo",
};

export function listingsToCsv(rows: readonly ListingExportRow[], janelaDias: number): string {
  const linhas = rows.map((row) => [
    csvCell(row.item_id),
    csvCell(row.title),
    csvCell(row.sku ?? ""),
    csvCell(VINCULO[row.link_state] ?? row.link_state),
    csvCell(row.account_label),
    csvCell(listingStatusLabel(row.status)),
    csvNumber(row.price),
    // Não lido (ou banco anterior): vazio, nunca "Não" (D-419).
    row.in_promotion === true ? "Sim" : row.in_promotion === false ? "Não" : "",
    csvNumber(row.promotional_price ?? null),
    csvNumber(row.available_quantity),
    // Sem snapshot de Full: célula vazia, nunca "0" (D-067).
    csvNumber(row.full_quantity),
    csvNumber(row.units_sold),
    csvNumber(row.gross_revenue),
    csvNumber(row.visits),
    row.days_observed === 0 ? "" : `${String(row.days_observed)}/${String(janelaDias)}`,
    // Taxa em PERCENTUAL, como a tela mostra; sem visita, vazia — nunca 0%.
    row.conversion_rate === null ? "" : csvNumber(row.conversion_rate * 100),
    csvCell(formatDateTime(row.synced_at)),
    csvCell(row.permalink ?? ""),
  ]);

  return csvDocument(HEADER, linhas);
}
