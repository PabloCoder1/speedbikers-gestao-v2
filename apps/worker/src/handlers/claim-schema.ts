import { z } from "zod";

/**
 * Formato de uma `claim` e de uma `return` do Mercado Livre, confirmado por
 * leitura direta (`developers.mercadolivre.com.br`, "Gerenciar reclamações"
 * e "Devoluções", 2026-08-23) — ver `docs/MERCADO_LIVRE.md` secao 2.10.
 * Só os campos que a V3 usa hoje; estender é aditivo.
 */
/**
 * Ação disponível para um participante. Permissivo de propósito (D-097): a
 * V3 ainda não consome nenhum destes campos, e D-103 mostrou o custo de
 * apertar valor de campo não usado.
 */
const claimPlayerActionSchema = z.object({
  action: z.string(),
  mandatory: z.boolean().nullable().optional(),
  /** Uma das fontes de prazo do claim (`docs/MERCADO_LIVRE.md` secao 2.12). */
  due_date: z.string().nullable().optional(),
});

const claimPlayerSchema = z.object({
  /** `complainant` | `respondent` | `mediator` | `purchase`. */
  role: z.string(),
  type: z.string().nullable().optional(),
  user_id: z.number(),
  available_actions: z.array(claimPlayerActionSchema).nullable().optional(),
});

const claimResolutionSchema = z.object({
  reason: z.string().nullable().optional(),
  /** Data de encerramento da reclamação — relógio do Mercado Livre. */
  date_created: z.string().nullable().optional(),
  closed_by: z.string().nullable().optional(),
});

export const claimSchema = z.object({
  id: z.number(),
  resource: z.string(),
  resource_id: z.number(),
  status: z.string(),
  type: z.string(),
  /**
   * Etapa da reclamação — `claim` | `dispute` | `recontact` | `none` | `stale`.
   *
   * **`dispute` é a mediação de verdade**, a única etapa em que "intervém um
   * representante do Mercado Livre" (documentação oficial lida ao vivo em
   * 2026-08-27). NÃO confundir com `type = "mediations"`, que a mesma página
   * define como a reclamação comum "entre comprador e vendedor" — o próprio
   * exemplo oficial traz `type: "mediations"` junto de `stage: "claim"` numa
   * reclamação encerrada pelo vendedor, sem mediação nenhuma.
   *
   * Opcional porque D-101 provou que campo presente no exemplo da doc pode
   * faltar no payload real.
   */
  stage: z.string().nullable().optional(),
  /**
   * Datas do relógio do Mercado Livre. Opcionais pelo mesmo motivo de D-101
   * (`GET /orders/{id}` não trazia `date_last_updated` apesar do exemplo):
   * este handler já roda em produção revertendo estoque, e exigir campo novo
   * transformaria uma ausência em ZodError que derrubaria a reversão.
   */
  date_created: z.string().nullable().optional(),
  last_updated: z.string().nullable().optional(),
  players: z.array(claimPlayerSchema).nullable().optional(),
  resolution: claimResolutionSchema.nullable().optional(),
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
