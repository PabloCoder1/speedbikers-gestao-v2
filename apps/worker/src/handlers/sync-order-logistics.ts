import type { AdminClient } from "@sb/db";
import {
  estornoKeyOf,
  fullEstornoOf,
  fullReversalEstornosOf,
  isFullLogistic,
  revertedSaleKeyOf,
} from "@sb/domain";
import type { OrderLogisticType, StockMovementDraft, TimedRecordedReversal } from "@sb/domain";
import type { MercadoLivreClient, MercadoLivreOAuthConfig } from "@sb/mercado-livre";
import { z } from "zod";

import type { JobOutcome } from "../job-outcome.js";
import { readAllPages } from "../read-all-pages.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { ensureAccessToken } from "./ml-token.js";
import { createShipmentLogistics } from "./shipment-logistics.js";
import { recordStockMovements } from "./stock-movements.js";

/**
 * `sync.order-logistics` (D-352, R2) — a varredura que FECHA a pendência.
 *
 * `persist-order.ts` só lê o envio do pedido que está passando por ele agora, e
 * uma leitura que falha (ou um pedido persistido antes desta fatia) deixa o
 * pedido PENDENTE: a venda baixou a loja e o `ESTORNO_FULL` não foi gravado
 * porque ninguém sabia se ela era do Full. R2 diz o que fazer com isso — "quando
 * o sinal chegar `fulfillment`, grava o `ESTORNO_FULL` que falta" — e este job é
 * quem faz o sinal chegar. Sem ele a pendência é permanente, porque o pedido
 * antigo nunca mais volta à janela de `sync.orders.window`.
 *
 * **O universo é o LEDGER, não a tabela de pedidos.** A pendência é "`VENDA_ML`
 * sem par de estorno": em produção, 2.667 linhas em 2.550 pedidos dentro de um
 * ledger de 8.832 movimentos — contra 331 mil linhas em `orders`. Varrer
 * `orders` por `logistic_captured_at is null` seria varrer a tabela inteira atrás
 * de um conjunto 130x menor, e pediria o índice que a migration
 * `20260918000000` documentadamente NÃO criou. O ledger é lido inteiro, paginado
 * (D-131), e cada rodada nasce sabendo exatamente o que falta.
 *
 * **Progresso por EXISTÊNCIA DE VALOR (D-156).** O checkpoint é
 * `orders.logistic_captured_at`: capturado, o pedido sai do conjunto "precisa
 * ler o envio" para sempre, e nenhuma re-tentativa do Cloud Tasks repete a
 * chamada. Mas ele NÃO é o critério da varredura — o critério é a venda sem
 * estorno. Um pedido já capturado como `fulfillment` cujo `ESTORNO_FULL` não
 * chegou a ser gravado (falha entre as duas escritas) continua aparecendo aqui e
 * é fechado SEM nenhuma ida à rede, com o valor PERSISTIDO (R5: a decisão é
 * função pura do campo gravado).
 *
 * **As escrita saem na ordem que sobrevive a uma falha no meio:** os movimentos
 * ANTES da captura. Carimbar `logistic_captured_at` primeiro e falhar no estorno
 * tiraria o pedido da lista de "precisa ler" com a venda ainda baixando a loja —
 * e, como a venda continuaria sem estorno, a rodada seguinte o pegaria de novo,
 * agora pelo ramo sem rede. As duas ordens se autocorrigem; esta gasta uma
 * chamada a menos.
 *
 * **Custo.** Uma chamada `GET /shipments/{id}` por pedido pendente, com o mesmo
 * espaçamento de `sync-order-financials.ts` (que já faz
 * `GET /shipments/{id}/costs` ~963 vezes por dia). O teto por rodada existe
 * porque o backlog inicial é grande e o job tem 900 s: 2.550 pedidos a ~150 ms
 * de espaçamento mais a latência de cada chamada passariam do timeout, e um job
 * que morre no meio não é mais rápido que quatro que terminam.
 *
 * **Sem `sync_runs`.** `sync_runs.resource` é o vocabulário dos RECURSOS do
 * Mercado Livre (`orders`, `listings`, `fulfillment`, ...), com CHECK no banco;
 * esta varredura não é um recurso, é manutenção do ledger — a mesma natureza de
 * `maintenance.reconcile-balances` e `maintenance.verify-ledger-integrity`, que
 * também não gravam lá. A saúde dela é a cadência em `job_runs`
 * (`JOB_CADENCE_MIN` em `apps/web/lib/sync-health.ts`), e o que importa de
 * verdade — quantos pedidos ainda estão pendentes — sai no log de cada rodada.
 */

