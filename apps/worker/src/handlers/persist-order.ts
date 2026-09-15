import { SKU_LINK_WITH_KIND_SELECT } from "@sb/db";
import type { AdminClient, Json, SkuLinkWithKindRow } from "@sb/db";
import {
  computeCancellationMovements,
  computeSaleDeductions,
  detectOrderStatusEvents,
  estornadoKeyOf,
  isCancelledOrderStatus,
  isValidSaleStatus,
  revertedSaleKeyOf,
} from "@sb/domain";
import type {
  ErpCutoff,
  ObservedSaleTransition,
  RecordedReversal,
  RecordedSale,
  RecordedSaleMovement,
  SaleDeductionItem,
  StockMovementDraft,
} from "@sb/domain";
import type { Logger } from "@sb/observability";

import { assertWritten, CriticalWriteError } from "./assert-written.js";
import { asJson, recordDomainEvents } from "./domain-events.js";
import type { PageWrites } from "./page-writes.js";
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
 * **D-351 — venda anterior ao snapshot do UpSeller.** Toda venda gravada sai
 * com o par `ESTORNO_PRE_CAPTURA` quando a "venda em" é anterior ou igual ao
 * corte do SKU (`@sb/domain/inventory`, `computeSaleDeductions`). O corte vem de
 * `get_erp_stock_cutoffs`, lido UMA vez por página e uma vez no webhook, e a
 * leitura que falha ou volta incompleta LANÇA: tratar "não sei o corte" como
 * "sem corte" é exatamente a dupla contagem que a guarda existe para impedir.
 * Venda já gravada só é estornada se entrou no saldo depois de o corte chegar
 * (`imported_at`). No cancelamento, a venda anterior ao corte que a V3 nunca
 * gravou e que cancelou depois dele ganha venda + estorno + cancelamento, com a
 * transição lida do status anterior ou de um `order.cancelled` já gravado
 * (`@sb/domain/inventory`, `computeCancellationMovements`). A chave do estorno é
 * neutra, `estorno:<chave do movimento>`: o tipo diz a causa.
 *
 * **Verificação de e6fda07.** O cancelamento é limitado pelo que a devolução já
 * devolveu (a unidade volta ao estoque no máximo uma vez): o `CANCELAMENTO_ML` e
 * as `DEVOLUCAO_ML` gravados do pedido são lidos junto com a venda. A venda
 * gravada até o corte só é estornada se entrou no saldo depois do último
 * alinhamento (o import ou uma reconciliação posterior), e o trio só repõe
 * pedido sem nenhum `VENDA_ML` gravado.
 *
 * **Deliberadamente não feito aqui**: reversão por DEVOLUÇÃO — o Mercado
 * Livre modela devolução pela API de Reclamações e Devoluções, não
 * integrada (mesmo motivo já registrado para `order.returned` em
 * `@sb/domain/events`). Só cancelamento é tratado nesta etapa.
 */

