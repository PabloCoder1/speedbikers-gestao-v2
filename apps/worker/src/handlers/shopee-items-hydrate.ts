import type { TablesUpdate } from "@sb/db";
import {
  ITEM_BASE_INFO_BATCH,
  ShopeeApiError,
  getItemBaseInfo,
  getModelList,
  precoEEstoque,
  shopeeEpochToIso,
  type ModelList,
  type ShopeeClient,
  type ShopeeItem,
} from "@sb/shopee";
import { ZodError } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { falhaDaShopee, lerLojaConectada, type ShopeeJobDeps } from "./shopee-comum.js";
import { ensureShopeeAccessToken } from "./shopee-token.js";

/**
 * `shopee.items.hydrate` (D-428) — o DETALHE dos itens de uma loja Shopee:
 * `get_item_base_info` em lotes de 50 e, para quem tem variação,
 * `get_model_list` (um item por chamada).
 *
 * - Uma cadeia por loja (`shopee_items_hydrate_lock`): o gatilho horário
 *   abriria outra enquanto a anterior anda, e as duas brigariam nas variações.
 * - Quem precisa de leitura é o SQL (`shopee_items_details_pending`).
 * - Só erro PASSAGEIRO interrompe a tarefa. O erro definitivo de UM item
 *   (não devolvido, fora do contrato, variações recusadas) marca aquele item
 *   com `details_error` e a fila segue — volta em 1 dia ou quando ele mudar.
 *   Sem isso, um item ruim voltaria primeiro em toda execução e travaria a
 *   loja inteira. Lote recusado por erro definitivo é relido item a item.
 * - Ordem de gravação: variações primeiro, o item por último. Se algo falha
 *   no meio, o item continua pendente e a nova tentativa o relê.
 * - `details_update_time` é o `update_time` que o detalhe trouxe (relógio da
 *   Shopee), comparado com o da lista.
 */

export type ShopeeItemsHydrateDeps = ShopeeJobDeps;

const TRAVA_S = 900;

interface Shop {
  accessToken: string;
  shopId: number;
}

function texto(valor: string | null | undefined): string | null {
  return valor === undefined || valor === null || valor.trim() === "" ? null : valor;
}

function ePassageiro(error: unknown): boolean {
  if (error instanceof ZodError) return false;

  return !(error instanceof ShopeeApiError) || error.errorClass === "retryable";
}

function motivo(error: unknown): string {
  if (error instanceof ShopeeApiError) return error.baseCode ?? `HTTP ${String(error.status)}`;

  return error instanceof ZodError ? "fora_do_contrato" : "erro";
}

/** O lote; recusado por erro definitivo, relido item a item para isolar o ruim. */
async function lerDetalhes(
  client: ShopeeClient,
  shop: Shop,
  ids: readonly number[],
): Promise<{ itens: Map<number, ShopeeItem>; erros: Map<number, string> }> {
  const itens = new Map<number, ShopeeItem>();
  const erros = new Map<number, string>();

  try {
    const lote = await getItemBaseInfo(client, shop, ids);

    for (const item of lote.items) itens.set(item.item_id, item);
    for (const id of lote.invalidItemIds) erros.set(id, "fora_do_contrato");

    return { itens, erros };
  } catch (error) {
    if (ePassageiro(error) || ids.length === 1) throw error;
  }

  for (const id of ids) {
    try {
      const um = await getItemBaseInfo(client, shop, [id]);
      const item = um.items[0];

      if (item !== undefined) itens.set(id, item);
      else erros.set(id, um.invalid > 0 ? "fora_do_contrato" : "nao_devolvido");
    } catch (error) {
      if (ePassageiro(error)) throw error;

      erros.set(id, motivo(error));
    }
  }

  return { itens, erros };
}

