import { SKU_LINK_WITH_KIND_SELECT } from "@sb/db";
import type { AdminClient, Json, SkuLinkWithKindRow } from "@sb/db";
import {
  computeCancellationMovements,
  computeSaleDeductions,
  detectOrderStatusEvents,
  estornadoKeyOf,
  isCancelledOrderStatus,
  isFullLogistic,
  isValidSaleStatus,
  revertedSaleKeyOf,
  saleInstant,
} from "@sb/domain";
import type {
  CancellationMovements,
  ErpCutoff,
  ObservedSaleTransition,
  OrderLogisticType,
  RecordedSale,
  RecordedSaleMovement,
  SaleDeductionItem,
  StockMovementDraft,
  TimedRecordedReversal,
} from "@sb/domain";
import type { Logger } from "@sb/observability";

import { assertWritten, CriticalWriteError } from "./assert-written.js";
import { asJson, recordDomainEvents } from "./domain-events.js";
import type { PageWrites } from "./page-writes.js";
import type { ParsedOrder } from "./order-schema.js";
import type { ShipmentLogistics } from "./shipment-logistics.js";
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
 * com o par `ESTORNO_PRE_CAPTURA` quando a "venda em" é anterior ou igual à
 * exportação da planilha do SKU (`exported_at`; o corte do alvo é `captured_at`,
 * reverificação de c48fb70) (`@sb/domain/inventory`, `computeSaleDeductions`). O corte vem de
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
 * **Reverificação de cc90baa (D-351 §12).** O estorno é a venda inteira, e a
 * reversão a mais do legado (cancelamento E devolução da mesma venda) sai como
 * `ESTORNO_REVERSAO_EXCEDENTE`, com o `occurred_at` da reversão: por isso as
 * reversões gravadas são lidas com o instante delas, e a leitura sem ele LANÇA.
 *
 * **D-352 — a venda entregue pelo Full.** O pedido não diz de onde a venda
 * sai: `GET /orders/{id}` traz `shipping: { id }` e nada mais, e nenhuma das 21
 * `tags` do histórico diz Full. Quem responde é
 * `GET /shipments/{id}.logistic_type`, lido aqui UMA vez por pedido e só para
 * quem vai deduzir de fato (`precisaDoSinalDaLogistica`), gravado cru em
 * `orders.logistic_type` com o instante em `logistic_captured_at`. Falha na
 * leitura não derruba o job: o pedido baixa a loja e fica PENDENTE do sinal.
 * `fulfillment` sai com o par `ESTORNO_FULL`; o cancelamento e a devolução de
 * pedido do Full não revertem nada em LOCAL, só completam o par que faltar. A
 * decisão é função do campo PERSISTIDO, e releitura divergente vira log.
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
   * (`ESTORNO_PRE_CAPTURA` e, desde D-352, `ESTORNO_FULL`), nunca pelo prefixo
   * da chave: a chave e neutra (`estorno:<chave do movimento>`) e so diz QUAL
   * movimento foi estornado -- nao por que. Os dois tipos respondem a MESMA
   * pergunta aqui: "esta venda ja foi anulada?".
   */
  estornadas: Set<string>;
  /**
   * `CANCELAMENTO_ML` e `DEVOLUCAO_ML` gravados das vendas do pedido: o limite de
   * cada reversão — a unidade volta ao estoque no máximo uma vez (verificação de
   * e6fda07, ALTA-1) —, com o instante de cada uma, que a anulação da reversão a
   * mais espelha (D-351 §12).
   */
  reversals: TimedRecordedReversal[];
}

/**
 * O que o pedido ja tem gravado de logistica (D-352).
 *
 * As duas colunas juntas distinguem os dois nulos: `capturedAt` NULO e "o envio
 * nunca foi lido" (pendente); `capturedAt` preenchido com `logisticType` nulo e
 * "foi lido e nao disse" -- resposta, nao pendencia.
 */
export interface PersistedLogistic {
  readonly logisticType: OrderLogisticType;
  /** `orders.logistic_captured_at`, como o banco o devolve. */
  readonly capturedAt: string | null;
}

/** Pedido que a V3 ainda nao viu: nada gravado, nada lido. */
const SEM_LOGISTICA: PersistedLogistic = { logisticType: null, capturedAt: null };