export interface PersistOrderContext {
  organizationId: string;
  mlAccountId: string;
  /**
   * A fonte dos eventos de pedido (D-351). `backfill` para a carga da história —
   * o evento é gravado, mas `private.fan_out_notification` não o notifica —;
   * `sync` para a janela horária e para o webhook. Obrigatória: um padrão
   * esquecido num chamador novo reabriria as notificações do backfill.
   */
  eventSource: "sync" | "backfill";
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

/** O que um pedido ja tem gravado no ledger e importa para vender ou reverter (D-351). */
export interface RecordedOrderMovements {
  /** `VENDA_ML` gravados — base da reversao e o que o estorno espelha, com o `created_at` de cada um. */
  sales: (RecordedSaleMovement & RecordedSale)[];
  /**
   * Chaves de venda que ja tem estorno gravado. Separadas pelo TIPO da linha
   * (`ESTORNO_PRE_CAPTURA`), nunca pelo prefixo da chave: a chave e neutra
   * (`estorno:<chave do movimento>`) e so diz QUAL movimento foi estornado.
   */
  estornadas: Set<string>;
  /**
   * `CANCELAMENTO_ML` e `DEVOLUCAO_ML` gravados das vendas do pedido: o limite de
   * cada reversão — a unidade volta ao estoque no máximo uma vez (verificação de
   * e6fda07, ALTA-1).
   */
  reversals: RecordedReversal[];
}

export interface OrderPrefetch {
  /** `String(order.id)` -> status gravado. Ausente = pedido novo para a V3. */
  previousStatusById: Map<string, string>;
  /** `chaveDoItem(item_id, variation_id)` -> vinculo vigente. Ausente = sem vinculo. */
  linkByItemKey: Map<string, ResolvedLink>;
  /**
   * `String(order.id)` -> movimentos gravados (D-351). Lido so para pedido em
   * status de venda ou de cancelamento; ausente = nada gravado.
   */
  recordedByOrderId: Map<string, RecordedOrderMovements>;
  /**
   * `sku_id` -> corte do snapshot do ERP (D-351). `null` = organizacao sem
   * snapshot. AUSENTE = nao lido, e consultar um SKU ausente LANCA.
   */
  cutoffBySku: Map<string, ErpCutoff | null>;
  /**
   * `String(order.id)` -> a transicao de venda para cancelado ja GRAVADA em
   * `domain_events` (D-351). Lida so para pedido cancelado; ausente = nenhuma.
   * E o que deixa o retry repor a venda anterior ao corte depois de o pedido
   * ja ter sido regravado como cancelado.
   */
  saleTransitionByOrderId: Map<string, ObservedSaleTransition>;
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

/**
 * Quantos pedidos por consulta de movimentos gravados (D-351). Cada pedido tem
 * 1 item (D-184), e um KIT tem uma venda, um estorno e um cancelamento por
 * componente. O maior KIT medido tem 4 componentes (produção e Dev,
 * 2026-09-15): 25 pedidos dão 300 linhas no pior caso, e o `linhasDe` grita se
 * chegar a 1.000. As devoluções (uma por claim e componente) vão pelo mesmo lote.
 */
const PEDIDOS_POR_CONSULTA = 25;

/** Ids por chamada de `get_erp_stock_cutoffs`: a saida tem uma linha por id, metade do teto. */
const SKUS_POR_CONSULTA_DE_CORTE = 500;

function emLotes<T>(itens: readonly T[], tamanho: number): T[][] {
  const lotes: T[][] = [];

  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }

