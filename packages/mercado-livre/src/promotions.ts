import { z } from "zod";

import { MercadoLivreApiError } from "./errors.js";
import type { MercadoLivreClient } from "./http-client.js";

/**
 * Promoções ativas de um item — `GET /seller-promotions/items/{item_id}?app_version=v2`
 * (`docs/MERCADO_LIVRE.md` secao 2.8, endpoint só documentado como existente
 * até então). Contrato CONFIRMADO ao vivo em 2026-09-21 contra a conta
 * "Speedbikers (loja 1)" do Dev, item MLB1384467402 (preço cadastrado 370,69):
 *
 * ```json
 * [
 *   { "type": "SELLER_CAMPAIGN", "status": "started", "price": 249.99, "original_price": 370.69, ... },
 *   { "type": "PRICE_DISCOUNT", "status": "candidate", "price": 0, "original_price": 370.69, ... },
 *   { "type": "DEAL", "status": "candidate", "price": 0, "original_price": 370.69, ... }
 * ]
 * ```
 *
 * **`status: "candidate"` é campanha que o vendedor PODE ativar e não
 * ativou — vem com `price: 0`.** Só `status: "started"` é promoção
 * realmente no ar, com o preço de verdade. Ler o primeiro item do array sem
 * filtrar por status devolveria R$ 0,00 como "preço promocional" — o motivo
 * de `effectivePromotionalPrice` existir em vez de `entries[0]?.price`.
 *
 * **403 "Caller don't have permissions to access this item" é o item FORA de
 * qualquer campanha, não falha de permissão do app** — medido no mesmo
 * teste: mesma conta, mesmo token, 200 com dado real num item e 403 nos
 * outros três. Vira `[]` (nenhuma promoção): tratar como erro pararia a
 * sincronização no primeiro item sem campanha, que é a maioria do catálogo.
 * **Só o 403 COM corpo (D-419).** O 403 sem corpo é a recusa por instância do
 * worker (25, 27 e 28/09) — recusa tudo, e como `[]` virava "sem promoção"
 * em todo anúncio lido por aquela instância. Ele continua sendo erro.
 *
 * **`price` pode faltar (D-419).** Medido em produção de 28 a 29/09: 430
 * leituras de 91 anúncios, das quatro contas, recusadas pelo schema com
 * `[i].price` ausente — e cada uma gravava "sem promoção". A entrada vale
 * sem preço; o que diz se a promoção está no ar é o `status`.
 */
export const sellerPromotionEntrySchema = z.object({
  id: z.string().optional(),
  type: z.string(),
  sub_type: z.string().optional(),
  status: z.string(),
  price: z.number().nullable().optional(),
  original_price: z.number(),
  start_date: z.string().optional(),
  finish_date: z.string().optional(),
  name: z.string().optional(),
  // D-420, medidos na sonda de 29/09 (44 anúncios, quatro contas): a faixa e o
  // preço que o Mercado Livre sugere para a candidata, e quem paga o desconto
  // na co-participada (SMART, UNHEALTHY_STOCK) ou no cupom. Todos opcionais —
  // cada tipo traz só uma parte.
  min_discounted_price: z.number().nullable().optional(),
  max_discounted_price: z.number().nullable().optional(),
  suggested_discounted_price: z.number().nullable().optional(),
  meli_percentage: z.number().nullable().optional(),
  seller_percentage: z.number().nullable().optional(),
  fixed_percentage: z.number().nullable().optional(),
});

export const sellerPromotionsSchema = z.array(sellerPromotionEntrySchema);

export type SellerPromotionEntry = z.infer<typeof sellerPromotionEntrySchema>;

export interface GetItemPromotionsOptions {
  client: MercadoLivreClient;
  itemId: string;
  accessToken: string;
}

