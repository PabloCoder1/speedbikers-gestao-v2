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
 * `free_shipping` É A ESCOLHA DO VENDEDOR, não uma constante (D-421). Abaixo de
 * R$ 79, com `true` vem o frete inteiro que ele pagaria oferecendo frete
 * grátis; com `false`, o custo de envio por unidade que o Mercado Livre cobra
 * sem esse frete grátis. Medido em 07/10/2026, conta real, 10x15x20 cm e
 * 500 g: Coleta R$ 50 -> 13,85 / 8,25; Full -> 15,05 / 8,75; Flex -> 9,99 / 0.
 * A partir de R$ 79 os dois dão o mesmo valor.
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
  /** O vendedor oferece frete grátis nesta venda (a partir de R$ 79 é obrigatório). */
  readonly freteGratis: boolean;
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
      free_shipping: input.freteGratis,
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

/**
 * A TARIFA FIXA por venda (D-421), de `GET /sites/MLB/listing_prices`.
 *
 * Desde 02/03/2026 no Brasil ("Custos por vender", developers, atualizada em
 * 03/09/2026) o `fixed_fee` depende da logística e do modo de envio, e a doc
 * avisa que sem `logistic_type`, `shipping_mode` e `billable_weight` o valor
 * não coincide com o cobrado. A regra publicada: preço abaixo do limite do
 * frete grátis obrigatório (R$ 79) e me2 -- só o Flex (`self_service`) cobra;
 * a partir do limite, nunca. Medido em 07/10/2026: Flex R$ 50 -> 7,75; R$ 15
 * -> 6,25; Coleta e Full -> 0. `category_id` não muda o `fixed_fee` (só o
 * percentual, que a calculadora não lê daqui).
 */
export const listingPricesSchema = z.union([
  z.array(z.object({ sale_fee_details: z.object({ fixed_fee: z.number().nonnegative() }) })).min(1),
  z.object({ sale_fee_details: z.object({ fixed_fee: z.number().nonnegative() }) }),
]);

export interface SaleFixedFeeInput {
  readonly accessToken: string;
  readonly preco: number;
  readonly listingTypeId: "gold_special" | "gold_pro";
  readonly logistica: LogisticaMl;
  /** Peso faturável da cotação de frete; sem ele, o peso informado. */
  readonly pesoFaturavelG: number;
}

export async function quoteSaleFixedFee(client: MercadoLivreClient, input: SaleFixedFeeInput): Promise<number> {
  const response = await client.request({
    method: "GET",
    path: "/sites/MLB/listing_prices",
    accessToken: input.accessToken,
    searchParams: {
      price: input.preco,
      listing_type_id: input.listingTypeId,
      currency_id: "BRL",
      logistic_type: input.logistica,
      shipping_mode: "me2",
      billable_weight: inteiro(input.pesoFaturavelG),
    },
    schema: listingPricesSchema,
  });

  const linha = Array.isArray(response) ? response[0] : response;

  // `min(1)` no schema: a lista nunca chega vazia aqui.
  return linha?.sale_fee_details.fixed_fee ?? 0;
}
