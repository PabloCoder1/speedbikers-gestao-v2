import type { AdminClient } from "@sb/db";
import { detectListingEvents } from "@sb/domain";
import type { ListingSnapshot } from "@sb/domain";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { chunkItemIds, getItemsBatch, scanSellerItems } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import { recordDomainEvents } from "./domain-events.js";
import { listingItemSchema } from "./listing-schema.js";
import { readAllPages } from "../read-all-pages.js";

/**
 * Sincronização de anúncios — **enumeração pelo CATÁLOGO REAL do vendedor**
 * (Fase 4B, item 1), não mais pelos vínculos internos.
 *
 * O que mudou e por quê (D-117 mediu, `docs/MERCADO_LIVRE.md` secao 2.14
 * confirmou o contrato): a versão anterior enumerava `sku_listing_links`, ou
 * seja, **só anúncios que a planilha do UpSeller já tinha vinculado**. A
 * consequência não era estética — a V3 não sabia quais anúncios existem.
 * Medido: 7.361 itens já venderam, 3.679 sem vínculo nenhum, e 21,8% dos
 * itens vendidos em 30 dias saem com `sku_id` nulo.
 *
 * Três fatos da doc oficial governam este arquivo:
 *
 * 1. **`results` traz só IDs** — enumerar é obrigatoriamente duas fases.
 * 2. **`search_type=scan` é obrigatório**, não otimização: o teto de 1.000 é
 *    real e a maior conta desta organização já teve 2.675 itens observados.
 * 3. **O scroll expira em 5 minutos e não pode ser pausado** — por isso a
 *    varredura é drenada INTEIRA antes de qualquer escrita no banco. Gravar
 *    no meio do laço é o caminho para 429 + scroll expirado.
 *
 * `sku_id` deixa de dirigir a enumeração e passa a ser um LOOKUP: anúncio sem
 * vínculo entra em `listings` com `sku_id` nulo (a coluna sempre foi anulável
 * e a interface já trata), em vez de simplesmente não existir.
 *
 * **Cinco perguntas que a doc oficial não responde estão instrumentadas**
 * (log `listings_catalog_probe`) para a primeira execução real respondê-las —
 * é a lição de D-109, onde a evidência existia e era descartada.
 */

/** Campos que `listings` usa hoje; projeção reduz payload no multiget. */
const ITEM_ATTRIBUTES = [
  "id",
  "title",
  "status",
  "price",
  "currency_id",
  "available_quantity",
  "category_id",
] as const;

/** Linha de `listings` tal como o upsert em lote a envia. */
interface ListingUpsertRow {
  organization_id: string;
  ml_account_id: string;
  item_id: string;
  sku_id: string | null;
  title: string;
  status: string;
  price: number;
  currency_id: string;
  available_quantity: number;
  category_id: string | null;
  synced_at: string;
}

export interface FetchListingsParams {
  db: AdminClient;
  organizationId: string;
  mlAccountId: string;
  /** `seller_id` do Mercado Livre — a enumeração é por vendedor, não por conta interna. */
  sellerId: number;
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  logger: Logger;
  now?: () => Date;
}

export interface FetchListingsResult {
  /** IDs devolvidos pela varredura — o denominador que nunca existiu antes. */
  itemsDiscovered: number;
  itemsProcessed: number;
  /** Falha POR ITEM: `code != 200` no multiget, ou payload fora do schema. */
  itemsFailed: number;
  /** Anúncios reais que nenhum vínculo alcança — o número que motivou a Fase 4B. */
  itemsWithoutLink: number;
}