const payloadSchema = z.object({ mlAccountId: z.uuid() });

/**
 * Teto de pedidos com ida à rede por rodada.
 *
 * Com 800 pedidos e 150 ms de espaçamento são 120 s só de espera; somando a
 * latência medida de uma chamada ao Mercado Livre (~300 ms), a rodada fica em
 * ~6 min contra os 900 s do timeout do worker — a mesma folga de 2x que
 * `sync.fulfillment.snapshot` já usa (266–323 s medidos, `docs/PERFORMANCE.md`).
 * O backlog de 2.550 pedidos fecha em 4 rodadas, ou seja, em um dia na cadência
 * de 6 h. O ramo SEM rede (já capturado, estorno faltando) não conta para o
 * teto: ele não gasta chamada nenhuma.
 */
const PEDIDOS_POR_RODADA = 800;

/** Mesmo espaçamento de `sync-order-financials` — ~6-7 chamadas/s no pior caso. */
const INTER_ORDER_DELAY_MS = 150;

/**
 * Ids por consulta de `orders` e por chamada da RPC das devoluções: metade do
 * teto do PostgREST, que devolve 1.000 linhas SEM erro (D-131).
 */
const PEDIDOS_POR_CONSULTA = 200;

/** A cada quantos pedidos sai uma linha de progresso — a rodada é longa demais para um log só no fim. */
const PEDIDOS_POR_PAGINA_DE_LOG = 100;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SyncOrderLogisticsDeps {
  db: AdminClient;
  mercadoLivre: MercadoLivreClient;
  oauth: MercadoLivreOAuthConfig;
  encryptionKey: Buffer;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

interface MovimentoDoLedger {
  /** `stock_movements.source_id` é `text` ANULÁVEL no schema — ver `lerPendencias`. */
  source_id: string | null;
  sku_id: string;
  qty_delta: number;
  idempotency_key: string;
  occurred_at: string;
  movement_type: string;
}

/**
 * O pedido de um movimento, ou `null` quando a origem não é um id de pedido
 * legível.
 *
 * `source_id` é `text` anulável, e o `in("id", ...)` de `orders` espera número:
 * `Number(null)` é 0 e `Number("x")` é NaN, e qualquer um dos dois levaria a
 * varredura a pedir um pedido que não existe — ou, pior, um que existe e não é
 * este. Mesma defesa do `case when m.source_id ~ '^[0-9]{1,18}$'` da
 * compensação. Um `VENDA_ML` de origem ilegível não é decidível aqui de jeito
 * nenhum: sem pedido não há envio para ler.
 */
function pedidoDe(sourceId: string | null): string | null {
  return sourceId !== null && /^[0-9]{1,15}$/u.test(sourceId) ? sourceId : null;
}

interface PedidoPendente {
  id: number;
  shipping_id: number | null;
  logistic_type: string | null;
  logistic_captured_at: string | null;
}

/**
 * As vendas sem par de um pedido, e o que já foi revertido delas.
 *
 * A venda gravada anda como `StockMovementDraft` — a mesma forma que
 * `fullEstornoOf` recebe — porque ela JÁ É a linha que o estorno espelha. O
 * `RecordedSale` do domínio existe para o caminho oposto (procurar a linha
 * gravada a partir de um rascunho novo) e aqui só faria carregar um
 * `recordedAt` que ninguém consulta.
 */
interface Pendencia {
  readonly vendas: StockMovementDraft[];
  readonly reversoes: TimedRecordedReversal[];
}

function emLotes<T>(itens: readonly T[], tamanho: number): T[][] {
  const lotes: T[][] = [];

  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }

  return lotes;
}

/**
 * As vendas sem estorno do ledger inteiro da organização, por pedido.
 *
 * Lê `VENDA_ML`, os dois estornos de venda e o `CANCELAMENTO_ML` na MESMA
 * varredura: separar em consultas por tipo custaria três paginações do mesmo
 * conjunto. As devoluções ficam de fora daqui de propósito — elas são gravadas
 * com a origem do CLAIM, e o pedido só aparece DENTRO da chave
 * (`devolucao:<claim>:<venda>`), então quem as acha é a RPC
 * `get_order_return_movements` (e só para os poucos pedidos que voltarem
 * `fulfillment`).
 */
