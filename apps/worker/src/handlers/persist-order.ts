import { SKU_LINK_WITH_KIND_SELECT } from "@sb/db";
import type { AdminClient, SkuLinkWithKindRow } from "@sb/db";
import {
  computeCancellationReversals,
  computeSaleDeductions,
  detectOrderStatusEvents,
  isCancelledOrderStatus,
} from "@sb/domain";
import type { RecordedSaleMovement, SaleDeductionItem } from "@sb/domain";
import type { Logger } from "@sb/observability";

import { assertWritten } from "./assert-written.js";
import { recordDomainEvents } from "./domain-events.js";
import type { ParsedOrder } from "./order-schema.js";
import { recordStockMovements } from "./stock-movements.js";

/**
 * Grava um pedido e seus itens — `orders`/`order_items`
 * (`docs/DATABASE.md`, migration `20260821040000_create_orders.sql`) — roda
 * o motor de diff (`@sb/domain/events`) comparando o status anterior contra
 * o novo, emitindo `domain_events` quando cabível (D-016), e mantém
 * `stock_movements` sincronizado com o status: deduz na venda válida
 * (D-019) ou reverte no cancelamento, nunca os dois na mesma chamada
 * (`@sb/domain/inventory`).
 *
 * Não é atômico entre `orders`/`order_items`/`domain_events`/
 * `stock_movements` (várias chamadas de rede separadas). Aceito de
 * propósito, mesmo padrão de `erp-import-apply.ts`: o pedido é reprocessado
 * a cada janela de reconciliação, então uma falha no meio se autocorrige na
 * próxima varredura — não é o tipo de escrita humana única que precisa da
 * atomicidade de uma RPC `security definer` (essa é para confirmação
 * humana, como `resolve_link_candidate`).
 *
 * `order_items` não tem id próprio do Mercado Livre — o array não traz
 * identificador estável por linha. Reprocessar substitui TODAS as linhas
 * (delete + insert), mesmo padrão já usado em `erp_import_rows`.
 *
 * A reversão de cancelamento reverte os movimentos `VENDA_ML` JÁ GRAVADOS no
 * ledger (consulta antes de reverter), não recalcula a partir dos itens
 * atuais — ver `@sb/domain/inventory` (`computeCancellationReversals`) para
 * o motivo. Por isso pula o recálculo de KIT/componentes quando o pedido
 * está cancelado: essa informação já está decomposta no ledger.
 *
 * **Deliberadamente não feito aqui**: reversão por DEVOLUÇÃO — o Mercado
 * Livre modela devolução pela API de Reclamações e Devoluções, não
 * integrada (mesmo motivo já registrado para `order.returned` em
 * `@sb/domain/events`). Só cancelamento é tratado nesta etapa.
 */

export interface PersistOrderContext {
  organizationId: string;
  mlAccountId: string;
}

/**
 * As tres leituras de `persistOrder`, resolvidas UMA VEZ para a pagina
 * inteira em vez de uma vez por pedido (D-186).
 *
 * As chaves sao STRING em todos os mapas, inclusive a do pedido — que no
 * banco e `bigint`. Isso nao e detalhe de estilo: `orders.id` chega como
 * `number` e `stock_movements.source_id` e `text`, e um mapa montado com um
 * tipo e consultado com o outro devolve `undefined` sem erro nenhum. O
 * resultado seria "pedido novo" para um pedido existente, ou "sem vinculo"
 * para um item vinculado — deducao de estoque pulada, em silencio.
 */
export interface ResolvedLink {
  id: string;
  sku_id: string;
  kind: "PRODUTO" | "KIT";
  components: { componentSkuId: string; quantity: number }[];
}

export interface OrderPrefetch {
  /** `String(order.id)` -> status gravado. Ausente = pedido novo para a V3. */
  previousStatusById: Map<string, string>;
  /** `chaveDoItem(item_id, variation_id)` -> vinculo vigente. Ausente = sem vinculo. */
  linkByItemKey: Map<string, ResolvedLink>;
}

