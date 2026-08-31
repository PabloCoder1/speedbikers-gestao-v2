import { z } from "zod";

/**
 * Formato de uma `order` do Mercado Livre, confirmado por leitura direta
 * (`developers.mercadolivre.com.br`, "Gerencie vendas → Orders", 2026-08-21)
 * — `/orders/search` devolve o objeto COMPLETO por resultado, igual a
 * `GET /orders/{id}`, incluindo `order_items`. Só os campos que a V3 usa
 * hoje (`docs/DATABASE.md`); estender é aditivo, nunca quebra o que já lê.
 *
 * Vocabulário de `status` CONFIRMADO na mesma página (secao "Status da
 * order") — os 9 valores existem hoje, espelhados na constraint de
 * `orders.status` (migration `20260821040000_create_orders.sql`).
 */
export const orderItemSchema = z.object({
  item: z.object({
    id: z.string(),
    title: z.string(),
    variation_id: z.number().nullable().optional(),
    seller_sku: z.string().nullable().optional(),
  }),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
  sale_fee: z.number().nullable().optional(),
  currency_id: z.string(),
});

export const orderSchema = z.object({
  id: z.number(),
  status: z.enum([
    "confirmed",
    "payment_required",
    "payment_in_process",
    "partially_paid",
    "paid",
    "partially_refunded",
    "pending_cancel",
    "cancelled",
    "invalid",
  ]),
  status_detail: z.string().nullable().optional(),
  date_created: z.string(),
  date_closed: z.string().nullable().optional(),
  // D-048: campo de checkpoint. Ver docs/MERCADO_LIVRE.md secao "Reconciliação".
  // Opcional desde D-101: o `GET /orders/{id}` REAL (fast path do webhook,
  // primeira execução com tráfego de verdade em 2026-08-27) vem SEM este
  // campo — o ZodError de produção tinha exatamente um path,
  // `date_last_updated` — enquanto o `/orders/search` (reconciliação) o
  // traz sempre. `persistOrder` deriva o fallback; o checkpoint de janela
  // continua lendo o campo do search, intacto.
  date_last_updated: z.string().nullable().optional(),
  last_updated: z.string().nullable().optional(),
  total_amount: z.number().nonnegative(),
  paid_amount: z.number().nullable().optional(),
  currency_id: z.string(),
  pack_id: z.number().nullable().optional(),
  buyer: z.object({ id: z.number() }).nullable().optional(),
  // D-165: shipping.id é a chave de GET /shipments/{id}/costs (§2.15). O
  // objeto shipping do pedido é padrão da API; ler só o id é aditivo.
  shipping: z.object({ id: z.number().nullable().optional() }).nullable().optional(),
  tags: z.array(z.string()).optional(),
  cancel_detail: z
    .object({ description: z.string().nullable().optional() })
    .nullable()
    .optional(),
  order_items: z.array(orderItemSchema),
});

export type ParsedOrder = z.infer<typeof orderSchema>;
