/**
 * Vocabulário das Movimentações de estoque (D-167, trilha 5E) — o risco
 * nomeado do item é "IDs sem contexto": esta é a camada que traduz o ledger
 * para gente. Funções TOTAIS: tipo/origem desconhecidos degradam para o
 * valor cru, nunca para tela quebrada (mesmo espírito de
 * `describeActionEvidence`).
 */

/** Os 16 tipos aprovados do CHECK de `stock_movements` (ARCHITECTURE §12; o 13º e o 14º em D-351, o 15º em D-375, o 16º em D-352). */
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
  // D-351: a venda anterior à planilha do UpSeller é gravada e anulada por este
  // par — o ERP já a tinha descontado.
  ESTORNO_PRE_CAPTURA: "Estorno de venda anterior à planilha (UpSeller)",
  // A anulação de uma reversão (cancelamento ou devolução) de venda ESTORNADA, com
  // a data dela. Duas causas gravam este tipo: a reversão a mais do legado
  // (D-351 §12, cancelamento E devolução da mesma venda) e TODA reversão de venda
  // do Full (D-352 — a unidade nunca foi da loja, então nada devia ter voltado
  // para ela). O rótulo antigo, "em dobro", mentia no segundo caso.
  ESTORNO_REVERSAO_EXCEDENTE: "Anulação de reversão de venda estornada (em dobro ou do Full)",
  // D-375: saída conferida por documento NÃO fiscal (Pedido de Saída do
  // UpSeller). Não é `SAIDA_NFE` porque nota nenhuma foi emitida.
  SAIDA_DOCUMENTO: "Saída por documento (sem nota)",
  // D-352: a venda que o Mercado Livre despachou do galpão dele — a unidade
  // nunca foi da loja, e o par anula a baixa.
  ESTORNO_FULL: "Estorno de venda entregue pelo Full (Mercado Livre)",
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