export interface OrderPrefetch {
  /** `String(order.id)` -> status gravado. Ausente = pedido novo para a V3. */
  previousStatusById: Map<string, string>;
  /**
   * `String(order.id)` -> a logistica ja gravada (D-352). Ausente = pedido novo,
   * e o sinal ainda nao foi lido.
   */
  logisticByOrderId: Map<string, PersistedLogistic>;
  /** `chaveDoItem(item_id, variation_id)` -> vinculo vigente. Ausente = sem vinculo. */
  linkByItemKey: Map<string, ResolvedLink>;
  /**
   * D-362: `user_product_id` -> o vínculo `USER_PRODUCT` da conta. A segunda
   * tentativa: só vale para o item sem vínculo por anúncio.
   */
  linkByUserProduct: Map<string, ResolvedLink>;
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
        // D-352: `ESTORNO_FULL` entra na mesma lista. Uma venda do Full ja
        // estornada que nao fosse lida aqui pareceria sem par, e o proximo
        // processamento gravaria um segundo estorno -- absorvido pelo UNIQUE,
        // mas contado como movimento novo nos logs e nas contagens.
        .in("movement_type", ["VENDA_ML", "ESTORNO_PRE_CAPTURA", "ESTORNO_FULL", "CANCELAMENTO_ML"]),
    ),
  );

  for (const resultado of resultados) {
    // Não tratar como "nenhum movimento": numa order cancelada, isso faria
    // computeCancellationReversals reverter zero — a dedução original da
    // venda ficaria de pé, estoque silenciosamente incorreto.
    for (const row of linhasDe(resultado, "stock_movements")) {
      const pedido = String(row.source_id);
      const gravados = porPedido.get(pedido) ?? nadaGravado();

      if (row.movement_type === "ESTORNO_PRE_CAPTURA" || row.movement_type === "ESTORNO_FULL") {
        // O TIPO diz que a linha e estorno; a chave neutra diz de qual
        // movimento. Chave fora do formato LANCA (`estornadoKeyOf`). As duas
        // causas contam igual: a venda ja esta anulada (D-352).
        gravados.estornadas.add(estornadoKeyOf(row.idempotency_key));
      } else if (row.movement_type === "CANCELAMENTO_ML") {
        gravados.reversals.push(reversaoGravada(row.idempotency_key, row.qty_delta, row.occurred_at));
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
 *
 * O instante tambem e conferido (D-351 §12): sem `occurred_at` (a RPC das
 * devolucoes na forma de cc90baa) ou com data ilegivel, LANCA. `new Date(undefined)`
 * e Invalid Date, e a reversao a mais seria escolhida por uma comparacao com NaN --
 * a anulacao sairia com a chave ou o lado do corte errados, em silencio.
 */
function reversaoGravada(idempotencyKey: string, quantity: number, occurredAt: unknown): TimedRecordedReversal {
  revertedSaleKeyOf(idempotencyKey);

  if (typeof occurredAt !== "string" || Number.isNaN(new Date(occurredAt).getTime())) {
    throw new Error(
      `reversao gravada ${idempotencyKey} sem occurred_at legivel ("${String(occurredAt)}") — sem ele a anulacao da reversao a mais nao sabe de que lado do corte cair (D-351)`,
    );
  }

  return { idempotencyKey, quantity, occurredAt: new Date(occurredAt) };
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
): Promise<Map<string, TimedRecordedReversal[]>> {
  const porPedido = new Map<string, TimedRecordedReversal[]>();

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
        reversaoGravada(row.idempotency_key, row.qty_delta, row.occurred_at),
      ]);
    }
  }

  return porPedido;
}