/**
 * Traduz uma linha do embed para a forma que o handler usa (D-188).
 *
 * **`skus` nulo LANCA.** `sku_listing_links.sku_id` e NOT NULL com FK
 * `on delete restrict` para `skus`, entao a linha do SKU sempre existe: nulo
 * aqui so pode ser o embed nao tendo resolvido. Cair em PRODUTO gravaria um
 * `VENDA_ML` contra a linha de um KIT — passa na FK, nao deduz os
 * componentes, e a chave `venda:<id>:<pos>` nunca mais e gerada depois do
 * conserto (a forma KIT usa `venda:<id>:<pos>:<sku>`). Linha irreversivel num
 * ledger append-only.
 */
function linkResolvido(row: SkuLinkWithKindRow): ResolvedLink {
  if (row.skus === null) {
    throw new Error(
      `vinculo ${row.id} veio sem o SKU embutido — a FK garante que ele existe, entao o embed falhou, e cair em PRODUTO deduziria contra a linha do kit`,
    );
  }

  return {
    id: row.id,
    sku_id: row.sku_id,
    kind: row.skus.kind === "KIT" ? "KIT" : "PRODUTO",
    components: row.skus.sku_components.map((component) => ({
      componentSkuId: component.component_sku_id,
      quantity: component.quantity,
    })),
  };
}

function chaveDoItem(itemId: string, variationId: string | null): string {
  // `\u0000` nunca aparece nos dois campos (sao ids do Mercado Livre), entao
  // nao ha par distinto que colida.
  return `${itemId}\u0000${variationId ?? ""}`;
}

/**
 * Teto do PostgREST: **1.000 linhas, devolvidas com `error` NULO** — o
 * defeito que corrompeu o saldo de estoque de producao em D-131 ("nao quebra,
 * mente"). Toda leitura em lote deste arquivo passa por aqui.
 *
 * Nao existe forma de distinguir "cortou" de "so tinha isso" olhando a
 * resposta; a unica defesa e nunca chegar perto do teto e gritar se chegar.
 */
const TETO_POSTGREST = 1000;

/**
 * As tres unicas formas de uma leitura em lote nao devolver o que promete —
 * conferidas num lugar so, porque as tres terminam no MESMO estrago: uma
 * linha ausente vira "sem vinculo", `sku_id` fica nulo e a deducao de
 * estoque e pulada em silencio.
 */
function linhasDe<T>(
  resultado: { data: T[] | null; error: { message: string } | null },
  leitura: string,
): T[] {
  if (resultado.error !== null) {
    throw new Error(`falha na leitura em lote de ${leitura}: ${resultado.error.message}`);
  }

  if (resultado.data === null) {
    // `error` nulo com `data` nulo nao acontece no cliente real — lista vazia
    // vem como `[]`. Recusar em vez de assumir vazio: "sem vinculo" e uma
    // resposta LEGITIMA neste caminho, entao um estado impossivel nao pode
    // virar essa resposta por omissao.
    throw new Error(`leitura em lote de ${leitura} devolveu data nulo sem erro`);
  }

  if (resultado.data.length >= TETO_POSTGREST) {
    throw new Error(
      `leitura em lote de ${leitura} devolveu ${String(resultado.data.length)} linhas e pode ter sido cortada pelo teto do PostgREST (D-131): reduza o lote`,
    );
  }

  return resultado.data;
}

/**
 * Quantos `item_id` distintos vao por consulta de vinculo.
 *
 * MEDIDO no Dev: um anuncio tem ate **19** vinculos (media 3,3, p99 11),
 * porque cada variacao e uma linha. Com os 50 pedidos de uma pagina do
 * Mercado Livre, o pior caso daria 950 linhas — perto demais das 1.000. Com
 * 25, o pior caso e 475, e a folga e de 2x.
 */
const ITENS_POR_CONSULTA = 25;

function emLotes<T>(itens: readonly T[], tamanho: number): T[][] {
  const lotes: T[][] = [];

  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }

  return lotes;
}

