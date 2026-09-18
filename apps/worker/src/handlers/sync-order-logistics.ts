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
import { classifyShipmentFailure, readShipmentLogistic } from "./shipment-logistics.js";
import type { CapturedLogistic } from "./shipment-logistics.js";
import { recordStockMovements } from "./stock-movements.js";

/**
 * `sync.order-logistics` (D-352, R2 e R3) — a varredura que faz o sinal chegar.
 *
 * `persist-order.ts` só lê o envio do pedido que está passando por ele agora, e
 * só quando a resposta muda uma linha naquele momento. Todo o resto fica
 * PENDENTE — as duas colunas de logística nulas — e é este job que lê o envio
 * deles. Sem ele a pendência é permanente, porque o pedido antigo nunca mais
 * volta à janela de `sync.orders.window`.
 *
 * **O universo é o LEDGER, não a tabela de pedidos** (331 mil linhas em `orders`
 * contra ~9 mil movimentos em 17/09, e sem o índice que a migration
 * `20260918000000` documentadamente não criou). Entra todo pedido com `VENDA_ML`
 * em um destes dois estados:
 *
 *  1. **ABERTO** — uma venda sem estorno, ou uma reversão (`CANCELAMENTO_ML`,
 *     `DEVOLUCAO_ML`) sem a anulação `estorno:<chave da reversão>`. Lido se o
 *     pedido ainda não tem captura ou se ela é `fulfillment` (a pendência de
 *     R2, e o fechamento que ficou pela metade).
 *  2. **SÓ FALTA O SINAL** — nada aberto, mas alguma venda estornada pela
 *     D-351 (`ESTORNO_PRE_CAPTURA`) num pedido sem captura. A venda soma zero
 *     hoje, e é exatamente por isso que ninguém lia o envio dela: o gate de
 *     `persist-order` pula a venda até o corte. Mas o cancelamento ou a
 *     devolução que vier depois precisa do sinal para não voltar +1 à loja
 *     (R3), e sem este estado o pedido do Full pré-capturado nunca o recebia
 *     (revisão de 6965b0e, ALTA). Lido só se ainda não tem captura.
 *
 * O pedido fechado cujos estornos são todos `ESTORNO_FULL` fica de fora: esse
 * tipo só é gravado com o pedido já capturado como `fulfillment`.
 *
 * **As escritas saem na ordem que sobrevive a uma falha no meio: a CAPTURA
 * primeiro, as anulações, o `ESTORNO_FULL` por último.** A captura carimbada é a
 * decisão (R5); tudo o que vem depois deriva dela, e o que falhar depois dela
 * deixa o pedido ABERTO e capturado como `fulfillment`, que a rodada seguinte
 * fecha SEM ida à rede (a anulação repetida cai no `UNIQUE`). A ordem antiga —
 * estorno, anulação, captura — perdia os dois últimos passos para sempre: com o
 * estorno já gravado, a venda saía do universo "venda sem par" e a anulação
 * que faltava nunca era refeita (revisão de 6965b0e, MÉDIA).
 *
 * **Política de erro da leitura** (`classifyShipmentFailure`): 429/5xx
 * esgotados, 401 e erro de transporte PARAM a rodada — a falha é da conta, e
 * seguir gastaria 4 tentativas com backoff por pedido na cota que o webhook usa;
 * a fila repete. 404 é resposta definitiva (envio inexistente): carimba a
 * captura com o tipo nulo e a venda baixa a loja. O resto (400, 403, corpo fora
 * do contrato) fica pendente e volta na próxima rodada, contado em `falhas`.
 *
 * **Custo.** Uma chamada `GET /shipments/{id}` por pedido sem captura, com o
 * mesmo espaçamento de `sync-order-financials.ts` (que já faz
 * `GET /shipments/{id}/costs` ~963 vezes por dia). Dois tetos por rodada: 800
 * chamadas e 7 min de rede — o prazo padrão do Cloud Tasks para alvo HTTP é
 * 10 min (`enqueue.ts` não define `dispatchDeadline`), e uma rodada que passa
 * dele é reentregue enquanto ainda roda.
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
 * ~6 min. O ramo SEM rede (já capturado como `fulfillment`, com algo aberto)
 * não conta para o teto: ele não gasta chamada nenhuma.
 */
