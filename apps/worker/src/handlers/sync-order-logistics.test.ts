import { randomBytes } from "node:crypto";

import { MercadoLivreApiError, encryptToken } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { SyncOrderLogisticsDeps } from "./sync-order-logistics.js";
import { createSyncOrderLogisticsHandler } from "./sync-order-logistics.js";

const ML_ACCOUNT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const ORGANIZATION_ID = "11111111-0000-4000-8000-000000000001";
const ENCRYPTION_KEY = randomBytes(32);
const NOW = new Date("2026-09-18T09:00:00.000Z");

const ENVELOPE = {
  jobType: "sync.order-logistics",
  jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b66",
  organizationId: ORGANIZATION_ID,
  dedupeKey: "order-logistics:loja-1:2026-09-18",
  attempt: 1,
  enqueuedAt: NOW.toISOString(),
};

interface MovimentoRow {
  source_type?: string;
  source_id: string | null;
  sku_id: string;
  qty_delta: number;
  idempotency_key: string;
  occurred_at: string;
  movement_type: string;
}

interface OrderRow {
  id: number;
  shipping_id: number | null;
  logistic_type: string | null;
  logistic_captured_at: string | null;
}

/** Uma venda gravada, na forma mínima que o ledger devolve. */
function venda(orderId: number, sku: string, quantidade: number, occurredAt: string, posicao = 1): MovimentoRow {
  return {
    source_type: "ORDER",
    source_id: String(orderId),
    sku_id: sku,
    qty_delta: -quantidade,
    idempotency_key: `venda:${String(orderId)}:${String(posicao)}`,
    occurred_at: occurredAt,
    movement_type: "VENDA_ML",
  };
}

function estorno(chaveDaVenda: string, tipo: "ESTORNO_PRE_CAPTURA" | "ESTORNO_FULL", orderId: number): MovimentoRow {
  return {
    source_type: "ORDER",
    source_id: String(orderId),
    sku_id: "SKU-A",
    qty_delta: 1,
    idempotency_key: `estorno:${chaveDaVenda}`,
    occurred_at: "2026-09-10T10:00:00.000Z",
    movement_type: tipo,
  };
}

function cancelamento(orderId: number, chaveDaVenda: string, quantidade: number, occurredAt: string): MovimentoRow {
  return {
    source_type: "ORDER",
    source_id: String(orderId),
    sku_id: "SKU-A",
    qty_delta: quantidade,
    idempotency_key: `cancelamento:${chaveDaVenda}`,
    occurred_at: occurredAt,
    movement_type: "CANCELAMENTO_ML",
  };
}

/** A devolução é gravada com a origem do CLAIM; o pedido só aparece DENTRO da chave. */
function devolucao(claim: string, chaveDaVenda: string, quantidade: number, occurredAt: string): MovimentoRow {
  return {
    source_type: "CLAIM",
    source_id: claim,
    sku_id: "SKU-A",
    qty_delta: quantidade,
    idempotency_key: `devolucao:${claim}:${chaveDaVenda}`,
    occurred_at: occurredAt,
    movement_type: "DEVOLUCAO_ML",
  };
}

function anulacao(chaveDaReversao: string, orderId: number, quantidade: number, occurredAt: string): MovimentoRow {
  return {
    source_type: "ORDER",
    source_id: String(orderId),
    sku_id: "SKU-A",
    qty_delta: -quantidade,
    idempotency_key: `estorno:${chaveDaReversao}`,
    occurred_at: occurredAt,
    movement_type: "ESTORNO_REVERSAO_EXCEDENTE",
  };
}

interface UpdateChamada {
  patch: Record<string, unknown>;
  id: number | null;
  /** O `is("logistic_captured_at", null)` do WHERE — a guarda de R5. */
  exigiuCapturaNula: boolean;
}

interface FakeOptions {
  ledger?: MovimentoRow[];
  orders?: OrderRow[];
  accountStatus?: string;
  /** Faz o upsert de um movimento falhar (timeout, 5xx do PostgREST). */
  falhaNoMovimento?: (row: Record<string, unknown>) => boolean;
  /** Faz o UPDATE da captura falhar. */
  falhaNaCaptura?: boolean;
  /**
   * Outro escritor carimba a captura entre a leitura dos pedidos e o UPDATE da
   * varredura — o `is null` do WHERE não casa nenhuma linha.
   */
  capturaConcorrente?: { logistic_type: string | null; logistic_captured_at: string };
}

/**
 * O banco falso, com ESTADO: o movimento gravado entra no ledger (com o
 * `ON CONFLICT DO NOTHING` da chave) e a captura gravada muda o pedido. É o que
 * deixa um teste rodar a varredura duas vezes e ver o que a segunda rodada
 * encontra depois de uma falha no meio da primeira.
 */