/**
 * Resolve, para uma pagina inteira de pedidos, o que `persistOrder` leria um
 * pedido por vez.
 *
 * MEDIDO (D-185): o custo de uma ida ao banco e o round trip, nao o SQL — o
 * SQL das sete idas de um pedido soma 3,95 ms contra 660,7 ms observados.
 * Logo o que importa e o NUMERO de idas. Estas tres leituras eram 3 por
 * pedido (150 numa pagina de 50); passam a ser ~4 por pagina.
 *
 * **As escritas continuam uma por pedido, de proposito.** Ver o comentario
 * em `fetchOrdersWindow`.
 */
export async function prefetchOrders(
  db: AdminClient,
  context: PersistOrderContext,
  orders: readonly ParsedOrder[],
): Promise<OrderPrefetch> {
  const previousStatusById = new Map<string, string>();
  const linkByItemKey = new Map<string, ResolvedLink>();

  if (orders.length === 0) {
    return { previousStatusById, linkByItemKey };
  }

  const orderIds = orders.map((order) => order.id);
  const itemIds = [...new Set(orders.flatMap((order) => order.order_items.map((item) => item.item.id)))];

  // 1 + N idas, com N = lotes de item. As duas primeiras nao dependem uma da
  // outra.
  const [statusResult, linkResults] = await Promise.all([
    db.from("orders").select("id, status").in("id", orderIds),
    Promise.all(
      emLotes(itemIds, ITENS_POR_CONSULTA).map((lote) =>
        db
          .from("sku_listing_links")
          .select(SKU_LINK_WITH_KIND_SELECT)
          .eq("ml_account_id", context.mlAccountId)
          .eq("ref_kind", "ITEM")
          .in("item_id", lote),
      ),
    ),
  ]);

  for (const row of linhasDe(statusResult, "orders.status")) {
    previousStatusById.set(String(row.id), row.status);
  }

  for (const linkResult of linkResults) {
    // Mesma razao de `resolveSku`: tratar falha como "sem vinculo" gravaria
    // `sku_id` null numa venda real e pularia a deducao inteira.
    for (const row of linhasDe(linkResult, "sku_listing_links") as unknown as SkuLinkWithKindRow[]) {
      // A constraint `sku_listing_links_ref_shape` garante `item_id not null`
      // quando `ref_kind = 'ITEM'`, que e o filtro desta consulta — o tipo
      // gerado e que nao sabe disso (a coluna e nullable para o outro
      // `ref_kind`). Pular em vez de afirmar com `!`: se a constraint mudar,
      // o pior caso vira "sem vinculo", que ja e o caminho tratado, e nao um
      // crash com chave `null`.
      if (row.item_id === null) {
        continue;
      }

      linkByItemKey.set(chaveDoItem(row.item_id, row.variation_id), linkResolvido(row));
    }
  }

  // D-188: `kind` e componentes vem embutidos na propria leitura do vinculo.
  // Antes eram duas consultas a mais, encadeadas (skus dependia dos vinculos,
  // sku_components dependia dos kinds).
  return { previousStatusById, linkByItemKey };
}

