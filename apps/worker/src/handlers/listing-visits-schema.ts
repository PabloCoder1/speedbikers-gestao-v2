import { z } from "zod";

/**
 * Formato de `GET /items/{item_id}/visits/time_window` — confirmado por
 * leitura direta (`developers.mercadolivre.com.br`, "Visitas", 2026-08-23).
 * Só os campos que `daily_listing_visits` usa hoje (`docs/DATABASE.md`);
 * `visits_detail` (quebra por país/site) fica de fora, sem uso ainda.
 */
function isValidCalendarPrefix(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);

  if (match === null) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const listingVisitsTimeWindowSchema = z.object({
  item_id: z.string(),
  results: z.array(
    z.object({
      date: z.string().refine(isValidCalendarPrefix, "data de visita inválida"),
      total: z.number().int().nonnegative(),
    }),
  ),
});

export type ParsedListingVisitsTimeWindow = z.infer<typeof listingVisitsTimeWindowSchema>;
