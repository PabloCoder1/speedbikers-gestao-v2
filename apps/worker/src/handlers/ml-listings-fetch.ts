import type { AdminClient, Json } from "@sb/db";
import { detectListingEvents } from "@sb/domain";
import type { ListingSnapshot } from "@sb/domain";
import type { ItemsMultigetEntry, MercadoLivreClient, PromotionOffer } from "@sb/mercado-livre";
import {
  chunkItemIds,
  effectivePromotionalPrice,
  getItemDescription,
  getItemPromotions,
  getItemsBatch,
  isInPromotion,
  promotionOffers,
  scanSellerItems,
} from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import { asJson, recordDomainEvents } from "./domain-events.js";
import {
  fingerprintDaDescricao,
  fingerprintDasFotos,
  fotoDoItem,
  linkDoItem,
  listingItemSchema,
  medidasDeclaradas,
} from "./listing-schema.js";
import { lerMedidas } from "./shipment-package.js";
import type { ParsedListingItem } from "./listing-schema.js";
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
  // D-631: o subestado diz a exclusao (`closed` + `deleted`), e o vendedor
  // confere o dono do item na leitura por notificacao.
  "sub_status",
  "seller_id",
  "price",
  "currency_id",
  "available_quantity",
  "category_id",
  // Foto e link da tela `/anuncios` (20260918150000).
  "secure_thumbnail",
  "thumbnail",
  "permalink",
  // Identificadores estáveis para o diff de foto; não usar thumbnail, que o
  // Mercado Livre pode regenerar sem alteração editorial.
  "pictures",
  // D-405: a sonda das medidas declaradas (`shipping.dimensions`). Os
  // atributos `SELLER_PACKAGE_*` ficam de fora: `attributes` traz o bloco
  // inteiro de dezenas de atributos por item, a cada 6 h.
  "shipping",
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
  /** Preço com campanha ativa do Mercado Livre (D-389). `null` sem promoção — nunca 0. */
  promotional_price: number | null;
  /** Numa campanha no ar (D-419). `null` = não lido; só anúncio ativo é lido. */
  in_promotion: boolean | null;
  /** Quando a promoção foi lida COM SUCESSO pela última vez (D-419). */
  promotion_checked_at: string | null;
  /** As campanhas no ar e as candidatas da mesma leitura (D-420). `null` = não lido. */
  promotions: Json | null;
  currency_id: string;
  available_quantity: number;
  category_id: string | null;
  picture_fingerprint: string | null;
  /** Hash SHA-256 da descrição (D-390) — nunca o texto. `null` sem descrição própria. */
  description_fingerprint: string | null;
  description_source_updated_at: string | null;
  thumbnail_url: string | null;
  permalink: string | null;
  /** D-631: o subestado do Mercado Livre na leitura. `null` sem o campo. */
  sub_status: string[] | null;
  /** D-631: quando a V3 viu o anúncio excluído; `null` enquanto ele existe. */
  deleted_at: string | null;
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
  /**
   * D-631: só estes anúncios, sem varredura — a leitura de uma notificação
   * `items` (criado, alterado ou excluído). Sem o campo, é a varredura do
   * catálogo inteiro, que também relê o que a V3 tem e a varredura não listou.
   */
  itemIds?: readonly string[];
}

export interface FetchListingsResult {
  /** IDs devolvidos pela varredura — o denominador que nunca existiu antes. */
  itemsDiscovered: number;
  itemsProcessed: number;
  /** Falha POR ITEM: `code != 200` no multiget, ou payload fora do schema. */
  itemsFailed: number;
  /** Anúncios reais que nenhum vínculo alcança — o número que motivou a Fase 4B. */
  itemsWithoutLink: number;
  /** D-631: anúncios que esta leitura viu excluídos (`closed` + `deleted`, ou 404). */
  itemsMarkedDeleted: number;
  /** D-631: anúncios que a V3 tinha e a varredura não listou — relidos um a um. */
  itemsOutsideScan: number;
}

/** O que uma leitura boa de `/seller-promotions/items/{id}` diz do anúncio. */
interface PromocaoLida {
  emPromocao: boolean;
  preco: number | null;
  ofertas: PromotionOffer[];
}