function fakeDb(options: FakeOptions): {
  db: SyncOrderLogisticsDeps["db"];
  movimentos: Record<string, unknown>[];
  pacotes: Record<string, unknown>[];
  updates: UpdateChamada[];
  ledger: MovimentoRow[];
  orders: OrderRow[];
  consultasDeOrders: { filtro: string; ids: number[] }[];
} {
  const ledger = [...(options.ledger ?? [])];
  const orders = (options.orders ?? []).map((row) => ({ ...row }));
  const movimentos: Record<string, unknown>[] = [];
  const pacotes: Record<string, unknown>[] = [];
  const updates: UpdateChamada[] = [];
  const consultasDeOrders: { filtro: string; ids: number[] }[] = [];

  const credentials = {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  };

  /** A leitura do ledger: aplica o `in("movement_type", ...)` como o PostgREST. */
  function rangeChain(): unknown {
    let tipos: string[] | null = null;
    const self = {
      eq: () => self,
      in: (coluna: string, valores: string[]) => {
        if (coluna === "movement_type") tipos = valores;

        return self;
      },
      order: () => self,
      range: (from: number, to: number) => {
        const filtradas = ledger
          .filter((row) => tipos === null || tipos.includes(row.movement_type))
          .map((row) => ({ source_type: "ORDER", ...row }));

        return Promise.resolve({ data: filtradas.slice(from, to + 1), error: null });
      },
    };

    return self;
  }

  /**
   * Leitura de `orders`, que se resolve no `await` direto. Os dois filtros do
   * handler são aplicados como o PostgREST aplicaria — e só eles: um filtro
   * diferente LANÇA, para o teste reprovar se a consulta mudar de forma.
   */
  function listChain(): unknown {
    let filtro = "nenhum";
    const self = {
      eq: () => self,
      or: (valor: string) => {
        if (valor !== "logistic_captured_at.is.null,logistic_type.eq.fulfillment") {
          throw new Error(`filtro inesperado em orders: ${valor}`);
        }

        filtro = "abertos";

        return self;
      },
      is: (coluna: string, valor: unknown) => {
        if (coluna !== "logistic_captured_at" || valor !== null) {
          throw new Error(`filtro inesperado em orders: ${coluna} is ${String(valor)}`);
        }

        filtro = "soSemCaptura";

        return self;
      },
      in: (_coluna: string, ids: number[]) => ({
        then: (resolve: (value: unknown) => unknown) => {
          consultasDeOrders.push({ filtro, ids });

          return Promise.resolve({
            data: orders
              .filter(
                (row) =>
                  ids.includes(row.id) &&
                  (filtro === "abertos"
                    ? row.logistic_captured_at === null || row.logistic_type === "fulfillment"
                    : filtro === "soSemCaptura"
                      ? row.logistic_captured_at === null
                      : true),
              )
              .map((row) => ({ ...row })),
            error: null,
          }).then(resolve);
        },
      }),
    };

    return self;
  }

  function maybeSingleChain(result: unknown): unknown {
    const self = {
      eq: () => self,
      maybeSingle: () => Promise.resolve({ data: result, error: null }),
    };

    return self;
  }

  const db = {
    from: (table: string) => ({
      select: () => {
        if (table === "ml_accounts") {
          return maybeSingleChain({
            id: ML_ACCOUNT_ID,
            organization_id: ORGANIZATION_ID,
            status: options.accountStatus ?? "CONNECTED",
          });
        }

        if (table === "ml_credentials") {
          return maybeSingleChain(credentials);
        }

        if (table === "stock_movements") {
          return rangeChain();
        }

        if (table === "orders") {
          return listChain();
        }

        return maybeSingleChain(null);
      },
      update: (patch: Record<string, unknown>) => {
        const chamada: UpdateChamada = { patch, id: null, exigiuCapturaNula: false };

        updates.push(chamada);

        const resolver = (): { data: { id: number }[] | null; error: { message: string } | null } => {
          if (options.falhaNaCaptura === true) {
            return { data: null, error: { message: "canceling statement due to statement timeout" } };
          }

          const alvo = orders.find((row) => row.id === chamada.id);

          if (options.capturaConcorrente !== undefined && alvo !== undefined) {
            Object.assign(alvo, options.capturaConcorrente);
          }

          if (alvo === undefined || (chamada.exigiuCapturaNula && alvo.logistic_captured_at !== null)) {
            return { data: [], error: null };
          }

          Object.assign(alvo, patch);

          return { data: [{ id: alvo.id }], error: null };
        };

        const self = {
          eq: (_coluna: string, valor: number) => {
            chamada.id = valor;

            return self;
          },
          is: (coluna: string, valor: unknown) => {
            if (coluna === "logistic_captured_at" && valor === null) {
              chamada.exigiuCapturaNula = true;
            }

            return self;
          },
          select: () => Promise.resolve(resolver()),
        };

        return self;
      },
      upsert: (row: Record<string, unknown>) => {
        // D-405: as medidas do pacote do envio, fora do ledger.
        if (table === "shipment_packages") {
          pacotes.push(row);

          return Promise.resolve({ error: null });
        }

        if (options.falhaNoMovimento?.(row) === true) {
          return Promise.resolve({ error: { message: "canceling statement due to statement timeout", code: "57014" } });
        }

        movimentos.push(row);

        if (!ledger.some((linha) => linha.idempotency_key === row.idempotency_key)) {
          ledger.push(row as unknown as MovimentoRow);
        }

        return Promise.resolve({ error: null });
      },
    }),
    rpc: () => {
      throw new Error("a varredura nao chama RPC: as devolucoes vem do proprio ledger");
    },
  } as unknown as SyncOrderLogisticsDeps["db"];

  return { db, movimentos, updates, ledger, orders, consultasDeOrders, pacotes };
}

/** `FALHA` = o Mercado Livre respondeu 500 depois das tentativas; `null` = respondeu e não disse a logística. */
const FALHA = Symbol("falha na leitura do envio");

function erroDoMl(status: number, errorClass: "retryable" | "not_retryable"): MercadoLivreApiError {
  return new MercadoLivreApiError(`Mercado Livre respondeu ${String(status)}`, {
    status,
    errorClass,
    url: "https://api.mercadolibre.com/shipments/x",
  });
}

function fakeClient(
  logisticaPorEnvio: Record<string, string | null | typeof FALHA | Error>,
  itensPorEnvio: Record<string, unknown> = {},
): {
  client: MercadoLivreClient;
  calls: string[];
} {
  const calls: string[] = [];

  const client = {
    request: (request: RequestOptions<unknown>) => {
      calls.push(request.path);

      const envio = request.path.replace("/shipments/", "");
      const resposta = logisticaPorEnvio[envio];

      if (resposta === FALHA) {
        return Promise.reject(erroDoMl(500, "retryable"));
      }

      if (resposta instanceof Error) {
        return Promise.reject(resposta);
      }

      // Passa pelo `schema.parse` como o cliente real: um corpo fora do
      // contrato lançaria o mesmo ZodError aqui.
      return Promise.resolve(
        request.schema.parse({ logistic_type: resposta ?? null, shipping_items: itensPorEnvio[envio] }),
      );
    },
  } as unknown as MercadoLivreClient;

  return { client, calls };
}

