import type { MercadoLivreClient } from "@sb/mercado-livre";
import { paginateOffset } from "@sb/mercado-livre";
import { z } from "zod";

/**
 * Busca de pedidos por janela de data, compartilhada por `sync.orders.window`
 * (reconciliação) e `backfill.orders` (história) — a única diferença entre os
 * dois é COMO `from`/`to` são calculados, não como a busca em si acontece.
 */

const orderSearchResultSchema = z.object({
  id: z.number(),
  last_updated: z.string(),
});

const orderSearchResponseSchema = z.object({
  paging: z.object({ total: z.number(), offset: z.number(), limit: z.number() }),
  results: z.array(orderSearchResultSchema),
});

/**
 * Confirmado por leitura direta (`developers.mercadolivre.com.br`, "Gerencie
 * vendas → Orders", 2026-08-21): `/orders/search` "usa até a hora e descarta
 * a informação dos minutos, segundos e milissegundos". Qualquer granularidade
 * abaixo de 1h é ilusória — a V3 nunca envia minutos não-zero.
 *
 * `from` arredonda PARA BAIXO (nunca perder um registro no limite); `to`
 * arredonda PARA CIMA (nunca depender de qual direção o Mercado Livre
 * arredondaria um valor não documentado). A sobreposição resultante é
 * aceitável — todo processamento é idempotente por natureza.
 */
export function floorToHour(date: Date): Date {
  const floored = new Date(date);

  floored.setUTCMinutes(0, 0, 0);

  return floored;
}

export function ceilToHour(date: Date): Date {
  const floored = floorToHour(date);

  return floored.getTime() === date.getTime() ? floored : new Date(floored.getTime() + 3_600_000);
}

export function toMercadoLivreDate(date: Date): string {
  return date.toISOString().replace("Z", "+00:00");
}

export interface FetchOrdersWindowParams {
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  sellerId: number;
  from: Date;
  to: Date;
}

export interface FetchOrdersWindowResult {
  itemsProcessed: number;
  /** O `last_updated` mais recente visto NESTA busca, ou `null` se nada veio. */
  latestRecordAt: Date | null;
}

/**
 * Percorre `/orders/search` inteiro para a janela `[from, to)`, via offset
 * dentro de UMA chamada só — nunca offset persistido entre execuções
 * (`docs/MERCADO_LIVRE.md` secao 4). Lança `MercadoLivreApiError` em caso de
 * falha; o chamador decide como classificar e registrar.
 */
export async function fetchOrdersWindow(params: FetchOrdersWindowParams): Promise<FetchOrdersWindowResult> {
  const pages = paginateOffset({
    fetchPage: ({ offset, limit }) =>
      params.mercadoLivre.request({
        method: "GET",
        path: "/orders/search",
        accessToken: params.accessToken,
        searchParams: {
          seller: params.sellerId,
          "order.date_last_updated.from": toMercadoLivreDate(params.from),
          "order.date_last_updated.to": toMercadoLivreDate(params.to),
          offset,
          limit,
        },
        schema: orderSearchResponseSchema,
      }),
  });

  let itemsProcessed = 0;
  let latestRecordAt: Date | null = null;

  for await (const page of pages) {
    itemsProcessed += page.length;

    for (const item of page) {
      const updatedAt = new Date(item.last_updated);

      if (latestRecordAt === null || updatedAt > latestRecordAt) {
        latestRecordAt = updatedAt;
      }
    }
  }

  return { itemsProcessed, latestRecordAt };
}