const PEDIDOS_POR_RODADA = 800;

/**
 * Teto de TEMPO de rede por rodada. O de 800 chamadas supõe ~450 ms por pedido;
 * uma API lenta o transformaria em 15 min. Com 7 min de rede e o resto da rodada
 * sem chamada nenhuma, ela termina dentro dos 10 min do prazo padrão do Cloud
 * Tasks — depois dele a task é reentregue com a primeira execução ainda rodando.
 */
const ORCAMENTO_DE_REDE_MS = 7 * 60_000;

/** Mesmo espaçamento de `sync-order-financials` — ~6-7 chamadas/s no pior caso. */
const INTER_ORDER_DELAY_MS = 150;

/** Ids por consulta de `orders`: metade do teto do PostgREST, que devolve 1.000 linhas SEM erro (D-131). */
const PEDIDOS_POR_CONSULTA = 200;

/** A cada quantos pedidos sai uma linha de progresso — a rodada é longa demais para um log só no fim. */
const PEDIDOS_POR_PAGINA_DE_LOG = 100;

/** Os tipos que a varredura lê: as vendas, as reversões delas e os três estornos. */
const TIPOS_LIDOS = [
  "VENDA_ML",
  "CANCELAMENTO_ML",
  "DEVOLUCAO_ML",
  "ESTORNO_PRE_CAPTURA",
  "ESTORNO_FULL",
  "ESTORNO_REVERSAO_EXCEDENTE",
];

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
  /** `stock_movements.source_type` também é anulável no schema. */
  source_type: string | null;
  /** `stock_movements.source_id` é `text` ANULÁVEL no schema — ver `pedidoDe`. */
  source_id: string | null;
  sku_id: string;
  qty_delta: number;
  idempotency_key: string;
  occurred_at: string;
  movement_type: string;
}

/**
 * O pedido de um id em texto, ou `null` quando ele não é um id legível.
 *
 * `source_id` é `text` anulável, e o `in("id", ...)` de `orders` espera número:
 * `Number(null)` é 0 e `Number("x")` é NaN, e qualquer um dos dois levaria a
 * varredura a pedir um pedido que não existe — ou, pior, um que existe e não é
 * este. Mesma defesa do `case when m.source_id ~ '^[0-9]{1,18}$'` da
 * compensação.
 *
 * **O id real do Mercado Livre tem 16 dígitos** (`2000018515005942`, lido em
 * 17/09). O teto é o do NÚMERO, não o de dígitos: `orders.id` chega ao worker
 * como `number` (`order-schema.ts`), e um id acima de `Number.MAX_SAFE_INTEGER`
 * seria arredondado para OUTRO pedido na consulta. Até lá (9,007e15, contra os
 * ~2,0e15 de hoje) todo id cabe; depois disso o movimento sai como ilegível —
 * pendente, baixando a loja, o lado conservador — em vez de ler o envio errado.
 */
function pedidoDe(id: string | null): string | null {
  if (id === null || !/^[0-9]{1,16}$/u.test(id)) {
    return null;
  }

  return Number.isSafeInteger(Number(id)) ? id : null;
}

/**
 * O pedido de uma `DEVOLUCAO_ML`. Ela é gravada com a origem do CLAIM, e o
 * pedido só aparece DENTRO da chave (`devolucao:<claim>:venda:<pedido>:...`) — o
 * mesmo `split_part(idempotency_key, ':', 4)` de `get_order_return_movements`.
 */
function pedidoDaDevolucao(chave: string): string | null {
  const casou = /^devolucao:[^:]+:venda:([^:]+):/u.exec(chave);

  return casou === null ? null : pedidoDe(casou[1] ?? null);
}

interface PedidoNoLedger {
  /**
   * Os `VENDA_ML` do pedido. A venda gravada anda como `StockMovementDraft` — a
   * forma que `fullEstornoOf` recebe — porque ela JÁ É a linha que o estorno
   * espelha.
   */
  readonly vendas: StockMovementDraft[];
  /** `CANCELAMENTO_ML` e `DEVOLUCAO_ML` gravados, com o instante que a anulação espelha. */
  readonly reversoes: TimedRecordedReversal[];
}