async function lerPendencias(db: AdminClient, organizationId: string): Promise<Map<string, Pendencia>> {
  const linhas = await readAllPages<MovimentoDoLedger>(
    (from, to) =>
      db
        .from("stock_movements")
        .select("source_id, sku_id, qty_delta, idempotency_key, occurred_at, movement_type, id")
        .eq("organization_id", organizationId)
        .eq("source_type", "ORDER")
        .in("movement_type", ["VENDA_ML", "ESTORNO_PRE_CAPTURA", "ESTORNO_FULL", "CANCELAMENTO_ML"])
        // Ordenação estável obrigatória (D-131): `id` é a PK.
        .order("id")
        .range(from, to),
    { label: "falha ao ler stock_movements" },
  );

  const estornadas = new Set<string>();
  const vendasPorPedido = new Map<string, StockMovementDraft[]>();
  const reversoesPorPedido = new Map<string, TimedRecordedReversal[]>();

  for (const linha of linhas) {
    const pedido = pedidoDe(linha.source_id);

    if (linha.movement_type === "ESTORNO_PRE_CAPTURA" || linha.movement_type === "ESTORNO_FULL") {
      // As duas causas respondem a MESMA pergunta: esta venda já foi anulada?
      // A chave é neutra, e o prefixo `estorno:` é conferido por `estornoKeyOf`
      // do outro lado — aqui basta guardar a chave inteira.
      estornadas.add(linha.idempotency_key);

      continue;
    }

    if (pedido === null) {
      continue;
    }

    if (linha.movement_type === "CANCELAMENTO_ML") {
      // A chave é conferida: um cancelamento que não diz qual venda reverteu
      // faria a anulação sair com a chave errada, e o `UNIQUE` não a pegaria.
      revertedSaleKeyOf(linha.idempotency_key);
      reversoesPorPedido.set(pedido, [
        ...(reversoesPorPedido.get(pedido) ?? []),
        {
          idempotencyKey: linha.idempotency_key,
          quantity: linha.qty_delta,
          occurredAt: new Date(linha.occurred_at),
        },
      ]);

      continue;
    }

    vendasPorPedido.set(pedido, [
      ...(vendasPorPedido.get(pedido) ?? []),
      {
        skuId: linha.sku_id,
        qtyDelta: linha.qty_delta,
        idempotencyKey: linha.idempotency_key,
        occurredAt: new Date(linha.occurred_at),
      },
    ]);
  }

  const pendencias = new Map<string, Pendencia>();

  for (const [pedido, vendas] of vendasPorPedido) {
    const semPar = vendas.filter((venda) => !estornadas.has(estornoKeyOf(venda.idempotencyKey)));

    if (semPar.length > 0) {
      pendencias.set(pedido, { vendas: semPar, reversoes: reversoesPorPedido.get(pedido) ?? [] });
    }
  }

  return pendencias;
}

