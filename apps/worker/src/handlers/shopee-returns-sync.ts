import { RETURN_LIST_MAX_WINDOW_S, getReturnListPage, shopeeEpochToIso, type ShopeeReturn } from "@sb/shopee";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { asJson } from "./domain-events.js";
import { falhaDaShopee, lerLojaConectada, type ShopeeJobDeps } from "./shopee-comum.js";
import { ensureShopeeAccessToken } from "./shopee-token.js";

/**
 * `shopee.returns.sync` (D-447) — as devoluções de UMA loja Shopee, uma janela
 * de até 15 dias de `update_time` por execução (o máximo de
 * `get_return_list`), como `shopee.orders.sync` (D-426/D-432):
 *
 * - a janela parte do marco da loja (`shopee_shops.returns_synced_until`) com
 *   10 minutos de sobreposição; sem marco, a primeira leitura começa 90 dias
 *   atrás e anda em janelas de 15 dias, cada uma enfileirando a seguinte;
 * - o marco só avança depois de a janela inteira gravar, e nunca recua;
 * - cada lote vai numa transação (`shopee_upsert_returns`: a devolução sem
 *   regredir, os itens substituídos e o SKU de cada item).
 *
 * Enfileirada por `shopee.orders.sync` quando os pedidos alcançam agora.
 * Nada do comprador é lido ou gravado (o cliente descarta).
 */

const SOBREPOSICAO_S = 10 * 60;
const PRIMEIRA_LEITURA_S = 90 * 24 * 3600;
/** Teto de páginas de 100 por janela: 10 mil devoluções em 15 dias passaria de qualquer loja da casa. */
const MAX_PAGINAS = 100;

/** A janela passou do teto, ou a paginação repetiu: repetir não resolve (D-432). */
class ListagemDefinitiva extends Error {}

export type ShopeeReturnsSyncDeps = ShopeeJobDeps;

export function createShopeeReturnsSyncHandler(deps: ShopeeReturnsSyncDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const aberta = await lerLojaConectada(deps, context, "shopee_returns_sync_skipped");

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    // O marco das devoluções, lido à parte: `lerLojaConectada` só lê colunas
    // de antes da D-428.
    const marcoLido = await deps.db.from("shopee_shops").select("returns_synced_until").eq("id", loja.id).maybeSingle();

    if (marcoLido.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler o marco das devoluções: ${marcoLido.error.message}` };
    }

    const now = deps.now?.() ?? new Date();
    const token = await ensureShopeeAccessToken(deps, { id: loja.id, shopId: loja.shop_id }, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    const shop = { accessToken: token.accessToken, shopId: loja.shop_id };
    const agoraS = Math.floor(now.getTime() / 1000);
    const marco = marcoLido.data?.returns_synced_until ?? null;
    const marcoS = marco === null ? null : Math.floor(new Date(marco).getTime() / 1000);
    const deS = marcoS === null ? agoraS - PRIMEIRA_LEITURA_S : Math.max(marcoS - SOBREPOSICAO_S, 0);
    const ateS = Math.min(deS + RETURN_LIST_MAX_WINDOW_S, agoraS);

    let devolucoes: ShopeeReturn[];

    try {
      devolucoes = await listarJanela(deps, shop, deS, ateS);
    } catch (error) {
      if (error instanceof ListagemDefinitiva) {
        return { status: "failed", retryable: false, reason: error.message };
      }

      return falhaDaShopee(error, "erro desconhecido ao ler devoluções da Shopee");
    }

    let gravadas = 0;

    for (let i = 0; i < devolucoes.length; i += 100) {
      const lote = await gravarDevolucoes(deps, loja.id, devolucoes.slice(i, i + 100), now);

      if ("erro" in lote) {
        return { status: "failed", retryable: true, reason: lote.erro };
      }

      gravadas += lote.gravadas;
    }

    const avancado = await deps.db.rpc("shopee_advance_returns_synced_until", {
      p_shopee_shop_id: loja.id,
      p_until: new Date(ateS * 1000).toISOString(),
    });

    if (avancado.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao avançar o marco das devoluções: ${avancado.error.message}` };
    }

    const temMais = ateS < agoraS;

    if (temMais) {
      await deps.enqueuer.enqueue({
        jobType: "shopee.returns.sync",
        organizationId: loja.organization_id,
        dedupeKey: `shopee-returns:${loja.id}:${String(ateS)}`,
        queue: "backfill",
        payload: { shopeeShopId: loja.id },
      });
    }

    context.logger.info("shopee_returns_sync_done", {
      shopee_shop_id: loja.id,
      shop_id: loja.shop_id,
      de: new Date(deS * 1000).toISOString(),
      ate: new Date(ateS * 1000).toISOString(),
      devolucoes_listadas: devolucoes.length,
      devolucoes_gravadas: gravadas,
      // Leitura mais velha que a guardada (outra execução chegou antes).
      devolucoes_ignoradas: devolucoes.length - gravadas,
      tem_mais: temMais,
    });

    return { status: "done", processed: gravadas };
  };
}

