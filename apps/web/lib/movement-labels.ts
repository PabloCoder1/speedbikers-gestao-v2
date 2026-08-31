/**
 * Vocabulário das Movimentações de estoque (D-167, trilha 5E) — o risco
 * nomeado do item é "IDs sem contexto": esta é a camada que traduz o ledger
 * para gente. Funções TOTAIS: tipo/origem desconhecidos degradam para o
 * valor cru, nunca para tela quebrada (mesmo espírito de
 * `describeActionEvidence`).
 */

/** Os 12 tipos aprovados do CHECK de `stock_movements` (ARCHITECTURE §12). */
const MOVEMENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  ENTRADA_NFE: "Entrada por NF-e",
  SAIDA_NFE: "Saída por NF-e",
  VENDA_ML: "Venda Mercado Livre",
  CANCELAMENTO_ML: "Cancelamento Mercado Livre",
  DEVOLUCAO_ML: "Devolução Mercado Livre",
  AJUSTE_MANUAL: "Ajuste manual",
  AJUSTE_RECONCILIACAO: "Ajuste de reconciliação (UpSeller)",
  TRANSFERENCIA: "Transferência",
  RESERVA: "Reserva",
  LIBERACAO_RESERVA: "Liberação de reserva",
  ENTRADA_TRANSITO: "Entrada em trânsito (compra)",
  RECEBIMENTO_TRANSITO: "Recebimento do trânsito",
};

const LOCATION_LABELS: Readonly<Record<string, string>> = {
  LOCAL: "Local",
  RESERVADO: "Reservado",
  TRANSITO: "Trânsito",
};

/** Os valores reais gravados pelos escritores do ledger (medidos + código). */
const SOURCE_TYPE_LABELS: Readonly<Record<string, string>> = {
  ORDER: "Pedido ML",
  RECONCILIATION: "Reconciliação UpSeller",
  CLAIM: "Reclamação/Devolução",
  DOCUMENT: "NF-e",
  PURCHASE_ORDER: "Pedido de compra",
};

export function movementTypeLabel(type: string): string {
  return MOVEMENT_TYPE_LABELS[type] ?? type;
}

export function locationKindLabel(kind: string): string {
  return LOCATION_LABELS[kind] ?? kind;
}

/**
 * Origem em texto: "Pedido ML 20001234" / "NF-e <id>" / "Ajuste sem
 * registro externo" quando não há origem (o caso legítimo do AJUSTE_MANUAL).
 */
export function movementSourceLabel(sourceType: string | null, sourceId: string | null): string {
  if (sourceType === null) {
    return "Sem registro externo";
  }

  const label = SOURCE_TYPE_LABELS[sourceType] ?? sourceType;

  return sourceId === null ? label : `${label} ${sourceId}`;
}

/** Delta com sinal explícito: entrada "+3", saída "−2" — o sinal É a informação. */
export function formatQtyDelta(delta: number): string {
  const formatted = new Intl.NumberFormat("pt-BR").format(Math.abs(delta));

  return delta > 0 ? `+${formatted}` : `−${formatted}`;
}
