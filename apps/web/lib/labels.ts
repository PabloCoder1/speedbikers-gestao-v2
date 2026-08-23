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

/**
 * Desfecho da APLICAÇÃO de uma linha (`apply_status`), diferente de
 * `rowStatusLabel`, que traduz o desfecho da LEITURA (`status`). `NULL` no
 * banco significa "ainda não aplicada" e nunca chega aqui — a tela só chama
 * isto quando o valor existe.
 */
const APPLY_STATUS: Record<string, string> = {
  APPLIED: "Aplicada",
  UNRESOLVED: "Pendente",
  FAILED: "Falhou",
};

const KIND: Record<string, string> = {
  PRODUCTS: "Produtos",
  KITS: "Kits",
  LINKS: "Vínculos",
  STOCK: "Estoque",
};

/** `documents.operation_type` (docs/NFE.md secao 2.2) — nunca `ide/tpNF` sozinho, D-053. */
const OPERATION_TYPE: Record<string, string> = {
  ENTRADA: "Entrada",
  SAIDA: "Saída",
};

/** `purchase_orders.status` — ciclo DRAFT->APPROVED->ORDERED->RECEIVED, CANCELLED de qualquer estado não-terminal. */
const PURCHASE_ORDER_STATUS: Record<string, string> = {
  DRAFT: "Rascunho",
  APPROVED: "Aprovado",
  ORDERED: "Pedido enviado",
  RECEIVED: "Recebido",
  CANCELLED: "Cancelado",
};

/** `purchase_order_events.event_type`. */
const PURCHASE_ORDER_EVENT: Record<string, string> = {
  CREATED: "Criado",
  UPDATED: "Atualizado",
  APPROVED: "Aprovado",
  ORDERED: "Marcado como pedido",
  RECEIVED: "Recebido",
  CANCELLED: "Cancelado",
};

/** `stock_movements.location_kind` — Full (D-018) fica fora, é snapshot, não ledger. */
const LOCATION_KIND: Record<string, string> = {
  LOCAL: "Local",
  RESERVADO: "Reservado",
  TRANSITO: "Em trânsito",
};

/**
 * `listings.status` — só os dois valores confirmados nesta sessão
 * (`docs/MERCADO_LIVRE.md` secao 2, "Items & Searches": `?status=active` e a
 * menção a pausar um anúncio). Outros valores possíveis do Mercado Livre
 * (`closed`, `under_review`, `inactive`) caem no fallback de `lookup()` — o
 * código bruto aparece em vez de travar, mesmo raciocínio do resto do mapa.
 */
const LISTING_STATUS: Record<string, string> = {
  active: "Ativo",
  paused: "Pausado",
};

function lookup(table: Record<string, string>, code: string): string {
  return table[code] ?? code;
}

export const batchStatusLabel = (code: string): string => lookup(BATCH_STATUS, code);
export const rowStatusLabel = (code: string): string => lookup(ROW_STATUS, code);
export const applyStatusLabel = (code: string): string => lookup(APPLY_STATUS, code);
export const kindLabel = (code: string): string => lookup(KIND, code);
export const operationTypeLabel = (code: string): string => lookup(OPERATION_TYPE, code);
export const purchaseOrderStatusLabel = (code: string): string => lookup(PURCHASE_ORDER_STATUS, code);
export const purchaseOrderEventLabel = (code: string): string => lookup(PURCHASE_ORDER_EVENT, code);
export const locationKindLabel = (code: string): string => lookup(LOCATION_KIND, code);
export const listingStatusLabel = (code: string): string => lookup(LISTING_STATUS, code);

/** Cor de destaque por estado. `null` = sem destaque, o padrão da tabela. */
export function statusTone(code: string): "ok" | "warn" | "bad" | null {
  if (code === "APPLIED" || code === "OK" || code === "RECEIVED") return "ok";
  if (
    code === "PARSED" ||
    code === "SKIPPED" ||
    code === "PARSING" ||
    code === "UNRESOLVED" ||
    code === "DRAFT" ||
    code === "APPROVED" ||
    code === "ORDERED"
  ) {
    return "warn";
  }

  if (code === "active") return "ok";
  if (code === "paused") return "warn";
  if (code === "FAILED" || code === "INVALID" || code === "CANCELLED") return "bad";

  return null;
}