export async function fetchListings(params: FetchListingsParams): Promise<FetchListingsResult> {
  const syncedAt = params.now?.() ?? new Date();

  // Vínculos viram LOOKUP, não fonte de enumeração. Uma consulta só: com
  // catálogo completo, uma consulta por item seria milhares de idas ao banco.
  //
  // PAGINADO desde D-193. Medido: a conta com mais vínculos tem **984** neste
  // recorte — 16 linhas do teto de 1.000 do PostgREST, que corta **sem erro**
  // (D-131). Ainda não estava truncando; estava a um lote de anúncios de
  // começar, e o sintoma seria mudo: vínculo ausente do Map vira `sku_id`
  // nulo no anúncio, e o painel perde o SKU sem nada quebrar.
  const links = await readAllPages<{ item_id: string | null; sku_id: string }>(
    (from, to) =>
      params.db
        .from("sku_listing_links")
        .select("item_id, sku_id")
        .eq("ml_account_id", params.mlAccountId)
        .eq("ref_kind", "ITEM")
        .is("variation_id", null)
        .order("id")
        .range(from, to),
    { label: "falha ao ler sku_listing_links" },
  );

  const skuByItem = new Map<string, string>();

  for (const link of links) {
    if (link.item_id !== null) {
      skuByItem.set(link.item_id, link.sku_id);
    }
  }

  // Estado ANTERIOR em bloco, antes do upsert sobrescrever: `listings` é
  // projeção mutável (`docs/DATABASE.md`), então o "antes" só existe agora.
  //
  // PAGINADO desde D-193, e aqui o truncamento **já estava acontecendo**: a
  // conta com mais anúncios tem **1.311**, contra o teto de 1.000. O efeito
  // era o pior formato possível — silêncio. `detectListingEvents(null, ...)`
  // devolve `[]` de propósito (primeira sincronização não gera evento), então
  // os ~311 anúncios fora da janela eram tratados como recém-vistos a CADA
  // execução: mudança de preço, de status e de quantidade neles **nunca**
  // virava evento. E, sem `.order()`, quais 1.000 entravam variava entre
  // execuções.
  const previousRows = await readAllPages<{
    item_id: string;
    title: string;
    status: string;
    price: number;
    available_quantity: number;
  }>(
    (from, to) =>
      params.db
        .from("listings")
        .select("item_id, title, status, price, available_quantity")
        .eq("ml_account_id", params.mlAccountId)
        // `listings_account_item_unique (ml_account_id, item_id)` — com a
        // conta já fixada no filtro, `item_id` é ordenação estável.
        .order("item_id")
        .range(from, to),
    { label: "falha ao ler listings anteriores" },
  );

  const previousByItem = new Map<string, ListingSnapshot>();

  for (const row of previousRows) {
    previousByItem.set(row.item_id, {
      itemId: row.item_id,
      title: row.title,
      status: row.status,
      price: row.price,
      availableQuantity: row.available_quantity,
    });
  }

  // Fase 1 — descoberta. Drenada INTEIRA antes de escrever: o scroll expira
  // em 5 min e a FAQ oficial diz que deixá-lo aberto gera 429.
  const discovered: string[] = [];
  let scanPages = 0;

  for await (const batch of scanSellerItems({
    client: params.mercadoLivre,
    sellerId: params.sellerId,
    accessToken: params.accessToken,
    limit: 100,
  })) {
    discovered.push(...batch);
    scanPages += 1;
  }

  let itemsProcessed = 0;
  let itemsFailed = 0;
  let itemsWithoutLink = 0;
  /** Distribuição de status observada — responde a pergunta 1 da 2.14. */
  const statusSeen = new Map<string, number>();

  // Fase 2 — hidratação em lotes de 20 (máximo documentado).
  for (const chunk of chunkItemIds(discovered)) {
    const entries = await getItemsBatch({
      client: params.mercadoLivre,
      ids: chunk,
      accessToken: params.accessToken,
      attributes: ITEM_ATTRIBUTES,
    });

    const rows: ListingUpsertRow[] = [];
    const pending: { current: ListingSnapshot; previous: ListingSnapshot | null }[] = [];

    for (const entry of entries) {
      // O envelope verbose carrega o código POR ITEM: um anúncio removido
      // entre a varredura e a hidratação não derruba o lote inteiro.
      if (entry.code !== 200) {
        itemsFailed += 1;
        params.logger.warn("listing_item_fetch_failed", {
          ml_account_id: params.mlAccountId,
          code: entry.code,
        });

        continue;
      }

      const parsed = listingItemSchema.safeParse(entry.body);

      if (!parsed.success) {
        itemsFailed += 1;
        params.logger.warn("listing_item_schema_rejected", {
          ml_account_id: params.mlAccountId,
          reason: parsed.error.message,
        });

        continue;
      }

      const item = parsed.data;
      const skuId = skuByItem.get(item.id) ?? null;

      if (skuId === null) {
        itemsWithoutLink += 1;
      }

      statusSeen.set(item.status, (statusSeen.get(item.status) ?? 0) + 1);

      rows.push({
        organization_id: params.organizationId,
        ml_account_id: params.mlAccountId,
        item_id: item.id,
        sku_id: skuId,
        title: item.title,
        status: item.status,
        price: item.price,
        currency_id: item.currency_id,
        available_quantity: item.available_quantity,
        category_id: item.category_id ?? null,
        synced_at: syncedAt.toISOString(),
      });

      pending.push({
        current: {
          itemId: item.id,
          title: item.title,
          status: item.status,
          price: item.price,
          availableQuantity: item.available_quantity,
        },
        previous: previousByItem.get(item.id) ?? null,
      });
    }

    if (rows.length === 0) {
      continue;
    }

    const result = await params.db
      .from("listings")
      .upsert(rows, { onConflict: "ml_account_id,item_id" });

    if (result.error !== null) {
      // Lote inteiro perdido: contabilizar como falha em vez de seguir
      // somando `itemsProcessed` sobre uma escrita que não aconteceu.
      itemsFailed += rows.length;
      params.logger.error("listing_not_recorded", {
        ml_account_id: params.mlAccountId,
        items: rows.length,
        reason: result.error.message,
      });

      continue;
    }

    itemsProcessed += rows.length;

    const events = pending.flatMap((entry) =>
      detectListingEvents(entry.previous, entry.current, syncedAt),
    );

    if (events.length > 0) {
      await recordDomainEvents(
        params.db,
        { organizationId: params.organizationId, mlAccountId: params.mlAccountId },
        events,
        params.logger,
      );
    }
  }

  // Instrumentação deliberada: a doc oficial NÃO diz quais status a varredura
  // devolve sem filtro (a frase "sempre serão itens ativos" pertence a OUTRO
  // endpoint da mesma página). Sem isto, a resposta continuaria sendo palpite.
  params.logger.info("listings_catalog_probe", {
    ml_account_id: params.mlAccountId,
    scan_pages: scanPages,
    items_discovered: discovered.length,
    items_without_link: itemsWithoutLink,
    links_known: skuByItem.size,
    status_seen: Object.fromEntries(statusSeen),
  });

  return { itemsDiscovered: discovered.length, itemsProcessed, itemsFailed, itemsWithoutLink };
}
