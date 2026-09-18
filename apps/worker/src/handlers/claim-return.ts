import type { AdminClient } from "@sb/db";
import {
  cancelledInSheetKeys,
  computeReturnReversal,
  computeUnreversedReturn,
  estornadoKeyOf,
  isCancelledOrderStatus,
  revertedSaleKeyOf,
} from "@sb/domain";
import type { OrderLogisticType, ReturnedSaleMovement, TimedRecordedReversal } from "@sb/domain";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import { claimReturnSchema, claimSchema } from "./claim-schema.js";
import type { ParsedClaimReturn } from "./claim-schema.js";
import { recordDomainEvents } from "./domain-events.js";
import { ingestSupportClaim } from "./ingest-support-claim.js";
import { readErpCutoffs } from "./persist-order.js";
import { recordStockMovements } from "./stock-movements.js";

/**
 * D-344 — quanto tempo depois de o claim nascer a devolução pode ainda não
 * existir em `GET /v2/claims/{id}/returns`.
 *
 * Medido em 7 dias de log (381 falhas, 147 claims): o claim já diz
 * `related_entities: ["return"]`, o endpoint de devolução responde 404, e
 * 145 dos 147 destravam sozinhos na notificação seguinte — no máximo 4,1
 * minutos depois da última falha. 143 deles falharam na PRIMEIRA notificação
 * do claim. E um 404 nesse momento não custa estoque: a reversão só acontece
 * com a devolução `delivered`, dias depois, quando o endpoint já responde.
 *
 * Sessenta minutos dão folga de uma ordem de grandeza sobre o medido. Fora
 * da janela, o 404 continua sendo falha: um claim antigo sem devolução
 * legível é anomalia de verdade, e é esse o caso que precisa ficar visível.
 */
const JANELA_DE_PROPAGACAO_DA_DEVOLUCAO_MIN = 60;

/** Idade do claim em minutos inteiros, pelo relógio do Mercado Livre; `null` sem carimbo legível. */
function idadeDoClaimEmMinutos(dateCreated: string | null | undefined, now: Date): number | null {
  if (dateCreated === null || dateCreated === undefined) {
    return null;
  }

  const criadoEm = Date.parse(dateCreated);

  if (Number.isNaN(criadoEm)) {
    return null;
  }

  // Relógios diferentes: um claim "do futuro" acabou de nascer, não é antigo.
  return Math.max(0, Math.floor((now.getTime() - criadoEm) / 60_000));
}

/**
 * Pós-venda (Claims/Returns, D-057) — chamado pelo Fast Path do webhook
 * (`webhook-received.ts`) quando `topic = post_purchase`.
 *
 * Busca o claim, confirma que há devolução física associada
 * (`related_entities` contém `"return"` — mecanismo recomendado na própria
 * documentação oficial, `docs/MERCADO_LIVRE.md` secao 2.10), busca a
 * devolução e, quando `status = "delivered"` (produto de volta fisicamente,
 * não só dinheiro), reverte o estoque do item devolvido —
 * `computeReturnReversal`, puro, em `@sb/domain/inventory`.
 *
 * Reprocessar a mesma notificação (reenvio do Mercado Livre, corrida do
 * Cloud Tasks) é seguro: tudo aqui é releitura do estado atual + chaves
 * determinísticas — nenhum estado é assumido entre chamadas.
 *
 * **D-352 — devolução de pedido entregue pelo Full não repõe a loja.** O
 * produto volta para o galpão do Mercado Livre, não para a prateleira daqui, e
 * o saldo LOCAL nunca perdeu a unidade. O sinal é `orders.logistic_type`, lido
 * junto com o pedido; a devolução de pedido `fulfillment` sai sem
 * `DEVOLUCAO_ML` e, quando a venda gravada ainda não tem par, com o
 * `ESTORNO_FULL` que falta. Este handler NÃO captura o sinal — ele só lê o que
 * `persist-order` gravou: um claim não é o momento de decidir de onde a venda
 * saiu, e a captura tem dono só.
 */

export interface ProcessClaimReturnDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
}

