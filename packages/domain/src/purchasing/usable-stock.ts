/**
 * Estoque real aproveitável (D-146, Fase 5D) — a definição explícita que o
 * PRD exige antes da sugestão de compra: o que entra de Local, Full,
 * Reservado e Trânsito, "sem contar duas vezes nem ignorar".
 * Definição normativa em `docs/METRICS.md` §5D.
 *
 * ## A conta, e por que cada parcela está onde está
 *
 *   aproveitável = LOCAL + FULL + TRÂNSITO      (RESERVADO fica FORA)
 *
 * - **LOCAL entra.** É o "Disponível" do UpSeller, que **já exclui** o
 *   "Ocupado": no modelo da V3 os dois viram `location_kind` disjuntos
 *   (LOCAL/RESERVADO) desde a importação — somá-los não conta nada duas
 *   vezes, e excluir RESERVADO não subtrai nada em dobro.
 * - **FULL entra.** É estoque físico em outro armazém (o CD do Mercado
 *   Livre), disjunto do LOCAL por lugar: unidade enviada ao Full saiu do
 *   estoque da loja. Não comprar o que já está no Full é o motivo de a
 *   parcela existir.
 * - **TRÂNSITO entra.** É compra já feita a caminho (ciclo do pedido de
 *   compra, D-055); quando chega, o movimento baixa TRÂNSITO e sobe LOCAL
 *   na mesma transação — em nenhum instante as duas parcelas carregam a
 *   mesma unidade.
 * - **RESERVADO fica fora.** Está comprometido com pedidos existentes;
 *   contá-lo faria a sugestão deixar de repor unidades que já têm dono.
 *
 * ## As duas honestidades
 *
 * 1. **SKU virtual não tem total.** `stock_is_virtual` diz que o LOCAL é
 *    sentinela (999/9999), não contagem — e um total que soma lixo com Full
 *    real é lixo com aparência de precisão. A resposta é `null` com o motivo,
 *    mesmo desenho da cobertura (D-127). Full e trânsito continuam expostos
 *    nos componentes: são reais e a tela pode mostrá-los separados.
 * 2. **LOCAL negativo entra NEGATIVO.** Saldo -5 significa 5 unidades
 *    vendidas além do que o ledger conhece — unidades devidas. Truncar em
 *    zero esconderia a dívida e a sugestão de compra deixaria de cobri-la.
 *    O componente fica visível para a divergência não passar despercebida.
 */

export interface UsableStockInput {
  readonly localQuantity: number;
  readonly fullQuantity: number;
  readonly transitQuantity: number;
  readonly reservedQuantity: number;
  readonly stockIsVirtual: boolean;
}

export interface UsableStockResult {
  /** Nulo quando o LOCAL não é confiável (SKU virtual) — recusa, não zero. */
  readonly total: number | null;
  readonly reason: "ESTOQUE_VIRTUAL" | null;
  /** A decomposição visível — "por que aproveitável = 48?" começa aqui. */
  readonly components: {
    readonly local: number;
    readonly full: number;
    readonly transit: number;
    /** Exposto para leitura, NUNCA somado — já comprometido. */
    readonly reservedExcluded: number;
  };
}

export function computeUsableStock(input: UsableStockInput): UsableStockResult {
  const components = {
    local: input.localQuantity,
    full: input.fullQuantity,
    transit: input.transitQuantity,
    reservedExcluded: input.reservedQuantity,
  };

  if (input.stockIsVirtual) {
    return { total: null, reason: "ESTOQUE_VIRTUAL", components };
  }

  return {
    total: input.localQuantity + input.fullQuantity + input.transitQuantity,
    reason: null,
    components,
  };
}
