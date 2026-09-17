import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
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

interface DevolucaoRow {
  order_id: string;
  sku_id: string;
  qty_delta: number;
  idempotency_key: string;
  occurred_at: string;
}

/** Uma venda gravada, na forma mínima que o ledger devolve. */
function venda(orderId: number, sku: string, quantidade: number, occurredAt: string, posicao = 1): MovimentoRow {
  return {
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
    source_id: String(orderId),
    sku_id: "SKU-A",
    qty_delta: quantidade,
    idempotency_key: `cancelamento:${chaveDaVenda}`,
    occurred_at: occurredAt,
    movement_type: "CANCELAMENTO_ML",
  };
}

interface UpdateChamada {
  patch: Record<string, unknown>;
  id: number | null;
  /** O `is("logistic_captured_at", null)` do WHERE — a guarda de R5. */
  exigiuCapturaNula: boolean;
}

function fakeDb(options: {
  ledger?: MovimentoRow[];
  orders?: OrderRow[];
  devolucoes?: DevolucaoRow[];
  accountStatus?: string;
}): {
  db: SyncOrderLogisticsDeps["db"];
  movimentos: Record<string, unknown>[];
  updates: UpdateChamada[];
  rpcs: string[];
} {
  const ledger = options.ledger ?? [];
  const orders = options.orders ?? [];
  const devolucoes = options.devolucoes ?? [];
  const movimentos: Record<string, unknown>[] = [];
  const updates: UpdateChamada[] = [];
  const rpcs: string[] = [];

  const credentials = {
    access_token_ciphertext: encryptToken("APP_USR-valido", ENCRYPTION_KEY),
    refresh_token_ciphertext: encryptToken("TG-valido", ENCRYPTION_KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3_600_000).toISOString(),
  };

  function rangeChain(rows: unknown[]): unknown {
    const self = {
      eq: () => self,
      in: () => self,
      order: () => self,
      range: (from: number, to: number) => Promise.resolve({ data: rows.slice(from, to + 1), error: null }),
    };

    return self;
  }

  /** Leitura que se resolve no `await` direto, sem `range` — a de `orders`. */
  function listChain(rows: unknown[]): unknown {
    const self = {
      eq: () => self,
      in: (_coluna: string, ids: number[]) => ({
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: (rows as OrderRow[]).filter((row) => ids.includes(row.id)),
            error: null,
          }).then(resolve),
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
          return rangeChain(ledger);
        }

        if (table === "orders") {
          return listChain(orders);
        }

        return maybeSingleChain(null);
      },
      update: (patch: Record<string, unknown>) => {
        const chamada: UpdateChamada = { patch, id: null, exigiuCapturaNula: false };

        updates.push(chamada);

        const self = {
          eq: (_coluna: string, valor: number) => {
            chamada.id = valor;

            return self;
          },
          is: (coluna: string, valor: unknown) => {
            if (coluna === "logistic_captured_at" && valor === null) {
              chamada.exigiuCapturaNula = true;
            }

            return {
              then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
            };
          },
        };

        return self;
      },
      upsert: (row: Record<string, unknown>) => {
        movimentos.push(row);

        return Promise.resolve({ error: null });
      },
    }),
    rpc: (name: string, args: { p_order_ids: string[] }) => {
      rpcs.push(name);

      return Promise.resolve({
        data: devolucoes.filter((row) => args.p_order_ids.includes(row.order_id)),
        error: null,
      });
    },
  } as unknown as SyncOrderLogisticsDeps["db"];

  return { db, movimentos, updates, rpcs };
}

/** `FALHA` = o Mercado Livre nao respondeu; `null` = respondeu e nao disse a logistica. */
const FALHA = Symbol("falha na leitura do envio");

function fakeClient(logisticaPorEnvio: Record<string, string | null | typeof FALHA>): {
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
        return Promise.reject(new Error("500 do Mercado Livre"));
      }

      // Passa pelo `schema.parse` como o cliente real: um corpo fora do
      // contrato lançaria o mesmo ZodError aqui.
      return Promise.resolve(request.schema.parse({ logistic_type: resposta ?? null }));
    },
  } as unknown as MercadoLivreClient;

  return { client, calls };
}