/**
 * As `DEVOLUCAO_ML` gravadas dos pedidos, pela mesma RPC que `persist-order.ts`
 * usa. Lida SÓ para os pedidos que voltaram `fulfillment`: numa varredura do
 * ledger inteiro, chamá-la para todo pendente seria pagar por 2.550 pedidos o
 * que só uns poucos precisam.
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

  for (const lote of emLotes([...new Set(orderIds)], PEDIDOS_POR_CONSULTA)) {
    const resultado = await db.rpc("get_order_return_movements", {
      p_organization_id: organizationId,
      p_order_ids: lote,
    });

    if (resultado.error !== null) {
      // "Não li" nunca vira "não houve devolução": sem a devolução, a anulação
      // dela não sairia e o saldo ficaria +R (o lado perigoso).
      throw new Error(`falha ao ler get_order_return_movements: ${resultado.error.message}`);
    }

    for (const row of resultado.data) {
      revertedSaleKeyOf(row.idempotency_key);
      porPedido.set(row.order_id, [
        ...(porPedido.get(row.order_id) ?? []),
        {
          idempotencyKey: row.idempotency_key,
          quantity: row.qty_delta,
          occurredAt: new Date(row.occurred_at),
        },
      ]);
    }
  }

  return porPedido;
}

/** Os pedidos pendentes desta CONTA, com o que já está gravado de logística. */
async function lerPedidos(
  db: AdminClient,
  mlAccountId: string,
  orderIds: readonly string[],
): Promise<PedidoPendente[]> {
  const pedidos: PedidoPendente[] = [];

  for (const lote of emLotes(orderIds, PEDIDOS_POR_CONSULTA)) {
    const resultado = await db
      .from("orders")
      .select("id, shipping_id, logistic_type, logistic_captured_at")
      .eq("ml_account_id", mlAccountId)
      // `orders.id` é número; o id veio de `source_id`, que é texto. A conversão
      // é segura porque `pedidoDe` já recusou o que não for dígito.
      .in("id", lote.map(Number));

    if (resultado.error !== null) {
      throw new Error(`falha ao ler orders: ${resultado.error.message}`);
    }

    pedidos.push(...resultado.data);
  }

  // Ordem determinística: a rodada seguinte continua de onde esta parou, e o
  // teto por rodada não sorteia quem fica para trás.
  return pedidos.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Os movimentos que fecham um pedido do Full: o `ESTORNO_FULL` de cada venda sem
 * par e a anulação de TODA reversão já gravada dessas vendas (R3 — numa venda
 * que nunca saiu da loja, toda unidade devolvida é excesso).
 *
 * As duas listas vêm das MESMAS funções do domínio que `computeSaleDeductions`
 * usa no caminho do pedido novo — é o que garante que a varredura e a
 * persistência calculem a mesma linha para o mesmo pedido.
 */
function movimentosDoFull(pendencia: Pendencia): {
  estornos: StockMovementDraft[];
  anulacoes: StockMovementDraft[];
} {
  const estornos: StockMovementDraft[] = [];
  const anulacoes: StockMovementDraft[] = [];

  for (const venda of pendencia.vendas) {
    // Sem `recordedSale`: a venda que chega aqui JÁ É a linha gravada, então o
    // espelho (SKU, quantidade e data) sai dela mesma.
    estornos.push(fullEstornoOf(venda));
    anulacoes.push(...fullReversalEstornosOf(venda, pendencia.reversoes));
  }

  return { estornos, anulacoes };
}

export function createSyncOrderLogisticsHandler(deps: SyncOrderLogisticsDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const now = deps.now?.() ?? new Date();
    const sleep = deps.sleep ?? defaultSleep;

    const account = await deps.db
      .from("ml_accounts")
      .select("id, organization_id, status")
      .eq("id", mlAccountId)
      .maybeSingle();

    if (account.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler a conta: ${account.error.message}` };
    }

    if (account.data?.status !== "CONNECTED") {
      context.logger.info("sync_order_logistics_account_not_connected", { ml_account_id: mlAccountId });

      return { status: "done", processed: 0 };
    }

    const organizationId = account.data.organization_id;
    const pendencias = await lerPendencias(deps.db, organizationId);

    if (pendencias.size === 0) {
      context.logger.info("sync_order_logistics_done", {
        ml_account_id: mlAccountId,
        pendentes: 0,
        capturados: 0,
        full: 0,
        estornos: 0,
        anulacoes: 0,
        sem_envio: 0,
        falhas: 0,
        restantes: 0,
      });

      return { status: "done", processed: 0 };
    }

    const pedidos = await lerPedidos(deps.db, mlAccountId, [...pendencias.keys()]);

    if (pedidos.length === 0) {
      // O ledger tem pendência, mas de OUTRA conta da mesma organização: a
      // varredura da conta dela fecha. Não é falha, e some do log como zero.
      context.logger.info("sync_order_logistics_done", {
        ml_account_id: mlAccountId,
        pendentes: 0,
        capturados: 0,
        full: 0,
        estornos: 0,
        anulacoes: 0,
        sem_envio: 0,
        falhas: 0,
        restantes: 0,
      });

      return { status: "done", processed: 0 };
    }

    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    const logistics = createShipmentLogistics({
      mercadoLivre: deps.mercadoLivre,
      accessToken: tokenResult.accessToken,
      logger: context.logger,
      ...(deps.now === undefined ? {} : { now: deps.now }),
    });

    // As devoluções de todos os pendentes desta conta, numa leitura só: a RPC é
    // por lote de pedidos, e descobrir quais são `fulfillment` acontece DEPOIS
    // da ida à rede — pedir de novo por pedido seria uma consulta por venda.
    const devolucoes = await lerDevolucoes(
      deps.db,
      organizationId,
      pedidos.map((pedido) => String(pedido.id)),
    );

    let capturados = 0;
    let full = 0;
    let estornosGravados = 0;
    let anulacoesGravadas = 0;
    let semEnvio = 0;
    let falhas = 0;
    let lidosDaRede = 0;
    let processados = 0;

    for (const pedido of pedidos) {
      const pendencia = pendencias.get(String(pedido.id));

      if (pendencia === undefined) {
        continue;
      }

      let logisticType: OrderLogisticType = pedido.logistic_type;
      let capturadoEm: string | null = pedido.logistic_captured_at;

      if (capturadoEm === null) {
        // R5: só se lê o envio de quem ainda não decidiu. Quem já tem captura
        // fecha com o valor PERSISTIDO, sem rede.
        if (pedido.shipping_id === null) {
          // Sem a chave do envio não há o que ler. Fica pendente e DECLARADO —
          // nunca escondido numa contagem de sucesso.
          semEnvio += 1;

          continue;
        }

        if (lidosDaRede >= PEDIDOS_POR_RODADA) {
          break;
        }

        if (lidosDaRede > 0) {
          await sleep(INTER_ORDER_DELAY_MS);
        }

        lidosDaRede += 1;

        const capturada = await logistics.read(pedido.shipping_id, pedido.id);

        if (capturada === null) {
          // `createShipmentLogistics` já registrou o motivo. O pedido continua
          // pendente e volta na próxima rodada — nunca presumir Full (R2).
          falhas += 1;

          continue;
        }

        logisticType = capturada.logisticType;
        capturadoEm = capturada.capturedAt.toISOString();
      }

      if (isFullLogistic(logisticType)) {
        full += 1;

        const { estornos, anulacoes } = movimentosDoFull({
          vendas: pendencia.vendas,
          reversoes: [...pendencia.reversoes, ...(devolucoes.get(String(pedido.id)) ?? [])],
        });

        // ANTES da captura: uma falha aqui deixa o pedido pendente (a venda
        // segue sem estorno) e a rodada seguinte o refaz — pelo ramo sem rede
        // se a captura já estiver gravada, ou lendo o envio de novo se não.
        await recordStockMovements(deps.db, { organizationId }, estornos, "ESTORNO_FULL", {
          type: "ORDER",
          id: String(pedido.id),
        });

        estornosGravados += estornos.length;

        if (anulacoes.length > 0) {
          await recordStockMovements(deps.db, { organizationId }, anulacoes, "ESTORNO_REVERSAO_EXCEDENTE", {
            type: "ORDER",
            id: String(pedido.id),
          });

          anulacoesGravadas += anulacoes.length;
        }
      }

      if (pedido.logistic_captured_at === null) {
        // O carimbo só nasce uma vez (R5): o `is null` no WHERE impede que uma
        // rodada concorrente, ou uma releitura divergente, reescreva a decisão
        // com que o par já foi gravado.
        const gravado = await deps.db
          .from("orders")
          .update({ logistic_type: logisticType, logistic_captured_at: capturadoEm })
          .eq("id", pedido.id)
          .is("logistic_captured_at", null);

        if (gravado.error !== null) {
          throw new Error(`falha ao gravar a logistica do pedido ${String(pedido.id)}: ${gravado.error.message}`);
        }

        capturados += 1;
      }

      processados += 1;

      if (processados % PEDIDOS_POR_PAGINA_DE_LOG === 0) {
        context.logger.info("sync_order_logistics_pagina", {
          ml_account_id: mlAccountId,
          processados,
          full,
          estornos: estornosGravados,
          falhas,
        });
      }
    }

    // Quantos pedidos desta conta continuam sem decisão depois desta rodada: o
    // número que diz se a varredura está avançando, e o único que o dono precisa
    // ver cair até zero antes da compensação.
    const restantes = pedidos.length - processados;

    context.logger.info("sync_order_logistics_done", {
      ml_account_id: mlAccountId,
      pendentes: pedidos.length,
      capturados,
      full,
      estornos: estornosGravados,
      anulacoes: anulacoesGravadas,
      sem_envio: semEnvio,
      falhas,
      restantes,
    });

    return { status: "done", processed: processados };
  };
}
