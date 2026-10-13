import { getItemListPage, shopeeEpochToIso, type ShopeeItemStatus } from "@sb/shopee";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { falhaDaShopee, lerLojaConectada, type ShopeeJobDeps } from "./shopee-comum.js";
import { ensureShopeeAccessToken } from "./shopee-token.js";

/**
 * `shopee.items.sync` (D-428) — a LISTA de itens de uma loja Shopee
 * (`get_item_list`), que enfileira a leitura do detalhe.
 *
 * - Sem marco, enumera o catálogo inteiro (só itens vivos). Com marco, lê
 *   desde ele (10 minutos de sobreposição) com TODOS os status — é assim que
 *   o item apagado ou banido fica sabido.
 * - A janela NÃO tem fim: com `update_time_to`, o item que muda durante a
 *   leitura sai do conjunto, os de trás sobem uma posição e o offset pula um.
 *   Sem o fim, quem muda continua no conjunto e entra também na próxima.
 * - A leitura só vale se for completa: o `total_count` não pode mudar entre
 *   as páginas e os itens distintos têm de alcançá-lo. Senão a lista é lida de
 *   novo (até 3 vezes) e, persistindo, a tarefa falha sem avançar o marco.
 * - Grava só item_id, status e `update_time`: o detalhe é de
 *   `shopee.items.hydrate`. O item nunca é apagado: o status diz o que houve.
 */

const SOBREPOSICAO_S = 10 * 60;
/** Teto de páginas de 100 — 20 mil itens passaria de qualquer loja da casa. */
const MAX_PAGINAS = 200;
const MAX_PASSADAS = 3;
const LOTE_GRAVACAO = 500;

const STATUS_VIVOS: readonly ShopeeItemStatus[] = ["NORMAL", "UNLIST", "BANNED", "REVIEWING"];
const STATUS_TODOS: readonly ShopeeItemStatus[] = [...STATUS_VIVOS, "SELLER_DELETE", "SHOPEE_DELETE"];

export type ShopeeItemsSyncDeps = ShopeeJobDeps;

type Itens = Map<number, { itemStatus: string; updateTime: number }>;

class ListaIncompleta extends Error {}

/** Uma passada pela lista inteira; lança `ListaIncompleta` se o conjunto mudou no meio. */
async function lerLista(
  deps: ShopeeItemsSyncDeps,
  shop: { accessToken: string; shopId: number },
  janela: { statuses: readonly ShopeeItemStatus[]; updateTimeFrom?: number },
): Promise<Itens> {
  const itens: Itens = new Map();
  let total: number | null | undefined;
  let offset: number | null = 0;
  let paginas = 0;

  while (offset !== null) {
    if (paginas >= MAX_PAGINAS) {
      throw new Error(`a lista de itens passou de ${String(MAX_PAGINAS)} páginas; revise o teto`);
    }

    const pagina = await getItemListPage(deps.client, shop, { offset, ...janela });

    if (total === undefined) total = pagina.totalCount;
    else if (pagina.totalCount !== null && pagina.totalCount !== total) throw new ListaIncompleta();

    for (const item of pagina.items) {
      const visto = itens.get(item.itemId);

      if (visto === undefined || item.updateTime >= visto.updateTime) {
        itens.set(item.itemId, { itemStatus: item.itemStatus, updateTime: item.updateTime });
      }
    }

    offset = pagina.nextOffset;
    paginas += 1;
  }

  if (typeof total === "number" && itens.size < total) throw new ListaIncompleta();

  return itens;
}

export function createShopeeItemsSyncHandler(deps: ShopeeItemsSyncDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const aberta = await lerLojaConectada(deps, context, "shopee_items_sync_skipped");

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const marcoLido = await deps.db.from("shopee_shops").select("items_synced_until").eq("id", loja.id).maybeSingle();

    if (marcoLido.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler o marco do catálogo: ${marcoLido.error.message}` };
    }

    const now = deps.now?.() ?? new Date();
    const agoraS = Math.floor(now.getTime() / 1000);
    const token = await ensureShopeeAccessToken(deps, { id: loja.id, shopId: loja.shop_id }, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    const shop = { accessToken: token.accessToken, shopId: loja.shop_id };
    const marco = marcoLido.data?.items_synced_until ?? null;
    const marcoS = marco === null ? null : Math.floor(new Date(marco).getTime() / 1000);
    const janela =
      marcoS === null
        ? { statuses: STATUS_VIVOS }
        : { statuses: STATUS_TODOS, updateTimeFrom: Math.max(marcoS - SOBREPOSICAO_S, 0) };

    let itens: Itens | null = null;
    let passadas = 0;

    try {
      while (itens === null && passadas < MAX_PASSADAS) {
        passadas += 1;

        try {
          itens = await lerLista(deps, shop, janela);
        } catch (error) {
          if (!(error instanceof ListaIncompleta)) throw error;
        }
      }
    } catch (error) {
      return falhaDaShopee(error, "erro desconhecido ao listar os itens da Shopee");
    }

    if (itens === null) {
      return {
        status: "failed",
        retryable: true,
        reason: `a lista de itens mudou durante ${String(MAX_PASSADAS)} leituras seguidas; o marco não avançou`,
      };
    }

    const linhas = [...itens].map(([itemId, item]) => ({
      shopee_shop_id: loja.id,
      organization_id: loja.organization_id,
      item_id: itemId,
      item_status: item.itemStatus,
      shopee_updated_at: shopeeEpochToIso(item.updateTime) ?? now.toISOString(),
    }));

    for (let i = 0; i < linhas.length; i += LOTE_GRAVACAO) {
      const gravado = await deps.db
        .from("shopee_items")
        .upsert(linhas.slice(i, i + LOTE_GRAVACAO), { onConflict: "shopee_shop_id,item_id" });

      if (gravado.error !== null) {
        return { status: "failed", retryable: true, reason: `falha ao gravar a lista de itens: ${gravado.error.message}` };
      }
    }

    const avancado = await deps.db
      .from("shopee_shops")
      .update({ items_synced_until: new Date(agoraS * 1000).toISOString() })
      .eq("id", loja.id);

    if (avancado.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao avançar o marco do catálogo: ${avancado.error.message}` };
    }

    // O detalhe vem atrás; quem diz o que ler é o SQL.
    await deps.enqueuer.enqueue({
      jobType: "shopee.items.hydrate",
      organizationId: loja.organization_id,
      dedupeKey: `shopee-items-hydrate:${loja.id}:${String(agoraS)}`,
      queue: "backfill",
      payload: { shopeeShopId: loja.id },
    });

    context.logger.info("shopee_items_sync_done", {
      shopee_shop_id: loja.id,
      shop_id: loja.shop_id,
      modo: marcoS === null ? "catalogo_inteiro" : "janela",
      ...(janela.updateTimeFrom === undefined ? {} : { de: new Date(janela.updateTimeFrom * 1000).toISOString() }),
      marco: new Date(agoraS * 1000).toISOString(),
      itens_listados: linhas.length,
      leituras: passadas,
    });

    return { status: "done", processed: linhas.length };
  };
}
