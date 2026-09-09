"use server";

import { createClient } from "../../lib/supabase/server";

/**
 * O retrato da gaveta do PEDIDO (D39 — a quinta das cinco).
 *
 * **É a única gaveta que abre uma superfície NOVA de verdade.** As outras
 * quatro resumem telas que existem; um pedido de venda nunca teve tela em
 * lugar nenhum: `/vendas` agrega, `/atendimento` mostra o NÚMERO do pedido e
 * para por aí — `resolveSupportCaseReference` devolve `href: null` para
 * `ORDER` porque não havia para onde apontar. Quem atendia via um número de 13
 * dígitos e tinha de abrir o painel do Mercado Livre para saber o que fora
 * comprado.
 *
 * ## O que o frame desenha e o esquema não tem
 *
 * Conferido em `\d`, não no código da tela:
 *
 * - **nome do comprador** — `orders` guarda `buyer_id`, um número. Não há
 *   tabela de comprador, e inventar "Lucas Almeida" seria dado falso;
 * - **logística ("Coleta")** — existe `shipping_id`, e nada mais: nenhuma
 *   tabela de envio, nenhum modo, nenhum status;
 * - **a timeline de transporte** ("Despachado", "Nova previsão da
 *   transportadora") — não existe fonte. O que existe é o registro de
 *   EXCEÇÕES em `domain_events` (`order.cancelled`, `order.returned`,
 *   `order.return.unreversed`): o pedido normal não gera evento nenhum, e o
 *   silêncio ali é a informação de que nada saiu do trilho.
 *
 * A gaveta mostra o que há: cabeçalho, itens (com vínculo de SKU quando
 * existe) e o que aconteceu de excepcional.
 */

export interface OrderItemRow {
  id: string;
  title: string;
  sellerSku: string | null;
  quantity: number;
  unitPrice: number;
  skuId: string | null;
  sku: string | null;
}

export interface OrderEventRow {
  id: string;
  occurredAt: string;
  eventType: string;
  severity: string;
}

export interface OrderInspection {
  status: string | null;
  statusDetail: string | null;
  dateCreated: string | null;
  dateClosed: string | null;
  totalAmount: number | null;
  paidAmount: number | null;
  buyerId: string | null;
  packId: string | null;
  cancelReason: string | null;
  accountLabel: string | null;
  sellerShippingCost: number | null;
  sellerDiscount: number | null;
  /** NULO = a leitura financeira ainda não passou por este pedido (D-229). */
  temFinanceiro: boolean;
  itens: OrderItemRow[];
  eventos: OrderEventRow[];
  error: string | null;
}

const VAZIO: OrderInspection = {
  status: null,
  statusDetail: null,
  dateCreated: null,
  dateClosed: null,
  totalAmount: null,
  paidAmount: null,
  buyerId: null,
  packId: null,
  cancelReason: null,
  accountLabel: null,
  sellerShippingCost: null,
  sellerDiscount: null,
  temFinanceiro: false,
  itens: [],
  eventos: [],
  error: null,
};

interface ItemLido {
  id: string;
  title: string;
  seller_sku: string | null;
  quantity: number;
  unit_price: number;
  sku_id: string | null;
  skus: { sku: string } | null;
}

export async function inspecionarPedido(orderId: number): Promise<OrderInspection> {
  const supabase = await createClient();

  const [orderResult, itemsResult, financialsResult, eventsResult] = await Promise.all([
    supabase
      .from("orders")
      .select(
        "status, status_detail, date_created, date_closed, total_amount, paid_amount, buyer_id, pack_id, cancel_reason, ml_accounts(label)",
      )
      .eq("id", orderId)
      .maybeSingle(),
    supabase
      .from("order_items")
      .select("id, title, seller_sku, quantity, unit_price, sku_id, skus(sku)")
      .eq("order_id", orderId)
      .order("position"),
    supabase
      .from("order_financials")
      .select("seller_shipping_cost, seller_discount")
      .eq("order_id", orderId)
      .maybeSingle(),
    supabase
      .from("domain_events")
      .select("id, occurred_at, event_type, severity")
      .eq("entity_type", "order")
      .eq("entity_id", String(orderId))
      .order("occurred_at", { ascending: false })
      .limit(5),
  ]);

  const erro =
    orderResult.error ?? itemsResult.error ?? financialsResult.error ?? eventsResult.error;

  if (erro !== null) {
    return { ...VAZIO, error: "Não foi possível ler este pedido." };
  }

  const order = orderResult.data;

  if (order === null) {
    /*
      Pedido fora do alcance ou inexistente, e a distinção importa: a policy de
      `orders` filtra por CONTA acessível, então um pedido de conta à qual esta
      pessoa não tem acesso responde igual a um que não existe. Dizer "não
      encontrado" seria afirmar ausência que não foi medida.
    */
    return { ...VAZIO, error: "Pedido não encontrado, ou fora das contas a que você tem acesso." };
  }

  const conta = order.ml_accounts as unknown as { label: string } | null;

  return {
    status: order.status,
    statusDetail: order.status_detail,
    dateCreated: order.date_created,
    dateClosed: order.date_closed,
    totalAmount: order.total_amount,
    paidAmount: order.paid_amount,
    buyerId: order.buyer_id === null ? null : String(order.buyer_id),
    packId: order.pack_id === null ? null : String(order.pack_id),
    cancelReason: order.cancel_reason,
    accountLabel: conta?.label ?? null,
    sellerShippingCost: financialsResult.data?.seller_shipping_cost ?? null,
    sellerDiscount: financialsResult.data?.seller_discount ?? null,
    temFinanceiro: financialsResult.data !== null,
    itens: ((itemsResult.data ?? []) as unknown as ItemLido[]).map((item) => ({
      id: item.id,
      title: item.title,
      sellerSku: item.seller_sku,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      skuId: item.sku_id,
      sku: item.skus?.sku ?? null,
    })),
    eventos: (eventsResult.data ?? []).map((evento) => ({
      id: evento.id,
      occurredAt: evento.occurred_at,
      eventType: evento.event_type,
      severity: evento.severity,
    })),
    error: null,
  };
}