/** Junta as devolucoes aos movimentos gravados de cada pedido. */
function juntaDevolucoes(
  gravados: Map<string, RecordedOrderMovements>,
  devolucoes: Map<string, TimedRecordedReversal[]>,
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
 * alinhado ao corte. E sem `exported_at` (a RPC na forma de c48fb70) tambem:
 * sem ele, a venda entre a exportacao e o parse de um snapshot que ainda carrega
 * o parse pareceria estar na planilha.
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
        // Sem cair em `captured_at`: no snapshot que ainda carrega o parse, "a planilha
        // tem a venda" seria decidido pelo corte do alvo, e a venda entre a exportacao e
        // o parse seria estornada (reverificacao de c48fb70, MEDIA-1).
        exportedAt: instanteDoCorte(row.exported_at, "exported_at", row.sku_id),
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
  const skus = new Set(skusDaVenda([...links]));

  for (const pedido of gravados) {
    for (const venda of pedido.sales) skus.add(venda.skuId);
  }

  return [...skus];
}

/** Os SKUs que a venda deste pedido baixaria de fato, com o KIT ja decomposto (D-352). */
function skusDaVenda(links: readonly (ResolvedLink | null)[]): string[] {
  const skus = new Set<string>();

  for (const link of links) {
    if (link === null) continue;

    if (link.kind === "KIT") {
      for (const component of link.components) skus.add(component.componentSkuId);
    } else {
      skus.add(link.sku_id);
    }
  }

  return [...skus];
}

/**
 * A VENDA precisa que a V3 leia o ENVIO? (D-352.) O cancelamento tem pergunta
 * propria — `cancelamentoPrecisaDoSinal`.
 *
 * A chamada e barata por pedido e cara na soma (~963 pedidos/dia), entao ela so
 * acontece para o pedido cuja venda vai DE FATO baixar a loja. Quatro perguntas,
 * todas baratas e locais:
 *
 *  1. o status vende? cancelado, `payment_in_process` e `invalid` nao deduzem;
 *  2. ha `shipping_id`? e a unica chave da leitura. Em producao, 100% dos
 *     28.902 pedidos pagos de 30 dias tem;
 *  3. algum item tem vinculo? sem SKU nao ha movimento;
 *  4. a venda cai DEPOIS da exportacao da planilha de algum SKU deduzido? venda
 *     ate o corte ja sai com `ESTORNO_PRE_CAPTURA` (D-351): o par soma zero, e
 *     saber a logistica nao mudaria uma linha. E o filtro que derruba a maior
 *     parte do volume na carga da historia.
 *
 * **"Ja decidido" NAO e pergunta daqui**, e a ausencia e deliberada: o
 * congelamento da R5 tem dono unico, o `if (gravada.capturedAt !== null)` de
 * `resolveLogistica`, que devolve o valor gravado antes de chegar neste gate.
 * Repetir a checagem aqui parecia defesa em profundidade e era linha MORTA —
 * nenhum teste conseguia alcanca-la, porque nenhuma execucao consegue. Um
 * segundo dono do mesmo invariante e pior que nenhum: os dois podem divergir, e
 * o que o teste mede nao e o que decide.
 *
 * Corte NAO LIDO (`undefined`) conta como "precisa": uma chamada a mais nunca
 * estraga o saldo, e `corteDe` ja LANCA onde a ausencia importaria.
 */
function vendaPrecisaDoSinal(
  order: ParsedOrder,
  links: readonly (ResolvedLink | null)[],
  cortes: Map<string, ErpCutoff | null>,
): boolean {
  if (!isValidSaleStatus(order.status)) return false;
  if (order.shipping?.id == null) return false;

  const skus = skusDaVenda(links);

  if (skus.length === 0) return false;

  const vendaEm = saleInstant({
    dateClosed: order.date_closed != null ? new Date(order.date_closed) : null,
    dateCreated: new Date(order.date_created),
  });

  return skus.some((skuId) => {
    const corte = cortes.get(skuId);

    return corte === undefined || corte === null || vendaEm.getTime() > corte.exportedAt.getTime();
  });
}

