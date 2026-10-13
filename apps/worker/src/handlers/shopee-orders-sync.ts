import {
  ORDER_DETAIL_BATCH,
  ORDER_LIST_MAX_WINDOW_S,
  ShopeeApiError,
  getOrderDetail,
  getOrderListPage,
  shopeeEpochToIso,
  type ShopeeOrder,
} from "@sb/shopee";
import { z, ZodError } from "zod";

import type { Enqueuer } from "../enqueue.js";
import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureShopeeAccessToken, type ShopeeTokenDeps } from "./shopee-token.js";

/**
 * `shopee.orders.sync` (D-426) — os pedidos de UMA loja Shopee, uma janela de
 * até 15 dias por execução (o máximo de `get_order_list`).
 *
 * - A janela é por `update_time` a partir do marco da loja
 *   (`shopee_shops.orders_synced_until`), com 10 minutos de sobreposição: o
 *   pedido atualizado durante a execução anterior entra de novo, e gravar o
 *   mesmo pedido duas vezes é idempotente.
 * - Sem marco, a primeira leitura começa 90 dias atrás e anda em janelas de
 *   15 dias, cada uma enfileirando a seguinte até alcançar agora.
 * - O marco só avança depois de a janela inteira gravar: uma falha no meio faz
 *   a fila repetir a MESMA janela.
 *
 * Fila `backfill` (1/s, 2 simultâneas): a Shopee tem volume baixo, e a fila já
 * deixa o worker se reenfileirar.
 */

const payloadSchema = z.object({ shopeeShopId: z.uuid() });

const SOBREPOSICAO_S = 10 * 60;
const PRIMEIRA_LEITURA_S = 90 * 24 * 3600;
/** Teto de páginas de 100 por janela — 20 mil pedidos em 15 dias passaria de qualquer loja da casa. */
const MAX_PAGINAS = 200;

export interface ShopeeOrdersSyncDeps extends ShopeeTokenDeps {
  enqueuer: Enqueuer;
  now?: () => Date;
}

function falhaDaShopee(error: unknown): JobOutcome {
  if (error instanceof ZodError) {
    return { status: "failed", retryable: false, reason: "resposta da Shopee fora do contrato" };
  }

  const reason = error instanceof Error ? error.message : "erro desconhecido ao ler pedidos da Shopee";

  return {
    status: "failed",
    retryable: !(error instanceof ShopeeApiError) || error.errorClass === "retryable",
    reason,
  };
}

export function createShopeeOrdersSyncHandler(deps: ShopeeOrdersSyncDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem shopeeShopId" };
    }

    const now = deps.now?.() ?? new Date();
    const lida = await deps.db
      .from("shopee_shops")
      .select("id, organization_id, environment, shop_id, status, orders_synced_until")
      .eq("id", parsed.data.shopeeShopId)
      .maybeSingle();

    if (lida.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler a loja: ${lida.error.message}` };
    }

    const loja = lida.data;

    // Loja apagada, em erro ou de outro ambiente: a corrente para aqui, sem
    // erro. Reconectar retoma do marco.
    if (loja?.status !== "CONNECTED" || loja.environment !== deps.client.environment) {
      context.logger.info("shopee_orders_sync_skipped", {
        shopee_shop_id: parsed.data.shopeeShopId,
        motivo: loja === null ? "loja inexistente" : loja.status !== "CONNECTED" ? "loja não conectada" : "outro ambiente",
      });

      return { status: "done", processed: 0 };
    }

    const token = await ensureShopeeAccessToken(deps, { id: loja.id, shopId: loja.shop_id }, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    const shop = { accessToken: token.accessToken, shopId: loja.shop_id };
    const agoraS = Math.floor(now.getTime() / 1000);
    const marcoS = loja.orders_synced_until === null ? null : Math.floor(new Date(loja.orders_synced_until).getTime() / 1000);
    const deS = marcoS === null ? agoraS - PRIMEIRA_LEITURA_S : Math.max(marcoS - SOBREPOSICAO_S, 0);
    const ateS = Math.min(deS + ORDER_LIST_MAX_WINDOW_S, agoraS);

    let ordens: string[];

    try {
      ordens = await listarJanela(deps, shop, deS, ateS);
    } catch (error) {
      return falhaDaShopee(error);
    }

    let gravados = 0;

    for (let i = 0; i < ordens.length; i += ORDER_DETAIL_BATCH) {
      let pedidos: ShopeeOrder[];

      try {
        pedidos = await getOrderDetail(deps.client, shop, ordens.slice(i, i + ORDER_DETAIL_BATCH));
      } catch (error) {
        return falhaDaShopee(error);
      }

      const erro = await gravarPedidos(deps, { id: loja.id, organizationId: loja.organization_id }, pedidos, now);

      if (erro !== null) {
        return { status: "failed", retryable: true, reason: erro };
      }

      gravados += pedidos.length;
    }

    const marco = await deps.db
      .from("shopee_shops")
      .update({ orders_synced_until: new Date(ateS * 1000).toISOString() })
      .eq("id", loja.id);

    if (marco.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao avançar o marco da loja: ${marco.error.message}` };
    }

    const temMais = ateS < agoraS;

    if (temMais) {
      await deps.enqueuer.enqueue({
        jobType: "shopee.orders.sync",
        organizationId: loja.organization_id,
        dedupeKey: `shopee-orders:${loja.id}:${String(ateS)}`,
        queue: "backfill",
        payload: { shopeeShopId: loja.id },
      });
    }

    context.logger.info("shopee_orders_sync_done", {
      shopee_shop_id: loja.id,
      shop_id: loja.shop_id,
      de: new Date(deS * 1000).toISOString(),
      ate: new Date(ateS * 1000).toISOString(),
      pedidos_listados: ordens.length,
      pedidos_gravados: gravados,
      tem_mais: temMais,
    });

    return { status: "done", processed: gravados };
  };
}