function colunasDoItem(item: ShopeeItem, pendente: { shopee_updated_at: string }, now: Date): TablesUpdate<"shopee_items"> {
  const semVariacao = item.has_model === false;
  const preco = semVariacao ? precoEEstoque(item) : null;
  const status = texto(item.item_status);

  return {
    item_name: texto(item.item_name),
    item_sku: texto(item.item_sku),
    has_model: item.has_model ?? null,
    currency: preco?.currency ?? null,
    current_price: preco?.currentPrice ?? null,
    original_price: preco?.originalPrice ?? null,
    available_stock: preco?.availableStock ?? null,
    image_url: item.image?.image_url_list?.[0] ?? null,
    is_fulfillment_by_shopee: item.is_fulfillment_by_shopee ?? null,
    shopee_created_at: shopeeEpochToIso(item.create_time),
    ...(status === null ? {} : { item_status: status }),
    // O relógio da Shopee: o do detalhe, ou o da lista quando ele não vem.
    details_update_time: shopeeEpochToIso(item.update_time) ?? pendente.shopee_updated_at,
    details_error: null,
    details_synced_at: now.toISOString(),
  };
}

export function createShopeeItemsHydrateHandler(deps: ShopeeItemsHydrateDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const aberta = await lerLojaConectada(deps, context, "shopee_items_hydrate_skipped");

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    const trava = await deps.db.rpc("shopee_items_hydrate_lock", { p_shopee_shop_id: loja.id, p_ttl_seconds: TRAVA_S });

    if (trava.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao travar a leitura do catálogo: ${trava.error.message}` };
    }

    if (!trava.data) {
      context.logger.info("shopee_items_hydrate_skipped", { shopee_shop_id: loja.id, motivo: "outra leitura em andamento" });

      return { status: "done", processed: 0 };
    }

    const soltar = async (): Promise<void> => {
      await deps.db.from("shopee_shops").update({ items_hydrate_locked_until: null }).eq("id", loja.id);
    };

    const resultado = await hidratar(deps, context, loja);

    await soltar();

    if (resultado.temMais) {
      await deps.enqueuer.enqueue({
        jobType: "shopee.items.hydrate",
        organizationId: loja.organization_id,
        dedupeKey: `shopee-items-hydrate:${loja.id}:mais:${String(Math.floor((deps.now?.() ?? new Date()).getTime() / 1000))}`,
        queue: "backfill",
        payload: { shopeeShopId: loja.id },
      });
    }

    return resultado.outcome;
  };
}

async function hidratar(
  deps: ShopeeItemsHydrateDeps,
  context: HandlerContext,
  loja: { id: string; organization_id: string; shop_id: number },
): Promise<{ outcome: JobOutcome; temMais: boolean }> {
  const now = deps.now?.() ?? new Date();
  const pendentes = await deps.db.rpc("shopee_items_details_pending", {
    p_shopee_shop_id: loja.id,
    p_limit: ITEM_BASE_INFO_BATCH,
  });

  if (pendentes.error !== null) {
    return {
      outcome: { status: "failed", retryable: true, reason: `falha ao listar itens sem detalhe: ${pendentes.error.message}` },
      temMais: false,
    };
  }

  if (pendentes.data.length === 0) {
    return { outcome: { status: "done", processed: 0 }, temMais: false };
  }

  const token = await ensureShopeeAccessToken(deps, { id: loja.id, shopId: loja.shop_id }, now);

  if (!token.ok) {
    return { outcome: { status: "failed", retryable: token.retryable, reason: token.reason }, temMais: false };
  }

  const shop: Shop = { accessToken: token.accessToken, shopId: loja.shop_id };
  let detalhes;

  try {
    detalhes = await lerDetalhes(
      deps.client,
      shop,
      pendentes.data.map((linha) => linha.item_id),
    );
  } catch (error) {
    return { outcome: falhaDaShopee(error, "erro desconhecido ao ler o detalhe dos itens da Shopee"), temMais: false };
  }

  let lidos = 0;
  let variacoes = 0;
  let variacoesInvalidas = 0;
  const semDetalhe: { item_id: number; motivo: string }[] = [];

  for (const pendente of pendentes.data) {
    const itemId = pendente.item_id;
    const item = detalhes.itens.get(itemId);
    let erro: string | null = item === undefined ? (detalhes.erros.get(itemId) ?? "nao_devolvido") : null;
    let models: ModelList["models"] | null = null;

    if (item?.has_model === true) {
      try {
        const lista = await getModelList(deps.client, shop, itemId);

        models = lista.models;
        variacoesInvalidas += lista.invalid;
      } catch (error) {
        if (ePassageiro(error)) {
          return { outcome: falhaDaShopee(error, "erro desconhecido ao ler as variações da Shopee"), temMais: false };
        }

        // Variações recusadas de vez: as gravadas ficam como estavam.
        erro = `variacoes:${motivo(error)}`;
      }
    } else if (item !== undefined) {
      models = [];
    }

    if (erro !== null) {
      // Leitura que não serviu: só a marca, nada do que já havia é apagado.
      const marcado = await deps.db
        .from("shopee_items")
        .update({ details_error: erro.slice(0, 200), details_synced_at: now.toISOString() })
        .eq("shopee_shop_id", loja.id)
        .eq("item_id", itemId);

      if (marcado.error !== null) {
        return {
          outcome: { status: "failed", retryable: true, reason: `falha ao marcar o item sem detalhe: ${marcado.error.message}` },
          temMais: false,
        };
      }

      semDetalhe.push({ item_id: itemId, motivo: erro });
      continue;
    }

    if (item === undefined || models === null) continue;

    // Variações primeiro (substituídas); o item, que diz "lido", por último.
    const apagadas = await deps.db.from("shopee_item_models").delete().eq("shopee_shop_id", loja.id).eq("item_id", itemId);

    if (apagadas.error !== null) {
      return {
        outcome: { status: "failed", retryable: true, reason: `falha ao substituir variações: ${apagadas.error.message}` },
        temMais: false,
      };
    }

    if (models.length > 0) {
      const inseridas = await deps.db.from("shopee_item_models").insert(
        models.map((model) => {
          const preco = precoEEstoque(model);

          return {
            shopee_shop_id: loja.id,
            item_id: itemId,
            model_id: model.model_id,
            organization_id: loja.organization_id,
            model_name: model.name,
            model_sku: texto(model.model_sku),
            model_status: texto(model.model_status),
            currency: preco.currency,
            current_price: preco.currentPrice,
            original_price: preco.originalPrice,
            available_stock: preco.availableStock,
          };
        }),
      );

      if (inseridas.error !== null) {
        return {
          outcome: { status: "failed", retryable: true, reason: `falha ao gravar variações: ${inseridas.error.message}` },
          temMais: false,
        };
      }
    }

    const gravado = await deps.db
      .from("shopee_items")
      .update(colunasDoItem(item, pendente, now))
      .eq("shopee_shop_id", loja.id)
      .eq("item_id", itemId);

    if (gravado.error !== null) {
      return {
        outcome: { status: "failed", retryable: true, reason: `falha ao gravar o detalhe do item: ${gravado.error.message}` },
        temMais: false,
      };
    }

    lidos += 1;
    variacoes += models.length;
  }

  if (semDetalhe.length > 0) {
    context.logger.warn("shopee_items_hydrate_sem_detalhe", { shopee_shop_id: loja.id, itens: semDetalhe.slice(0, 50) });
  }

  const temMais = pendentes.data.length === ITEM_BASE_INFO_BATCH;

  context.logger.info("shopee_items_hydrate_done", {
    shopee_shop_id: loja.id,
    shop_id: loja.shop_id,
    itens_pendentes: pendentes.data.length,
    itens_lidos: lidos,
    sem_detalhe: semDetalhe.length,
    variacoes,
    variacoes_fora_do_contrato: variacoesInvalidas,
    tem_mais: temMais,
  });

  return { outcome: { status: "done", processed: pendentes.data.length }, temMais };
}
