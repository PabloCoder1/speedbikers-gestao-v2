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
  date_last_updated: z.string(),
  last_updated: z.string().nullable().optional(),
  total_amount: z.number().nonnegative(),
  paid_amount: z.number().nullable().optional(),
  currency_id: z.string(),
  pack_id: z.number().nullable().optional(),
  buyer: z.object({ id: z.number() }).nullable().optional(),
  tags: z.array(z.string()).optional(),
  cancel_detail: z
    .object({ description: z.string().nullable().optional() })
    .nullable()
    .optional(),
  order_items: z.array(orderItemSchema),
});

export type ParsedOrder = z.infer<typeof orderSchema>;
