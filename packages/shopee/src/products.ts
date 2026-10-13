import { z } from "zod";

import type { ShopeeClient } from "./client.js";

/**
 * Catálogo da loja (D-428) — `v2.product.get_item_list`,
 * `v2.product.get_item_base_info` e `v2.product.get_model_list`, conferidos
 * na referência oficial em 13/10/2026 (`docs/SHOPEE.md` §4.3).
 *
 * - A lista pagina por `offset` (até 100), filtra por `item_status`
 *   (parâmetro repetido) e, opcionalmente, pela janela de `update_time`.
 * - O detalhe aceita até 50 itens; com variação (`has_model`), preço e
 *   estoque vêm por variação, em `get_model_list` (um item por chamada).
 * - Leitura TOLERANTE: a Shopee acrescenta campo todo mês, e um item fora do
 *   contrato não pode derrubar o lote dos outros 49. O envelope aceita
 *   qualquer item; cada um é validado sozinho e o inválido é contado.
 */

export const ITEM_LIST_PAGE_SIZE = 100;
export const ITEM_BASE_INFO_BATCH = 50;

export type ShopeeItemStatus = "NORMAL" | "BANNED" | "UNLIST" | "REVIEWING" | "SELLER_DELETE" | "SHOPEE_DELETE";

const itemListSchema = z.object({
  response: z.object({
    item: z
      .array(z.object({ item_id: z.number().int().positive(), item_status: z.string().min(1), update_time: z.number().int() }))
      .nullable()
      .optional(),
    has_next_page: z.boolean(),
    next_offset: z.number().int().nullable().optional(),
    total_count: z.number().int().nullable().optional(),
  }),
});

export interface ItemListPage {
  items: { itemId: number; itemStatus: string; updateTime: number }[];
  nextOffset: number | null;
  totalCount: number | null;
}

/** Uma página de itens da loja. `updateTimeFrom`/`updateTimeTo` em epoch (segundos). */
export async function getItemListPage(
  client: ShopeeClient,
  shop: { accessToken: string; shopId: number },
  options: { offset: number; statuses: readonly ShopeeItemStatus[]; updateTimeFrom?: number; updateTimeTo?: number },
): Promise<ItemListPage> {
  const resposta = await client.request({
    method: "GET",
    path: "/api/v2/product/get_item_list",
    shop,
    query: {
      offset: String(options.offset),
      page_size: String(ITEM_LIST_PAGE_SIZE),
      item_status: options.statuses,
      ...(options.updateTimeFrom === undefined ? {} : { update_time_from: String(options.updateTimeFrom) }),
      ...(options.updateTimeTo === undefined ? {} : { update_time_to: String(options.updateTimeTo) }),
    },
    schema: itemListSchema,
  });

  return {
    items: (resposta.response.item ?? []).map((item) => ({
      itemId: item.item_id,
      itemStatus: item.item_status,
      updateTime: item.update_time,
    })),
    nextOffset: resposta.response.has_next_page ? (resposta.response.next_offset ?? null) : null,
    totalCount: resposta.response.total_count ?? null,
  };
}

const texto = z.string().nullable().optional();
const numero = z.number().nullable().optional();

const precoSchema = z
  .array(z.object({ currency: texto, current_price: numero, original_price: numero }).loose())
  .nullable()
  .optional();

const estoqueSchema = z
  .object({
    summary_info: z.object({ total_available_stock: numero, total_reserved_stock: numero }).loose().nullable().optional(),
  })
  .loose()
  .nullable()
  .optional();

export const shopeeItemSchema = z
  .object({
    item_id: z.number().int().positive(),
    item_name: texto,
    item_sku: texto,
    item_status: texto,
    create_time: numero,
    update_time: numero,
    has_model: z.boolean().nullable().optional(),
    price_info: precoSchema,
    stock_info_v2: estoqueSchema,
    image: z.object({ image_url_list: z.array(z.string()).nullable().optional() }).loose().nullable().optional(),
    is_fulfillment_by_shopee: z.boolean().nullable().optional(),
  })
  .loose();

export type ShopeeItem = z.infer<typeof shopeeItemSchema>;

const itemBaseInfoSchema = z.object({
  response: z.object({ item_list: z.array(z.unknown()).nullable().optional() }).nullable().optional(),
});

