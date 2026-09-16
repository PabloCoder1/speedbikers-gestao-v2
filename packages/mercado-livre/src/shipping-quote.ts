import { z } from "zod";

import type { MercadoLivreClient } from "./http-client.js";

/**
 * Cotação do frete grátis que o VENDEDOR paga (D-359).
 *
 * Contrato lido na documentação oficial em 16/09/2026 ("Custos de envio",
 * developers.mercadolivre.com.br/pt_br/custos-de-envio, atualizada em
 * 20/04/2026):
 *
 *   GET /users/{USER_ID}/shipping_options/free
 *     ?dimensions=ALTURAxLARGURAxCOMPRIMENTO,PESO
 *     &verbose=true&item_price=...&listing_type_id=gold_special|gold_pro
 *     &mode=me2&condition=new&logistic_type=...&free_shipping=true
 *
 * - `coverage.all_country.list_cost` é o "custo de envio oferecido ao
 *   vendedor" — é ESTE o número da calculadora;
 * - `coverage.discount` só vem quando há desconto (`rate`, `promoted_amount`);
 * - obrigatório: `item_id` OU `dimensions`; `free_shipping` precisa ser enviado
 *   para o custo vir certo;
 * - a própria doc chama o valor de "estimativa aproximada", considerando uma
 *   unidade. A tela diz isso.
 *
 * Unidades: o exemplo oficial é `9x17x22,462`, e o formato de dimensões dos
 * itens do Mercado Livre é centímetros e gramas. A doc desta rota não repete as
 * unidades — ficam declaradas aqui como a leitura adotada.
 */

export const LOGISTICAS_ML = ["cross_docking", "xd_drop_off", "drop_off", "fulfillment", "self_service"] as const;

export type LogisticaMl = (typeof LOGISTICAS_ML)[number];

export const shippingQuoteSchema = z.object({
  coverage: z.object({
    all_country: z.object({
      list_cost: z.number().nonnegative(),
      currency_id: z.string(),
      billable_weight: z.number().nonnegative().optional(),
    }),
    discount: z
      .object({
        rate: z.number().optional(),
        type: z.string().optional(),
        promoted_amount: z.number().optional(),
      })
      .optional(),
  }),
});

export type ShippingQuoteResponse = z.infer<typeof shippingQuoteSchema>;

export interface ShippingQuoteInput {
  readonly sellerId: number;
  readonly accessToken: string;
  readonly alturaCm: number;
  readonly larguraCm: number;
  readonly comprimentoCm: number;
  readonly pesoG: number;
  readonly preco: number;
  readonly listingTypeId: "gold_special" | "gold_pro";
  readonly logistica: LogisticaMl;
}

export interface ShippingQuote {
  /** O que o vendedor paga pelo frete grátis, já com desconto quando houver. */
  readonly custoVendedor: number;
  readonly moeda: string;
  readonly pesoFaturavelG: number | null;
  /** Valor antes do desconto, quando o Mercado Livre informa um. */
  readonly custoSemDesconto: number | null;
  readonly descontoPercentual: number | null;
}

/** Inteiros positivos: o Mercado Livre não aceita fração de centímetro nem de grama. */
const inteiro = (valor: number): number => Math.max(1, Math.round(valor));

export async function quoteFreeShippingCost(client: MercadoLivreClient, input: ShippingQuoteInput): Promise<ShippingQuote> {
  const dimensions = `${String(inteiro(input.alturaCm))}x${String(inteiro(input.larguraCm))}x${String(inteiro(input.comprimentoCm))},${String(inteiro(input.pesoG))}`;

  const response = await client.request({
    method: "GET",
    path: `/users/${String(input.sellerId)}/shipping_options/free`,
    accessToken: input.accessToken,
    searchParams: {
      dimensions,
      verbose: true,
      item_price: input.preco,
      listing_type_id: input.listingTypeId,
      mode: "me2",
      condition: "new",
      logistic_type: input.logistica,
      free_shipping: true,
    },
    schema: shippingQuoteSchema,
  });

  const { all_country: pais, discount } = response.coverage;

  return {
    custoVendedor: pais.list_cost,
    moeda: pais.currency_id,
    pesoFaturavelG: pais.billable_weight ?? null,
    custoSemDesconto: discount?.promoted_amount ?? null,
    descontoPercentual: discount?.rate ?? null,
  };
}
