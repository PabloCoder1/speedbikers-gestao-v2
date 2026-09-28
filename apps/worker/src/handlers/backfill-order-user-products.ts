import { toSalesMetricDate } from "@sb/domain";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import { z, ZodError } from "zod";

import type { Enqueuer } from "../enqueue.js";
import type { JobOutcome } from "../job-outcome.js";
import { readAllPages } from "../read-all-pages.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { orderSchema } from "./order-schema.js";
import { resolveSku, userProductDoItem } from "./persist-order.js";
import type { SyncOrderFinancialsDeps } from "./sync-order-financials.js";
import { recordSyncRunFailure, recordSyncRunSuccess } from "./sync-runs.js";

/**
 * `backfill.order-user-products` (D-362, 3ª parte) — o SKU dos itens vendidos
 * ANTIGOS que ficaram sem, para os relatórios.
 *
 * A 2ª parte da D-362 resolve a venda pelo vínculo `USER_PRODUCT`, mas só na
 * venda que chega depois dela, e só quando o pedido traz o user product: o
 * `GET /orders/{id}` do webhook traz, o `/orders/search` da reconciliação não.
 * Em produção, de 26/08 a 14/09, ~3.300 itens ficaram sem SKU — fora do
 * ranking, da margem por produto e das curvas por SKU.
 *
 * **A regra é a do worker, a mesma função** (`resolveSku`): vínculo por
 * anúncio primeiro, depois o do user product. Regra mais larga seria desfeita
 * no primeiro reprocessamento do pedido (o argumento de D-356). O item com
 * user product já gravado resolve sem chamada; só o que não tem custa um
 * `GET /orders/{id}`, e o user product lido fica gravado mesmo sem vínculo.
 *
 * **Nenhum movimento de estoque**, como em D-356: o job grava `sku_id` e
 * `user_product_id` na linha, e mais nada. A venda antiga já está no saldo
 * pela planilha do UpSeller (D-351); pelo caminho inteiro do `persistOrder`,
 * o SKU com planilha sairia em par que soma zero, mas o SKU SEM planilha
 * baixaria o estoque de hoje por uma venda de agosto. Quando o pedido voltar
 * ao worker, a baixa segue a regra de sempre — o SKU que ele resolve é o
 * mesmo.
 *
 * **O desenho é o de `backfill.order-financials` (D-396):** fila `backfill`,
 * um dia por pedaço, cada pedaço enfileira o dia anterior até o limite,
 * progresso por existência (o item que ganhou SKU sai da busca; o que ganhou
 * só o user product não custa chamada de novo).
 *
 * Erros do Mercado Livre: 429/5xx/rede propagam e a fila repete o pedaço; 4xx
 * definitivo pula o pedido (um pedido que sumiu não trava a história). A
 * exceção é a recusa que não é do pedido: 401, e 403 SEM corpo — a recusa por
 * instância de 25 e 27/09, que recusa tudo. Ela também falha o pedaço, para a
 * fila repetir (noutra instância) em vez de a corrente atravessar a história
 * sem ler nada. O 403 do PolicyAgent vem com corpo e é do pedido.
 */

const payloadSchema = z.object({
  mlAccountId: z.uuid(),
  /** Fim do pedaço, exclusivo. */
  ate: z.iso.datetime(),
  /** Até onde a recuperação desce; o último pedaço para aqui. */
  limite: z.iso.datetime(),
});

/** Um dia por execução, como D-396. */
const PEDACO_MS = 24 * 3_600_000;

/** `order_items` é consultada pelos ids do pedaço em lotes: a URL do PostgREST tem teto. */
const LOTE_DE_IDS = 200;

/** Teto do PostgREST (D-131): a leitura em lote que chega nele pode ter sido cortada. */
const TETO_POSTGREST = 1000;

/** A mesma pausa entre pedidos da varredura de frete. */
const PAUSA_ENTRE_PEDIDOS_MS = 150;