interface Ledger {
  readonly pedidos: Map<string, PedidoNoLedger>;
  /** A chave de todo estorno gravado (`estorno:<chave do movimento>`), com o tipo dele. */
  readonly estornos: Map<string, string>;
}

/** O que está aberto num pedido, lido do ledger. */
interface Situacao {
  /** Vendas sem estorno. */
  readonly semPar: StockMovementDraft[];
  /** Reversões de venda do pedido sem a anulação `estorno:<chave da reversão>`. */
  readonly reversoesAbertas: TimedRecordedReversal[];
  /** Alguma venda do pedido foi estornada pela D-351. */
  readonly preCapturada: boolean;
}

function emLotes<T>(itens: readonly T[], tamanho: number): T[][] {
  const lotes: T[][] = [];

  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }

  return lotes;
}

function doPedido(pedidos: Map<string, PedidoNoLedger>, pedido: string): PedidoNoLedger {
  const existente = pedidos.get(pedido);

  if (existente !== undefined) {
    return existente;
  }

  const novo: PedidoNoLedger = { vendas: [], reversoes: [] };

  pedidos.set(pedido, novo);

  return novo;
}

/**
 * As vendas, as reversões e os estornos do ledger inteiro da organização, numa
 * varredura paginada (D-131): separar por tipo custaria seis paginações do mesmo
 * conjunto. As devoluções vêm junto — antes eram lidas pela RPC
 * `get_order_return_movements` só para os pedidos que voltavam `fulfillment`, e
 * a varredura não sabia se um pedido capturado tinha devolução sem anulação.
 */
async function lerLedger(db: AdminClient, organizationId: string): Promise<Ledger> {
  const linhas = await readAllPages<MovimentoDoLedger>(
    (from, to) =>
      db
        .from("stock_movements")
        .select("source_type, source_id, sku_id, qty_delta, idempotency_key, occurred_at, movement_type, id")
        .eq("organization_id", organizationId)
        .in("movement_type", TIPOS_LIDOS)
        // Ordenação estável obrigatória (D-131): `id` é a PK.
        .order("id")
        .range(from, to),
    { label: "falha ao ler stock_movements" },
  );

  const pedidos = new Map<string, PedidoNoLedger>();
  const estornos = new Map<string, string>();

  for (const linha of linhas) {
    if (linha.movement_type.startsWith("ESTORNO_")) {
      // Os três respondem a MESMA pergunta — "este movimento já foi anulado?" —
      // pela chave neutra `estorno:<chave do movimento>`.
      estornos.set(linha.idempotency_key, linha.movement_type);

      continue;
    }

    if (linha.movement_type === "DEVOLUCAO_ML") {
      const pedido = pedidoDaDevolucao(linha.idempotency_key);

      if (pedido !== null) {
        doPedido(pedidos, pedido).reversoes.push({
          idempotencyKey: linha.idempotency_key,
          quantity: linha.qty_delta,
          occurredAt: new Date(linha.occurred_at),
        });
      }

      continue;
    }

    const pedido = linha.source_type === "ORDER" ? pedidoDe(linha.source_id) : null;

    if (pedido === null) {
      // Um `VENDA_ML` de origem ilegível não é decidível aqui de jeito nenhum:
      // sem pedido não há envio para ler.
      continue;
    }

    if (linha.movement_type === "CANCELAMENTO_ML") {
      // A chave é conferida: um cancelamento que não diz qual venda reverteu
      // faria a anulação sair com a chave errada, e o `UNIQUE` não a pegaria.
      revertedSaleKeyOf(linha.idempotency_key);
      doPedido(pedidos, pedido).reversoes.push({
        idempotencyKey: linha.idempotency_key,
        quantity: linha.qty_delta,
        occurredAt: new Date(linha.occurred_at),
      });

      continue;
    }

    doPedido(pedidos, pedido).vendas.push({
      skuId: linha.sku_id,
      qtyDelta: linha.qty_delta,
      idempotencyKey: linha.idempotency_key,
      occurredAt: new Date(linha.occurred_at),
    });
  }

  return { pedidos, estornos };
}

