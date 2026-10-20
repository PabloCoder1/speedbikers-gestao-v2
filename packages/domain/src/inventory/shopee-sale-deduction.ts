import { cancellationKeyOf } from "./reversal-limit.js";
import { fullEstornoOf, preCaptureEstornoOf } from "./sale-deduction.js";
import type { ErpCutoff, RecordedSale, StockMovementDraft } from "./sale-deduction.js";

/**
 * A venda da Shopee no estoque (D-495), pelas regras que o dono deu em
 * 19/10/2026 e pelas peças da venda do Mercado Livre (D-351, D-352):
 *
 *  - **a venda paga baixa ao ser lida**, no instante do pagamento (`paid_at`,
 *    o equivalente ao `date_closed` do ML);
 *  - **o corte da planilha do UpSeller vale igual** (ele lê o pedido da Shopee
 *    na hora, como o do ML): venda até a exportação já está descontada nela e
 *    ganha o `ESTORNO_PRE_CAPTURA`;
 *  - **o armazém da Shopee é o Full** (`fulfillment_flag` =
 *    `fulfilled_by_shopee`): a unidade nunca foi da loja, a venda ganha o par
 *    (`ESTORNO_ARMAZEM_SHOPEE`) e o cancelamento não repõe nada;
 *  - **o cancelamento repõe uma vez, e só o que a planilha ainda não repôs**: o
 *    UpSeller devolve sozinho a unidade do pedido cancelado, então o
 *    cancelamento até a exportação já está no saldo dela.
 *
 * Sem o legado do ML: nenhum movimento da Shopee foi gravado antes desta
 * regra, então não há venda com data velha nem reversão a mais para anular.
 *
 * A tabela de casos (S = pagamento, C = cancelamento, E = exportação):
 *
 *   S > E                -> venda                       (baixa)
 *   S <= E               -> venda + estorno             (a planilha já tem)
 *   cancelado, C > E     -> + cancelamento              (repõe o que a planilha ainda não repôs)
 *   cancelado, C <= E    -> nada a mais                 (a planilha já repôs)
 *   armazém da Shopee    -> venda + estorno; cancelamento não repõe
 *
 * A venda paga e cancelada ANTES de a V3 a ler entra igual: S > E dá venda e
 * cancelamento (soma zero); S <= E < C dá venda, estorno e cancelamento -- o
 * "trio" do ML, que repõe a unidade que a planilha ainda tem descontada.
 */

/** O valor de `fulfillment_flag` do armazém da Shopee (documentação de `get_order_detail`, 19/10/2026). */
export const SHOPEE_ARMAZEM_FLAG = "fulfilled_by_shopee";

/**
 * O pedido sai do armazém da Shopee? Só a igualdade exata: valor desconhecido
 * e ausência de sinal BAIXAM a loja, como no Full (D-352) -- errar para "baixa"
 * deixa o saldo baixo até a planilha seguinte; errar para "armazém" vende o que
 * não existe.
 */
export function isArmazemDaShopee(fulfillmentFlag: string | null): boolean {
  return fulfillmentFlag === SHOPEE_ARMAZEM_FLAG;
}

/**
 * O cancelamento que repõe: o `CANCELLED` final. O `IN_CANCEL` é um pedido de
 * cancelamento que o vendedor ainda pode recusar, e o ledger não desfaz: a
 * reposição espera o status final.
 */
export const SHOPEE_CANCELADO = "CANCELLED";

export interface ShopeeSaleItem {
  readonly position: number;
  readonly quantity: number;
  readonly skuId: string | null;
  readonly skuKind: "PRODUTO" | "KIT" | null;
  /** Só relevante quando `skuKind === "KIT"`. */
  readonly components: readonly { componentSkuId: string; quantity: number }[];
}

export interface ShopeeSaleOrder {
  /** `shopee_shops.id` -- entra na chave: o `order_sn` é único na loja. */
  readonly shopId: string;
  readonly orderSn: string;
  readonly status: string;
  /** `shopee_orders.paid_at`; nulo = não pago, nada a baixar. */
  readonly paidAt: Date | null;
  /** `shopee_orders.shopee_updated_at`: o instante do cancelamento quando o status é `CANCELLED`. */
  readonly updatedAt: Date;
  readonly fulfillmentFlag: string | null;
  readonly items: readonly ShopeeSaleItem[];
}