export interface ProcessClaimReturnContext {
  organizationId: string;
  mlAccountId: string;
}

interface OrderMovements {
  /**
   * `VENDA_ML` gravados, com o `occurred_at` de cada um (D-352): é ele que o
   * `ESTORNO_FULL` espelha, para o par cair do mesmo lado do corte do alvo.
   */
  sales: ReturnedSaleMovement[];
  /**
   * `CANCELAMENTO_ML` e `DEVOLUCAO_ML` já gravados: o limite da devolução, e —
   * num pedido do Full — o que a anulação espelha, com o instante de cada um.
   */
  reversals: TimedRecordedReversal[];
  /** Chaves de `VENDA_ML` com estorno gravado: `ESTORNO_PRE_CAPTURA` (D-351) ou `ESTORNO_FULL` (D-352). */
  estornadas: Set<string>;
}

/** O pedido devolvido, como `orders` o guarda — o que a devolução precisa saber dele. */
interface OrderRow {
  status: string;
  date_created: string;
  date_last_updated: string;
  last_updated: string | null;
  /** D-352: só `fulfillment` é Full, e aí a devolução não repõe a loja. */
  logistic_type: OrderLogisticType;
}

/**
 * As vendas do pedido e as reversões já gravadas delas.
 *
 * Verificação de e6fda07, ALTA-1: cancelamento e devolução revertem a MESMA
 * venda, e a unidade volta ao estoque no máximo uma vez. Sem ler o
 * cancelamento (origem do pedido) e as outras devoluções (origem do claim,
 * pedido dentro da chave — `get_order_return_movements`), a devolução entregue
 * de um pedido já cancelado devolveria a unidade de novo. Chave de reversão fora
 * do formato LANÇA (`revertedSaleKeyOf`).
 */
async function loadOrderMovements(db: AdminClient, organizationId: string, orderId: number): Promise<OrderMovements> {
  const result = await db
    .from("stock_movements")
    // D-352: `occurred_at` entra porque o `ESTORNO_FULL` espelha o instante da
    // venda, e a anulação, o da reversão.
    .select("sku_id, qty_delta, idempotency_key, movement_type, occurred_at")
    .eq("organization_id", organizationId)
    .eq("source_type", "ORDER")
    .eq("source_id", String(orderId))
    // `ESTORNO_PRE_CAPTURA` desde a reverificação de 60c7a6a (BAIXA-1): a venda estornada
    // cujo cancelamento a planilha já contém (`loadCancelledInSheet`).
    // `ESTORNO_FULL` desde D-352: a venda do Full já anulada não ganha um segundo par.
    .in("movement_type", ["VENDA_ML", "CANCELAMENTO_ML", "ESTORNO_PRE_CAPTURA", "ESTORNO_FULL"]);

  if (result.error !== null) {
    // Não tratar como "nenhum movimento": a devolução física reverteria
    // zero, o estoque devolvido nunca voltaria pro saldo.
    throw new Error(`falha ao ler stock_movements da order ${String(orderId)}: ${result.error.message}`);
  }

  const sales: ReturnedSaleMovement[] = [];
  const reversals: TimedRecordedReversal[] = [];
  const estornadas = new Set<string>();

  for (const row of result.data) {
    if (row.movement_type === "CANCELAMENTO_ML") {
      revertedSaleKeyOf(row.idempotency_key);
      reversals.push(reversaoGravada(row.idempotency_key, row.qty_delta, row.occurred_at, orderId));
    } else if (row.movement_type === "ESTORNO_PRE_CAPTURA" || row.movement_type === "ESTORNO_FULL") {
      // Chave fora do formato `estorno:<venda>` LANÇA: um estorno que não diz qual venda anulou.
      // As duas causas respondem a MESMA pergunta: "esta venda já foi anulada?".
      estornadas.add(estornadoKeyOf(row.idempotency_key));
    } else {
      sales.push({
        skuId: row.sku_id,
        qtyDelta: row.qty_delta,
        idempotencyKey: row.idempotency_key,
        occurredAt: instanteGravado(row.occurred_at, row.idempotency_key, orderId),
      });
    }
  }

  if (sales.length === 0) {
    // Sem venda gravada não há o que reverter, nem devolução gravada dela.
    return { sales, reversals, estornadas };
  }

  const devolucoes = await db.rpc("get_order_return_movements", {
    p_organization_id: organizationId,
    p_order_ids: [String(orderId)],
  });

  if (devolucoes.error !== null) {
    // Não tratar como "nenhuma devolução": a segunda devolução (outro claim)
    // devolveria a unidade de novo.
    throw new Error(`falha ao ler as devolucoes gravadas da order ${String(orderId)}: ${devolucoes.error.message}`);
  }

  // O tipo gerado diz que `data` nunca é nulo sem erro; o PostgREST não promete isso, e
  // "data nulo" tratado como "nenhuma devolução" devolveria a unidade de novo.
  const linhas: unknown = devolucoes.data;

  if (!Array.isArray(linhas)) {
    throw new Error(`falha ao ler as devolucoes gravadas da order ${String(orderId)}: data nulo sem erro`);
  }

  for (const row of devolucoes.data) {
    revertedSaleKeyOf(row.idempotency_key);
    reversals.push(reversaoGravada(row.idempotency_key, row.qty_delta, row.occurred_at, orderId));
  }

  return { sales, reversals, estornadas };
}