/** Todos os `order_sn` da janela, sem repetição, página a página. */
async function listarJanela(
  deps: ShopeeOrdersSyncDeps,
  shop: { accessToken: string; shopId: number },
  deS: number,
  ateS: number,
): Promise<string[]> {
  const vistos = new Set<string>();
  let cursor: string | undefined;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
    const resposta = await getOrderListPage(deps.client, shop, {
      timeRangeField: "update_time",
      timeFrom: deS,
      timeTo: ateS,
      ...(cursor === undefined ? {} : { cursor }),
    });

    for (const sn of resposta.orderSns) vistos.add(sn);

    if (resposta.nextCursor === null || resposta.nextCursor === "") {
      return [...vistos];
    }

    cursor = resposta.nextCursor;
  }

  throw new Error(`a janela passou de ${String(MAX_PAGINAS)} páginas de pedidos; reduza a janela`);
}

/**
 * Um lote: os pedidos por upsert, e os itens SUBSTITUÍDOS (o detalhe não traz
 * identificador estável por linha em todo caso). Devolve o erro, ou `null`.
 */
async function gravarPedidos(
  deps: ShopeeOrdersSyncDeps,
  loja: { id: string; organizationId: string },
  pedidos: readonly ShopeeOrder[],
  now: Date,
): Promise<string | null> {
  if (pedidos.length === 0) return null;

  const linhas = pedidos.map((pedido) => ({
    shopee_shop_id: loja.id,
    organization_id: loja.organizationId,
    order_sn: pedido.order_sn,
    order_status: pedido.order_status,
    currency: pedido.currency ?? null,
    cod: pedido.cod ?? null,
    total_amount: pedido.total_amount ?? null,
    shopee_created_at: shopeeEpochToIso(pedido.create_time) ?? now.toISOString(),
    shopee_updated_at: shopeeEpochToIso(pedido.update_time) ?? now.toISOString(),
    paid_at: shopeeEpochToIso(pedido.pay_time),
    shipping_carrier: pedido.shipping_carrier ?? null,
    payment_method: pedido.payment_method ?? null,
    cancel_by: pedido.cancel_by ?? null,
    cancel_reason: pedido.cancel_reason ?? null,
    synced_at: now.toISOString(),
  }));

  const ordens = await deps.db.from("shopee_orders").upsert(linhas, { onConflict: "shopee_shop_id,order_sn" });

  if (ordens.error !== null) return `falha ao gravar pedidos: ${ordens.error.message}`;

  const apagados = await deps.db
    .from("shopee_order_items")
    .delete()
    .eq("shopee_shop_id", loja.id)
    .in(
      "order_sn",
      pedidos.map((pedido) => pedido.order_sn),
    );

  if (apagados.error !== null) return `falha ao substituir itens: ${apagados.error.message}`;

  const itens = pedidos.flatMap((pedido) =>
    (pedido.item_list ?? []).map((item, position) => ({
      shopee_shop_id: loja.id,
      order_sn: pedido.order_sn,
      position,
      organization_id: loja.organizationId,
      item_id: item.item_id,
      item_name: item.item_name ?? null,
      item_sku: item.item_sku === "" ? null : (item.item_sku ?? null),
      model_id: item.model_id === 0 ? null : (item.model_id ?? null),
      model_name: item.model_name === "" ? null : (item.model_name ?? null),
      model_sku: item.model_sku === "" ? null : (item.model_sku ?? null),
      quantity: item.model_quantity_purchased,
      original_price: item.model_original_price ?? null,
      discounted_price: item.model_discounted_price ?? null,
      promotion_type: item.promotion_type === "" ? null : (item.promotion_type ?? null),
    })),
  );

  if (itens.length === 0) return null;

  const inseridos = await deps.db.from("shopee_order_items").insert(itens);

  return inseridos.error === null ? null : `falha ao gravar itens: ${inseridos.error.message}`;
}