  return lotes;
}

/** O status em que um pedido pode vender ou reverter — os unicos que precisam do ledger. */
function mexeNoEstoque(status: string): boolean {
  return isValidSaleStatus(status) || isCancelledOrderStatus(status);
}

/**
 * `VENDA_ML`, `ESTORNO_PRE_CAPTURA` e `CANCELAMENTO_ML` ja gravados para os
 * pedidos (D-351). As devolucoes, gravadas com a origem do claim, vem de
 * `lerDevolucoes`.
 *
 * Substitui a leitura por pedido que o cancelamento fazia: a mesma consulta
 * serve a reversao (o que reverter e o que foi estornado) e a venda (o que o
 * estorno precisa espelhar).
 */
async function lerMovimentosGravados(
  db: AdminClient,
  organizationId: string,
  orderIds: readonly number[],
): Promise<Map<string, RecordedOrderMovements>> {
  const porPedido = new Map<string, RecordedOrderMovements>();

  if (orderIds.length === 0) {
    return porPedido;
  }

  const resultados = await Promise.all(
    emLotes([...new Set(orderIds.map(String))], PEDIDOS_POR_CONSULTA).map((lote) =>
      db
        .from("stock_movements")
        .select("source_id, sku_id, qty_delta, idempotency_key, occurred_at, created_at, movement_type")
        .eq("organization_id", organizationId)
        .eq("source_type", "ORDER")
        .in("source_id", lote)
        .in("movement_type", ["VENDA_ML", "ESTORNO_PRE_CAPTURA", "CANCELAMENTO_ML"]),
    ),
  );

  for (const resultado of resultados) {
    // Não tratar como "nenhum movimento": numa order cancelada, isso faria
    // computeCancellationReversals reverter zero — a dedução original da
    // venda ficaria de pé, estoque silenciosamente incorreto.
    for (const row of linhasDe(resultado, "stock_movements")) {
      const pedido = String(row.source_id);
      const gravados = porPedido.get(pedido) ?? nadaGravado();

      if (row.movement_type === "ESTORNO_PRE_CAPTURA") {
        // O TIPO diz que a linha e estorno; a chave neutra diz de qual
        // movimento. Chave fora do formato LANCA (`estornadoKeyOf`).
        gravados.estornadas.add(estornadoKeyOf(row.idempotency_key));
      } else if (row.movement_type === "CANCELAMENTO_ML") {
        gravados.reversals.push(reversaoGravada(row.idempotency_key, row.qty_delta));
      } else {
        gravados.sales.push({
          skuId: row.sku_id,
          qtyDelta: row.qty_delta,
          idempotencyKey: row.idempotency_key,
          occurredAt: new Date(row.occurred_at),
          // Quando a venda entrou no saldo: a venda gravada antes de o corte
          // chegar nao e estornada (ALTA-1 da revisao de D-351).
          recordedAt: new Date(row.created_at),
        });
      }

      porPedido.set(pedido, gravados);
    }
  }

  return porPedido;
}

/**
 * Uma reversao gravada, com a chave conferida: `cancelamento:<venda>` ou
 * `devolucao:<claim>:<venda>`. Fora do formato LANCA (`revertedSaleKeyOf`) —
 * uma reversao que nao diz qual venda reverteu faria a venda parecer nao
 * revertida, e a proxima reversao devolveria a unidade de novo.
 */
function reversaoGravada(idempotencyKey: string, quantity: number): RecordedReversal {
  revertedSaleKeyOf(idempotencyKey);

  return { idempotencyKey, quantity };
}

/** Os pedidos com `VENDA_ML` gravado — os unicos que podem ter devolucao gravada. */
function pedidosComVenda(gravados: Map<string, RecordedOrderMovements>): string[] {
  return [...gravados].filter(([, doPedido]) => doPedido.sales.length > 0).map(([pedido]) => pedido);
}

/**
 * As `DEVOLUCAO_ML` gravadas dos pedidos (verificacao de e6fda07, ALTA-1), por
 * `get_order_return_movements`.
 *
 * Cancelamento e devolucao entregue revertem a MESMA venda, e a unidade volta ao
 * estoque no maximo uma vez: sem ler a devolucao, o cancelamento devolveria de
 * novo o que ela ja devolveu (+2 para 1 unidade vendida). A devolucao e gravada
 * com a origem do CLAIM, e o pedido so aparece dentro da chave -- por isso a RPC,
 * e nao a consulta por `source_id`. Mesma regra das outras leituras: falha LANCA,
 * nunca vira "nenhuma devolucao".
 */
async function lerDevolucoes(
  db: AdminClient,
  organizationId: string,
  orderIds: readonly string[],
): Promise<Map<string, RecordedReversal[]>> {
  const porPedido = new Map<string, RecordedReversal[]>();

  if (orderIds.length === 0) {
    return porPedido;
  }

  const resultados = await Promise.all(
    emLotes([...new Set(orderIds)], PEDIDOS_POR_CONSULTA).map((lote) =>
      db.rpc("get_order_return_movements", { p_organization_id: organizationId, p_order_ids: lote }),
    ),
  );

  for (const resultado of resultados) {
    for (const row of linhasDe(resultado, "get_order_return_movements")) {
      porPedido.set(row.order_id, [
        ...(porPedido.get(row.order_id) ?? []),
        reversaoGravada(row.idempotency_key, row.qty_delta),
      ]);
    }
  }

  return porPedido;
}

/** Junta as devolucoes aos movimentos gravados de cada pedido. */
function juntaDevolucoes(
  gravados: Map<string, RecordedOrderMovements>,
  devolucoes: Map<string, RecordedReversal[]>,
): void {
  for (const [pedido, lista] of devolucoes) {
    gravados.get(pedido)?.reversals.push(...lista);
  }
}

/**
 * A transicao de venda para cancelado ja GRAVADA de cada pedido (D-351): o
 * `order.cancelled` mais recente com `before.status` de venda valida.
 *
 * **Por que ler o evento, e nao so o status anterior.** A venda anterior ao
 * corte, nunca gravada e cancelada depois dele, so e reposta quando a V3 viu a
 * transicao (`computeCancellationMovements`). O status anterior mostra a
 * transicao UMA vez: a pagina grava `orders` antes dos movimentos
 * (`page-writes.ts`), e o webhook tambem, entao um retry depois de uma falha na
 * gravacao dos movimentos ja acharia o pedido cancelado no banco -- e a
 * reposicao sumiria. O evento e gravado ANTES dos movimentos nos dois caminhos
 * (no lote, a falha dele aborta a pagina), e sobrevive ao retry.
 */
async function lerTransicoesDeVenda(
  db: AdminClient,
  organizationId: string,
  orderIds: readonly number[],
): Promise<Map<string, ObservedSaleTransition>> {
  const porPedido = new Map<string, ObservedSaleTransition>();

  if (orderIds.length === 0) {
    return porPedido;
  }

  const resultados = await Promise.all(
    emLotes([...new Set(orderIds.map(String))], PEDIDOS_POR_CONSULTA).map((lote) =>
      db
        .from("domain_events")
        .select("entity_id, before, occurred_at")
        .eq("organization_id", organizationId)
        .eq("entity_type", "order")
        .eq("event_type", "order.cancelled")
        .in("entity_id", lote),
    ),
  );

  for (const resultado of resultados) {
    // Mesma regra das outras leituras: "nao li" nunca vira "nao houve transicao".
    for (const row of linhasDe(resultado, "domain_events")) {
      const antes = statusAnterior(row.before);

      if (antes === null || !isValidSaleStatus(antes)) {
        continue;
      }

      const cancelledAt = new Date(row.occurred_at);
      const atual = porPedido.get(row.entity_id);

      if (atual?.cancelledAt == null || atual.cancelledAt.getTime() < cancelledAt.getTime()) {
        porPedido.set(row.entity_id, { saleStatus: antes, cancelledAt });
      }
    }
  }

  return porPedido;
}

/** `before.status` de um `order.cancelled` (`detectOrderStatusEvents` grava `{ status }`). */
function statusAnterior(before: Json | null): string | null {
  if (before === null || typeof before !== "object" || Array.isArray(before)) {
    return null;
  }

  const status = before.status;

  return typeof status === "string" ? status : null;
}

/**
 * Um instante do corte, conferido. LANCA para coluna ausente (a RPC na forma de
 * uma versao anterior da migration), valor que nao e texto e data ilegivel
 * (verificacao de e6fda07, BAIXA-3): `new Date(undefined)` e Invalid Date, e
 * toda comparacao com NaN e falsa -- a guarda do import deixaria de segurar e
 * toda venda gravada seria estornada, em silencio.
 */
function instanteDoCorte(valor: unknown, coluna: string, skuId: string): Date {
  if (typeof valor !== "string") {
    throw new Error(
      `get_erp_stock_cutoffs devolveu o corte do SKU ${skuId} sem ${coluna} — sem ele nao da para saber se a venda gravada ja estava no saldo (D-351)`,
    );
  }

  const instante = new Date(valor);

  if (Number.isNaN(instante.getTime())) {
    throw new Error(`get_erp_stock_cutoffs devolveu ${coluna} ilegivel para o SKU ${skuId}: "${valor}" (D-351)`);
  }

  return instante;
}

/**
 * O corte do snapshot do ERP por SKU (D-351), por `get_erp_stock_cutoffs`.
 *
 * A RPC devolve UMA linha por id pedido, sempre — `captured_at` nulo quando a
 * organizacao nao tem snapshot. Linha ausente e leitura incompleta e LANCA, e
 * corte sem `imported_at` ou sem `reconciled_at` (a coluna; o valor pode ser
 * nulo, "nunca reconciliou"), ou com data ilegivel, tambem: sem eles nao ha
 * como saber se uma venda gravada ja estava no saldo quando o saldo foi
 * alinhado ao corte.
 */
export async function readErpCutoffs(
  db: AdminClient,
  organizationId: string,
  skuIds: readonly string[],
): Promise<Map<string, ErpCutoff | null>> {
  const cortes = new Map<string, ErpCutoff | null>();
  const pedidos = [...new Set(skuIds)].sort();

  if (pedidos.length === 0) {
    return cortes;
  }

  const lotes = emLotes(pedidos, SKUS_POR_CONSULTA_DE_CORTE);
  const resultados = await Promise.all(
    lotes.map((lote) =>
      db.rpc("get_erp_stock_cutoffs", { p_organization_id: organizationId, p_sku_ids: lote }),
    ),
  );

  for (const [indice, resultado] of resultados.entries()) {
    for (const row of linhasDe(resultado, "get_erp_stock_cutoffs")) {
      if (row.captured_at === null) {
        cortes.set(row.sku_id, null);
        continue;
      }

      cortes.set(row.sku_id, {
        capturedAt: instanteDoCorte(row.captured_at, "captured_at", row.sku_id),
        importedAt: instanteDoCorte(row.imported_at, "imported_at", row.sku_id),
        reconciledAt:
          row.reconciled_at === null ? null : instanteDoCorte(row.reconciled_at, "reconciled_at", row.sku_id),
      });
    }

    for (const skuId of lotes[indice] ?? []) {
      if (!cortes.has(skuId)) {
        throw new Error(
          `get_erp_stock_cutoffs nao devolveu o corte do SKU ${skuId} — leitura incompleta nao vira "sem corte" (D-351)`,
        );
      }
    }
  }

  return cortes;
}

/** Os SKUs cujo corte uma venda ou reversao pode consultar: os vinculados hoje e os ja gravados. */
function skusComCorte(links: Iterable<ResolvedLink | null>, gravados: Iterable<RecordedOrderMovements>): string[] {
  const skus = new Set<string>();

  for (const link of links) {
    if (link === null) continue;

    if (link.kind === "KIT") {
      for (const component of link.components) skus.add(component.componentSkuId);
    } else {
      skus.add(link.sku_id);
    }
  }

  for (const pedido of gravados) {
    for (const venda of pedido.sales) skus.add(venda.skuId);
  }

  return [...skus];
}

function corteDe(cortes: Map<string, ErpCutoff | null>, orderId: number): (skuId: string) => ErpCutoff | null {
  return (skuId) => {
    const corte = cortes.get(skuId);

    if (corte === undefined) {
      throw new Error(
        `corte do snapshot do ERP nao lido para o SKU ${skuId} (order ${String(orderId)}) — "nao lido" nunca vira "sem corte" (D-351)`,
      );
    }

    return corte;
  };
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
 * D-351 acrescenta duas, sem crescer com a pagina: os movimentos gravados (na
 * mesma rodada das duas primeiras) e o corte do ERP (depois, porque os SKUs
 * vem dos vinculos e dos movimentos).
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
    return {
      previousStatusById,
      linkByItemKey,
      recordedByOrderId: new Map(),
      cutoffBySku: new Map(),
      saleTransitionByOrderId: new Map(),
    };
  }