/**
 * O CANCELAMENTO precisa que a V3 leia o ENVIO? (D-352, R3 — revisao de 6965b0e, ALTA.)
 *
 * Precisa quando ele vai REVERTER de fato: gravar `CANCELAMENTO_ML`, sozinho ou
 * no trio da D-351 (venda + estorno + cancelamento — o trio sempre leva o
 * cancelamento, entao a mesma pergunta o cobre). E exatamente a linha que, num
 * pedido do Full, devolveria a loja uma unidade que ela nunca perdeu. Antes o unico gate
 * era o da venda ("vai deduzir?"), e o pedido cancelado nunca lia o envio: a
 * venda do Full estornada pela D-351 e cancelada depois do corte voltava +1 a
 * loja.
 *
 * A pergunta e feita ao PROPRIO plano do cancelamento, calculado com a logistica
 * gravada (nula aqui): nenhuma regra paralela que possa divergir dele. O
 * cancelamento que so completa o par, ou que nao grava nada, nao gasta a chamada.
 * Se a leitura falhar, o cancelamento reverte como hoje e o pedido fica pendente:
 * a varredura (`sync-order-logistics.ts`) le o envio depois e anula a reversao.
 */
function cancelamentoPrecisaDoSinal(order: ParsedOrder, plano: CancellationMovements): boolean {
  if (order.shipping?.id == null) return false;

  return plano.reversals.length > 0;
}

/**
 * Os itens de deducao do pedido, com o KIT ja decomposto — funcao pura dos
 * vinculos resolvidos no topo do handler.
 *
 * Saem ANTES da gravacao do pedido desde a revisao de 6965b0e: o plano do
 * cancelamento precisa deles para decidir se vale ler o envio, e o envio e lido
 * antes do upsert de `orders` (a logistica e coluna dele). Item sem vinculo
 * continua com `skuKind: null`: a forma `skuKind: "PRODUTO"` com `skuId: null` e
 * um estado que o contrato de `SaleDeductionItem` declara impossivel.
 */
/** A forma de `sku_listing_links.user_product_id` e de `order_items.user_product_id`. */
const FORMA_USER_PRODUCT = /^MLBU[0-9]+$/;

/**
 * D-362: o user product que o pedido traz no item, se tiver a forma que a
 * coluna aceita. Outra forma vira NULL -- o pedido grava do mesmo jeito.
 */
function userProductDoItem(valor: string | null | undefined): string | null {
  const up = valor ?? null;

  return up !== null && FORMA_USER_PRODUCT.test(up) ? up : null;
}

function itensDeDeducao(order: ParsedOrder, resolvedLinks: readonly (ResolvedLink | null)[]): SaleDeductionItem[] {
  return order.order_items.map((item, position) => {
    const resolved = resolvedLinks[position] ?? null;

    if (resolved === null) {
      return { position, quantity: item.quantity, skuId: null, skuKind: null, components: [] };
    }

    // D-188: `kind` e componentes chegam junto com o vinculo, nos DOIS caminhos —
    // o lote da janela e o embed do webhook. Nao ha leitura aqui dentro.
    return {
      position,
      quantity: item.quantity,
      skuId: resolved.sku_id,
      skuKind: resolved.kind,
      components: resolved.components,
    };
  });
}

/**
 * A logistica deste pedido (D-352): a que ja esta gravada, ou a capturada agora.
 *
 * **A decisao e funcao pura do campo PERSISTIDO** (R5). Com
 * `logistic_captured_at` preenchido, nada aqui muda o valor: uma releitura que
 * discorda vira LOG. O ledger e append-only — o par ja foi gravado com uma
 * resposta, e trocar a resposta depois deixaria o saldo com a metade de dois
 * desenhos diferentes.
 *
 * Quando o sinal ainda nao foi capturado, ele vem de duas fontes, nesta ordem:
 * o PROPRIO pedido (`shipping.logistic_type`, que hoje nao vem — se um dia
 * vier, e um `GET /shipments` a menos por venda) e a leitura do envio.
 *
 * Sem `logistics`, nada e capturado: o chamador que nao tem cliente do Mercado
 * Livre na mao (um teste, um caminho futuro) deixa o pedido pendente em vez de
 * carimbar uma captura que nao houve.
 */