/**
 * A promoção que a linha grava (D-419, D-420). Anúncio não ativo não roda
 * campanha e não é lido: tudo nulo. Ativo e lido agora: o que a leitura disse,
 * com a hora. Ativo e a leitura falhou: a ÚLTIMA leitura boa, com a hora dela —
 * nunca "sem promoção" (nem "sem campanha disponível") por falta de leitura.
 */
function promocaoDaLinha(
  status: string,
  lida: PromocaoLida | undefined,
  anterior:
    | {
        promotional_price: number | null;
        in_promotion: boolean | null;
        promotion_checked_at: string | null;
        promotions?: Json | null;
      }
    | undefined,
  agora: Date,
): Pick<ListingUpsertRow, "promotional_price" | "in_promotion" | "promotion_checked_at" | "promotions"> {
  if (status !== "active") {
    return { promotional_price: null, in_promotion: null, promotion_checked_at: null, promotions: null };
  }

  if (lida !== undefined) {
    return {
      promotional_price: lida.preco,
      in_promotion: lida.emPromocao,
      promotion_checked_at: agora.toISOString(),
      promotions: asJson(lida.ofertas),
    };
  }

  return {
    promotional_price: anterior?.promotional_price ?? null,
    in_promotion: anterior?.in_promotion ?? null,
    promotion_checked_at: anterior?.promotion_checked_at ?? null,
    promotions: anterior?.promotions ?? null,
  };
}

/**
 * D-631: o Mercado Livre marca a exclusão como status `closed` com `deleted`
 * no subestado ("deleted: é adicionado quando o item está fechado e o seller
 * decide removê-lo" — documentação oficial, "Sincronização e modificação de
 * publicações", lida em 21/10/2026).
 */
function excluidoNoMercadoLivre(item: ParsedListingItem): boolean {
  return item.status === "closed" && (item.sub_status ?? []).includes("deleted");
}