export interface ItemBaseInfo {
  items: ShopeeItem[];
  /** Itens que vieram fora do contrato: nunca gravados pela metade. O id, quando legível, para o log. */
  invalid: number;
  invalidItemIds: number[];
}

/** O detalhe de até 50 itens. */
export async function getItemBaseInfo(
  client: ShopeeClient,
  shop: { accessToken: string; shopId: number },
  itemIds: readonly number[],
): Promise<ItemBaseInfo> {
  if (itemIds.length === 0) return { items: [], invalid: 0, invalidItemIds: [] };

  if (itemIds.length > ITEM_BASE_INFO_BATCH) {
    throw new Error(`get_item_base_info aceita no máximo ${String(ITEM_BASE_INFO_BATCH)} itens por chamada`);
  }

  const resposta = await client.request({
    method: "GET",
    path: "/api/v2/product/get_item_base_info",
    shop,
    query: { item_id_list: itemIds.map(String).join(",") },
    schema: itemBaseInfoSchema,
  });

  const items: ShopeeItem[] = [];
  const invalidItemIds: number[] = [];
  let invalid = 0;

  for (const bruto of resposta.response?.item_list ?? []) {
    const lido = shopeeItemSchema.safeParse(bruto);

    if (lido.success) {
      items.push(lido.data);
      continue;
    }

    invalid += 1;

    const id = bruto !== null && typeof bruto === "object" ? (bruto as { item_id?: unknown }).item_id : undefined;

    if (typeof id === "number") invalidItemIds.push(id);
  }

  return { items, invalid, invalidItemIds };
}

export const shopeeModelSchema = z
  .object({
    model_id: z.number().int().positive(),
    model_sku: texto,
    model_status: texto,
    tier_index: z.array(z.number().int()).nullable().optional(),
    price_info: precoSchema,
    stock_info_v2: estoqueSchema,
  })
  .loose();

export type ShopeeModel = z.infer<typeof shopeeModelSchema>;

const modelListSchema = z.object({
  response: z
    .object({
      tier_variation: z
        .array(
          z
            .object({
              name: texto,
              option_list: z.array(z.object({ option: texto }).loose()).nullable().optional(),
            })
            .loose(),
        )
        .nullable()
        .optional(),
      model: z.array(z.unknown()).nullable().optional(),
    })
    .nullable()
    .optional(),
});

export interface ModelList {
  models: (ShopeeModel & { name: string | null })[];
  invalid: number;
}

/**
 * As variações de UM item. O nome de cada variação sai das opções da
 * `tier_variation` pelos índices do model ("Azul / P"); sem opção, nulo.
 */
export async function getModelList(
  client: ShopeeClient,
  shop: { accessToken: string; shopId: number },
  itemId: number,
): Promise<ModelList> {
  const resposta = await client.request({
    method: "GET",
    path: "/api/v2/product/get_model_list",
    shop,
    query: { item_id: String(itemId) },
    schema: modelListSchema,
  });

  const camadas = resposta.response?.tier_variation ?? [];
  const models: ModelList["models"] = [];
  let invalid = 0;

  for (const bruto of resposta.response?.model ?? []) {
    const lido = shopeeModelSchema.safeParse(bruto);

    if (!lido.success) {
      invalid += 1;
      continue;
    }

    const opcoes = (lido.data.tier_index ?? [])
      .map((indice, camada) => camadas[camada]?.option_list?.[indice]?.option ?? null)
      .filter((opcao): opcao is string => opcao !== null && opcao.trim() !== "");

    models.push({ ...lido.data, name: opcoes.length === 0 ? null : opcoes.join(" / ") });
  }

  return { models, invalid };
}

/** Preço e estoque de um item SEM variação, ou de uma variação — ausente fica nulo. */
export function precoEEstoque(fonte: {
  price_info?: z.infer<typeof precoSchema>;
  stock_info_v2?: z.infer<typeof estoqueSchema>;
}): { currency: string | null; currentPrice: number | null; originalPrice: number | null; availableStock: number | null } {
  const preco = fonte.price_info?.[0];
  const estoque = fonte.stock_info_v2?.summary_info?.total_available_stock;

  return {
    currency: preco?.currency ?? null,
    currentPrice: preco?.current_price ?? null,
    originalPrice: preco?.original_price ?? null,
    availableStock: typeof estoque === "number" ? Math.trunc(estoque) : null,
  };
}