interface ItemSemSku {
  id: string;
  order_id: number;
  position: number;
  item_id: string;
  variation_id: string | null;
  user_product_id: string | null;
}

export interface BackfillOrderUserProductsDeps extends SyncOrderFinancialsDeps {
  enqueuer: Enqueuer;
}

interface Contagem {
  /** Itens que ganharam `sku_id`. */
  comSku: number;
  /** Itens que ganharam só o `user_product_id` (sem vínculo para ele). */
  soUserProduct: number;
  /** Itens cujo pedido, relido, não traz user product. */
  semUserProduct: number;
  /** Pedidos relidos no Mercado Livre. */
  leituras: number;
  /** Leituras recusadas com 4xx definitivo do pedido (404, 403 com corpo). */
  recusadas: number;
  /** Respostas fora do contrato (D-229). */
  foraDoContrato: number;
  /** Linha do pedido relido que não é mais o item gravado naquela posição. */
  divergentes: number;
}

/** 401, ou 403 sem corpo: a recusa não é do pedido, e o pedaço inteiro falha (ver o cabeçalho). */
function recusaDaInstancia(error: unknown): boolean {
  return (
    error instanceof MercadoLivreApiError &&
    (error.status === 401 || (error.status === 403 && (error.body === undefined || error.body === null)))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createBackfillOrderUserProductsHandler(deps: BackfillOrderUserProductsDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId, ate ou limite" };
    }

    const { mlAccountId } = parsed.data;
    const ate = new Date(parsed.data.ate);
    const limite = new Date(parsed.data.limite);
    const now = deps.now?.() ?? new Date();

    if (ate.getTime() <= limite.getTime()) {
      context.logger.info("backfill_order_user_products_complete", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, slug, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler a conta: ${account.error.message}` };
    }

    if (account.data?.status !== "CONNECTED") {
      // Desconectada entre um pedaço e outro: a corrente para aqui, sem erro.
      // Um novo disparo retoma — o que ganhou SKU sai da busca.
      context.logger.info("backfill_order_user_products_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const { organization_id: organizationId, slug } = account.data;
    const desde = new Date(Math.max(ate.getTime() - PEDACO_MS, limite.getTime()));
    const started = now;
    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      await recordSyncRunFailure(
        deps.db,
        {
          organizationId,
          mlAccountId,
          jobId: envelope.jobId,
          resource: "orders",
          channel: "backfill",
          startedAt: started,
          finishedAt: deps.now?.() ?? new Date(),
          reason: tokenResult.reason,
          errorClass: tokenResult.retryable ? "retryable" : "not_retryable",
        },
        context.logger,
      );

      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    const contagem: Contagem = {
      comSku: 0,
      soUserProduct: 0,
      semUserProduct: 0,
      leituras: 0,
      recusadas: 0,
      foraDoContrato: 0,
      divergentes: 0,
    };
    const diasTocados = new Set<string>();
    const itensPorPedido = new Map<number, ItemSemSku[]>();

    try {
      // Os mesmos status da varredura de frete: a venda que conta nos relatórios.
      const orders = await readAllPages<{ id: number; date_created: string }>(
        (from, to) =>
          deps.db
            .from("orders")
            .select("id, date_created")
            .eq("ml_account_id", mlAccountId)
            .in("status", ["paid", "partially_refunded"])
            .gte("date_created", desde.toISOString())
            .lt("date_created", ate.toISOString())
            .order("id")
            .range(from, to),
        { label: "falha ao ler orders do pedaço" },
      );

      const criadoEm = new Map(orders.map((order) => [order.id, order.date_created]));

      for (let i = 0; i < orders.length; i += LOTE_DE_IDS) {
        const ids = orders.slice(i, i + LOTE_DE_IDS).map((order) => order.id);
        const lidos = await deps.db
          .from("order_items")
          .select("id, order_id, position, item_id, variation_id, user_product_id")
          .in("order_id", ids)
          .is("sku_id", null);

        if (lidos.error !== null) {
          throw new Error(`falha ao ler os itens sem SKU: ${lidos.error.message}`);
        }

        if (lidos.data.length >= TETO_POSTGREST) {
          throw new Error(`a leitura dos itens sem SKU chegou ao teto do PostgREST (D-131): reduza o lote`);
        }

        for (const item of lidos.data) {
          const doPedido = itensPorPedido.get(item.order_id) ?? [];
          doPedido.push(item);
          itensPorPedido.set(item.order_id, doPedido);
        }
      }

      for (const [orderId, itens] of itensPorPedido) {
        const preenchidos = await preencherPedido({
          deps,
          context,
          mlAccountId,
          accessToken: tokenResult.accessToken,
          orderId,
          itens,
          contagem,
        });
        const dataCriacao = criadoEm.get(orderId);

        if (preenchidos > 0 && dataCriacao !== undefined) {
          diasTocados.add(toSalesMetricDate(dataCriacao));
        }
      }
    } catch (error) {
      const finishedAt = deps.now?.() ?? new Date();
      const errorClass =
        error instanceof MercadoLivreApiError && !recusaDaInstancia(error) ? error.errorClass : "retryable";
      const reason = error instanceof Error ? error.message : "erro desconhecido ao preencher o SKU dos itens";

      await recordSyncRunFailure(
        deps.db,
        {
          organizationId,
          mlAccountId,
          jobId: envelope.jobId,
          resource: "orders",
          channel: "backfill",
          startedAt: started,
          finishedAt,
          reason,
          errorClass,
        },
        context.logger,
      );

      // O que já ganhou SKU fica; a fila repete O MESMO pedaço, e ele sai da busca.
      return { status: "failed", retryable: errorClass !== "not_retryable", reason };
    }

    // `daily_sku_metrics` agrupa por `order_items.sku_id` (D-356): sem o
    // recálculo, o item continuaria no balde "sem produto" dos relatórios.
    const janela = `${(deps.now?.() ?? new Date()).toISOString().slice(0, 16)}Z`;

    for (const metricDate of [...diasTocados].sort()) {
      await deps.enqueuer.enqueue({
        jobType: "analytics.recompute",
        organizationId,
        dedupeKey: `recompute:${mlAccountId}:${metricDate}:${janela}`,
        queue: "analytics-recompute",
        payload: { mode: "incremental", mlAccountId, metricDate },
        delaySeconds: 60,
      });
    }

    const finishedAt = deps.now?.() ?? new Date();
    const foraDoContrato =
      contagem.foraDoContrato > 0
        ? `${String(contagem.foraDoContrato)} pedido(s) com resposta fora do contrato do Mercado Livre; não gravados`
        : undefined;

    await recordSyncRunSuccess(
      deps.db,
      {
        organizationId,
        mlAccountId,
        jobId: envelope.jobId,
        resource: "orders",
        channel: "backfill",
        itemsProcessed: contagem.comSku,
        latestRecordAt: finishedAt,
        startedAt: started,
        finishedAt,
        status: contagem.foraDoContrato > 0 ? "partial" : "done",
        ...(foraDoContrato !== undefined ? { reason: foraDoContrato } : {}),
      },
      context.logger,
    );

    const temMais = desde.getTime() > limite.getTime();

    if (temMais) {
      await deps.enqueuer.enqueue({
        jobType: "backfill.order-user-products",
        organizationId,
        dedupeKey: `backfill-order-user-products:${slug}:${desde.toISOString()}`,
        queue: "backfill",
        payload: { mlAccountId, ate: desde.toISOString(), limite: limite.toISOString() },
      });
    }

    context.logger.info("backfill_order_user_products_chunk_done", {
      ml_account_id: mlAccountId,
      desde: desde.toISOString(),
      ate: ate.toISOString(),
      pedidos_com_item_sem_sku: itensPorPedido.size,
      itens_com_sku: contagem.comSku,
      itens_so_user_product: contagem.soUserProduct,
      itens_sem_user_product: contagem.semUserProduct,
      leituras: contagem.leituras,
      leituras_recusadas: contagem.recusadas,
      fora_do_contrato: contagem.foraDoContrato,
      divergentes: contagem.divergentes,
      dias_recalculados: diasTocados.size,
      tem_mais: temMais,
    });

    return { status: "done", processed: contagem.comSku };
  };
}

/**
 * Um pedido: resolve o que já dá sem chamada, relê no Mercado Livre só se
 * sobrar item sem user product, e grava. Devolve quantos itens ganharam SKU.
 */
async function preencherPedido(params: {
  deps: BackfillOrderUserProductsDeps;
  context: HandlerContext;
  mlAccountId: string;
  accessToken: string;
  orderId: number;
  itens: readonly ItemSemSku[];
  contagem: Contagem;
}): Promise<number> {
  const { deps, context, mlAccountId, accessToken, orderId, itens, contagem } = params;
  let preenchidos = 0;
  const semUserProduct: ItemSemSku[] = [];

  for (const item of itens) {
    const link = await resolveSku(deps.db, mlAccountId, item.item_id, item.variation_id, item.user_product_id);

    if (link !== null) {
      await gravar(deps, item, { sku_id: link.sku_id, sku_listing_link_id: link.id });
      contagem.comSku += 1;
      preenchidos += 1;
    } else if (item.user_product_id === null) {
      semUserProduct.push(item);
    }
    // Com user product e sem vínculo: nada a fazer até alguém vincular.
  }

  if (semUserProduct.length === 0) {
    return preenchidos;
  }

  if (contagem.leituras > 0) {
    await (deps.sleep ?? sleep)(PAUSA_ENTRE_PEDIDOS_MS);
  }

  contagem.leituras += 1;

  let order;

  try {
    order = await deps.mercadoLivre.request({
      method: "GET",
      path: `/orders/${String(orderId)}`,
      accessToken,
      schema: orderSchema,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      contagem.foraDoContrato += 1;
      context.logger.warn("backfill_order_user_products_shape_unknown", {
        ml_account_id: mlAccountId,
        order_id: orderId,
        issues: error.issues.map((issue) => `${issue.path.map(String).join(".")}: ${issue.message}`),
      });

      return preenchidos;
    }

    if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable" && !recusaDaInstancia(error)) {
      contagem.recusadas += 1;

      return preenchidos;
    }

    throw error;
  }

  for (const item of semUserProduct) {
    const linha = order.order_items[item.position];

    // A posição é o índice no pedido (`persistOrder`); se o item ali não é o
    // gravado, o pedido mudou e o próximo reprocessamento dele decide.
    if (linha?.item.id !== item.item_id) {
      contagem.divergentes += 1;

      continue;
    }

    const userProductId = userProductDoItem(linha.item.user_product_id);

    if (userProductId === null) {
      contagem.semUserProduct += 1;

      continue;
    }

    const link = await resolveSku(deps.db, mlAccountId, item.item_id, item.variation_id, userProductId);

    if (link === null) {
      await gravar(deps, item, { user_product_id: userProductId });
      contagem.soUserProduct += 1;
    } else {
      await gravar(deps, item, {
        user_product_id: userProductId,
        sku_id: link.sku_id,
        sku_listing_link_id: link.id,
      });
      contagem.comSku += 1;
      preenchidos += 1;
    }
  }

  return preenchidos;
}

/**
 * Só a linha que ainda está sem SKU: se o worker regravou o pedido no meio
 * (delete + insert), a linha nova já saiu com a regra dele e nada é tocado.
 */
async function gravar(
  deps: BackfillOrderUserProductsDeps,
  item: ItemSemSku,
  campos: { user_product_id?: string; sku_id?: string; sku_listing_link_id?: string },
): Promise<void> {
  const resultado = await deps.db.from("order_items").update(campos).eq("id", item.id).is("sku_id", null);

  if (resultado.error !== null) {
    throw new Error(`falha ao gravar o SKU do item ${item.id}: ${resultado.error.message}`);
  }
}
