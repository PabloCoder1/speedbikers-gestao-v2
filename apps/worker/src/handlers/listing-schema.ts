import { z } from "zod";

/**
 * Formato de um item do Mercado Livre, `GET /items/{item_id}` — campos
 * confirmados por leitura direta (`developers.mercadolivre.com.br`,
 * "Items & Searches", 2026-08-23; `status` confirmado como filtro válido na
 * mesma página — `?status=active`). Só os campos que `listings` usa hoje
 * (`docs/DATABASE.md`); estender é aditivo.
 */
export const listingItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  price: z.number(),
  currency_id: z.string(),
  available_quantity: z.number(),
  category_id: z.string().nullable().optional(),
});

export type ParsedListingItem = z.infer<typeof listingItemSchema>;
