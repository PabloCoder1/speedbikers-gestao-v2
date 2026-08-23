import { z } from "zod";

/**
 * Formato de uma `claim` e de uma `return` do Mercado Livre, confirmado por
 * leitura direta (`developers.mercadolivre.com.br`, "Gerenciar reclamações"
 * e "Devoluções", 2026-08-23) — ver `docs/MERCADO_LIVRE.md` secao 2.10.
 * Só os campos que a V3 usa hoje; estender é aditivo.
 */
export const claimSchema = z.object({
  id: z.number(),
  resource: z.string(),
  resource_id: z.number(),
  status: z.string(),
  type: z.string(),
  /**
   * Lista de entidades vinculadas — o próprio Mercado Livre recomenda usar
   * este campo para detectar devolução física: "se existir o valor
   * 'return', significa que há uma devolução associada a esta reclamação"
   * (docs oficiais, citado em `docs/MERCADO_LIVRE.md`).
   */
  related_entities: z.array(z.string()),
});

export type ParsedClaim = z.infer<typeof claimSchema>;

const claimReturnOrderSchema = z.object({
  order_id: z.number(),
  item_id: z.string(),
  variation_id: z.number().nullable().optional(),
  context_type: z.string(),
  total_quantity: z.coerce.number(),
  return_quantity: z.coerce.number(),
});

export const claimReturnSchema = z.object({
  id: z.number(),
  claim_id: z.number(),
  /** "delivered" = produto fisicamente de volta — o gatilho da reversão de estoque. */
  status: z.string(),
  orders: z.array(claimReturnOrderSchema),
});

export type ParsedClaimReturn = z.infer<typeof claimReturnSchema>;
