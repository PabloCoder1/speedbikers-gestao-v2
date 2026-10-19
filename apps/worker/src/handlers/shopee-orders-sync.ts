import {
  ORDER_DETAIL_BATCH,
  ORDER_LIST_MAX_WINDOW_S,
  getOrderDetail,
  getOrderListPage,
  shopeeEpochToIso,
  type ShopeeOrder,
} from "@sb/shopee";

import type { EnqueueRequest } from "../enqueue.js";
import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { asJson } from "./domain-events.js";
import { falhaDaShopee, lerLojaConectada, type LojaConectada, type ShopeeJobDeps } from "./shopee-comum.js";
import { ensureShopeeAccessToken } from "./shopee-token.js";

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
 * - D-432: cada lote é gravado numa transação (`shopee_upsert_orders`: o
 *   pedido, os itens substituídos e o SKU), sem regredir — a leitura mais
 *   velha que a guardada é ignorada, porque duas execuções na mesma loja
 *   podem se cruzar. O marco também só anda para a frente
 *   (`shopee_advance_orders_synced_until`).
 *
 * - D-481: uma leitura por loja de cada vez (`shopee_orders_sync_lock`). O
 *   aviso de pedido (push, D-453) e o gatilho horário enfileiram esta tarefa
 *   enquanto a cadeia da loja anda; sem a trava, as duas liam a MESMA janela
 *   ao mesmo tempo. Quem não pega encerra sem erro (a leitura em andamento
 *   cobre a loja). A trava é solta ANTES de enfileirar a janela seguinte: a
 *   continuação a acharia presa. Vencida (execução que morreu no meio), o
 *   próximo gatilho pega.
 *
 * Fila `backfill` (1/s, 2 simultâneas): a Shopee tem volume baixo, e a fila já
 * deixa o worker se reenfileirar.
 */

const SOBREPOSICAO_S = 10 * 60;
/** D-481: validade da trava -- uma janela de 15 dias leva ~2 min nas lojas reais. */
const TRAVA_S = 10 * 60;
const PRIMEIRA_LEITURA_S = 90 * 24 * 3600;
/** Teto de páginas de 100 por janela — 20 mil pedidos em 15 dias passaria de qualquer loja da casa. */
const MAX_PAGINAS = 200;

/**
 * A janela passou do teto. Repetir leria a MESMA janela e bateria no mesmo
 * teto: a falha não se repete (D-432) e aparece em `job_runs` a cada hora.
 */
class JanelaGrandeDemais extends Error {}

export type ShopeeOrdersSyncDeps = ShopeeJobDeps;