/**
 * Um instante de linha gravada, conferido (D-352).
 *
 * LANÇA para data ausente ou ilegível: `new Date(undefined)` é Invalid Date, e
 * um `ESTORNO_FULL` com `occurred_at` inválido não cairia do mesmo lado do
 * corte do alvo que a venda — o par somaria zero no saldo e NÃO no alvo, em
 * silêncio. É a mesma regra de `reversaoGravada` em `persist-order.ts`.
 */
function instanteGravado(valor: unknown, idempotencyKey: string, orderId: number): Date {
  if (typeof valor !== "string" || Number.isNaN(new Date(valor).getTime())) {
    throw new Error(
      `movimento ${idempotencyKey} da order ${String(orderId)} sem occurred_at legivel ("${String(valor)}") — sem ele o par do Full nao sabe de que lado do corte cair (D-352)`,
    );
  }

  return new Date(valor);
}

/** Uma reversão gravada com a chave e o instante conferidos. */
function reversaoGravada(
  idempotencyKey: string,
  quantity: number,
  occurredAt: unknown,
  orderId: number,
): TimedRecordedReversal {
  return { idempotencyKey, quantity, occurredAt: instanteGravado(occurredAt, idempotencyKey, orderId) };
}

/**
 * As vendas estornadas do pedido cujo cancelamento a planilha já contém
 * (reverificação de 60c7a6a, BAIXA-1).
 *
 * A venda estornada cancelada até a exportação do corte não grava
 * `CANCELAMENTO_ML` (`persist-order`): a planilha já tem a unidade de volta. Sem
 * nada gravado, a devolução entregue depois a devolveria uma segunda vez. A
 * pergunta é a mesma do cancelamento (`sheetContainsCancellation`), sobre o
 * pedido como `persist-order` o gravou: `date_last_updated` é o instante da
 * última leitura, e ele só é conhecido com `last_updated` ou com
 * `date_last_updated` diferente de `date_created` -- `persist-order` grava
 * `date_last_updated ?? last_updated ?? date_created`.
 *
 * Só lê o corte quando há venda estornada e o pedido está cancelado. Leitura que
 * falha LANÇA: "não sei" não vira "a planilha não contém".
 *
 * **O pedido chega pronto desde D-352**: a logística dele é obrigatória para
 * decidir a devolução, então a linha de `orders` passou a ser lida SEMPRE
 * (`loadOrder`), e não só quando há venda estornada.
 */