export interface ShopeeStockInputs {
  /**
   * O corte do SKU (D-351), ou `null` quando a organização não tem planilha.
   * O chamador LANÇA para SKU cujo corte não foi lido -- "não sei" nunca vira
   * "sem corte".
   */
  readonly cutoffFor: (skuId: string) => ErpCutoff | null;
  /** O `VENDA_SHOPEE` já gravado com esta chave, se existir. */
  readonly recordedSale: (idempotencyKey: string) => RecordedSale | undefined;
}

export interface ShopeeStockMovements {
  /** `VENDA_SHOPEE`. */
  readonly vendas: StockMovementDraft[];
  /** `ESTORNO_PRE_CAPTURA`. */
  readonly estornosPreCaptura: StockMovementDraft[];
  /** `ESTORNO_ARMAZEM_SHOPEE`. */
  readonly estornosArmazem: StockMovementDraft[];
  /** `CANCELAMENTO_SHOPEE`. */
  readonly cancelamentos: StockMovementDraft[];
}

/** A chave da venda: `shopee-venda:<loja>:<order_sn>:<posição>[:<componente>]`. */
export function shopeeSaleKeyOf(shopId: string, orderSn: string, position: number, componentSkuId?: string): string {
  const base = `shopee-venda:${shopId}:${orderSn}:${String(position)}`;

  return componentSkuId === undefined ? base : `${base}:${componentSkuId}`;
}

const VAZIO: ShopeeStockMovements = { vendas: [], estornosPreCaptura: [], estornosArmazem: [], cancelamentos: [] };

export function computeShopeeStockMovements(order: ShopeeSaleOrder, inputs: ShopeeStockInputs): ShopeeStockMovements {
  if (order.paidAt === null) return VAZIO;

  const saleAt = order.paidAt;
  const vendas: StockMovementDraft[] = [];

  for (const item of order.items) {
    // Item sem vínculo: nada a baixar (como no ML).
    if (item.skuId === null || item.quantity <= 0) continue;

    if (item.skuKind === "KIT") {
      for (const component of item.components) {
        vendas.push({
          skuId: component.componentSkuId,
          qtyDelta: -(item.quantity * component.quantity),
          idempotencyKey: shopeeSaleKeyOf(order.shopId, order.orderSn, item.position, component.componentSkuId),
          occurredAt: saleAt,
        });
      }

      continue;
    }

    vendas.push({
      skuId: item.skuId,
      qtyDelta: -item.quantity,
      idempotencyKey: shopeeSaleKeyOf(order.shopId, order.orderSn, item.position),
      occurredAt: saleAt,
    });
  }

  const armazem = isArmazemDaShopee(order.fulfillmentFlag);
  const cancelado = order.status === SHOPEE_CANCELADO;
  const precaptura = { cutoffFor: inputs.cutoffFor, recordedSale: inputs.recordedSale, recordedReversals: [] };
  const estornosPreCaptura: StockMovementDraft[] = [];
  const estornosArmazem: StockMovementDraft[] = [];
  const cancelamentos: StockMovementDraft[] = [];

  for (const venda of vendas) {
    // Um estorno por venda, nunca dois: a chave é a mesma (`estorno:<venda>`), e
    // o corte tem precedência, como na D-352.
    const doCorte = preCaptureEstornoOf(venda, saleAt, precaptura);

    if (doCorte !== null) {
      estornosPreCaptura.push(doCorte);
    } else if (armazem) {
      estornosArmazem.push(fullEstornoOf(venda, inputs.recordedSale));
    }

    if (!cancelado || armazem) continue;

    // A venda que o cancelamento repõe: a gravada, quando existe.
    const base = inputs.recordedSale(venda.idempotencyKey) ?? venda;
    const corte = inputs.cutoffFor(base.skuId);

    // O cancelamento até a exportação já está na planilha: o UpSeller repôs.
    if (corte !== null && order.updatedAt.getTime() <= corte.exportedAt.getTime()) continue;

    cancelamentos.push({
      skuId: base.skuId,
      qtyDelta: -base.qtyDelta,
      idempotencyKey: cancellationKeyOf(venda.idempotencyKey),
      occurredAt: order.updatedAt,
    });
  }

  return { vendas, estornosPreCaptura, estornosArmazem, cancelamentos };
}
