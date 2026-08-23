import { z } from "zod";

/**
 * Formato de `GET /items/{item_id}/visits/time_window` — confirmado por
 * leitura direta (`developers.mercadolivre.com.br`, "Visitas", 2026-08-23).
 * Só os campos que `daily_listing_visits` usa hoje (`docs/DATABASE.md`);
 * `visits_detail` (quebra por país/site) fica de fora, sem uso ainda.
 */
export const listingVisitsTimeWindowSchema = z.object({
  item_id: z.string(),
  results: z.array(
    z.object({
      date: z.string(),
      total: z.number(),
    }),
  ),
});

export type ParsedListingVisitsTimeWindow = z.infer<typeof listingVisitsTimeWindowSchema>;