export function createShopeeOrdersSyncHandler(deps: ShopeeOrdersSyncDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const aberta = await lerLojaConectada(deps, context, "shopee_orders_sync_skipped");

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const trava = await deps.db.rpc("shopee_orders_sync_lock", { p_shopee_shop_id: loja.id, p_ttl_seconds: TRAVA_S });

    if (trava.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao travar a leitura de pedidos: ${trava.error.message}` };
    }

    if (!trava.data) {
      context.logger.info("shopee_orders_sync_skipped", { shopee_shop_id: loja.id, motivo: "outra leitura em andamento" });

      return { status: "done", processed: 0 };
    }

    const seguintes: EnqueueRequest[] = [];
    let outcome: JobOutcome;

    try {
      outcome = await lerJanela(deps, context, loja, seguintes);
    } finally {
      // Solta ANTES de enfileirar: a janela seguinte acharia a loja travada.
      const solta = await deps.db.from("shopee_shops").update({ orders_sync_locked_until: null }).eq("id", loja.id);

      if (solta.error !== null) {
        context.logger.warn("shopee_orders_sync_unlock_failed", { shopee_shop_id: loja.id, reason: solta.error.message });
      }
    }

    for (const pedido of seguintes) {
      await deps.enqueuer.enqueue(pedido);
    }

    return outcome;
  };
}

/**
 * Uma janela de pedidos da loja (a leitura de D-426/D-432, sem mudança). As
 * tarefas seguintes (a próxima janela, ou o financeiro, as devoluções, o Ads e
 * os repasses) vão em `seguintes`: quem enfileira é o handler, depois de
 * soltar a trava (D-481).
 */
async function lerJanela(
  deps: ShopeeOrdersSyncDeps,
  context: HandlerContext,
  loja: LojaConectada,
  seguintes: EnqueueRequest[],
): Promise<JobOutcome> {
  const now = deps.now?.() ?? new Date();
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
    if (error instanceof JanelaGrandeDemais) {
      return { status: "failed", retryable: false, reason: error.message };
    }

    return falhaDaShopee(error, "erro desconhecido ao ler pedidos da Shopee");
  }

  let gravados = 0;
  let ignorados = 0;

  for (let i = 0; i < ordens.length; i += ORDER_DETAIL_BATCH) {
    let pedidos: ShopeeOrder[];

    try {
      pedidos = await getOrderDetail(deps.client, shop, ordens.slice(i, i + ORDER_DETAIL_BATCH));
    } catch (error) {
      return falhaDaShopee(error, "erro desconhecido ao ler pedidos da Shopee");
    }

    const lote = await gravarPedidos(deps, loja.id, pedidos, now);

    if ("erro" in lote) {
      return { status: "failed", retryable: true, reason: lote.erro };
    }

    gravados += lote.gravados;
    ignorados += pedidos.length - lote.gravados;
  }

  const marco = await deps.db.rpc("shopee_advance_orders_synced_until", {
    p_shopee_shop_id: loja.id,
    p_until: new Date(ateS * 1000).toISOString(),
  });

  if (marco.error !== null) {
    return { status: "failed", retryable: true, reason: `falha ao avançar o marco da loja: ${marco.error.message}` };
  }

  const temMais = ateS < agoraS;

  if (temMais) {
    seguintes.push({
      jobType: "shopee.orders.sync",
      organizationId: loja.organization_id,
      dedupeKey: `shopee-orders:${loja.id}:${String(ateS)}`,
      queue: "backfill",
      payload: { shopeeShopId: loja.id },
    });
  } else {
    // Os pedidos alcançaram agora: o financeiro deles vem atrás (D-427), e
    // as devoluções (D-447), o Ads (D-449) e os repasses (D-451) da loja também.
    seguintes.push({
      jobType: "shopee.order-financials.sync",
      organizationId: loja.organization_id,
      dedupeKey: `shopee-financials:${loja.id}:${String(ateS)}`,
      queue: "backfill",
      payload: { shopeeShopId: loja.id },
    });
    seguintes.push({
      jobType: "shopee.returns.sync",
      organizationId: loja.organization_id,
      dedupeKey: `shopee-returns-ciclo:${loja.id}:${String(ateS)}`,
      queue: "backfill",
      payload: { shopeeShopId: loja.id },
    });
    seguintes.push({
      jobType: "shopee.ads.sync",
      organizationId: loja.organization_id,
      dedupeKey: `shopee-ads:${loja.id}:${String(ateS)}`,
      queue: "backfill",
      payload: { shopeeShopId: loja.id },
    });
    seguintes.push({
      jobType: "shopee.escrow-releases.sync",
      organizationId: loja.organization_id,
      dedupeKey: `shopee-escrow-releases-ciclo:${loja.id}:${String(ateS)}`,
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
    // Leitura mais velha que a guardada (outra execução chegou antes).
    pedidos_ignorados: ignorados,
    tem_mais: temMais,
  });

  return { status: "done", processed: gravados };
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

  throw new JanelaGrandeDemais(`a janela passou de ${String(MAX_PAGINAS)} páginas de pedidos; reduza a janela`);
}

/**
 * Um lote, numa transação (`shopee_upsert_orders`, D-432): o pedido, os itens
 * SUBSTITUÍDOS (o detalhe não traz identificador estável por linha em todo
 * caso) e o SKU de cada item (D-430). Aqui só se normaliza: vazio vira nulo,
 * modelo 0 vira nulo. Devolve quantos pedidos o banco gravou — os outros eram
 * leitura mais velha que a guardada.
 */
async function gravarPedidos(
  deps: ShopeeOrdersSyncDeps,
  lojaId: string,
  pedidos: readonly ShopeeOrder[],
  now: Date,
): Promise<{ gravados: number } | { erro: string }> {
  if (pedidos.length === 0) return { gravados: 0 };

  const lote = pedidos.map((pedido) => ({
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
    // D-495: quem expede (o armazém da Shopee ou o vendedor), como veio.
    fulfillment_flag: pedido.fulfillment_flag === "" ? null : (pedido.fulfillment_flag ?? null),
    itens: (pedido.item_list ?? []).map((item, position) => ({
      position,
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
  }));

  const gravado = await deps.db.rpc("shopee_upsert_orders", {
    p_shopee_shop_id: lojaId,
    p_pedidos: asJson(lote),
    p_synced_at: now.toISOString(),
  });

  if (gravado.error !== null) return { erro: `falha ao gravar pedidos: ${gravado.error.message}` };

  return { gravados: gravado.data };
}