async function loadCancelledInSheet(
  db: AdminClient,
  organizationId: string,
  orderId: number,
  movements: OrderMovements,
  pedido: OrderRow,
): Promise<Set<string>> {
  const estornadas = movements.sales.filter((sale) => movements.estornadas.has(sale.idempotencyKey));

  if (estornadas.length === 0) {
    return new Set();
  }

  const { status, date_created: criadoEm, date_last_updated: atualizadoEm, last_updated: lastUpdated } = pedido;

  if (!isCancelledOrderStatus(status)) {
    return new Set();
  }

  const occurredAt = new Date(atualizadoEm);
  const occurredAtKnown = lastUpdated !== null || occurredAt.getTime() !== new Date(criadoEm).getTime();
  const cortes = await readErpCutoffs(
    db,
    organizationId,
    estornadas.map((sale) => sale.skuId),
  );

  return new Set(
    cancelledInSheetKeys({ id: orderId, status, occurredAt, occurredAtKnown }, estornadas, movements.estornadas, (skuId) => {
      const corte = cortes.get(skuId);

      if (corte === undefined) {
        throw new Error(`corte do snapshot do ERP nao lido para o SKU ${skuId} (order ${String(orderId)}) (D-351)`);
      }

      return corte;
    }),
  );
}

/**
 * A linha de `orders` do pedido devolvido (D-352).
 *
 * Lida SEMPRE, e não só quando há venda estornada: `logistic_type` decide se a
 * devolução repõe a loja, e essa pergunta vale para todo pedido. É uma ida a
 * mais por linha devolvida num caminho que processa um claim por notificação —
 * não é o laço de página de `persist-order`.
 *
 * Linha ausente LANÇA. Sem ela não dá para saber nem se a venda saiu do Full
 * nem se a planilha já contém o cancelamento, e tratar "não sei" como "não é
 * Full" reporia estoque que a loja não perdeu.
 */
async function loadOrder(db: AdminClient, organizationId: string, orderId: number): Promise<OrderRow> {
  const pedido = await db
    .from("orders")
    .select("status, date_created, date_last_updated, last_updated, logistic_type")
    .eq("organization_id", organizationId)
    .eq("id", orderId)
    .maybeSingle();

  if (pedido.error !== null) {
    throw new Error(`falha ao ler a order ${String(orderId)}: ${pedido.error.message}`);
  }

  if (pedido.data === null) {
    throw new Error(
      `order ${String(orderId)} devolvida e sem linha em orders -- sem ela nao da para saber se a venda saiu do Full (D-352) nem se a planilha ja contem o cancelamento (D-351)`,
    );
  }

  return pedido.data;
}

/** Mesma forma de `resolveSku` em `persist-order.ts`: `variation_id` nulo precisa de `.is()`, não `.eq()`. */
async function loadOrderItemPosition(
  db: AdminClient,
  orderId: number,
  itemId: string,
  variationId: string | null,
): Promise<number | null> {
  const query = db.from("order_items").select("position").eq("order_id", orderId).eq("item_id", itemId);

  const filtered = variationId === null ? query.is("variation_id", null) : query.eq("variation_id", variationId);

  const result = await filtered.maybeSingle();

  if (result.error !== null) {
    // Não tratar como "item não encontrado" (que vira `continue`, silencioso
    // por natureza): uma devolução física real ficaria sem reversão de
    // estoque por causa de uma falha transitória, indistinguível de "não
    // achou o item".
    throw new Error(
      `falha ao ler order_items (order ${String(orderId)}, item ${itemId}): ${result.error.message}`,
    );
  }

  return result.data?.position ?? null;
}