  const orderIds = orders.map((order) => order.id);
  const itemIds = [...new Set(orders.flatMap((order) => order.order_items.map((item) => item.item.id)))];

  // 1 + N idas, com N = lotes de item. As quatro primeiras nao dependem umas
  // das outras.
  const [statusResult, linkResults, recordedByOrderId, saleTransitionByOrderId] = await Promise.all([
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
    lerMovimentosGravados(
      db,
      context.organizationId,
      orders.filter((order) => mexeNoEstoque(order.status)).map((order) => order.id),
    ),
    lerTransicoesDeVenda(
      db,
      context.organizationId,
      orders.filter((order) => isCancelledOrderStatus(order.status)).map((order) => order.id),
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
  //
  // D-351: o corte de todos os SKUs da pagina numa leitura so — a venda
  // consulta os vinculados, a reversao consulta os ja gravados.
  //
  // Verificacao de e6fda07, ALTA-1: as devolucoes gravadas, na mesma rodada do
  // corte, e so dos pedidos com venda gravada -- devolucao sem venda nao existe.
  const [cutoffBySku, devolucoes] = await Promise.all([
    readErpCutoffs(db, context.organizationId, skusComCorte(linkByItemKey.values(), recordedByOrderId.values())),
    lerDevolucoes(db, context.organizationId, pedidosComVenda(recordedByOrderId)),
  ]);

  juntaDevolucoes(recordedByOrderId, devolucoes);

  return { previousStatusById, linkByItemKey, recordedByOrderId, cutoffBySku, saleTransitionByOrderId };
}

/**
 * Um lugar so para a bifurcacao "coleta ou grava" dos movimentos.
 *
 * Em lote NAO reusa `recordStockMovements`: aquela funcao e compartilhada com
 * `nfe-import-apply`, que nao tem retry, e mudar a forma dela para all-or-
 * nothing seria perda de estoque permanente ali (D-187). O lote usa funcao
 * propria, em `page-writes.ts`.
 */
async function gravaMovimentos(
  db: AdminClient,
  context: PersistOrderContext,
  writes: PageWrites | undefined,
  drafts: readonly StockMovementDraft[],
  movementType: string,
  source: { type: string; id: string },
): Promise<void> {
  if (writes !== undefined) {
    for (const draft of drafts) {
      writes.movements.push({ draft, movementType, source });
    }

    return;
  }

  await recordStockMovements(db, context, drafts, movementType, source);
}

/**
 * As vendas do trio num comando so, no webhook (verificacao de e6fda07, MEDIA-1).
 *
 * O trio so sai para pedido SEM nenhum `VENDA_ML` gravado. O webhook grava linha a
 * linha (`recordStockMovements`), e uma falha entre dois componentes de um KIT
 * deixaria uma venda gravada e a outra nao: o retry veria venda gravada, nao
 * reporia a que faltou, e o componente ficaria 1 abaixo. Um INSERT de varias
 * linhas e atomico. No lote da pagina isso ja vale (`flushPageWrites`). Ordenado
 * por SKU pelo mesmo motivo de `page-writes.ts`: as travas de saldo sempre na
 * mesma ordem.
 */
async function gravaNumComando(
  db: AdminClient,
  context: PersistOrderContext,
  drafts: readonly StockMovementDraft[],
  movementType: string,
  source: { type: string; id: string },
): Promise<void> {
  const linhas = [...drafts]
    .sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : 0))
    .map((draft) => ({
      organization_id: context.organizationId,
      sku_id: draft.skuId,
      location_kind: draft.locationKind ?? "LOCAL",
      qty_delta: draft.qtyDelta,
      movement_type: movementType,
      source_type: source.type,
      source_id: source.id,
      idempotency_key: draft.idempotencyKey,
      occurred_at: draft.occurredAt.toISOString(),
    }));

  const resultado = await db
    .from("stock_movements")
    .upsert(linhas, { onConflict: "idempotency_key", ignoreDuplicates: true });

  // Mesma regra de D-187: 23505 e a idempotencia funcionando; o resto aborta.
  if (resultado.error !== null && resultado.error.code !== "23505") {
    throw new CriticalWriteError(
      `stock_movements.upsert do trio (${movementType}, ${String(linhas.length)} movimentos, origem ${source.id})`,
      resultado.error.message,
      resultado.error.code,
    );
  }
}

/** Nada gravado para o pedido. Um objeto novo por chamada: `juntaDevolucoes` escreve nele. */
function nadaGravado(): RecordedOrderMovements {
  return { sales: [], estornadas: new Set(), reversals: [] };
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
  /**
   * Acumulador da pagina (D-190). Presente, as escritas deste pedido sao
   * COLETADAS e o chamador descarrega uma vez por pagina. Ausente, o handler
   * escreve na hora — e o caminho do webhook, que tem UM pedido e para o qual
   * "escreve e so entao segue" continua sendo a semantica certa.
   */
  writes?: PageWrites,
): Promise<void> {
  // D-101: o `GET /orders/{id}` real (fast path do webhook) vem SEM
  // `date_last_updated` — só o `/orders/search` (reconciliação) o traz.
  // A coluna é NOT NULL e três `occurredAt` derivam dela, então o fallback
  // fica em cascata de campos do PRÓPRIO pedido (nunca `now()`, que
  // colocaria o relógio da V3 no lugar do relógio do Mercado Livre):
  // `last_updated` é o irmão com o mesmo significado (D-048), e
  // `date_created` sempre existe.
  const lastUpdatedAt = order.date_last_updated ?? order.last_updated ?? order.date_created;

  // D-184 — as leituras deste handler sobem para ANTES de qualquer
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
  // De brinde, uma espera a menos: as leituras não dependem umas das
  // outras. `resolveSku` já é uma função async (dispara na chamada) e o
  // builder do PostgREST é thenable, então `Promise.all` inicia todas.
  //
  // D-351: os movimentos gravados e o corte do ERP entram na mesma regra —
  // lidos antes de qualquer escrita, e a falha deles LANÇA.
  const variationIds = order.order_items.map((item) =>
    item.item.variation_id != null ? String(item.item.variation_id) : null,
  );

  let previousStatus: string | null;
  let resolvedLinks: (ResolvedLink | null)[];
  let gravados: RecordedOrderMovements;
  let cortes: Map<string, ErpCutoff | null>;
  let transicaoGravada: ObservedSaleTransition | null;

  if (prefetch !== undefined) {
    // Chave STRING para um `id` que e `bigint` no banco: ver o comentario de
    // `OrderPrefetch`. Ausente do mapa = pedido novo para a V3, exatamente o
    // que o `maybeSingle()` sem linha significa.
    previousStatus = prefetch.previousStatusById.get(String(order.id)) ?? null;
    resolvedLinks = order.order_items.map(
      (item, index) => prefetch.linkByItemKey.get(chaveDoItem(item.item.id, variationIds[index] ?? null)) ?? null,
    );
    gravados = prefetch.recordedByOrderId.get(String(order.id)) ?? nadaGravado();
    cortes = prefetch.cutoffBySku;
    transicaoGravada = prefetch.saleTransitionByOrderId.get(String(order.id)) ?? null;
  } else {
    const [existing, links, recorded, transicoes] = await Promise.all([
      db.from("orders").select("status").eq("id", order.id).maybeSingle(),
      Promise.all(
        order.order_items.map((item, index) =>
          resolveSku(db, context.mlAccountId, item.item.id, variationIds[index] ?? null),
        ),
      ),
      mexeNoEstoque(order.status)
        ? lerMovimentosGravados(db, context.organizationId, [order.id])
        : Promise.resolve(new Map<string, RecordedOrderMovements>()),
      isCancelledOrderStatus(order.status)
        ? lerTransicoesDeVenda(db, context.organizationId, [order.id])
        : Promise.resolve(new Map<string, ObservedSaleTransition>()),
    ]);

    if (existing.error !== null) {
      throw new Error(`falha ao ler status anterior da order ${String(order.id)}: ${existing.error.message}`);
    }

    previousStatus = existing.data?.status ?? null;
    resolvedLinks = links;
    gravados = recorded.get(String(order.id)) ?? nadaGravado();
    transicaoGravada = transicoes.get(String(order.id)) ?? null;

    if (mexeNoEstoque(order.status)) {
      // O corte e as devolucoes gravadas na mesma rodada, antes de qualquer escrita.
      const [lidos, devolucoes] = await Promise.all([
        readErpCutoffs(db, context.organizationId, skusComCorte(links, [gravados])),
        lerDevolucoes(db, context.organizationId, pedidosComVenda(recorded)),
      ]);

      cortes = lidos;
      juntaDevolucoes(recorded, devolucoes);
    } else {
      cortes = new Map<string, ErpCutoff | null>();
    }
  }

  // Aborta se o pedido nao gravou (D-178): tudo abaixo -- eventos de status e
  // deducao de estoque -- presume que ele existe.
  const linhaDaOrder = {
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
  };

  if (writes !== undefined) {
    writes.orders.push(linhaDaOrder);
  } else {
    assertWritten(
      await db.from("orders").upsert(linhaDaOrder, { onConflict: "id" }),
      `orders.upsert (order ${String(order.id)})`,
    );
  }

  const events = detectOrderStatusEvents(
    previousStatus,
    { id: order.id, status: order.status },
    new Date(lastUpdatedAt),
    context.eventSource,
  );

  if (events.length > 0) {
    if (writes !== undefined) {
      for (const draft of events) {
        writes.events.push({
          organization_id: context.organizationId,
          ml_account_id: context.mlAccountId,
          occurred_at: draft.occurredAt.toISOString(),
          event_type: draft.eventType,
          entity_type: draft.entityType,
          entity_id: draft.entityId,
          before: asJson(draft.before ?? null),
          after: asJson(draft.after ?? null),
          severity: draft.severity,
          source: draft.source,
          dedup_key: draft.dedupKey,
        });
      }
    } else {
      await recordDomainEvents(db, context, events, logger);
    }
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
  if (writes !== undefined) {
    writes.items.push(...items);
    writes.tails.push({ orderId: order.id, fromPosition: items.length });
  } else {
    assertWritten(
      await db.from("order_items").upsert(items, { onConflict: "order_id,position" }),
      `order_items.upsert (order ${String(order.id)})`,
    );
  }

  // A cauda: posicoes que existiam numa versao anterior mais longa e nao
  // existem mais. Roda DEPOIS da gravacao, entao nao ha instante em que o
  // pedido esteja sem os itens atuais. Em lote, a cauda ja foi registrada
  // junto com os itens, acima.
  if (writes === undefined) {
    assertWritten(
      await db.from("order_items").delete().eq("order_id", order.id).gte("position", items.length),
      `order_items.delete da cauda (order ${String(order.id)})`,
    );
  }

  // D-351: os itens de deducao saem ANTES da bifurcacao venda/cancelamento. O
  // cancelamento tambem precisa deles: a venda anterior ao corte que a V3 nunca
  // gravou e reposta a partir dos vinculos de hoje (`computeCancellationMovements`).
  //
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

  if (isCancelledOrderStatus(order.status)) {
    // Sem `date_last_updated` nem `last_updated`, `lastUpdatedAt` e a CRIACAO
    // do pedido, nao o cancelamento: a regra do corte nao se aplica (D-351).
    const occurredAtKnown = order.date_last_updated != null || order.last_updated != null;

    // D-351: a transicao de venda para cancelado. Vista agora (o status
    // anterior no banco era de venda) ou gravada antes em `domain_events` -- o
    // retry de uma pagina que gravou o pedido e falhou nos movimentos so a acha
    // ali (`lerTransicoesDeVenda`).
    const transicao: ObservedSaleTransition | null =
      previousStatus !== null && isValidSaleStatus(previousStatus)
        ? { saleStatus: previousStatus, cancelledAt: occurredAtKnown ? new Date(lastUpdatedAt) : null }
        : transicaoGravada;

    const { sales, estornos, reversals, alreadyReversed } = computeCancellationMovements({
      order: {
        id: order.id,
        status: order.status,
        dateCreated: new Date(order.date_created),
        dateClosed: order.date_closed != null ? new Date(order.date_closed) : null,
        items: deductionItems,
      },
      occurredAt: new Date(lastUpdatedAt),
      occurredAtKnown,
      transition: transicao,
      recordedSales: gravados.sales,
      estornadas: gravados.estornadas,
      reversals: gravados.reversals,
      cutoffFor: corteDe(cortes, order.id),
    });

    const puladas = gravados.sales.length + sales.length - reversals.length - alreadyReversed.length;

    if (puladas > 0) {
      logger.info("cancellation_reversal_pulada_pre_captura", { order_id: order.id, vendas_puladas: puladas });
    }

    if (alreadyReversed.length > 0) {
      // Verificacao de e6fda07, ALTA-1: a devolucao entregue ja devolveu a
      // unidade. A segunda reversao nao grava -- mas fica registrada.
      logger.info("cancellation_reversal_ja_revertida", { order_id: order.id, vendas: alreadyReversed.length });
    }

    if (!occurredAtKnown && gravados.estornadas.size > 0) {
      logger.warn("cancellation_reversal_sem_instante_do_cancelamento", {
        order_id: order.id,
        vendas_estornadas: gravados.estornadas.size,
      });
    }

    const origem = { type: "ORDER", id: String(order.id) };

    // A ORDEM importa no webhook, que grava linha a linha: venda, estorno,
    // cancelamento. Se o estorno ou o cancelamento falhar, o retry acha a venda
    // gravada e completa o resto pela mesma regra, sem depender da transicao.
    if (sales.length > 0) {
      // Revisao de D-351, ALTA-2: venda anterior ao corte que a V3 nunca gravou
      // e que cancelou depois dele -- a unidade volta ao estoque.
      logger.info("cancellation_repoe_venda_anterior_ao_corte", { order_id: order.id, vendas: sales.length });

      if (writes === undefined) {
        await gravaNumComando(db, context, sales, "VENDA_ML", origem);
      } else {
        await gravaMovimentos(db, context, writes, sales, "VENDA_ML", origem);
      }
    }

    if (estornos.length > 0) {
      await gravaMovimentos(db, context, writes, estornos, "ESTORNO_PRE_CAPTURA", origem);
      contaEstornos(writes, logger, order.id, estornos.length);
    }

    if (reversals.length > 0) {
      await gravaMovimentos(db, context, writes, reversals, "CANCELAMENTO_ML", origem);
    }

    return;
  }

  const vendasGravadas = new Map(gravados.sales.map((venda) => [venda.idempotencyKey, venda]));

  // D-351: `occurred_at` da venda e a "venda em" (`date_closed ?? date_created`),
  // nao `lastUpdatedAt`. Com a data da atualizacao, um pedido antigo atualizado
  // depois da planilha caia DEPOIS do corte e entrava no alvo da reconciliacao.
  const { deductions, preCaptureReversals } = computeSaleDeductions(
    {
      id: order.id,
      status: order.status,
      dateCreated: new Date(order.date_created),
      dateClosed: order.date_closed != null ? new Date(order.date_closed) : null,
      items: deductionItems,
    },
    {
      cutoffFor: corteDe(cortes, order.id),
      recordedSale: (key) => vendasGravadas.get(key),
      recordedReversals: gravados.reversals,
    },
  );

  if (deductions.length > 0) {
    await gravaMovimentos(db, context, writes, deductions, "VENDA_ML", {
      type: "ORDER",
      id: String(order.id),
    });
  }

  if (preCaptureReversals.length > 0) {
    // No lote o par sai no MESMO upsert (`page-writes.ts`). No webhook sai linha
    // a linha, a venda antes: se o estorno falhar, o job lanca, o retry
    // descarta a venda pela chave e grava o estorno.
    await gravaMovimentos(db, context, writes, preCaptureReversals, "ESTORNO_PRE_CAPTURA", {
      type: "ORDER",
      id: String(order.id),
    });

    contaEstornos(writes, logger, order.id, preCaptureReversals.length);
  }
}

/**
 * Em lote, conta os estornos na pagina para o log sair UMA vez por pagina
 * (`fetchOrdersWindow`); no webhook, registra na hora. Venda e cancelamento
 * contam no mesmo lugar.
 */
function contaEstornos(writes: PageWrites | undefined, logger: Logger, orderId: number, estornos: number): void {
  if (writes !== undefined) {
    writes.estornosPreCaptura.pedidos += 1;
    writes.estornosPreCaptura.movimentos += estornos;

    return;
  }

  logger.info("sale_deduction_estornada_pre_captura", { order_id: orderId, estornos });
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
