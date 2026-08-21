import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { paginateOffset } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import { orderSchema } from "./order-schema.js";
import { persistOrder } from "./persist-order.js";

/**
 * Busca de pedidos por janela de data, compartilhada por `sync.orders.window`
 * (reconciliação) e `backfill.orders` (história) — a única diferença entre os
 * dois é COMO `from`/`to` são calculados, não como a busca em si acontece.
 */

/**
 * `results` é validado FROUXO aqui (`z.unknown()`), não com `orderSchema`
 * direto: uma order com formato inesperado no meio da página não pode
 * derrubar a página inteira — `client.request()` valida a resposta INTEIRA
 * de uma vez, então o parse estrito por order acontece depois, item a item,
 * dentro do loop abaixo (mesmo espírito de `erp_import_rows` distinguindo
 * `SKIPPED`/`INVALID` de falhar o lote inteiro).
 */
const orderSearchResponseSchema = z.object({
  paging: z.object({ total: z.number(), offset: z.number(), limit: z.number() }),
  results: z.array(z.unknown()),
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
  db: AdminClient;
  organizationId: string;
  mlAccountId: string;
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  sellerId: number;
  from: Date;
  to: Date;
  logger: Logger;
}

export interface FetchOrdersWindowResult {
  itemsProcessed: number;
  /** Orders que não bateram `orderSchema` — logadas, não fatais (ver nota acima). */
  itemsSkipped: number;
  /** O `date_last_updated` mais recente visto NESTA busca, ou `null` se nada veio. */
  latestRecordAt: Date | null;
}

/**
 * Percorre `/orders/search` inteiro para a janela `[from, to)`, via offset
 * dentro de UMA chamada só — nunca offset persistido entre execuções
 * (`docs/MERCADO_LIVRE.md` secao 4). Grava cada order válida
 * (`persistOrder`) conforme a página chega. Lança `MercadoLivreApiError` em
 * caso de falha de rede/HTTP; o chamador decide como classificar e
 * registrar.
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
  let itemsSkipped = 0;
  let latestRecordAt: Date | null = null;

  for await (const page of pages) {
    for (const raw of page) {
      const parsed = orderSchema.safeParse(raw);

      if (!parsed.success) {
        itemsSkipped += 1;
        params.logger.warn("order_parse_failed", {
          ml_account_id: params.mlAccountId,
          issues: parsed.error.issues.map((issue) => issue.message),
        });

        continue;
      }

      const order = parsed.data;

      await persistOrder(
        params.db,
        { organizationId: params.organizationId, mlAccountId: params.mlAccountId },
        order,
        params.logger,
      );

      itemsProcessed += 1;

      const updatedAt = new Date(order.date_last_updated);

      if (latestRecordAt === null || updatedAt > latestRecordAt) {
        latestRecordAt = updatedAt;
      }
    }
  }

  return { itemsProcessed, itemsSkipped, latestRecordAt };
}