export async function processClaimReturn(
  deps: ProcessClaimReturnDeps,
  context: ProcessClaimReturnContext,
  accessToken: string,
  claimId: string,
  now: Date,
  logger: Logger,
): Promise<number> {
  const claim = await deps.mercadoLivre.request({
    method: "GET",
    path: `/post-purchase/v1/claims/${claimId}`,
    accessToken,
    schema: claimSchema,
  });

  // D-104 — a projeção de atendimento vem ANTES dos early returns abaixo, e a
  // ordem é o ponto todo: uma reclamação SEM devolução (mediação, disputa de
  // pagamento) é justamente o que a Caixa de Entrada precisa mostrar. Colocar
  // isto depois entregaria só os claims que já reverteram estoque.
  // `notifyEpoch: null` — o webhook NÃO emite evento de atendimento (D-110).
  // Ele observa o claim 1-2 segundos após nascer, cedo demais para saber se
  // vai sobreviver: 6 claims medidos se auto-resolveram em minutos, um deles
  // uma mediação encerrada em 108s. A varredura horária notifica, e só vê
  // claim que continua ABERTO — o assentamento é da API, não de um timer.
  await ingestSupportClaim(
    deps,
    { ...context, source: "WEBHOOK", notifyEpoch: null },
    accessToken,
    claimId,
    claim,
    logger,
  );

  // `related_entities` virou opcional em D-109 (a busca não o traz). Aqui o
  // claim SEMPRE vem de `GET /claims/{id}`, que o traz — mas ausência cai no
  // ramo conservador de "sem devolução associada", que é a direção segura:
  // não reverter estoque por engano.
  if (claim.resource !== "order" || !(claim.related_entities?.includes("return") ?? false)) {
    // Reclamação sem devolução física associada (mediação de pagamento,
    // disputa ainda sem devolução, etc.) — nada a fazer aqui ainda; se uma
    // devolução nascer depois, uma nova notificação (claims_actions) chega.
    return 0;
  }

  let claimReturn: ParsedClaimReturn;

  try {
    claimReturn = await deps.mercadoLivre.request({
      method: "GET",
      path: `/post-purchase/v2/claims/${claimId}/returns`,
      accessToken,
      schema: claimReturnSchema,
    });
  } catch (error) {
    if (!(error instanceof MercadoLivreApiError) || error.status !== 404) {
      throw error;
    }

    // D-344 — claim recém-nascido: o Mercado Livre anuncia a devolução antes de
    // ela existir no endpoint. Não há o que reverter ainda (a reversão exige
    // `delivered`), e a notificação seguinte do mesmo claim a encontra.
    const idadeMin = idadeDoClaimEmMinutos(claim.date_created, now);

    if (idadeMin !== null && idadeMin < JANELA_DE_PROPAGACAO_DA_DEVOLUCAO_MIN) {
      logger.info("claim_return_not_yet_available", { claim_id: claimId, claim_age_min: idadeMin });

      return 0;
    }

    // Fora da janela, ou sem carimbo: a anomalia segue como falha, agora com a
    // idade no log para a próxima investigação não precisar reconstruí-la.
    logger.warn("claim_return_missing", { claim_id: claimId, claim_age_min: idadeMin });

    throw error;
  }

  if (claimReturn.status !== "delivered") {
    // Devolução em andamento (pending/shipped/etc.) — reverter agora
    // arriscaria estornar um produto que nunca voltou fisicamente. A
    // próxima notificação de mudança de status reprocessa.
    return 0;
  }

  let processed = 0;

  for (const returnedOrder of claimReturn.orders) {
    const variationId = returnedOrder.variation_id != null ? String(returnedOrder.variation_id) : null;

    const position = await loadOrderItemPosition(deps.db, returnedOrder.order_id, returnedOrder.item_id, variationId);

    if (position === null) {
      logger.warn("claim_return_order_item_not_found", {
        claim_id: claimId,
        order_id: returnedOrder.order_id,
        item_id: returnedOrder.item_id,
      });

      // O `warn` acima era, ate D-208, o UNICO vestigio de uma devolucao
      // perdida — e ele mora no log do Cloud Run, que ninguem consulta. Sem
      // a `position` nao ha como reverter (e ela que localiza a venda), mas
      // a PERDA precisa ficar consultavel no banco: o estoque segue deduzido
      // sem caminho automatico de volta, e so gente resolve.
      //
      // Nao vira `failed`: repetir a busca nao faz a linha de `order_items`
      // aparecer, entao retentativa seria ruido (D-202). E `processed` NAO e
      // incrementado de proposito — nada foi processado.
      await recordDomainEvents(
        deps.db,
        context,
        [
          computeUnreversedReturn(
            { id: returnedOrder.order_id },
            {
              itemId: returnedOrder.item_id,
              variationId,
              returnQuantity: returnedOrder.return_quantity,
            },
            claimId,
            now,
          ),
        ],
        logger,
      );

      continue;
    }

    const pedido = await loadOrder(deps.db, context.organizationId, returnedOrder.order_id);
    const movimentos = await loadOrderMovements(deps.db, context.organizationId, returnedOrder.order_id);
    const naPlanilha = await loadCancelledInSheet(
      deps.db,
      context.organizationId,
      returnedOrder.order_id,
      movimentos,
      pedido,
    );

    const reversal = computeReturnReversal(
      // D-352: pedido do Full não repõe a loja — o produto volta para o galpão
      // do Mercado Livre, e o saldo LOCAL nunca perdeu a unidade.
      { id: returnedOrder.order_id, logisticType: pedido.logistic_type },
      { position, totalQuantity: returnedOrder.total_quantity, returnQuantity: returnedOrder.return_quantity },
      movimentos.sales,
      movimentos.reversals,
      claimId,
      now,
      naPlanilha,
      movimentos.estornadas,
    );

    if (reversal.movements.length > 0) {
      await recordStockMovements(
        deps.db,
        { organizationId: context.organizationId },
        reversal.movements,
        "DEVOLUCAO_ML",
        { type: "CLAIM", id: claimId },
      );
    }

    // D-352 — o par que faltava à venda de um pedido do Full, e a anulação do
    // que já tinha sido devolvido à loja antes de o sinal chegar.
    //
    // **A origem é o PEDIDO, e não o claim** — a mesma escolha de
    // `gravaAnulacoes` em `persist-order.ts`. A linha estorna uma VENDA, e a
    // venda tem origem `ORDER`. Com a origem do claim, nem `loadOrderMovements`
    // (aqui) nem `lerMovimentosGravados` (lá) achariam o estorno: os dois
    // filtram por `source_type = 'ORDER'` e `source_id = <pedido>`. A venda
    // pareceria sem par para sempre, e todo processamento seguinte tentaria
    // gravá-lo de novo — absorvido pelo `UNIQUE`, mas contado como movimento
    // novo em log e métrica.
    //
    // A ORDEM é a de `persist-order`: o estorno antes da anulação, porque é ele
    // que o retry usa para recalcular o resto.
    const origemDoPedido = { type: "ORDER", id: String(returnedOrder.order_id) };

    if (reversal.estornosFull.length > 0) {
      await recordStockMovements(
        deps.db,
        { organizationId: context.organizationId },
        reversal.estornosFull,
        "ESTORNO_FULL",
        origemDoPedido,
      );

      logger.info("claim_return_estornada_full", {
        claim_id: claimId,
        order_id: returnedOrder.order_id,
        estornos: reversal.estornosFull.length,
      });
    }

    if (reversal.excessReversalEstornos.length > 0) {
      await recordStockMovements(
        deps.db,
        { organizationId: context.organizationId },
        reversal.excessReversalEstornos,
        "ESTORNO_REVERSAO_EXCEDENTE",
        origemDoPedido,
      );
    }

    await recordDomainEvents(deps.db, context, [reversal.event], logger);

    if (reversal.alreadyReversed.length > 0) {
      // Verificação de e6fda07, ALTA-1: o cancelamento (ou outra devolução) já
      // devolveu a unidade. Nada gravado no saldo, e o evento leva
      // `movementsAlreadyReversed`.
      logger.info("claim_return_ja_revertida", {
        claim_id: claimId,
        order_id: returnedOrder.order_id,
        position,
        vendas: reversal.alreadyReversed.length,
      });
    }

    if (!reversal.fullReversal) {
      logger.warn("claim_return_needs_manual_review", {
        claim_id: claimId,
        order_id: returnedOrder.order_id,
        position,
        return_quantity: returnedOrder.return_quantity,
        total_quantity: returnedOrder.total_quantity,
      });
    }

    processed += 1;
  }

  return processed;
}
