/**
 * Vocabulário das Movimentações de estoque (D-167, trilha 5E) — o risco
 * nomeado do item é "IDs sem contexto": esta é a camada que traduz o ledger
 * para gente. Funções TOTAIS: tipo/origem desconhecidos degradam para o
 * valor cru, nunca para tela quebrada (mesmo espírito de
 * `describeActionEvidence`).
 */

/** Os 19 tipos aprovados do CHECK de `stock_movements` (ARCHITECTURE §12; o 13º e o 14º em D-351, o 15º em D-375, o 16º em D-352, do 17º ao 19º na D-495 b). */
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
  // D-495 (b), C-68: a venda paga de loja Shopee live baixa no pagamento, e o
  // cancelamento final depois do corte da planilha repõe uma vez. A venda que
  // saiu do armazém da Shopee ganha o par, como o Full. O estorno do corte é o
  // mesmo `ESTORNO_PRE_CAPTURA` do ML.
  VENDA_SHOPEE: "Venda Shopee",
  CANCELAMENTO_SHOPEE: "Cancelamento Shopee",
  ESTORNO_ARMAZEM_SHOPEE: "Estorno de venda entregue pelo armazém da Shopee",
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
  // D-495 (b), C-68: o pedido da Shopee (`source_id` = `order_sn`). Nunca
  // `ORDER`, que é "Pedido ML".
  SHOPEE_ORDER: "Pedido Shopee",
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

/**
 * Para onde a REFERÊNCIA de um movimento leva (lote 3 do pente fino, 18/09). A
 * coluna mostrava o `source_id` cru — um uuid que ninguém consegue usar. Só
 * vira link o que tem tela de detalhe e cujo id É o id daquela tela:
 * `PURCHASE_ORDER` grava `po.id` (20260823160629) e `DOCUMENT` grava
 * `documents.id` (`nfe-import-apply.ts`). Pedido do ML e reconciliação não têm
 * tela própria — ficam texto.
 *
 * D-614: o pedido da Shopee abre em `/vendas/shopee`, filtrado como a Busca
 * Universal o abre (D-467): a loja e o DIA DA CRIAÇÃO em São Paulo, porque a
 * tela acha o pedido dentro do período. As duas vêm do `get_stock_movements`
 * (C-68); sem elas — pedido apagado, ou banco anterior à migration —, a
 * referência fica texto, nunca um link para lista vazia.
 */
export function movementSourceHref(
  sourceType: string | null,
  sourceId: string | null,
  shopee: { readonly loja: string | null; readonly dia: string | null } = { loja: null, dia: null },
): string | null {
  if (sourceId === null || sourceId.trim() === "") return null;

  if (sourceType === "PURCHASE_ORDER") return `/compras/${encodeURIComponent(sourceId)}`;
  if (sourceType === "DOCUMENT") return `/notas-fiscais/${encodeURIComponent(sourceId)}`;

  if (sourceType === "SHOPEE_ORDER" && shopee.loja !== null && shopee.dia !== null && DIA.test(shopee.dia)) {
    const busca = new URLSearchParams({ loja: shopee.loja, from: shopee.dia, to: shopee.dia, pedido: sourceId });

    return `/vendas/shopee?${busca.toString()}`;
  }

  return null;
}

const DIA = /^\d{4}-\d{2}-\d{2}$/u;