function situacaoDe(pedido: PedidoNoLedger, estornos: ReadonlyMap<string, string>): Situacao {
  const chavesDasVendas = new Set(pedido.vendas.map((venda) => venda.idempotencyKey));

  return {
    semPar: pedido.vendas.filter((venda) => !estornos.has(estornoKeyOf(venda.idempotencyKey))),
    reversoesAbertas: pedido.reversoes.filter(
      (reversao) =>
        chavesDasVendas.has(revertedSaleKeyOf(reversao.idempotencyKey)) &&
        !estornos.has(estornoKeyOf(reversao.idempotencyKey)),
    ),
    preCapturada: pedido.vendas.some(
      (venda) => estornos.get(estornoKeyOf(venda.idempotencyKey)) === "ESTORNO_PRE_CAPTURA",
    ),
  };
}

interface PedidoPendente {
  id: number;
  shipping_id: number | null;
  logistic_type: string | null;
  logistic_captured_at: string | null;
}

/**
 * Os pedidos desta CONTA, com o que já está gravado de logística.
 *
 * `abertos` pede os que ainda podem ser do Full: sem captura (falta ler o envio)
 * ou capturados como `fulfillment` (algo ficou aberto). O pedido já decidido
 * como NÃO-Full fica de fora — a venda dele é legítima e continua "sem par"
 * para sempre, e sem o filtro `pendentes` nunca chegaria a zero.
 *
 * `soSemCaptura` pede só os que não têm captura: é o estado 2 do cabeçalho, em
 * que o pedido já capturado — Full ou não — não tem nada a fazer.
 */
async function lerPedidos(
  db: AdminClient,
  mlAccountId: string,
  orderIds: readonly string[],
  filtro: "abertos" | "soSemCaptura",
): Promise<PedidoPendente[]> {
  const pedidos: PedidoPendente[] = [];

  for (const lote of emLotes(orderIds, PEDIDOS_POR_CONSULTA)) {
    const consulta = db
      .from("orders")
      .select("id, shipping_id, logistic_type, logistic_captured_at")
      .eq("ml_account_id", mlAccountId);
    const filtrada =
      filtro === "abertos"
        ? consulta.or("logistic_captured_at.is.null,logistic_type.eq.fulfillment")
        : consulta.is("logistic_captured_at", null);
    // `orders.id` é número; o id veio de `source_id`, que é texto. A conversão
    // é segura porque `pedidoDe` já recusou o que não for dígito ou não
    // couber no inteiro seguro.
    const resultado = await filtrada.in("id", lote.map(Number));

    if (resultado.error !== null) {
      throw new Error(`falha ao ler orders: ${resultado.error.message}`);
    }

    pedidos.push(...resultado.data);
  }

  return pedidos;
}

/**
 * Os movimentos que fecham um pedido do Full: a anulação de TODA reversão aberta
 * das vendas dele (R3 — numa venda que nunca saiu da loja, toda unidade devolvida
 * é excesso, esteja a venda estornada pela D-351 ou não) e o `ESTORNO_FULL` de
 * cada venda sem par.
 *
 * As duas listas vêm das MESMAS funções do domínio que `computeSaleDeductions` e
 * `cancelamentoDoFull` usam — é o que garante que a varredura e a persistência
 * calculem a mesma linha, com a mesma chave, para o mesmo pedido.
 */
function movimentosDoFull(
  pedido: PedidoNoLedger,
  situacao: Situacao,
): { estornos: StockMovementDraft[]; anulacoes: StockMovementDraft[] } {
  return {
    // Sem `recordedSale`: a venda que chega aqui JÁ É a linha gravada, então o
    // espelho (SKU, quantidade e data) sai dela mesma.
    estornos: situacao.semPar.map((venda) => fullEstornoOf(venda)),
    anulacoes: pedido.vendas.flatMap((venda) => fullReversalEstornosOf(venda, situacao.reversoesAbertas)),
  };
}

interface Contagem {
  pendentes: number;
  capturados: number;
  full: number;
  estornos: number;
  anulacoes: number;
  sem_envio: number;
  envio_inexistente: number;
  falhas: number;
  adiados: number;
  concorrentes: number;
  restantes: number;
}