export async function persistOrder(
  db: AdminClient,
  context: PersistOrderContext,
  order: ParsedOrder,
  logger: Logger,
  /**
   * Leituras ja resolvidas para a pagina inteira (D-186). Ausente, o handler
   * le por conta propria — e o caminho do webhook, que tem UM pedido e nao
   * teria o que agrupar.
   */
  prefetch?: OrderPrefetch,
): Promise<void> {
  // D-101: o `GET /orders/{id}` real (fast path do webhook) vem SEM
  // `date_last_updated` — só o `/orders/search` (reconciliação) o traz.
  // A coluna é NOT NULL e três `occurredAt` derivam dela, então o fallback
  // fica em cascata de campos do PRÓPRIO pedido (nunca `now()`, que
  // colocaria o relógio da V3 no lugar do relógio do Mercado Livre):
  // `last_updated` é o irmão com o mesmo significado (D-048), e
  // `date_created` sempre existe.
  const lastUpdatedAt = order.date_last_updated ?? order.last_updated ?? order.date_created;

  // D-184 — as duas leituras deste handler sobem para ANTES de qualquer
  // escrita, e sobem JUNTAS.
  //
  // O motivo forte é robustez, não latência. `resolveSku` rodava ENTRE o
  // `order_items.delete` e o `order_items.insert`, e ela LANÇA em erro de
  // propósito (gravar `sku_id` null numa venda real pularia a dedução
  // inteira). Ou seja: a única leitura do caminho vivia dentro da janela em
  // que o pedido está sem itens, e uma falha ali deixava o pedido com ZERO
  // itens até um reprocessamento bem-sucedido.
  //
  // Existem 2 pedidos assim no Dev (`paid`, com o movimento de estoque
  // gravado e nenhuma linha em `order_items`) — ambos de julho/2026, antes
  // de D-178, quando a falha do próprio `insert` ainda era silenciosa. Essa
  // metade D-178 já fechou; esta fecha a outra.
  //
  // O consumidor que paga a conta é `claim-return.ts`: sem a linha do item
  // ele não acha a `position`, emite `claim_return_order_item_not_found` e
  // pula a reversão da devolução. É registrado — não é perda silenciosa —
  // mas é reversão que não acontece.
  //
  // De brinde, uma espera a menos: as duas leituras não dependem uma da
  // outra. `resolveSku` já é uma função async (dispara na chamada) e o
  // builder do PostgREST é thenable, então `Promise.all` inicia as duas.
  const variationIds = order.order_items.map((item) =>
    item.item.variation_id != null ? String(item.item.variation_id) : null,
  );

  let previousStatus: string | null;
  let resolvedLinks: (ResolvedLink | null)[];

  if (prefetch !== undefined) {
    // Chave STRING para um `id` que e `bigint` no banco: ver o comentario de
    // `OrderPrefetch`. Ausente do mapa = pedido novo para a V3, exatamente o
    // que o `maybeSingle()` sem linha significa.
    previousStatus = prefetch.previousStatusById.get(String(order.id)) ?? null;
    resolvedLinks = order.order_items.map(
      (item, index) => prefetch.linkByItemKey.get(chaveDoItem(item.item.id, variationIds[index] ?? null)) ?? null,
    );
  } else {
    const [existing, links] = await Promise.all([
      db.from("orders").select("status").eq("id", order.id).maybeSingle(),
      Promise.all(
        order.order_items.map((item, index) =>
          resolveSku(db, context.mlAccountId, item.item.id, variationIds[index] ?? null),
        ),
      ),
    ]);

    if (existing.error !== null) {
      throw new Error(`falha ao ler status anterior da order ${String(order.id)}: ${existing.error.message}`);
    }

    previousStatus = existing.data?.status ?? null;
    resolvedLinks = links;
  }

  // Aborta se o pedido nao gravou (D-178): tudo abaixo -- eventos de status e
  // deducao de estoque -- presume que ele existe.
  assertWritten(
    await db
    .from("orders")
    .upsert(
      {
        id: order.id,
        organization_id: context.organizationId,
        ml_account_id: context.mlAccountId,
        pack_id: order.pack_id ?? null,
        status: order.status,
        status_detail: order.status_detail ?? null,
        date_created: order.date_created,
        date_closed: order.date_closed ?? null,
        date_last_updated: lastUpdatedAt,
        last_updated: order.last_updated ?? null,
        total_amount: order.total_amount,
        paid_amount: order.paid_amount ?? null,
        currency_id: order.currency_id,
        buyer_id: order.buyer?.id ?? null,
        shipping_id: order.shipping?.id ?? null,
        tags: order.tags ?? [],
        cancel_reason: order.cancel_detail?.description ?? null,
      },
      { onConflict: "id" },
    ),
    "orders.upsert",
  );

  const events = detectOrderStatusEvents(
    previousStatus,
    { id: order.id, status: order.status },
    new Date(lastUpdatedAt),
  );

  if (events.length > 0) {
    await recordDomainEvents(db, context, events, logger);
  }

  if (order.order_items.length === 0) {
    // Pedido sem item nenhum: nao ha o que gravar, e apagar o que existe
    // seria destruir dado a partir de uma resposta vazia do Mercado Livre.
    return;
  }

  // Sem `await` aqui: os vínculos foram resolvidos no topo.
  const items = order.order_items.map((item, position) => {
    const variationId = variationIds[position] ?? null;
    const resolved = resolvedLinks[position] ?? null;

    return {
      order_id: order.id,
      organization_id: context.organizationId,
      ml_account_id: context.mlAccountId,
      position,
      item_id: item.item.id,
      variation_id: variationId,
      title: item.item.title,
      seller_sku: item.item.seller_sku ?? null,
      quantity: item.quantity,
      unit_price: item.unit_price,
      sale_fee: item.sale_fee ?? null,
      currency_id: item.currency_id,
      sku_id: resolved?.sku_id ?? null,
      sku_listing_link_id: resolved?.id ?? null,
    };
  });

  // D-189 — GRAVA e depois apaga a sobra, em vez de apagar e depois gravar.
  //
  // A forma antiga era `delete` + `insert`, e entre as duas o pedido ficava
  // sem item nenhum. PostgREST nao tem transacao entre chamadas, entao a
  // janela era real: **ha 2 pedidos no Dev assim** — `paid`, com o movimento
  // de estoque gravado e nenhuma linha em `order_items`. D-184 tirou a
  // leitura de dentro dessa janela; esta fatia tira a janela.
  //
  // Comparacao honesta dos modos de falha, que e o que decide:
  //
  //   antiga  delete OK, insert falha  -> pedido com ZERO itens (observado)
  //   nova    upsert OK, delete falha  -> pedido com os itens CERTOS, no
  //                                       pior caso com sobra de uma versao
  //                                       anterior mais longa
  //
  // A sobra so existiria se um pedido ENCOLHESSE de itens, o que nunca
  // acontece: todo pedido tem exatamente 1 item (D-184 — no Mercado Livre,
  // compra de varios produtos vira um pack de varios pedidos).
  //
  // `onConflict` em `(order_id, position)`: a UNIQUE ja existia
  // (`order_items_order_id_position_key`). Nenhuma FK aponta para
  // `order_items.id` — conferido no catalogo —, entao preservar o id em vez
  // de trocar a cada gravacao nao quebra nada, e de brinde o id passa a ser
  // estavel.
  assertWritten(
    await db.from("order_items").upsert(items, { onConflict: "order_id,position" }),
    `order_items.upsert (order ${String(order.id)})`,
  );

  // A cauda: posicoes que existiam numa versao anterior mais longa e nao
  // existem mais. Roda DEPOIS da gravacao, entao nao ha instante em que o
  // pedido esteja sem os itens atuais.
  assertWritten(
    await db.from("order_items").delete().eq("order_id", order.id).gte("position", items.length),
    `order_items.delete da cauda (order ${String(order.id)})`,
  );

  if (isCancelledOrderStatus(order.status)) {
    const saleMovements = await loadSaleMovements(db, context.organizationId, order.id);
    const reversals = computeCancellationReversals(
      { id: order.id, status: order.status, occurredAt: new Date(lastUpdatedAt) },
      saleMovements,
    );

    if (reversals.length > 0) {
      await recordStockMovements(
        db,
        context,
        reversals,
        "CANCELAMENTO_ML",
        { type: "ORDER", id: String(order.id) },
      );
    }

    return;
  }

  // Sem `await` aqui: desde D-188 nao ha leitura dentro deste laco. `kind` e
  // componentes chegam junto com o vinculo, nos dois caminhos.
  const deductionItems: SaleDeductionItem[] = items.map((item) => {
      // Item sem vinculo continua com `skuKind: null`: a forma
      // `skuKind: "PRODUTO"` com `skuId: null` e um estado que o contrato de
      // `SaleDeductionItem` declara impossivel.
      if (item.sku_id === null) {
        return { position: item.position, quantity: item.quantity, skuId: null, skuKind: null, components: [] };
      }

      // D-188: `kind` e componentes chegam junto com o vinculo, nos DOIS
      // caminhos — o lote da janela e o embed do webhook. Nao ha mais leitura
      // aqui dentro.
      const resolved = resolvedLinks[item.position];

      if (resolved === null || resolved === undefined) {
        throw new Error(
          `item ${String(item.position)} da order ${String(order.id)} tem sku_id sem vinculo resolvido — estado impossivel`,
        );
      }

    return {
      position: item.position,
      quantity: item.quantity,
      skuId: item.sku_id,
      skuKind: resolved.kind,
      components: resolved.components,
    };
  });

  const deductions = computeSaleDeductions({
    id: order.id,
    status: order.status,
    occurredAt: new Date(lastUpdatedAt),
    items: deductionItems,
  });

  if (deductions.length > 0) {
    await recordStockMovements(
      db,
      context,
      deductions,
      "VENDA_ML",
      { type: "ORDER", id: String(order.id) },
    );
  }
}