export async function getItemPromotions(options: GetItemPromotionsOptions): Promise<SellerPromotionEntry[]> {
  try {
    return await options.client.request({
      method: "GET",
      path: `/seller-promotions/items/${options.itemId}`,
      accessToken: options.accessToken,
      searchParams: { app_version: "v2" },
      schema: sellerPromotionsSchema,
    });
  } catch (error) {
    if (error instanceof MercadoLivreApiError && error.status === 403 && error.body !== undefined && error.body !== null) {
      return [];
    }

    throw error;
  }
}

/**
 * O preço que o comprador PAGA agora: o menor `price` entre as campanhas
 * `started`, ou `null` quando o item não está em promoção nenhuma — ou está,
 * mas a campanha veio sem preço (D-419): aí `isInPromotion` diz que está, e o
 * preço fica desconhecido em vez de inventado.
 *
 * `Math.min` (não "a primeira `started`"): nada na doc garante no máximo uma
 * campanha ativa por item ao mesmo tempo, e o preço que o comprador vê na
 * vitrine é sempre o menor entre as que estiverem valendo.
 */
export function effectivePromotionalPrice(entries: readonly SellerPromotionEntry[]): number | null {
  const ativos = entries
    .filter((entry) => entry.status === "started")
    .map((entry) => entry.price)
    .filter((price): price is number => typeof price === "number" && price > 0);

  return ativos.length === 0 ? null : Math.min(...ativos);
}

/** O item está numa campanha no ar agora (`status: "started"`), com ou sem preço lido (D-419). */
export function isInPromotion(entries: readonly SellerPromotionEntry[]): boolean {
  return entries.some((entry) => entry.status === "started");
}

/**
 * Uma campanha do anúncio, no ar ou candidata, na forma que `listings.promotions`
 * guarda (D-420). Ausente vira `null`, nunca zero: a candidata vem com
 * `price: 0` como marcador, e o preço dela é o que o vendedor escolher.
 */
export interface PromotionOffer {
  type: string;
  status: "started" | "candidate";
  id: string | null;
  name: string | null;
  start_date: string | null;
  finish_date: string | null;
  /** O preço com a campanha: o no ar, ou o que a candidata já propõe (relâmpago, co-participada). */
  price: number | null;
  original_price: number | null;
  suggested_price: number | null;
  min_price: number | null;
  max_price: number | null;
  /** Co-participada: quanto do desconto cada um paga, em %. */
  meli_percentage: number | null;
  seller_percentage: number | null;
  /** Cupom de percentual fixo. */
  fixed_percentage: number | null;
}

/** Teto de campanhas guardadas por anúncio — a sonda mediu no máximo 10. */
const MAX_OFFERS = 30;

function positivo(valor: number | null | undefined): number | null {
  return typeof valor === "number" && valor > 0 ? valor : null;
}

function numero(valor: number | null | undefined): number | null {
  return typeof valor === "number" ? valor : null;
}

function texto(valor: string | undefined): string | null {
  return valor === undefined || valor.trim() === "" ? null : valor;
}

/**
 * As campanhas no ar e as candidatas, na ordem em que o Mercado Livre as
 * devolve (D-420). Outros estados (encerrada, pendente) ficam de fora: não são
 * nem o que vale agora nem o que dá para ativar.
 */
export function promotionOffers(entries: readonly SellerPromotionEntry[]): PromotionOffer[] {
  return entries
    .filter((entry) => entry.status === "started" || entry.status === "candidate")
    .slice(0, MAX_OFFERS)
    .map((entry) => ({
      type: entry.type,
      status: entry.status === "started" ? "started" : "candidate",
      id: texto(entry.id),
      name: texto(entry.name),
      start_date: texto(entry.start_date),
      finish_date: texto(entry.finish_date),
      price: positivo(entry.price),
      original_price: positivo(entry.original_price),
      suggested_price: positivo(entry.suggested_discounted_price),
      min_price: positivo(entry.min_discounted_price),
      max_price: positivo(entry.max_discounted_price),
      meli_percentage: numero(entry.meli_percentage),
      seller_percentage: numero(entry.seller_percentage),
      fixed_percentage: numero(entry.fixed_percentage),
    }));
}
