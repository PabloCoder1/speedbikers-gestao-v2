import type { AdminClient } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { paginateOffset } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import { orderSchema } from "./order-schema.js";
import type { ParsedOrder } from "./order-schema.js";
import { persistOrder, prefetchOrders } from "./persist-order.js";

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
  /** Dias de negócio que tiveram ao menos uma order persistida nesta janela. */
  dirtyMetricDates: string[];
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
  const dirtyMetricDates = new Set<string>();

  const context = { organizationId: params.organizationId, mlAccountId: params.mlAccountId };

  for await (const page of pages) {
    // D-186 — a pagina inteira e parseada antes de persistir, para que as
    // LEITURAS possam ser resolvidas de uma vez so.
    //
    // MEDIDO em D-185: o custo de uma ida ao banco e o round trip, nao o SQL
    // (o SQL das sete idas de um pedido soma 3,95 ms contra 660,7 ms
    // observados). Logo o que importa e o NUMERO de idas. As tres leituras
    // eram 3 por pedido — 150 numa pagina de 50 — e passam a ser ~4 por
    // pagina.
    //
    // **As ESCRITAS continuam uma por pedido, de proposito.** Nao e timidez;
    // sao tres razoes medidas:
    //
    //  1. `order_items` e substituido por `delete` + `insert`, e PostgREST
    //     nao tem transacao entre chamadas. Em lote, um insert que falha
    //     depois do delete deixaria os 50 pedidos da pagina sem itens em vez
    //     de um — multiplicando por 50 exatamente a janela que D-184 acabou
    //     de fechar.
    //  2. `stock_movements_apply_to_balance` e `AFTER INSERT FOR EACH ROW` e
    //     faz `DO UPDATE` em `inventory_balances`. Um insert de ~36 linhas
    //     seguraria ~36 travas de saldo em ordem arbitraria dentro de um
    //     statement — classe de deadlock que hoje nao existe, com 4 contas
    //     na mesma organizacao e catalogo compartilhado.
    //  3. `recordStockMovements` e compartilhada com `nfe-import-apply`, que
    //     marca a nota `APPLIED` incondicionalmente logo depois. All-or-
    //     nothing ali e perda de estoque permanente sem retry — ao contrario
    //     de pedido, que a janela horaria reprocessa.
    //
    // O lote de escrita fica registrado no ROADMAP com essas tres, para nao
    // ser refeito como se fosse so mais um `in (...)`.
    const orders: ParsedOrder[] = [];

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

      orders.push(parsed.data);
    }

    const prefetch = await prefetchOrders(params.db, context, orders);

    for (const order of orders) {
      await persistOrder(params.db, context, order, params.logger, prefetch);

      dirtyMetricDates.add(toSalesMetricDate(order.date_created));

      itemsProcessed += 1;

      // No search o campo SEMPRE vem (D-048) — o opcional no schema existe
      // para o GET por id do fast path (D-101). Se um dia faltar aqui, NÃO
      // avançar o checkpoint é o conservador: um checkpoint adiantado por
      // fallback poderia pular janela e perder pedido; um parado só
      // reprocessa, que é idempotente.
      const updatedAt = order.date_last_updated != null ? new Date(order.date_last_updated) : null;

      if (updatedAt !== null && (latestRecordAt === null || updatedAt > latestRecordAt)) {
        latestRecordAt = updatedAt;
      }
    }
  }

  return {
    itemsProcessed,
    itemsSkipped,
    latestRecordAt,
    dirtyMetricDates: [...dirtyMetricDates].sort(),
  };
}