async function resolveLogistica(
  order: ParsedOrder,
  gravada: PersistedLogistic,
  /** O gate: a venda que vai deduzir, ou o cancelamento que vai reverter. */
  precisaDoSinal: () => boolean,
  logistics: ShipmentLogistics | undefined,
  logger: Logger,
): Promise<PersistedLogistic> {
  const doPedido = order.shipping?.logistic_type ?? null;

  if (gravada.capturedAt !== null) {
    if (doPedido !== null && doPedido !== gravada.logisticType) {
      // Nao regrava: o par ja foi decidido com o valor gravado.
      logger.warn("order_logistic_divergente", {
        order_id: order.id,
        gravado: gravada.logisticType,
        lido: doPedido,
      });
    }

    return gravada;
  }

  if (logistics === undefined) {
    return gravada;
  }

  if (doPedido !== null) {
    return { logisticType: doPedido, capturedAt: logistics.now().toISOString() };
  }

  if (!precisaDoSinal()) {
    return gravada;
  }

  // `order.shipping.id` e nao-nulo aqui: o gate exige.
  const capturada = await logistics.read(order.shipping?.id ?? 0, order.id);

  // Falha na leitura: o pedido fica PENDENTE (as duas colunas nulas) e baixa a
  // loja agora. Nunca presumir Full (R2).
  return capturada === null
    ? gravada
    : { logisticType: capturada.logisticType, capturedAt: capturada.capturedAt.toISOString() };
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
  const logisticByOrderId = new Map<string, PersistedLogistic>();
  const linkByItemKey = new Map<string, ResolvedLink>();
  const linkByUserProduct = new Map<string, ResolvedLink>();

  if (orders.length === 0) {
    return {
      previousStatusById,
      logisticByOrderId,
      linkByItemKey,
      linkByUserProduct,
      recordedByOrderId: new Map(),
      cutoffBySku: new Map(),
      saleTransitionByOrderId: new Map(),
    };
  }

  const orderIds = orders.map((order) => order.id);
  const itemIds = [...new Set(orders.flatMap((order) => order.order_items.map((item) => item.item.id)))];
  // D-362: os user products que os pedidos da página trazem. Página sem
  // nenhum (pedidos anteriores à captura) não paga a leitura.
  const userProducts = [
    ...new Set(
      orders.flatMap((order) =>
        order.order_items.flatMap((item) => {
          const up = userProductDoItem(item.item.user_product_id);

          return up === null ? [] : [up];
        }),
      ),
    ),
  ];

  // 1 + N idas, com N = lotes de item. As quatro primeiras nao dependem umas
  // das outras.
  const [statusResult, linkResults, userProductResults, recordedByOrderId, saleTransitionByOrderId] = await Promise.all([
    // D-352: a logistica gravada vem na MESMA leitura do status — ela e a
    // decisao ja tomada, e releitura nunca a reescreve (R5).
    db.from("orders").select("id, status, logistic_type, logistic_captured_at").in("id", orderIds),
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
    Promise.all(
      emLotes(userProducts, ITENS_POR_CONSULTA).map((lote) =>
        db
          .from("sku_listing_links")
          .select(SKU_LINK_WITH_KIND_SELECT)
          .eq("ml_account_id", context.mlAccountId)
          .eq("ref_kind", "USER_PRODUCT")
          .in("user_product_id", lote),
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
    logisticByOrderId.set(String(row.id), {
      logisticType: row.logistic_type,
      capturedAt: row.logistic_captured_at,
    });
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

  for (const linkResult of userProductResults) {
    // A mesma regra: falha de leitura LANÇA, nunca vira "sem vínculo".
    for (const row of linhasDe(linkResult, "sku_listing_links") as unknown as SkuLinkWithKindRow[]) {
      // `sku_listing_links_ref_shape` garante o user product no `USER_PRODUCT`.
      if (row.user_product_id === null) {
        continue;
      }

      linkByUserProduct.set(row.user_product_id, linkResolvido(row));
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
    readErpCutoffs(
      db,
      context.organizationId,
      skusComCorte([...linkByItemKey.values(), ...linkByUserProduct.values()], recordedByOrderId.values()),
    ),
    lerDevolucoes(db, context.organizationId, pedidosComVenda(recordedByOrderId)),
  ]);

  juntaDevolucoes(recordedByOrderId, devolucoes);

  return {
    previousStatusById,
    logisticByOrderId,
    linkByItemKey,
    linkByUserProduct,
    recordedByOrderId,
    cutoffBySku,
    saleTransitionByOrderId,
  };
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
  /**
   * A captura da logistica do envio (D-352). Ausente, nada e capturado e o
   * pedido decide pelo que ja esta gravado — o caminho conservador para um
   * chamador sem cliente do Mercado Livre na mao.
   */
  logistics?: ShipmentLogistics,
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
  let logisticaGravada: PersistedLogistic;
  let resolvedLinks: (ResolvedLink | null)[];
  let gravados: RecordedOrderMovements;
  let cortes: Map<string, ErpCutoff | null>;
  let transicaoGravada: ObservedSaleTransition | null;

  if (prefetch !== undefined) {
    // Chave STRING para um `id` que e `bigint` no banco: ver o comentario de
    // `OrderPrefetch`. Ausente do mapa = pedido novo para a V3, exatamente o
    // que o `maybeSingle()` sem linha significa.
    previousStatus = prefetch.previousStatusById.get(String(order.id)) ?? null;
    logisticaGravada = prefetch.logisticByOrderId.get(String(order.id)) ?? SEM_LOGISTICA;
    // D-362: o vínculo por anúncio vence; sem ele, o do user product do pedido.
    resolvedLinks = order.order_items.map((item, index) => {
      const porAnuncio = prefetch.linkByItemKey.get(chaveDoItem(item.item.id, variationIds[index] ?? null));
      const up = userProductDoItem(item.item.user_product_id);

      return porAnuncio ?? (up === null ? null : (prefetch.linkByUserProduct.get(up) ?? null));
    });
    gravados = prefetch.recordedByOrderId.get(String(order.id)) ?? nadaGravado();
    cortes = prefetch.cutoffBySku;
    transicaoGravada = prefetch.saleTransitionByOrderId.get(String(order.id)) ?? null;
  } else {
    const [existing, links, recorded, transicoes] = await Promise.all([
      // D-352: a logistica gravada na mesma leitura do status.
      db.from("orders").select("status, logistic_type, logistic_captured_at").eq("id", order.id).maybeSingle(),
      Promise.all(
        order.order_items.map((item, index) =>
          resolveSku(
            db,
            context.mlAccountId,
            item.item.id,
            variationIds[index] ?? null,
            userProductDoItem(item.item.user_product_id),
          ),
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
    logisticaGravada =
      existing.data === null
        ? SEM_LOGISTICA
        : { logisticType: existing.data.logistic_type, capturedAt: existing.data.logistic_captured_at };
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

  // D-351: os itens de deducao, a transicao e o plano do cancelamento saem ANTES
  // do sinal da logistica — o cancelamento pergunta ao proprio plano se vale ler
  // o envio (`cancelamentoPrecisaDoSinal`). Tudo puro: nenhuma leitura aqui.
  const deductionItems = itensDeDeducao(order, resolvedLinks);
  const cancelado = isCancelledOrderStatus(order.status);
  // Sem `date_last_updated` nem `last_updated`, `lastUpdatedAt` e a CRIACAO
  // do pedido, nao o cancelamento: a regra do corte nao se aplica (D-351).
  const occurredAtKnown = order.date_last_updated != null || order.last_updated != null;

  // D-351: a transicao de venda para cancelado. Vista agora (o status anterior no
  // banco era de venda) ou gravada antes em `domain_events` -- o retry de uma
  // pagina que gravou o pedido e falhou nos movimentos so a acha ali
  // (`lerTransicoesDeVenda`).
  const transicao: ObservedSaleTransition | null =
    previousStatus !== null && isValidSaleStatus(previousStatus)
      ? { saleStatus: previousStatus, cancelledAt: occurredAtKnown ? new Date(lastUpdatedAt) : null }
      : transicaoGravada;

  const planoDoCancelamento = (logisticType: OrderLogisticType): CancellationMovements =>
    computeCancellationMovements({
      order: {
        id: order.id,
        status: order.status,
        dateCreated: new Date(order.date_created),
        dateClosed: order.date_closed != null ? new Date(order.date_closed) : null,
        // D-352: pedido do Full nao reverte nada em LOCAL -- so completa o par
        // da venda gravada.
        logisticType,
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

  // D-352 — o sinal da logistica, ANTES da gravacao do pedido: ele e coluna de
  // `orders`, e e ele que decide se a venda abaixo sai com o par `ESTORNO_FULL`
  // e se o cancelamento reverte em LOCAL. Roda depois das leituras (precisa dos
  // vinculos e do corte para decidir se vale a chamada) e antes de qualquer
  // escrita, como tudo neste handler.
  const logistica = await resolveLogistica(
    order,
    logisticaGravada,
    () =>
      cancelado
        ? cancelamentoPrecisaDoSinal(order, planoDoCancelamento(logisticaGravada.logisticType))
        : vendaPrecisaDoSinal(order, resolvedLinks, cortes),
    logistics,
    logger,
  );

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
    // D-352: o valor JA RESOLVIDO, que inclui o gravado. O upsert e
    // `DO UPDATE`: mandar o valor do pedido cru apagaria com NULL a captura de
    // uma execucao anterior a cada reprocessamento (R5).
    logistic_type: logistica.logisticType,
    logistic_captured_at: logistica.capturedAt,
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
      user_product_id: userProductDoItem(item.item.user_product_id),
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

  if (cancelado) {
    // O MESMO plano que decidiu se valia ler o envio, agora com a logistica
    // resolvida: `fulfillment` nao reverte nada em LOCAL (D-352, R3).
    const { sales, estornos, estornosFull, excessReversalEstornos, reversals, alreadyReversed } =
      planoDoCancelamento(logistica.logisticType);

    const doFull = isFullLogistic(logistica.logisticType);
    const puladas = gravados.sales.length + sales.length - reversals.length - alreadyReversed.length;

    if (puladas > 0) {
      // D-352: no Full a razao de pular e OUTRA -- a unidade nunca saiu da loja
      // --, e dar a ela o nome da pre-captura mentiria no log exatamente onde
      // alguem vai investigar por que o saldo nao subiu.
      logger.info(
        doFull ? "cancellation_reversal_pulada_full" : "cancellation_reversal_pulada_pre_captura",
        { order_id: order.id, vendas_puladas: puladas },
      );
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

    // A ORDEM importa no webhook, que grava linha a linha: venda, estorno, anulacao
    // da reversao a mais, cancelamento. Se o estorno ou o cancelamento falhar, o
    // retry acha a venda gravada e completa o resto pela mesma regra, sem depender
    // da transicao; se a anulacao falhar, o retry acha a venda estornada e a grava
    // de novo (`computeCancellationMovements`).
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

    if (estornosFull.length > 0) {
      // D-352: o par que faltava a venda gravada de um pedido do Full. Vem antes
      // da anulacao pelo mesmo motivo do estorno da pre-captura: se a anulacao
      // falhar, o retry acha a venda estornada e a grava de novo.
      await gravaMovimentos(db, context, writes, estornosFull, "ESTORNO_FULL", origem);
      contaEstornosFull(writes, logger, order.id, estornosFull.length);
    }

    await gravaAnulacoes(db, context, writes, logger, order.id, excessReversalEstornos);

    if (reversals.length > 0) {
      await gravaMovimentos(db, context, writes, reversals, "CANCELAMENTO_ML", origem);
    }

    return;
  }

  const vendasGravadas = new Map(gravados.sales.map((venda) => [venda.idempotencyKey, venda]));

  // D-351: `occurred_at` da venda e a "venda em" (`date_closed ?? date_created`),
  // nao `lastUpdatedAt`. Com a data da atualizacao, um pedido antigo atualizado
  // depois da planilha caia DEPOIS do corte e entrava no alvo da reconciliacao.
  const { deductions, preCaptureReversals, estornosFull, excessReversalEstornos } = computeSaleDeductions(
    {
      id: order.id,
      status: order.status,
      dateCreated: new Date(order.date_created),
      dateClosed: order.date_closed != null ? new Date(order.date_closed) : null,
      // D-352: `fulfillment` sai com o par `ESTORNO_FULL`; qualquer outro valor,
      // e a ausencia do sinal, baixam a loja como sempre.
      logisticType: logistica.logisticType,
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

  if (estornosFull.length > 0) {
    // D-352 — o par da venda entregue pelo Full. No lote sai no MESMO upsert da
    // venda (`page-writes.ts`); no webhook, linha a linha, a venda antes: se o
    // estorno falhar, o job lanca e o retry o grava (a venda ja gravada e
    // descartada pela chave). Nunca sai junto com o `ESTORNO_PRE_CAPTURA` da
    // mesma venda — os dois dividem a chave, e o dominio deixa so um passar.
    await gravaMovimentos(db, context, writes, estornosFull, "ESTORNO_FULL", {
      type: "ORDER",
      id: String(order.id),
    });

    contaEstornosFull(writes, logger, order.id, estornosFull.length);
  }

  // Depois do estorno: no webhook, a anulacao que falhar sai de novo no retry, que
  // recalcula o estorno da mesma venda.
  await gravaAnulacoes(db, context, writes, logger, order.id, excessReversalEstornos);
}

/**
 * A anulacao da reversao a mais do legado (D-351 §12): `ESTORNO_REVERSAO_EXCEDENTE`,
 * com a origem do pedido -- a da venda estornada, como o estorno -- e a chave
 * `estorno:<chave da reversao>`. Rara (20 vendas em producao em 2026-09-16), entao
 * o log sai por pedido tambem no lote.
 */
async function gravaAnulacoes(
  db: AdminClient,
  context: PersistOrderContext,
  writes: PageWrites | undefined,
  logger: Logger,
  orderId: number,
  anulacoes: readonly StockMovementDraft[],
): Promise<void> {
  if (anulacoes.length === 0) {
    return;
  }

  await gravaMovimentos(db, context, writes, anulacoes, "ESTORNO_REVERSAO_EXCEDENTE", {
    type: "ORDER",
    id: String(orderId),
  });

  logger.info("sale_deduction_reversao_excedente_anulada", { order_id: orderId, anulacoes: anulacoes.length });
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
 * O mesmo para o `ESTORNO_FULL` (D-352), num contador PROPRIO.
 *
 * Somar os dois apagaria a unica medida do efeito desta fatia: quantas vendas
 * pararam de baixar a loja porque saem do Full, separadas das que ja nao
 * baixavam por serem anteriores a planilha. As duas causas somem juntas na
 * contagem, e e exatamente elas que precisam ser comparadas.
 */
function contaEstornosFull(writes: PageWrites | undefined, logger: Logger, orderId: number, estornos: number): void {
  if (writes !== undefined) {
    writes.estornosFull.pedidos += 1;
    writes.estornosFull.movimentos += estornos;

    return;
  }

  logger.info("sale_deduction_estornada_full", { order_id: orderId, estornos });
}

/**
 * Resolve `sku_id` pelo vínculo vigente (D-020) — congelado na linha do
 * item, nunca recalculado por join na leitura. Mesma forma de índice parcial
 * de `sku_listing_links` (`docs/DATABASE.md` secao 4): `variation_id` nulo
 * precisa de `.is()`, não `.eq()`.
 *
 * D-362: sem vínculo por anúncio, a segunda tentativa é o vínculo
 * `USER_PRODUCT` do user product que o pedido traz. O por anúncio vence
 * sempre -- é a decisão do dono para quando os dois divergem.
 */
async function resolveSku(
  db: AdminClient,
  mlAccountId: string,
  itemId: string,
  variationId: string | null,
  userProductId: string | null,
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

  if (row !== null) {
    return linkResolvido(row);
  }

  return userProductId === null ? null : resolvePeloUserProduct(db, mlAccountId, userProductId);
}

/**
 * D-362: o vínculo `USER_PRODUCT` da conta. O índice único
 * `sku_listing_links_user_product_unique` garante no máximo um.
 */
async function resolvePeloUserProduct(
  db: AdminClient,
  mlAccountId: string,
  userProductId: string,
): Promise<ResolvedLink | null> {
  const result = await db
    .from("sku_listing_links")
    .select(SKU_LINK_WITH_KIND_SELECT)
    .eq("ml_account_id", mlAccountId)
    .eq("ref_kind", "USER_PRODUCT")
    .eq("user_product_id", userProductId)
    .maybeSingle();

  if (result.error !== null) {
    // A mesma regra do vínculo por anúncio: falha não é "sem vínculo".
    throw new Error(`falha ao resolver sku_listing_link (user product ${userProductId}): ${result.error.message}`);
  }

  const row = result.data as unknown as SkuLinkWithKindRow | null;

  return row === null ? null : linkResolvido(row);
}