/**
 * Carrega os movimentos `VENDA_ML` já gravados para esta order — a base
 * para reverter exatamente o que foi deduzido, não o que os itens atuais
 * computariam (ver comentário no topo do arquivo).
 */
async function loadSaleMovements(
  db: AdminClient,
  organizationId: string,
  orderId: number,
): Promise<RecordedSaleMovement[]> {
  const result = await db
    .from("stock_movements")
    .select("sku_id, qty_delta, idempotency_key")
    .eq("organization_id", organizationId)
    .eq("source_type", "ORDER")
    .eq("source_id", String(orderId))
    .eq("movement_type", "VENDA_ML");

  if (result.error !== null) {
    // Não tratar como "nenhum movimento": numa order cancelada, isso faria
    // computeCancellationReversals reverter zero — a dedução original da
    // venda ficaria de pé, estoque silenciosamente incorreto.
    throw new Error(`falha ao ler stock_movements da order ${String(orderId)}: ${result.error.message}`);
  }

  return result.data.map((row) => ({
    skuId: row.sku_id,
    qtyDelta: row.qty_delta,
    idempotencyKey: row.idempotency_key,
  }));
}

/**
 * Resolve `sku_id` pelo vínculo vigente (D-020) — congelado na linha do
 * item, nunca recalculado por join na leitura. Mesma forma de índice parcial
 * de `sku_listing_links` (`docs/DATABASE.md` secao 4): `variation_id` nulo
 * precisa de `.is()`, não `.eq()`.
 */
async function resolveSku(
  db: AdminClient,
  mlAccountId: string,
  itemId: string,
  variationId: string | null,
): Promise<ResolvedLink | null> {
  const query = db
    .from("sku_listing_links")
    .select(SKU_LINK_WITH_KIND_SELECT)
    .eq("ml_account_id", mlAccountId)
    .eq("ref_kind", "ITEM")
    .eq("item_id", itemId);

  const filtered = variationId === null ? query.is("variation_id", null) : query.eq("variation_id", variationId);

  const result = await filtered.maybeSingle();

  if (result.error !== null) {
    // Não tratar como "sem vínculo": isso gravaria sku_id null numa venda
    // real e puparia a dedução de estoque inteira — overselling silencioso.
    throw new Error(
      `falha ao resolver sku_listing_link (item ${itemId}, variation ${variationId ?? "null"}): ${result.error.message}`,
    );
  }

  // D-188: uma ida em vez de tres. O caminho do webhook processa UM pedido e
  // nao tem o que agrupar, entao era ele que ainda pagava `sku_listing_links`
  // + `skus` + `sku_components` em sequencia.
  const row = result.data as unknown as SkuLinkWithKindRow | null;

  return row === null ? null : linkResolvido(row);
}