function run(
  db: SyncOrderLogisticsDeps["db"],
  client: MercadoLivreClient,
  sleeps: number[] = [],
): Promise<{ outcome: unknown; lines: string[] }> {
  const handler = createSyncOrderLogisticsHandler({
    db,
    mercadoLivre: client,
    oauth: { clientId: "APP_ID", clientSecret: "segredo", redirectUri: "" },
    encryptionKey: ENCRYPTION_KEY,
    now: () => NOW,
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

describe("sync.order-logistics (D-352, R2)", () => {
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

  it("os movimentos saem ANTES da captura: uma falha no meio deixa o pedido pendente, nunca capturado sem par", async () => {
    const { db } = fakeDb({
      ledger: [venda(9001, "SKU-A", 1, "2026-09-12T18:00:00.000Z")],
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

    expect(ordem).toEqual(["movimento:ESTORNO_FULL", "captura"]);
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

  it("venda JÁ estornada não entra na varredura: nenhuma chamada e nenhuma escrita", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [
        venda(9004, "SKU-D", 1, "2026-09-12T18:00:00.000Z"),
        estorno("venda:9004:1", "ESTORNO_PRE_CAPTURA", 9004),
      ],
      orders: [{ id: 9004, shipping_id: 5004, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({ "5004": "fulfillment" });

    const { outcome, lines } = await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
    expect(updates).toEqual([]);
    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(resumo(lines)).toMatchObject({ pendentes: 0 });
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

  it("já capturado como NÃO-Full com a venda sem estorno: nada a fazer, e nenhuma chamada", async () => {
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

    await run(db, client);

    expect(calls).toEqual([]);
    expect(movimentos).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("leitura do envio que falha: o pedido continua pendente — sem captura, sem movimento, nunca presumir Full", async () => {
    const { db, movimentos, updates } = fakeDb({
      ledger: [venda(9008, "SKU-H", 1, "2026-09-11T12:00:00.000Z")],
      orders: [{ id: 9008, shipping_id: 5008, logistic_type: null, logistic_captured_at: null }],
    });
    const { client, calls } = fakeClient({ "5008": FALHA });

    const { outcome, lines } = await run(db, client);

    expect(calls).toEqual(["/shipments/5008"]);
    expect(movimentos).toEqual([]);
    expect(updates).toEqual([]);
    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(resumo(lines)).toMatchObject({ falhas: 1, capturados: 0, restantes: 1 });
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
    const { db, movimentos } = fakeDb({
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
        movement_type: "ESTORNO_FULL",
        qty_delta: 1,
        idempotency_key: "estorno:venda:9010:1",
        occurred_at: "2026-09-11T12:00:00.000Z",
      }),
      expect.objectContaining({
        movement_type: "ESTORNO_REVERSAO_EXCEDENTE",
        // O sinal da VENDA: a reversão devolveu a unidade, a anulação a tira de
        // novo. Soma final do pedido: -1 +1 +1 -1 = 0.
        qty_delta: -1,
        idempotency_key: "estorno:cancelamento:venda:9010:1",
        occurred_at: "2026-09-13T08:30:00.000Z",
      }),
    ]);
  });

  it("pedido do Full com DEVOLUCAO_ML (origem do claim, achada pela RPC): a anulação dela também sai", async () => {
    const { db, movimentos, rpcs } = fakeDb({
      ledger: [venda(9011, "SKU-K", 1, "2026-09-11T12:00:00.000Z")],
      orders: [{ id: 9011, shipping_id: 5011, logistic_type: null, logistic_captured_at: null }],
      devolucoes: [
        {
          order_id: "9011",
          sku_id: "SKU-K",
          qty_delta: 1,
          idempotency_key: "devolucao:CLAIM-7:venda:9011:1",
          occurred_at: "2026-09-14T22:00:00.000Z",
        },
      ],
    });
    const { client } = fakeClient({ "5011": "fulfillment" });

    await run(db, client);

    expect(rpcs).toEqual(["get_order_return_movements"]);
    expect(movimentos).toEqual([
      expect.objectContaining({ movement_type: "ESTORNO_FULL" }),
      expect.objectContaining({
        movement_type: "ESTORNO_REVERSAO_EXCEDENTE",
        qty_delta: -1,
        idempotency_key: "estorno:devolucao:CLAIM-7:venda:9011:1",
        occurred_at: "2026-09-14T22:00:00.000Z",
      }),
    ]);
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