/**
 * Todas as devoluções da janela, página a página. `page_no` começa em 0 (a
 * referência; o exemplo dela usa 1): uma página que só repete devoluções já
 * vistas enquanto a Shopee diz que há mais é paginação fora do esperado — a
 * tarefa para com o motivo, em vez de girar em falso.
 */
async function listarJanela(
  deps: ShopeeReturnsSyncDeps,
  shop: { accessToken: string; shopId: number },
  deS: number,
  ateS: number,
): Promise<ShopeeReturn[]> {
  const vistas = new Map<string, ShopeeReturn>();

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
    const resposta = await getReturnListPage(deps.client, shop, { timeFrom: deS, timeTo: ateS, pageNo: pagina });
    let novas = 0;

    for (const devolucao of resposta.returns) {
      const anterior = vistas.get(devolucao.return_sn);

      if (anterior === undefined) novas += 1;

      if (anterior === undefined || anterior.update_time <= devolucao.update_time) {
        vistas.set(devolucao.return_sn, devolucao);
      }
    }

    if (!resposta.more) return [...vistas.values()];

    if (novas === 0) {
      throw new ListagemDefinitiva(`a página ${String(pagina)} de devoluções só repetiu as anteriores; paginação fora do esperado`);
    }
  }

  throw new ListagemDefinitiva(`a janela passou de ${String(MAX_PAGINAS)} páginas de devoluções; reduza a janela`);
}

/** 0 na API = devolução e reembolso; 1 = só reembolso (documentação). */
function solucao(valor: number | null | undefined): "RETURN_REFUND" | "REFUND" | null {
  if (valor === 0) return "RETURN_REFUND";

  if (valor === 1) return "REFUND";

  return null;
}

/** Vazio vira nulo; modelo 0 vira nulo (como nos pedidos). */
function textoOuNulo(valor: string | null | undefined): string | null {
  return valor === undefined || valor === null || valor === "" ? null : valor;
}

async function gravarDevolucoes(
  deps: ShopeeReturnsSyncDeps,
  lojaId: string,
  devolucoes: readonly ShopeeReturn[],
  now: Date,
): Promise<{ gravadas: number } | { erro: string }> {
  if (devolucoes.length === 0) return { gravadas: 0 };

  const lote = devolucoes.map((d) => ({
    return_sn: d.return_sn,
    order_sn: d.order_sn,
    status: d.status,
    reason: textoOuNulo(d.reason),
    reassessed_reason: textoOuNulo(d.reassessed_request_reason),
    return_solution: solucao(d.return_solution),
    refund_amount: d.refund_amount ?? null,
    amount_before_discount: d.amount_before_discount ?? null,
    currency: textoOuNulo(d.currency),
    needs_logistics: d.needs_logistics ?? null,
    tracking_number: textoOuNulo(d.tracking_number),
    negotiation_status: textoOuNulo(d.negotiation_status),
    seller_proof_status: textoOuNulo(d.seller_proof_status),
    seller_compensation_status: textoOuNulo(d.seller_compensation_status),
    return_refund_type: textoOuNulo(d.return_refund_type),
    return_refund_request_type: d.return_refund_request_type ?? null,
    validation_type: textoOuNulo(d.validation_type),
    is_partial_quantity_return: d.is_partial_quantity_return ?? null,
    is_refund_amount_adjusted: d.is_refund_amount_adjusted ?? null,
    due_date: shopeeEpochToIso(d.due_date),
    return_ship_due_date: shopeeEpochToIso(d.return_ship_due_date),
    return_seller_due_date: shopeeEpochToIso(d.return_seller_due_date),
    shopee_created_at: shopeeEpochToIso(d.create_time) ?? now.toISOString(),
    shopee_updated_at: shopeeEpochToIso(d.update_time) ?? now.toISOString(),
    itens: (d.item ?? []).map((item, position) => ({
      position,
      item_id: item.item_id,
      model_id: item.model_id === 0 ? null : (item.model_id ?? null),
      item_name: textoOuNulo(item.name),
      item_sku: textoOuNulo(item.item_sku),
      variation_sku: textoOuNulo(item.variation_sku),
      quantity: item.amount,
      item_price: item.item_price ?? null,
    })),
  }));

  const gravado = await deps.db.rpc("shopee_upsert_returns", {
    p_shopee_shop_id: lojaId,
    p_devolucoes: asJson(lote),
    p_synced_at: now.toISOString(),
  });

  if (gravado.error !== null) return { erro: `falha ao gravar devoluções: ${gravado.error.message}` };

  return { gravadas: gravado.data };
}