export async function fetchListings(params: FetchListingsParams): Promise<FetchListingsResult> {
  const syncedAt = params.now?.() ?? new Date();
  // D-631: na leitura por notificação, o banco é lido só para estes itens.
  const soEstes = params.itemIds === undefined ? null : [...new Set(params.itemIds)];

  // Vínculos viram LOOKUP, não fonte de enumeração. Uma consulta só: com
  // catálogo completo, uma consulta por item seria milhares de idas ao banco.
  //
  // PAGINADO desde D-193. Medido: a conta com mais vínculos tem **984** neste
  // recorte — 16 linhas do teto de 1.000 do PostgREST, que corta **sem erro**
  // (D-131). Ainda não estava truncando; estava a um lote de anúncios de
  // começar, e o sintoma seria mudo: vínculo ausente do Map vira `sku_id`
  // nulo no anúncio, e o painel perde o SKU sem nada quebrar.
  const links = await readAllPages<{ item_id: string | null; sku_id: string }>(
    (from, to) => {
      let consulta = params.db
        .from("sku_listing_links")
        .select("item_id, sku_id")
        .eq("ml_account_id", params.mlAccountId)
        .eq("ref_kind", "ITEM")
        .is("variation_id", null);

      if (soEstes !== null) consulta = consulta.in("item_id", soEstes);

      return consulta.order("id").range(from, to);
    },
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
    picture_fingerprint: string | null;
    description_fingerprint: string | null;
    description_source_updated_at: string | null;
    promotional_price: number | null;
    in_promotion: boolean | null;
    promotion_checked_at: string | null;
    promotions: Json | null;
    deleted_at: string | null;
  }>(
    (from, to) => {
      let consulta = params.db
        .from("listings")
        .select(
          "item_id, title, status, price, available_quantity, picture_fingerprint, description_fingerprint, description_source_updated_at, promotional_price, in_promotion, promotion_checked_at, promotions, deleted_at",
        )
        .eq("ml_account_id", params.mlAccountId);

      if (soEstes !== null) consulta = consulta.in("item_id", soEstes);

      // `listings_account_item_unique (ml_account_id, item_id)` — com a
      // conta já fixada no filtro, `item_id` é ordenação estável.
      return consulta.order("item_id").range(from, to);
    },
    { label: "falha ao ler listings anteriores" },
  );

  const previousByItem = new Map<string, ListingSnapshot>();
  const previousListingRowsByItem = new Map<string, (typeof previousRows)[number]>();

  for (const row of previousRows) {
    previousListingRowsByItem.set(row.item_id, row);
    previousByItem.set(row.item_id, {
      itemId: row.item_id,
      title: row.title,
      status: row.status,
      price: row.price,
      availableQuantity: row.available_quantity,
      pictureFingerprint: row.picture_fingerprint,
      descriptionFingerprint: row.description_fingerprint,
    });
  }

  // Fase 1 — descoberta. Drenada INTEIRA antes de escrever: o scroll expira
  // em 5 min e a FAQ oficial diz que deixá-lo aberto gera 429.
  const discovered: string[] = soEstes === null ? [] : [...soEstes];
  let scanPages = 0;

  if (soEstes === null) {
    for await (const batch of scanSellerItems({
      client: params.mercadoLivre,
      sellerId: params.sellerId,
      accessToken: params.accessToken,
      limit: 100,
    })) {
      discovered.push(...batch);
      scanPages += 1;
    }
  }

  // D-631: a varredura NÃO devolve o anúncio excluído, e a V3 só gravava o que
  // ela devolvia — a linha ficava com o último status visto, até "ativo",
  // para sempre. Depois da varredura INTEIRA (ela drena ou lança), o que a V3
  // tem vivo e a varredura não listou é relido pelo multiget: excluído,
  // encerrado ou ainda vivo, a linha converge.
  const listados = new Set(discovered);
  const foraDaVarredura =
    soEstes === null
      ? previousRows.filter((row) => (row.deleted_at ?? null) === null && !listados.has(row.item_id)).map((row) => row.item_id)
      : [];
  const paraLer = [...discovered, ...foraDaVarredura];
  // D-631: o que o Mercado Livre não devolve mais (404 na leitura do item
  // sozinho) — "depois de um tempo, os itens finalizados não serão mais
  // mostrados para sua consulta" (documentação oficial).
  const inexistentes: string[] = [];
  let itemsMarkedDeleted = 0;

  let itemsProcessed = 0;
  let itemsFailed = 0;
  let itemsWithoutLink = 0;
  /** Distribuição de status observada — responde a pergunta 1 da 2.14. */
  const statusSeen = new Map<string, number>();
  let itensComMedidas = 0;
  let itensComMedidasLegiveis = 0;
  let exemploDeMedidaIlegivel: string | null = null;

  // Fase 2 — hidratação em lotes de 20 (máximo documentado).
  for (const chunk of chunkItemIds(paraLer)) {
    const entries = await getItemsBatch({
      client: params.mercadoLivre,
      ids: chunk,
      accessToken: params.accessToken,
      attributes: ITEM_ATTRIBUTES,
    });

    const itensValidos: ParsedListingItem[] = [];
    // D-631: o multiget não promete a ordem das entradas nem o corpo do 404.
    // O item que voltou é reconhecido pelo `id` do corpo; o resto do lote é
    // relido SOZINHO, e só o 404 dessa leitura diz que o item não existe.
    const devolvidos = new Set<string>();

    const classificar = (entry: ItemsMultigetEntry, idDaLeituraSozinha: string | null): void => {
      // O envelope verbose carrega o código POR ITEM: um anúncio removido
      // entre a varredura e a hidratação não derruba o lote inteiro.
      if (entry.code !== 200) {
        if (idDaLeituraSozinha === null) return;

        if (entry.code === 404) {
          inexistentes.push(idDaLeituraSozinha);

          return;
        }

        itemsFailed += 1;
        params.logger.warn("listing_item_fetch_failed", {
          ml_account_id: params.mlAccountId,
          item_id: idDaLeituraSozinha,
          code: entry.code,
        });

        return;
      }

      const idDoCorpo = (entry.body as { id?: unknown } | null)?.id;

      if (typeof idDoCorpo === "string") devolvidos.add(idDoCorpo);

      const parsed = listingItemSchema.safeParse(entry.body);

      if (!parsed.success) {
        itemsFailed += 1;
        params.logger.warn("listing_item_schema_rejected", {
          ml_account_id: params.mlAccountId,
          reason: parsed.error.message,
        });

        return;
      }

      // D-631: na leitura por notificação o id vem de fora da varredura do
      // vendedor — o item de outro vendedor nunca vira linha desta conta.
      if (parsed.data.seller_id !== undefined && parsed.data.seller_id !== null && parsed.data.seller_id !== params.sellerId) {
        itemsFailed += 1;
        params.logger.warn("listing_item_other_seller", {
          ml_account_id: params.mlAccountId,
          item_id: parsed.data.id,
        });

        return;
      }

      itensValidos.push(parsed.data);
    };

    for (const entry of entries) classificar(entry, chunk.length === 1 ? (chunk[0] ?? null) : null);

    if (chunk.length > 1) {
      for (const id of chunk.filter((item) => !devolvidos.has(item))) {
        const [sozinho] = await getItemsBatch({
          client: params.mercadoLivre,
          ids: [id],
          accessToken: params.accessToken,
          attributes: ITEM_ATTRIBUTES,
        });

        if (sozinho === undefined) {
          itemsFailed += 1;
          continue;
        }

        classificar(sozinho, id);
      }
    }

    // ENRIQUECIMENTO POR ITEM — preço promocional (D-389) e descrição
    // (D-390) — só para anúncios ATIVOS: pausado/encerrado não roda campanha
    // (docs/MERCADO_LIVRE.md secao 2.8), e um anúncio parado não tem venda
    // nem visita nova para o diagnóstico de D-390 comparar. Pedir os dois
    // para 4.447 anúncios por conta a cada 6h, para os que nunca mudam, seria
    // custo sem uso. As DUAS chamadas de um mesmo item correm juntas
    // (Promise.all interno), e os itens do lote correm em PARALELO — em
    // série, cada chamada extra multiplicaria o tempo do multiget inteiro.
    //
    // Uma falha AQUI não derruba o item: a descrição fica nula e o log guarda
    // o motivo — a sincronização do catálogo é o que importa, estes dois são
    // enriquecimento. A PROMOÇÃO que falha fica com a última leitura boa
    // (D-419): gravar nulo dizia "sem promoção" de um anúncio que só não foi
    // lido, e o filtro de `/anuncios` o ofereceria para entrar numa campanha.
    const promocaoPorItem = new Map<string, PromocaoLida>();
    const fingerprintDescricaoPorItem = new Map<string, string | null>();
    const descricaoAtualizadaEmPorItem = new Map<string, string | null>();

    await Promise.all(
      itensValidos
        .filter((item) => item.status === "active")
        .map(async (item) => {
          const previous = previousByItem.get(item.id) ?? null;
          const previousRow = previousListingRowsByItem.get(item.id) ?? null;
          const shouldFetchDescription =
            !previousListingRowsByItem.has(item.id) ||
            previousRow?.description_source_updated_at === null ||
            previousRow?.description_source_updated_at === undefined ||
            item.last_updated !== previousRow.description_source_updated_at;

          const [promocao, descricao] = await Promise.all([
            getItemPromotions({ client: params.mercadoLivre, itemId: item.id, accessToken: params.accessToken })
              .then((promocoes) => ({
                ok: true as const,
                value: {
                  emPromocao: isInPromotion(promocoes),
                  preco: effectivePromotionalPrice(promocoes),
                  // D-420: as candidatas vêm na MESMA resposta — nenhuma chamada a mais.
                  ofertas: promotionOffers(promocoes),
                },
              }))
              .catch((error: unknown) => ({ ok: false as const, error })),
            shouldFetchDescription
              ? getItemDescription({ client: params.mercadoLivre, itemId: item.id, accessToken: params.accessToken })
                  .then((plainText) => ({ ok: true as const, value: fingerprintDaDescricao(plainText) }))
                  .catch((error: unknown) => ({ ok: false as const, error }))
              : Promise.resolve({ ok: true as const, value: previous?.descriptionFingerprint ?? null }),
          ]);

          if (promocao.ok) {
            promocaoPorItem.set(item.id, promocao.value);
          } else {
            params.logger.warn("listing_promotion_fetch_failed", {
              ml_account_id: params.mlAccountId,
              item_id: item.id,
              reason: promocao.error instanceof Error ? promocao.error.message : "erro desconhecido",
            });
          }

          if (descricao.ok) {
            fingerprintDescricaoPorItem.set(item.id, descricao.value);
            descricaoAtualizadaEmPorItem.set(item.id, item.last_updated ?? previousRow?.description_source_updated_at ?? null);
          } else {
            params.logger.warn("listing_description_fetch_failed", {
              ml_account_id: params.mlAccountId,
              item_id: item.id,
              reason: descricao.error instanceof Error ? descricao.error.message : "erro desconhecido",
            });
          }
        }),
    );

    const rows: ListingUpsertRow[] = [];
    const pending: { current: ListingSnapshot; previous: ListingSnapshot | null }[] = [];

    for (const item of itensValidos) {
      const skuId = skuByItem.get(item.id) ?? null;

      if (skuId === null) {
        itemsWithoutLink += 1;
      }

      statusSeen.set(item.status, (statusSeen.get(item.status) ?? 0) + 1);

      // D-405: a sonda — quantos anúncios declaram medidas, e quantas delas
      // têm a forma do envio. Só contagem: o valor não é gravado ainda.
      const declaradas = medidasDeclaradas(item);

      if (declaradas !== null) {
        itensComMedidas += 1;

        if (lerMedidas(declaradas) !== null) itensComMedidasLegiveis += 1;
        else exemploDeMedidaIlegivel ??= declaradas.slice(0, 60);
      }

      rows.push({
        organization_id: params.organizationId,
        ml_account_id: params.mlAccountId,
        item_id: item.id,
        sku_id: skuId,
        title: item.title,
        status: item.status,
        price: item.price,
        ...promocaoDaLinha(item.status, promocaoPorItem.get(item.id), previousListingRowsByItem.get(item.id), syncedAt),
        currency_id: item.currency_id,
        available_quantity: item.available_quantity,
        category_id: item.category_id ?? null,
        picture_fingerprint: fingerprintDasFotos(item),
        description_fingerprint: fingerprintDescricaoPorItem.get(item.id) ?? null,
        description_source_updated_at: descricaoAtualizadaEmPorItem.get(item.id) ?? null,
        thumbnail_url: fotoDoItem(item),
        permalink: linkDoItem(item),
        sub_status: item.sub_status ?? null,
        // D-631: excluído = `closed` com `deleted` no subestado. A primeira vez
        // que a V3 o viu assim fica; o anúncio que volta a existir perde a marca.
        deleted_at: excluidoNoMercadoLivre(item)
          ? (previousListingRowsByItem.get(item.id)?.deleted_at ?? syncedAt.toISOString())
          : null,
        synced_at: syncedAt.toISOString(),
      });

      if (excluidoNoMercadoLivre(item)) itemsMarkedDeleted += 1;

      pending.push({
        current: {
          itemId: item.id,
          title: item.title,
          status: item.status,
          price: item.price,
          availableQuantity: item.available_quantity,
          pictureFingerprint: fingerprintDasFotos(item),
          descriptionFingerprint: fingerprintDescricaoPorItem.get(item.id) ?? null,
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

  // D-631: o item que o Mercado Livre não devolve mais sai das telas. Só a
  // linha que existe e ainda não está marcada; um id que a V3 nunca gravou
  // não cria nada.
  if (inexistentes.length > 0) {
    const marcados = await params.db
      .from("listings")
      .update({ deleted_at: syncedAt.toISOString(), synced_at: syncedAt.toISOString() })
      .eq("ml_account_id", params.mlAccountId)
      .in("item_id", inexistentes)
      .is("deleted_at", null)
      .select("item_id");

    if (marcados.error !== null) {
      itemsFailed += inexistentes.length;
      params.logger.error("listing_not_marked_deleted", {
        ml_account_id: params.mlAccountId,
        items: inexistentes.length,
        reason: marcados.error.message,
      });
    } else {
      itemsMarkedDeleted += marcados.data.length;
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
    itens_com_medidas: itensComMedidas,
    itens_com_medidas_legiveis: itensComMedidasLegiveis,
    exemplo_de_medida_ilegivel: exemploDeMedidaIlegivel,
    itens_fora_da_varredura: foraDaVarredura.length,
    itens_excluidos: itemsMarkedDeleted,
    itens_inexistentes: inexistentes.length,
  });

  return {
    itemsDiscovered: discovered.length,
    itemsProcessed,
    itemsFailed,
    itemsWithoutLink,
    itemsMarkedDeleted,
    itemsOutsideScan: foraDaVarredura.length,
  };
}