function run(
  db: SyncOrderLogisticsDeps["db"],
  client: MercadoLivreClient,
  sleeps: number[] = [],
  now: () => Date = () => NOW,
): Promise<{ outcome: unknown; lines: string[] }> {
  const handler = createSyncOrderLogisticsHandler({
    db,
    mercadoLivre: client,
    oauth: { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" },
    encryptionKey: ENCRYPTION_KEY,
    now,
    sleep: (ms) => {
      sleeps.push(ms);

      return Promise.resolve();
    },
  });

  const lines: string[] = [];

  return handler(ENVELOPE, {
    logger: createLogger({}, { sink: (line) => lines.push(line) }),
    payload: { mlAccountId: ML_ACCOUNT_ID },
  }).then((outcome) => ({ outcome, lines }));
}

/** O objeto do log `sync_order_logistics_done` da rodada. */
function resumo(lines: string[]): Record<string, unknown> {
  const linha = lines.find((line) => line.includes("sync_order_logistics_done"));

  expect(linha).toBeDefined();

  return JSON.parse(linha ?? "{}") as Record<string, unknown>;
}

/** A soma LOCAL de um pedido no ledger, com a devolução (origem do claim) pela chave. */
function somaDoPedido(ledger: MovimentoRow[], orderId: number): number {
  const pedido = String(orderId);

  return ledger
    .filter(
      (row) =>
        row.source_id === pedido ||
        (row.movement_type === "DEVOLUCAO_ML" && row.idempotency_key.split(":")[3] === pedido),
    )
    .reduce((total, row) => total + row.qty_delta, 0);
}

describe("sync.order-logistics (D-352, R2)", () => {
  it("D-405: a mesma leitura grava as medidas do pacote, sem movimento, e conta no resumo", async () => {
    const { db, movimentos, pacotes } = fakeDb({
      ledger: [venda(9002, "SKU-B", 1, "2026-09-12T18:00:00.000Z")],
      orders: [{ id: 9002, shipping_id: 5002, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient(
      { "5002": "cross_docking" },
      {
        "5002": [
          {
            id: "MLB1382501176",
            quantity: 1,
            dimensions: "4.0x19.0x26.0,710.0",
            dimensions_source: { origin: "bmp", id: "MLB1382501176__1" },
          },
        ],
      },
    );

    const { lines } = await run(db, client);

    expect(movimentos).toEqual([]);
    expect(pacotes).toEqual([
      {
        order_id: 9002,
        organization_id: ORGANIZATION_ID,
        ml_account_id: ML_ACCOUNT_ID,
        shipping_id: 5002,
        item_id: "MLB1382501176",
        items_in_shipment: 1,
        dimensions_raw: "4.0x19.0x26.0,710.0",
        weight_g: 710,
        volume_cm3: 1976,
        largest_side_cm: 26,
        dimensions_origin: "bmp",
        captured_at: NOW.toISOString(),
      },
    ]);
    expect(resumo(lines)).toMatchObject({ capturados: 1, pacotes: 1 });
  });

  it("pedido pendente do Full: grava o ESTORNO_FULL espelhado e carimba a captura", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [venda(9001, "SKU-A", 2, "2026-09-12T18:00:00.000Z")],
      orders: [{ id: 9001, shipping_id: 5001, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({ "5001": "fulfillment" });

    const { outcome, lines } = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(calls).toEqual(["/shipments/5001"]);
    expect(movimentos).toEqual([
      expect.objectContaining({
        organization_id: ORGANIZATION_ID,
        sku_id: "SKU-A",
        // Quantidade OPOSTA e `occurred_at` ESPELHADO da venda gravada: o par
        // soma zero no saldo E no alvo (as duas linhas do mesmo lado do corte).
        qty_delta: 2,
        movement_type: "ESTORNO_FULL",
        source_type: "ORDER",
        source_id: "9001",
        idempotency_key: "estorno:venda:9001:1",
        occurred_at: "2026-09-12T18:00:00.000Z",
        location_kind: "LOCAL",
      }),
    ]);
    expect(updates).toEqual([
      {
        patch: { logistic_type: "fulfillment", logistic_captured_at: NOW.toISOString() },
        id: 9001,
        exigiuCapturaNula: true,
      },
    ]);
    expect(resumo(lines)).toMatchObject({ pendentes: 1, capturados: 1, full: 1, estornos: 1, restantes: 0 });
  });

  it("a CAPTURA sai antes dos movimentos, e o ESTORNO_FULL por último (revisão de 6965b0e, MÉDIA)", async () => {
    const { db } = fakeDb({
      ledger: [
        venda(9001, "SKU-A", 1, "2026-09-12T18:00:00.000Z"),
        cancelamento(9001, "venda:9001:1", 1, "2026-09-13T08:30:00.000Z"),
      ],
      orders: [{ id: 9001, shipping_id: 5001, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient({ "5001": "fulfillment" });
    const ordem: string[] = [];
    const espiao = {
      from: (table: string) => {
        const alvo = (db as unknown as { from: (t: string) => Record<string, unknown> }).from(table);

        return {
          ...alvo,
          upsert: (row: Record<string, unknown>) => {
            ordem.push(`movimento:${String(row.movement_type)}`);

            return (alvo.upsert as (r: Record<string, unknown>) => unknown)(row);
          },
          update: (patch: Record<string, unknown>) => {
            ordem.push("captura");

            return (alvo.update as (p: Record<string, unknown>) => unknown)(patch);
          },
        };
      },
      rpc: (db as unknown as { rpc: unknown }).rpc,
    } as unknown as SyncOrderLogisticsDeps["db"];

    await run(espiao, client);

    expect(ordem).toEqual(["captura", "movimento:ESTORNO_REVERSAO_EXCEDENTE", "movimento:ESTORNO_FULL"]);
  });

  it("cross_docking: carimba a captura e NÃO grava movimento — a venda continua baixando a loja", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [venda(9002, "SKU-B", 1, "2026-09-12T18:00:00.000Z")],
      orders: [{ id: 9002, shipping_id: 5002, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient({ "5002": "cross_docking" });

    const { lines } = await run(db, client);

    expect(movimentos).toEqual([]);
    expect(updates[0]?.patch).toEqual({
      logistic_type: "cross_docking",
      logistic_captured_at: NOW.toISOString(),
    });
    expect(resumo(lines)).toMatchObject({ full: 0, estornos: 0, capturados: 1 });
  });

  it("envio lido sem logística: é RESPOSTA, não pendência — carimba a captura com o tipo nulo e baixa a loja", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [venda(9003, "SKU-C", 1, "2026-09-12T18:00:00.000Z")],
      orders: [{ id: 9003, shipping_id: 5003, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient({ "5003": null });

    await run(db, client);

    expect(movimentos).toEqual([]);
    expect(updates[0]?.patch).toEqual({ logistic_type: null, logistic_captured_at: NOW.toISOString() });
  });

  it("o ESTORNO_FULL já gravado também conta como estornada — a rodada seguinte não o recalcula", async () => {
    const { db, movimentos } = fakeDb({
      ledger: [venda(9005, "SKU-E", 1, "2026-09-12T18:00:00.000Z"), estorno("venda:9005:1", "ESTORNO_FULL", 9005)],
      orders: [
        { id: 9005, shipping_id: 5005, logistic_type: "fulfillment", logistic_captured_at: NOW.toISOString() },
      ],
    });
    const { client, calls } = fakeClient({ "5005": "fulfillment" });

    await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
  });

  it("já capturado como fulfillment com o estorno faltando: fecha pelo valor PERSISTIDO, sem ida à rede (R5)", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [venda(9006, "SKU-F", 3, "2026-09-11T12:00:00.000Z")],
      orders: [
        {
          id: 9006,
          shipping_id: 5006,
          logistic_type: "fulfillment",
          logistic_captured_at: "2026-09-17T20:00:00.000Z",
        },
      ],
    });
    const { client, calls } = fakeClient({ "5006": "cross_docking" });

    const { lines } = await run(db, client);

    // Nenhuma chamada: quem já decidiu não relê, e o valor lido NUNCA passa por
    // cima do persistido.
    expect(calls).toEqual([]);
    expect(movimentos).toEqual([
      expect.objectContaining({ movement_type: "ESTORNO_FULL", qty_delta: 3, idempotency_key: "estorno:venda:9006:1" }),
    ]);
    // A captura não é reescrita: ela já existe.
    expect(updates).toEqual([]);
    expect(resumo(lines)).toMatchObject({ capturados: 0, full: 1, estornos: 1 });
  });

  it("já capturado como NÃO-Full com a venda sem estorno: fora do conjunto — nenhuma chamada, pendentes 0", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [venda(9007, "SKU-G", 1, "2026-09-11T12:00:00.000Z")],
      orders: [
        {
          id: 9007,
          shipping_id: 5007,
          logistic_type: "drop_off",
          logistic_captured_at: "2026-09-17T20:00:00.000Z",
        },
      ],
    });
    const { client, calls } = fakeClient({ "5007": "fulfillment" });

    const { lines } = await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
    expect(updates).toEqual([]);
    // A venda legítima continua "sem par" para sempre: se o pedido dela entrasse
    // no conjunto, `pendentes` nunca zeraria.
    expect(resumo(lines)).toMatchObject({ pendentes: 0, restantes: 0 });
  });

  it("id REAL do Mercado Livre (16 dígitos): o pedido é varrido, e o estorno sai com a origem certa", async () => {
    // Pedido e envio lidos de verdade em 17/09 (`docs/MERCADO_LIVRE.md` 2.17).
    const { db, movimentos, updates } = fakeDb({
      ledger: [venda(2000018515005942, "SKU-REAL", 1, "2026-09-17T15:02:11.000Z")],
      orders: [{ id: 2000018515005942, shipping_id: 48041052940, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({ "48041052940": "fulfillment" });

    await run(db, client);

    expect(calls).toEqual(["/shipments/48041052940"]);
    expect(movimentos).toEqual([
      expect.objectContaining({
        movement_type: "ESTORNO_FULL",
        source_id: "2000018515005942",
        idempotency_key: "estorno:venda:2000018515005942:1",
        qty_delta: 1,
      }),
    ]);
    expect(updates[0]?.id).toBe(2000018515005942);
  });

  it("id acima do inteiro seguro: não vira pedido — arredondado, a consulta traria OUTRO", async () => {
    const { db, movimentos, consultasDeOrders } = fakeDb({
      ledger: [{ ...venda(1, "SKU-U", 1, "2026-09-11T12:00:00.000Z"), source_id: "9007199254740993" }],
      // `Number("9007199254740993")` é 9007199254740992: o pedido vizinho.
      orders: [{ id: 9007199254740992, shipping_id: 5070, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({ "5070": "fulfillment" });

    const { lines } = await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
    // Nem chega a consultar: o vizinho não entra na rodada como se fosse ele.
    expect(consultasDeOrders).toEqual([]);
    expect(resumo(lines)).toMatchObject({ pendentes: 0 });
  });

  it("teto de CHAMADAS por rodada: o excedente fica para a próxima, e o já capturado depois dele fecha mesmo assim", async () => {
    const semCaptura = Array.from({ length: 801 }, (_, i) => 10_000 + i);
    const jaCapturado = 20_000;
    const { db, movimentos } = fakeDb({
      ledger: [...semCaptura, jaCapturado].map((id) => venda(id, "SKU-V", 1, "2026-09-11T12:00:00.000Z")),
      orders: [
        ...semCaptura.map((id) => ({ id, shipping_id: id + 1, logistic_type: null, logistic_captured_at: null })),
        {
          id: jaCapturado,
          shipping_id: jaCapturado + 1,
          logistic_type: "fulfillment",
          logistic_captured_at: "2026-09-17T20:00:00.000Z",
        },
      ],
    });
    const { client, calls } = fakeClient(
      Object.fromEntries(semCaptura.map((id) => [String(id + 1), "cross_docking"])),
    );

    const { lines } = await run(db, client);

    expect(calls).toHaveLength(800);
    expect(calls).not.toContain("/shipments/10801");
    // O pedido do Full já capturado vem DEPOIS do 801º na ordem por id, e não
    // gasta chamada: o teto não pode segurá-lo.
    expect(movimentos).toEqual([
      expect.objectContaining({ movement_type: "ESTORNO_FULL", source_id: String(jaCapturado) }),
    ]);
    expect(resumo(lines)).toMatchObject({ pendentes: 802, full: 1, adiados: 1, restantes: 1 });
  });

  it("teto de TEMPO de rede: passados 7 min, o resto fica para a próxima rodada — dentro do prazo do Cloud Tasks", async () => {
    const ids = [9101, 9102, 9103, 9104];
    const { db } = fakeDb({
      ledger: ids.map((id) => venda(id, "SKU-T", 1, "2026-09-11T12:00:00.000Z")),
      orders: ids.map((id) => ({ id, shipping_id: id + 1, logistic_type: null, logistic_captured_at: null })),
    });
    const { client, calls } = fakeClient(Object.fromEntries(ids.map((id) => [String(id + 1), "cross_docking"])));
    // Cada leitura do relógio anda 3 min: a API ficou lenta.
    let tique = 0;
    const relogio = (): Date => new Date(NOW.getTime() + tique++ * 3 * 60_000);

    const { outcome, lines } = await run(db, client, [], relogio);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.length).toBeLessThan(ids.length);
    expect(outcome).toMatchObject({ status: "done" });
    expect(resumo(lines)).toMatchObject({ adiados: ids.length - calls.length });
  });

  it("pedido sem shipping_id: declarado em sem_envio, nunca escondido num sucesso", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [venda(9009, "SKU-I", 1, "2026-09-11T12:00:00.000Z")],
      orders: [{ id: 9009, shipping_id: null, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({});

    const { lines } = await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
    expect(updates).toEqual([]);
    expect(resumo(lines)).toMatchObject({ sem_envio: 1, restantes: 1 });
  });

  it("pedido do Full com CANCELAMENTO_ML gravado: anula a reversão INTEIRA, espelhando o instante dela", async () => {
    const { db, movimentos, ledger } = fakeDb({
      ledger: [
        venda(9010, "SKU-J", 1, "2026-09-11T12:00:00.000Z"),
        cancelamento(9010, "venda:9010:1", 1, "2026-09-13T08:30:00.000Z"),
      ],
      orders: [{ id: 9010, shipping_id: 5010, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient({ "5010": "fulfillment" });

    await run(db, client);

    expect(movimentos).toEqual([
      expect.objectContaining({
        movement_type: "ESTORNO_REVERSAO_EXCEDENTE",
        // O sinal da VENDA: a reversão devolveu a unidade, a anulação a tira de
        // novo. Soma final do pedido: -1 +1 +1 -1 = 0.
        qty_delta: -1,
        idempotency_key: "estorno:cancelamento:venda:9010:1",
        occurred_at: "2026-09-13T08:30:00.000Z",
      }),
      expect.objectContaining({
        movement_type: "ESTORNO_FULL",
        qty_delta: 1,
        idempotency_key: "estorno:venda:9010:1",
        occurred_at: "2026-09-11T12:00:00.000Z",
      }),
    ]);
    expect(somaDoPedido(ledger, 9010)).toBe(0);
  });

  it("pedido do Full com DEVOLUCAO_ML (origem do claim, achada pela chave no próprio ledger): a anulação dela também sai", async () => {
    const { db, movimentos, ledger } = fakeDb({
      ledger: [
        venda(9011, "SKU-K", 1, "2026-09-11T12:00:00.000Z"),
        devolucao("CLAIM-7", "venda:9011:1", 1, "2026-09-14T22:00:00.000Z"),
      ],
      orders: [{ id: 9011, shipping_id: 5011, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient({ "5011": "fulfillment" });

    await run(db, client);

    expect(movimentos).toEqual([
      expect.objectContaining({
        movement_type: "ESTORNO_REVERSAO_EXCEDENTE",
        qty_delta: -1,
        idempotency_key: "estorno:devolucao:CLAIM-7:venda:9011:1",
        occurred_at: "2026-09-14T22:00:00.000Z",
        // A origem é a do PEDIDO, e não a do claim: é por ela que a anulação é achada.
        source_type: "ORDER",
        source_id: "9011",
      }),
      expect.objectContaining({ movement_type: "ESTORNO_FULL" }),
    ]);
    expect(somaDoPedido(ledger, 9011)).toBe(0);
  });

  it("KIT: um ESTORNO_FULL por componente, cada um espelhando a própria linha", async () => {
    const { db, movimentos } = fakeDb({
      ledger: [
        {
          source_id: "9012",
          sku_id: "COMP-1",
          qty_delta: -2,
          idempotency_key: "venda:9012:1:COMP-1",
          occurred_at: "2026-09-11T12:00:00.000Z",
          movement_type: "VENDA_ML",
        },
        {
          source_id: "9012",
          sku_id: "COMP-2",
          qty_delta: -4,
          idempotency_key: "venda:9012:1:COMP-2",
          occurred_at: "2026-09-11T12:00:00.000Z",
          movement_type: "VENDA_ML",
        },
      ],
      orders: [{ id: 9012, shipping_id: 5012, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient({ "5012": "fulfillment" });

    await run(db, client);

    expect(movimentos.map((row) => [row.sku_id, row.qty_delta, row.idempotency_key])).toEqual([
      ["COMP-1", 2, "estorno:venda:9012:1:COMP-1"],
      ["COMP-2", 4, "estorno:venda:9012:1:COMP-2"],
    ]);
  });

  it("espaçamento entre pedidos: nenhum antes do primeiro, um entre cada par (como em sync-order-financials)", async () => {
    const { db } = fakeDb({
      ledger: [
        venda(9013, "SKU-L", 1, "2026-09-11T12:00:00.000Z"),
        venda(9014, "SKU-M", 1, "2026-09-11T12:00:00.000Z"),
        venda(9015, "SKU-N", 1, "2026-09-11T12:00:00.000Z"),
      ],
      orders: [
        { id: 9013, shipping_id: 5013, logistic_type: null, logistic_captured_at: null },
        { id: 9014, shipping_id: 5014, logistic_type: null, logistic_captured_at: null },
        { id: 9015, shipping_id: 5015, logistic_type: null, logistic_captured_at: null },
      ],
    });
    const { client, calls } = fakeClient({ "5013": "cross_docking", "5014": "cross_docking", "5015": "cross_docking" });
    const sleeps: number[] = [];

    await run(db, client, sleeps);

    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([150, 150]);
  });

  it("a ordem é por id, e é determinística: a rodada seguinte continua de onde esta parou", async () => {
    const { db } = fakeDb({
      ledger: [
        venda(9030, "SKU-O", 1, "2026-09-11T12:00:00.000Z"),
        venda(9020, "SKU-P", 1, "2026-09-11T12:00:00.000Z"),
      ],
      orders: [
        { id: 9030, shipping_id: 5030, logistic_type: null, logistic_captured_at: null },
        { id: 9020, shipping_id: 5020, logistic_type: null, logistic_captured_at: null },
      ],
    });
    const { client, calls } = fakeClient({ "5020": "cross_docking", "5030": "cross_docking" });

    await run(db, client);

    expect(calls).toEqual(["/shipments/5020", "/shipments/5030"]);
  });

  it("pendência de OUTRA conta da mesma organização não é varrida aqui, e não vira falha", async () => {
    const { db, movimentos } = fakeDb({
      ledger: [venda(9040, "SKU-Q", 1, "2026-09-11T12:00:00.000Z")],
      // A consulta de `orders` filtra por `ml_account_id`: o pedido não volta.
      orders: [],
    });
    const { client, calls } = fakeClient({});

    const { outcome, lines } = await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(resumo(lines)).toMatchObject({ pendentes: 0 });
  });

  it("conta não CONNECTED: não lê o ledger, não chama o Mercado Livre", async () => {
    const { db, movimentos } = fakeDb({
      accountStatus: "DISCONNECTED",
      ledger: [venda(9050, "SKU-R", 1, "2026-09-11T12:00:00.000Z")],
      orders: [{ id: 9050, shipping_id: 5050, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({ "5050": "fulfillment" });

    const { outcome } = await run(db, client);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
  });

  it("payload sem mlAccountId: falha NÃO retryable — repetir não conserta um payload errado", async () => {
    const { db } = fakeDb({});
    const { client } = fakeClient({});
    const handler = createSyncOrderLogisticsHandler({
      db,
      mercadoLivre: client,
      oauth: { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" },
      encryptionKey: ENCRYPTION_KEY,
    });

    const outcome = await handler(ENVELOPE, {
      logger: createLogger({}, { sink: () => undefined }),
      payload: {},
    });

    expect(outcome).toEqual({ status: "failed", retryable: false, reason: "payload sem mlAccountId" });
  });

  it("movimento de origem ilegível não vira pedido: nenhuma consulta com id inválido", async () => {
    const { db, movimentos } = fakeDb({
      ledger: [
        { ...venda(9060, "SKU-S", 1, "2026-09-11T12:00:00.000Z"), source_id: "pack-abc" },
        { ...venda(9061, "SKU-T", 1, "2026-09-11T12:00:00.000Z"), source_id: null },
      ],
      orders: [{ id: 9060, shipping_id: 5060, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({ "5060": "fulfillment" });

    const { outcome } = await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
    expect(outcome).toEqual({ status: "done", processed: 0 });
  });
});

describe("sync.order-logistics — a venda JÁ estornada pela D-351 também recebe o sinal (revisão de 6965b0e, ALTA)", () => {
  it("venda pré-capturada sem reversão: o envio É lido e a captura carimbada — nenhum movimento, porque nada está aberto", async () => {
    const { db, movimentos, updates, consultasDeOrders } = fakeDb({
      ledger: [
        venda(9004, "SKU-D", 1, "2026-09-12T18:00:00.000Z"),
        estorno("venda:9004:1", "ESTORNO_PRE_CAPTURA", 9004),
      ],
      orders: [{ id: 9004, shipping_id: 5004, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({ "5004": "fulfillment" });

    const { outcome, lines } = await run(db, client);

    // O cancelamento ou a devolução que vier depois vai precisar do sinal (R3):
    // sem ele, sairia pelo caminho não-Full e voltaria +1 à loja.
    expect(calls).toEqual(["/shipments/5004"]);
    expect(updates).toEqual([
      {
        patch: { logistic_type: "fulfillment", logistic_captured_at: NOW.toISOString() },
        id: 9004,
        exigiuCapturaNula: true,
      },
    ]);
    expect(movimentos).toEqual([]);
    // Pedido fechado só é pedido SEM captura: o já capturado não volta.
    expect(consultasDeOrders).toEqual([{ filtro: "soSemCaptura", ids: [9004] }]);
    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(resumo(lines)).toMatchObject({ pendentes: 1, capturados: 1, full: 1, estornos: 0, anulacoes: 0 });
  });

  it("o caso da revisão (P1): VENDA + ESTORNO_PRE_CAPTURA + CANCELAMENTO_ML de pedido do Full — a anulação sai e o pedido soma zero", async () => {
    const { db, movimentos, ledger } = fakeDb({
      ledger: [
        venda(9070, "SKU-A", 1, "2026-09-10T12:00:00.000Z"),
        estorno("venda:9070:1", "ESTORNO_PRE_CAPTURA", 9070),
        cancelamento(9070, "venda:9070:1", 1, "2026-09-16T08:30:00.000Z"),
      ],
      orders: [{ id: 9070, shipping_id: 5070, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({ "5070": "fulfillment" });

    expect(somaDoPedido(ledger, 9070)).toBe(1);

    await run(db, client);

    expect(calls).toEqual(["/shipments/5070"]);
    // Nenhum segundo estorno da venda: ela já tem o da D-351 (um por venda).
    expect(movimentos.map((row) => [row.movement_type, row.qty_delta, row.idempotency_key, row.occurred_at])).toEqual([
      ["ESTORNO_REVERSAO_EXCEDENTE", -1, "estorno:cancelamento:venda:9070:1", "2026-09-16T08:30:00.000Z"],
    ]);
    expect(somaDoPedido(ledger, 9070)).toBe(0);
  });

  it("a DEVOLUCAO_ML de venda pré-capturada de pedido do Full também é anulada", async () => {
    const { db, movimentos, ledger } = fakeDb({
      ledger: [
        venda(9071, "SKU-A", 1, "2026-09-10T12:00:00.000Z"),
        estorno("venda:9071:1", "ESTORNO_PRE_CAPTURA", 9071),
        devolucao("CLAIM-9", "venda:9071:1", 1, "2026-09-16T10:00:00.000Z"),
      ],
      orders: [{ id: 9071, shipping_id: 5071, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient({ "5071": "fulfillment" });

    await run(db, client);

    expect(movimentos.map((row) => [row.movement_type, row.idempotency_key])).toEqual([
      ["ESTORNO_REVERSAO_EXCEDENTE", "estorno:devolucao:CLAIM-9:venda:9071:1"],
    ]);
    expect(somaDoPedido(ledger, 9071)).toBe(0);
  });

  it("contraprova FORA do Full: o mesmo trio de um pedido cross_docking só carimba — o +1 do cancelamento é legítimo", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [
        venda(9072, "SKU-A", 1, "2026-09-10T12:00:00.000Z"),
        estorno("venda:9072:1", "ESTORNO_PRE_CAPTURA", 9072),
        cancelamento(9072, "venda:9072:1", 1, "2026-09-16T08:30:00.000Z"),
      ],
      orders: [{ id: 9072, shipping_id: 5072, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient({ "5072": "cross_docking" });

    await run(db, client);

    expect(movimentos).toEqual([]);
    expect(updates[0]?.patch).toMatchObject({ logistic_type: "cross_docking" });
  });

  it("pedido pré-capturado já capturado como NÃO-Full com o cancelamento aberto: fora do conjunto, nenhuma chamada", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [
        venda(9073, "SKU-A", 1, "2026-09-10T12:00:00.000Z"),
        estorno("venda:9073:1", "ESTORNO_PRE_CAPTURA", 9073),
        cancelamento(9073, "venda:9073:1", 1, "2026-09-16T08:30:00.000Z"),
      ],
      orders: [
        { id: 9073, shipping_id: 5073, logistic_type: "cross_docking", logistic_captured_at: "2026-09-17T20:00:00.000Z" },
      ],
    });
    const { client, calls } = fakeClient({ "5073": "fulfillment" });

    const { lines } = await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
    expect(updates).toEqual([]);
    expect(resumo(lines)).toMatchObject({ pendentes: 0 });
  });

  it("pedido pré-capturado FECHADO e já capturado: nem entra na rodada", async () => {
    const { db, movimentos } = fakeDb({
      ledger: [
        venda(9074, "SKU-A", 1, "2026-09-10T12:00:00.000Z"),
        estorno("venda:9074:1", "ESTORNO_PRE_CAPTURA", 9074),
      ],
      orders: [
        { id: 9074, shipping_id: 5074, logistic_type: "fulfillment", logistic_captured_at: "2026-09-17T20:00:00.000Z" },
      ],
    });
    const { client, calls } = fakeClient({ "5074": "fulfillment" });

    const { lines } = await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
    expect(resumo(lines)).toMatchObject({ pendentes: 0 });
  });

  it("a anulação que já existe (a parcial da D-351 §12) fecha a reversão: nada é regravado por cima dela", async () => {
    const { db, movimentos } = fakeDb({
      ledger: [
        venda(9075, "SKU-A", 1, "2026-09-10T12:00:00.000Z"),
        estorno("venda:9075:1", "ESTORNO_PRE_CAPTURA", 9075),
        cancelamento(9075, "venda:9075:1", 1, "2026-09-16T08:30:00.000Z"),
        anulacao("cancelamento:venda:9075:1", 9075, 1, "2026-09-16T08:30:00.000Z"),
      ],
      orders: [{ id: 9075, shipping_id: 5075, logistic_type: null, logistic_captured_at: null }],
    });
    const { client } = fakeClient({ "5075": "fulfillment" });

    await run(db, client);

    expect(movimentos).toEqual([]);
  });
});

describe("sync.order-logistics — falha no meio da rodada (revisão de 6965b0e, MÉDIA)", () => {
  const CANCELADO_ANTES_DO_SINAL = (): FakeOptions => ({
    ledger: [
      venda(9010, "SKU-A", 1, "2026-09-11T12:00:00.000Z"),
      cancelamento(9010, "venda:9010:1", 1, "2026-09-13T08:30:00.000Z"),
    ],
    orders: [{ id: 9010, shipping_id: 5010, logistic_type: null, logistic_captured_at: null }],
  });

  it("a anulação falha: a rodada lança, e a seguinte fecha o pedido SEM ida à rede — soma zero", async () => {
    let falhar = true;
    const fake = fakeDb({
      ...CANCELADO_ANTES_DO_SINAL(),
      falhaNoMovimento: (row) => falhar && row.movement_type === "ESTORNO_REVERSAO_EXCEDENTE",
    });
    const { client, calls } = fakeClient({ "5010": "fulfillment" });

    await expect(run(fake.db, client)).rejects.toThrow(/ESTORNO_REVERSAO_EXCEDENTE/u);
    // A decisão já está gravada: o pedido saiu capturado, e ABERTO.
    expect(fake.orders[0]).toMatchObject({ logistic_type: "fulfillment" });

    falhar = false;
    await run(fake.db, client);

    expect(calls).toEqual(["/shipments/5010"]);
    expect(somaDoPedido(fake.ledger, 9010)).toBe(0);
    expect(fake.ledger.map((row) => row.movement_type)).toEqual([
      "VENDA_ML",
      "CANCELAMENTO_ML",
      "ESTORNO_REVERSAO_EXCEDENTE",
      "ESTORNO_FULL",
    ]);
  });

  it("o ESTORNO_FULL falha depois da anulação: a seguinte grava só o que falta", async () => {
    let falhar = true;
    const fake = fakeDb({
      ...CANCELADO_ANTES_DO_SINAL(),
      falhaNoMovimento: (row) => falhar && row.movement_type === "ESTORNO_FULL",
    });
    const { client, calls } = fakeClient({ "5010": "fulfillment" });

    await expect(run(fake.db, client)).rejects.toThrow(/ESTORNO_FULL/u);

    falhar = false;
    fake.movimentos.length = 0;
    await run(fake.db, client);

    expect(calls).toHaveLength(1);
    expect(fake.movimentos.map((row) => row.movement_type)).toEqual(["ESTORNO_FULL"]);
    expect(somaDoPedido(fake.ledger, 9010)).toBe(0);
  });

  it("a CAPTURA falha: nada foi gravado, e a seguinte lê o envio de novo e fecha", async () => {
    const primeira = fakeDb({ ...CANCELADO_ANTES_DO_SINAL(), falhaNaCaptura: true });
    const { client } = fakeClient({ "5010": "fulfillment" });

    await expect(run(primeira.db, client)).rejects.toThrow(/falha ao gravar a logistica do pedido 9010/u);
    expect(primeira.movimentos).toEqual([]);

    const segunda = fakeDb({ ledger: primeira.ledger, orders: primeira.orders });

    await run(segunda.db, client);

    expect(somaDoPedido(segunda.ledger, 9010)).toBe(0);
  });

  it("captura já carimbada como fulfillment com a reversão aberta e a venda com par: fecha sem rede", async () => {
    const { db, movimentos } = fakeDb({
      ledger: [
        venda(9076, "SKU-A", 1, "2026-09-11T12:00:00.000Z"),
        estorno("venda:9076:1", "ESTORNO_FULL", 9076),
        cancelamento(9076, "venda:9076:1", 1, "2026-09-13T08:30:00.000Z"),
      ],
      orders: [
        { id: 9076, shipping_id: 5076, logistic_type: "fulfillment", logistic_captured_at: "2026-09-17T20:00:00.000Z" },
      ],
    });
    const { client, calls } = fakeClient({});

    await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos.map((row) => row.movement_type)).toEqual(["ESTORNO_REVERSAO_EXCEDENTE"]);
  });

  it("outro escritor carimbou entre a leitura e o UPDATE: nenhum movimento — a decisão que vale é a gravada (R5)", async () => {
    const { db, movimentos, lines } = {
      ...fakeDb({
        ledger: [venda(9077, "SKU-A", 1, "2026-09-11T12:00:00.000Z")],
        orders: [{ id: 9077, shipping_id: 5077, logistic_type: null, logistic_captured_at: null }],
        capturaConcorrente: { logistic_type: "cross_docking", logistic_captured_at: "2026-09-18T08:59:00.000Z" },
      }),
      lines: [] as string[],
    };
    const { client } = fakeClient({ "5077": "fulfillment" });

    const resultado = await run(db, client);

    lines.push(...resultado.lines);
    expect(movimentos).toEqual([]);
    expect(resumo(lines)).toMatchObject({ concorrentes: 1, capturados: 0, full: 0, restantes: 1 });
  });
});

describe("sync.order-logistics — a política de erro da leitura do envio (revisão de 6965b0e, MÉDIA)", () => {
  function doisPendentes(): FakeOptions {
    return {
      ledger: [
        venda(9081, "SKU-A", 1, "2026-09-11T12:00:00.000Z"),
        venda(9082, "SKU-B", 1, "2026-09-11T12:00:00.000Z"),
      ],
      orders: [
        { id: 9081, shipping_id: 5081, logistic_type: null, logistic_captured_at: null },
        { id: 9082, shipping_id: 5082, logistic_type: null, logistic_captured_at: null },
      ],
    };
  }

  it("429 esgotado PARA a rodada: falha retryable, e nenhum outro pedido gasta a cota", async () => {
    const { db, movimentos, updates } = fakeDb(doisPendentes());
    const { client, calls } = fakeClient({ "5081": erroDoMl(429, "retryable"), "5082": "fulfillment" });

    const { outcome, lines } = await run(db, client);

    expect(calls).toEqual(["/shipments/5081"]);
    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(movimentos).toEqual([]);
    expect(updates).toEqual([]);
    expect(resumo(lines)).toMatchObject({ interrompida: true, restantes: 2 });
  });

  it("5xx esgotado também para a rodada", async () => {
    const { db } = fakeDb(doisPendentes());
    const { client, calls } = fakeClient({ "5081": FALHA, "5082": "fulfillment" });

    const { outcome } = await run(db, client);

    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("401 (token) para a rodada — carimbar o resto como resposta seria decidir o backlog inteiro por um token", async () => {
    const { db, updates } = fakeDb(doisPendentes());
    const { client, calls } = fakeClient({ "5081": erroDoMl(401, "not_retryable"), "5082": "fulfillment" });

    const { outcome } = await run(db, client);

    expect(calls).toHaveLength(1);
    expect(updates).toEqual([]);
    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("erro de transporte (fetch rejeitado) para a rodada", async () => {
    const { db } = fakeDb(doisPendentes());
    const { client, calls } = fakeClient({ "5081": new TypeError("fetch failed"), "5082": "fulfillment" });

    const { outcome } = await run(db, client);

    expect(calls).toHaveLength(1);
    expect(outcome).toMatchObject({ status: "failed", retryable: true });
  });

  it("404 é RESPOSTA: o envio não existe, a captura sai com o tipo nulo e o pedido deixa a fila para sempre", async () => {
    const { db, movimentos, updates } = fakeDb(doisPendentes());
    const { client, calls } = fakeClient({ "5081": erroDoMl(404, "not_retryable"), "5082": "cross_docking" });

    const { outcome, lines } = await run(db, client);

    expect(calls).toHaveLength(2);
    expect(updates[0]).toEqual({
      patch: { logistic_type: null, logistic_captured_at: NOW.toISOString() },
      id: 9081,
      exigiuCapturaNula: true,
    });
    expect(movimentos).toEqual([]);
    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(resumo(lines)).toMatchObject({ envio_inexistente: 1, falhas: 0, restantes: 0 });
  });

  it("403 do envio: pendente, contado em falhas, e a rodada segue para o próximo pedido", async () => {
    const { db, updates } = fakeDb(doisPendentes());
    const { client, calls } = fakeClient({ "5081": erroDoMl(403, "not_retryable"), "5082": "cross_docking" });

    const { outcome, lines } = await run(db, client);

    expect(calls).toEqual(["/shipments/5081", "/shipments/5082"]);
    expect(updates.map((update) => update.id)).toEqual([9082]);
    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(resumo(lines)).toMatchObject({ falhas: 1, restantes: 1 });
  });
});