function contagemZerada(): Contagem {
  return {
    pendentes: 0,
    capturados: 0,
    full: 0,
    estornos: 0,
    anulacoes: 0,
    sem_envio: 0,
    envio_inexistente: 0,
    falhas: 0,
    adiados: 0,
    concorrentes: 0,
    restantes: 0,
  };
}

export function createSyncOrderLogisticsHandler(deps: SyncOrderLogisticsDeps): JobHandler {
  return async (_envelope, context: HandlerContext): Promise<JobOutcome> => {
    const parsed = payloadSchema.safeParse(context.payload);

    if (!parsed.success) {
      return { status: "failed", retryable: false, reason: "payload sem mlAccountId" };
    }

    const { mlAccountId } = parsed.data;
    const agora = (): Date => deps.now?.() ?? new Date();
    const now = agora();
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
    const ledger = await lerLedger(deps.db, organizationId);
    const situacoes = new Map<string, Situacao>();
    const abertos: string[] = [];
    const soSemCaptura: string[] = [];

    for (const [pedido, noLedger] of ledger.pedidos) {
      if (noLedger.vendas.length === 0) {
        // Reversão sem venda gravada: nada a espelhar, e nenhuma decisão a tomar.
        continue;
      }

      const situacao = situacaoDe(noLedger, ledger.estornos);

      situacoes.set(pedido, situacao);

      if (situacao.semPar.length > 0 || situacao.reversoesAbertas.length > 0) {
        abertos.push(pedido);
      } else if (situacao.preCapturada) {
        soSemCaptura.push(pedido);
      }
    }

    const contagem = contagemZerada();
    const resumo = (extra: Record<string, unknown> = {}): void => {
      context.logger.info("sync_order_logistics_done", { ml_account_id: mlAccountId, ...contagem, ...extra });
    };

    const pedidos = [
      ...(await lerPedidos(deps.db, mlAccountId, abertos, "abertos")),
      ...(await lerPedidos(deps.db, mlAccountId, soSemCaptura, "soSemCaptura")),
      // Ordem determinística: a rodada seguinte continua de onde esta parou, e o
      // teto por rodada não sorteia quem fica para trás.
    ].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    if (pedidos.length === 0) {
      // Nada aberto que ainda possa ser do Full, ou o que está aberto é de OUTRA
      // conta da mesma organização (a varredura da conta dela fecha). Nenhum dos
      // dois é falha.
      resumo();

      return { status: "done", processed: 0 };
    }

    contagem.pendentes = pedidos.length;

    const tokenResult = await ensureAccessToken(deps, mlAccountId, now);

    if (!tokenResult.ok) {
      return { status: "failed", retryable: tokenResult.retryable, reason: tokenResult.reason };
    }

    const { accessToken } = tokenResult;

    const inicioDaRede = now.getTime();
    let lidosDaRede = 0;
    let processados = 0;

    for (const pedido of pedidos) {
      const noLedger = ledger.pedidos.get(String(pedido.id));
      const situacao = situacoes.get(String(pedido.id));

      if (noLedger === undefined || situacao === undefined) {
        continue;
      }

      let logisticType: OrderLogisticType = pedido.logistic_type;

      if (pedido.logistic_captured_at === null) {
        // R5: só se lê o envio de quem ainda não decidiu. Quem já tem captura
        // fecha com o valor PERSISTIDO, sem rede.
        if (pedido.shipping_id === null) {
          // Sem a chave do envio não há o que ler. Fica pendente e DECLARADO —
          // nunca escondido numa contagem de sucesso.
          contagem.sem_envio += 1;

          continue;
        }

        if (lidosDaRede >= PEDIDOS_POR_RODADA || agora().getTime() - inicioDaRede >= ORCAMENTO_DE_REDE_MS) {
          // `continue`, e não `break`: os tetos são de REDE, e o pedido já
          // capturado mais adiante na lista fecha sem chamada nenhuma.
          contagem.adiados += 1;

          continue;
        }

        if (lidosDaRede > 0) {
          await sleep(INTER_ORDER_DELAY_MS);
        }

        lidosDaRede += 1;

        let capturada: CapturedLogistic;

        try {
          capturada = await readShipmentLogistic(
            { mercadoLivre: deps.mercadoLivre, accessToken, now: agora },
            pedido.shipping_id,
          );
        } catch (error) {
          const acao = classifyShipmentFailure(error);
          const motivo = error instanceof Error ? error.message : String(error);

          if (acao === "interromper") {
            // A falha é da conta ou da rede: o próximo pedido falharia igual, e
            // cada um gastaria as tentativas do cliente na cota que o webhook
            // usa. O que já foi gravado fica — tudo aqui é idempotente.
            context.logger.warn("sync_order_logistics_interrompida", {
              ml_account_id: mlAccountId,
              order_id: pedido.id,
              motivo,
            });
            contagem.restantes = pedidos.length - processados;
            resumo({ interrompida: true });

            return {
              status: "failed",
              retryable: true,
              reason: `leitura do envio interrompida no pedido ${String(pedido.id)}: ${motivo}`,
            };
          }

          if (acao === "pular") {
            // Do envio, e sem prova de que seja definitiva: pendente, volta na
            // próxima rodada. Nunca presumir Full (R2).
            context.logger.warn("order_logistic_leitura_falhou", {
              order_id: pedido.id,
              shipping_id: pedido.shipping_id,
              motivo,
            });
            contagem.falhas += 1;

            continue;
          }

          // 404: o envio não existe, e não há sinal a esperar. É RESPOSTA — a
          // captura é carimbada com o tipo nulo e a venda baixa a loja.
          context.logger.warn("order_logistic_envio_inexistente", {
            order_id: pedido.id,
            shipping_id: pedido.shipping_id,
          });
          contagem.envio_inexistente += 1;
          capturada = { logisticType: null, capturedAt: agora() };
        }

        // 1. A CAPTURA, antes de qualquer movimento: ela é a decisão (R5), e o
        // que falhar daqui em diante deixa o pedido capturado e ABERTO, que a
        // rodada seguinte fecha sem rede. O `is null` impede que uma rodada
        // concorrente, ou uma releitura divergente, reescreva a decisão.
        const gravado = await deps.db
          .from("orders")
          .update({ logistic_type: capturada.logisticType, logistic_captured_at: capturada.capturedAt.toISOString() })
          .eq("id", pedido.id)
          .is("logistic_captured_at", null)
          .select("id");

        if (gravado.error !== null) {
          throw new Error(`falha ao gravar a logistica do pedido ${String(pedido.id)}: ${gravado.error.message}`);
        }

        if (gravado.data.length === 0) {
          // Outro escritor carimbou entre a leitura do pedido e aqui. A decisão
          // que vale é a DELE (R5), e ela não está na mão: a rodada seguinte o
          // encontra capturado e decide pelo valor gravado.
          contagem.concorrentes += 1;

          continue;
        }

        contagem.capturados += 1;
        logisticType = capturada.logisticType;
      }

      if (isFullLogistic(logisticType)) {
        contagem.full += 1;

        const { estornos, anulacoes } = movimentosDoFull(noLedger, situacao);
        const origem = { type: "ORDER", id: String(pedido.id) };

        // 2. As anulações. 3. O `ESTORNO_FULL` por ÚLTIMO: enquanto ele não
        // entra, a venda continua sem par e o pedido continua ABERTO — é o que
        // traz de volta a rodada que falhou no meio.
        if (anulacoes.length > 0) {
          await recordStockMovements(deps.db, { organizationId }, anulacoes, "ESTORNO_REVERSAO_EXCEDENTE", origem);
          contagem.anulacoes += anulacoes.length;
        }

        if (estornos.length > 0) {
          await recordStockMovements(deps.db, { organizationId }, estornos, "ESTORNO_FULL", origem);
          contagem.estornos += estornos.length;
        }
      }

      processados += 1;

      if (processados % PEDIDOS_POR_PAGINA_DE_LOG === 0) {
        context.logger.info("sync_order_logistics_pagina", {
          ml_account_id: mlAccountId,
          processados,
          full: contagem.full,
          estornos: contagem.estornos,
          falhas: contagem.falhas,
        });
      }
    }

    // Quantos pedidos desta conta continuam sem decisão depois desta rodada: o
    // número que diz se a varredura está avançando, e o único que o dono precisa
    // ver cair até zero antes da compensação.
    contagem.restantes = pedidos.length - processados;
    resumo();

    return { status: "done", processed: processados };
  };
}
