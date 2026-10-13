import { randomBytes } from "node:crypto";

import { encryptToken } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { createShopeeClient } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import type { EnqueueRequest } from "../enqueue.js";
import type { JobHandler } from "../router.js";
import type { LojaConectada, ShopeeJobDeps } from "./shopee-comum.js";
import { createShopeeItemsHydrateHandler } from "./shopee-items-hydrate.js";
import { createShopeeItemsSyncHandler } from "./shopee-items-sync.js";

/**
 * O catálogo Shopee (D-428): a lista (`shopee.items.sync`) e o detalhe
 * (`shopee.items.hydrate`), contra um banco falso que registra cada operação
 * NA ORDEM e uma Shopee falsa que responde por caminho.
 */

const KEY = randomBytes(32);
const NOW = new Date("2026-10-13T15:00:00.000Z");
const AGORA_S = Math.floor(NOW.getTime() / 1000);
const LOJA_ID = "aaaaaaaa-0000-4000-8000-0000000000aa";
const ORG = "11111111-0000-4000-8000-000000000001";

const LOJA: LojaConectada = {
  id: LOJA_ID,
  organization_id: ORG,
  environment: "sandbox",
  shop_id: 227974834,
  status: "CONNECTED",
  orders_synced_until: null,
};

type Op =
  | { op: "upsert"; table: string; rows: Record<string, unknown>[]; onConflict: unknown }
  | { op: "update"; table: string; row: Record<string, unknown>; filtros: Record<string, unknown> }
  | { op: "delete"; table: string; filtros: Record<string, unknown> }
  | { op: "insert"; table: string; rows: Record<string, unknown>[] }
  | { op: "rpc"; nome: string; args: unknown };

function fakeDb(
  opcoes: {
    loja?: LojaConectada | null;
    marco?: string | null;
    pendentes?: { item_id: number; shopee_updated_at: string }[];
    travaLivre?: boolean;
  } = {},
) {
  const ops: Op[] = [];
  const credencial = {
    access_token_ciphertext: encryptToken("acesso-valido", KEY),
    access_token_expires_at: new Date(NOW.getTime() + 3 * 3_600_000).toISOString(),
  };

  function filtravel(registrar: (filtros: Record<string, unknown>) => void) {
    const filtros: Record<string, unknown> = {};
    const self = {
      eq: (coluna: string, valor: unknown) => {
        filtros[coluna] = valor;

        return self;
      },
      then: (resolve: (value: unknown) => unknown) => {
        registrar({ ...filtros });

        return Promise.resolve({ error: null }).then(resolve);
      },
    };

    return self;
  }

  const db = {
    rpc: (nome: string, args: unknown) => {
      ops.push({ op: "rpc", nome, args });

      if (nome === "shopee_items_hydrate_lock") return Promise.resolve({ data: opcoes.travaLivre ?? true, error: null });

      return Promise.resolve({ data: opcoes.pendentes ?? [], error: null });
    },
    from: (table: string) => ({
      select: () => {
        const leitura = {
          eq: () => leitura,
          maybeSingle: () => {
            if (table !== "shopee_shops") return Promise.resolve({ data: credencial, error: null });

            const loja = opcoes.loja === undefined ? LOJA : opcoes.loja;

            return Promise.resolve({
              data: loja === null ? null : { ...loja, items_synced_until: opcoes.marco ?? null },
              error: null,
            });
          },
        };

        return leitura;
      },
      upsert: (rows: Record<string, unknown>[], opts: { onConflict?: unknown } = {}) => {
        ops.push({ op: "upsert", table, rows, onConflict: opts.onConflict });

        return Promise.resolve({ error: null });
      },
      update: (row: Record<string, unknown>) => filtravel((filtros) => ops.push({ op: "update", table, row, filtros })),
      delete: () => filtravel((filtros) => ops.push({ op: "delete", table, filtros })),
      insert: (rows: Record<string, unknown>[]) => {
        ops.push({ op: "insert", table, rows });

        return Promise.resolve({ error: null });
      },
    }),
  } as unknown as ShopeeJobDeps["db"];

  return { db, ops };
}

/** Shopee falsa: cada caminho responde com o corpo da função dada (ou erro). */
function fakeShopee(rotas: Record<string, (url: URL) => unknown>) {
  const chamadas: URL[] = [];
  const fetchImpl = (url: URL) => {
    chamadas.push(url);

    const rota = rotas[url.pathname];
    const corpo = rota === undefined ? { error: "error_param", message: "rota não simulada" } : rota(url);

    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  };

  return {
    client: createShopeeClient({
      environment: "sandbox",
      partnerId: 1248019,
      partnerKey: "chave-de-teste-nao-real",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => NOW,
    }),
    chamadas,
  };
}

async function rodar(
  criar: (deps: ShopeeJobDeps) => JobHandler,
  banco: ReturnType<typeof fakeDb>,
  shopee: ReturnType<typeof fakeShopee>,
) {
  const enfileirados: EnqueueRequest[] = [];
  const logs: { message: string; campos: Record<string, unknown> }[] = [];
  const handler = criar({
    db: banco.db,
    client: shopee.client,
    encryptionKey: KEY,
    now: () => NOW,
    enqueuer: {
      enqueue: (request) => {
        enfileirados.push(request);

        return Promise.resolve({ deduplicated: false });
      },
    } as ShopeeJobDeps["enqueuer"],
  });

  const outcome = await handler(
    {
      jobType: "shopee.items",
      jobId: "6f1d5f9c-6d0b-4a5f-9f4a-2c9a7a1f0b97",
      organizationId: ORG,
      dedupeKey: "x",
      attempt: 1,
      enqueuedAt: NOW.toISOString(),
    },
    {
      logger: createLogger(
        {},
        {
          sink: (linha: string) => {
            const lido = JSON.parse(linha) as Record<string, unknown>;

            logs.push({ message: String(lido.message), campos: lido });
          },
        },
      ),
      payload: { shopeeShopId: LOJA_ID },
    },
  );

  return { outcome, enfileirados, logs };
}

const escritas = (ops: Op[]) => ops.filter((o) => o.op !== "rpc");

// ---------------------------------------------------------------- lista

interface ItemDaLista {
  item_id: number;
  item_status: string;
  update_time: number;
}

/** Páginas de 100; `totais` dá o total_count de cada passada (padrão: o número de itens). */
function paginas(lotes: ItemDaLista[][], totais: number[] = []) {
  let passada = -1;

  return (url: URL) => {
    const offset = Number(url.searchParams.get("offset"));

    if (offset === 0) passada += 1;

    const indice = offset / 100;
    const mais = indice + 1 < lotes.length;
    const total = totais[passada] ?? lotes.flat().length;

    return {
      error: "",
      response: {
        item: lotes[indice] ?? [],
        total_count: indice === 0 ? lotes.flat().length : total,
        has_next_page: mais,
        ...(mais ? { next_offset: offset + 100 } : {}),
      },
    };
  };
}

describe("shopee.items.sync (D-428)", () => {
  it("sem marco: enumera o catálogo vivo inteiro, sem janela, segue o offset, grava e enfileira o detalhe", async () => {
    const banco = fakeDb();
    const shopee = fakeShopee({
      "/api/v2/product/get_item_list": paginas([
        [{ item_id: 1, item_status: "NORMAL", update_time: AGORA_S - 50 }],
        [{ item_id: 2, item_status: "UNLIST", update_time: AGORA_S - 40 }],
      ]),
    });

    const { outcome, enfileirados } = await rodar(createShopeeItemsSyncHandler, banco, shopee);

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(shopee.chamadas.map((u) => u.searchParams.get("offset"))).toEqual(["0", "100"]);
    expect(shopee.chamadas[0]?.searchParams.getAll("item_status")).toEqual(["NORMAL", "UNLIST", "BANNED", "REVIEWING"]);
    expect(shopee.chamadas[0]?.searchParams.has("update_time_from")).toBe(false);
    expect(escritas(banco.ops)).toEqual([
      {
        op: "upsert",
        table: "shopee_items",
        onConflict: "shopee_shop_id,item_id",
        rows: [
          {
            shopee_shop_id: LOJA_ID,
            organization_id: ORG,
            item_id: 1,
            item_status: "NORMAL",
            shopee_updated_at: new Date((AGORA_S - 50) * 1000).toISOString(),
          },
          {
            shopee_shop_id: LOJA_ID,
            organization_id: ORG,
            item_id: 2,
            item_status: "UNLIST",
            shopee_updated_at: new Date((AGORA_S - 40) * 1000).toISOString(),
          },
        ],
      },
      { op: "update", table: "shopee_shops", row: { items_synced_until: NOW.toISOString() }, filtros: { id: LOJA_ID } },
    ]);
    expect(enfileirados).toEqual([
      {
        jobType: "shopee.items.hydrate",
        organizationId: ORG,
        dedupeKey: `shopee-items-hydrate:${LOJA_ID}:${String(AGORA_S)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
    ]);
  });

  it("com marco: desde ele (10 min antes), SEM fim de janela, com TODOS os status — inclusive apagados", async () => {
    const shopee = fakeShopee({
      "/api/v2/product/get_item_list": paginas([[{ item_id: 7, item_status: "SELLER_DELETE", update_time: AGORA_S - 5 }]]),
    });

    const { outcome } = await rodar(
      createShopeeItemsSyncHandler,
      fakeDb({ marco: new Date(NOW.getTime() - 3_600_000).toISOString() }),
      shopee,
    );

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(shopee.chamadas[0]?.searchParams.get("update_time_from")).toBe(String(AGORA_S - 3600 - 600));
    // Com fim, o item que muda durante a leitura sairia do conjunto e o offset pularia um.
    expect(shopee.chamadas[0]?.searchParams.has("update_time_to")).toBe(false);
    expect(shopee.chamadas[0]?.searchParams.getAll("item_status")).toContain("SELLER_DELETE");
  });

  it("o conjunto mudou no meio (total_count diferente entre páginas): lê de novo e só então grava", async () => {
    const lotes = [
      Array.from({ length: 100 }, (_, i) => ({ item_id: i + 1, item_status: "NORMAL", update_time: AGORA_S - 100 })),
      [{ item_id: 101, item_status: "NORMAL", update_time: AGORA_S - 100 }],
    ];
    const banco = fakeDb();
    // 1ª passada: a 2ª página diz 102 (um item entrou); 2ª passada: estável em 101.
    const shopee = fakeShopee({ "/api/v2/product/get_item_list": paginas(lotes, [102, 101]) });

    const { outcome, logs } = await rodar(createShopeeItemsSyncHandler, banco, shopee);

    expect(outcome).toEqual({ status: "done", processed: 101 });
    expect(shopee.chamadas).toHaveLength(4);
    expect(logs.find((l) => l.message === "shopee_items_sync_done")?.campos).toMatchObject({ leituras: 2 });
  });

  it("o conjunto muda em todas as leituras: falha passageira, sem gravar nem avançar o marco", async () => {
    const lotes = [
      Array.from({ length: 100 }, (_, i) => ({ item_id: i + 1, item_status: "NORMAL", update_time: AGORA_S - 100 })),
      [{ item_id: 101, item_status: "NORMAL", update_time: AGORA_S - 100 }],
    ];
    const banco = fakeDb();
    const shopee = fakeShopee({ "/api/v2/product/get_item_list": paginas(lotes, [102, 103, 104]) });

    const { outcome, enfileirados } = await rodar(createShopeeItemsSyncHandler, banco, shopee);

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(escritas(banco.ops)).toEqual([]);
    expect(enfileirados).toEqual([]);
  });

  it("erro da Shopee: falha (passageira ou não), sem gravar nem enfileirar", async () => {
    for (const [codigo, repete] of [
      ["error_server", true],
      ["error_system_busy", true],
      ["error_param", false],
    ] as const) {
      const banco = fakeDb();
      const shopee = fakeShopee({ "/api/v2/product/get_item_list": () => ({ error: codigo, message: "x" }) });
      const { outcome, enfileirados } = await rodar(createShopeeItemsSyncHandler, banco, shopee);

      expect(outcome).toMatchObject({ status: "failed", retryable: repete });
      expect(escritas(banco.ops)).toEqual([]);
      expect(enfileirados).toEqual([]);
    }
  });

  it("loja em erro, de outro ambiente ou inexistente: pula sem chamar a Shopee", async () => {
    for (const loja of [{ ...LOJA, status: "ERROR" }, { ...LOJA, environment: "live" }, null]) {
      const shopee = fakeShopee({});
      const { outcome } = await rodar(createShopeeItemsSyncHandler, fakeDb({ loja }), shopee);

      expect(outcome).toEqual({ status: "done", processed: 0 });
      expect(shopee.chamadas).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------- detalhe

const LISTA_VIU = new Date((AGORA_S - 60) * 1000).toISOString();
const pendente = (item_id: number) => ({ item_id, shopee_updated_at: LISTA_VIU });

const SEM_VARIACAO = {
  item_id: 1,
  item_name: "Painel Digital",
  item_sku: " painel-01 ",
  item_status: "NORMAL",
  has_model: false,
  update_time: AGORA_S - 100,
  create_time: AGORA_S - 86400,
  price_info: [{ currency: "BRL", current_price: 149.9, original_price: 159.9 }],
  stock_info_v2: { summary_info: { total_available_stock: 7 } },
  image: { image_url_list: ["https://cf.shopee.com.br/file/a"] },
};

const COM_VARIACAO = {
  item_id: 2,
  item_name: "Baú",
  item_sku: "",
  item_status: "NORMAL",
  has_model: true,
  // Sem update_time no detalhe: vale o da lista.
  price_info: [{ currency: "BRL", current_price: 1, original_price: 1 }],
};

const VARIACOES = {
  error: "",
  response: {
    tier_variation: [{ name: "Cor", option_list: [{ option: "Azul" }, { option: "Preto" }] }],
    model: [
      {
        model_id: 21,
        model_sku: "BAU-AZUL",
        model_status: "MODEL_NORMAL",
        tier_index: [0],
        price_info: [{ currency: "BRL", current_price: 99.9 }],
      },
      { model_id: 22, model_sku: "", model_status: "MODEL_UNAVAILABLE", tier_index: [1] },
    ],
  },
};

const detalheCom = (...itens: unknown[]) => () => ({ error: "", response: { item_list: itens } });

const soltouATrava = (ops: Op[]) =>
  ops.some((o) => o.op === "update" && o.table === "shopee_shops" && o.row.items_hydrate_locked_until === null);

describe("shopee.items.hydrate (D-428)", () => {
  it("outra cadeia com a trava: termina sem ler pendentes nem chamar a Shopee", async () => {
    const banco = fakeDb({ travaLivre: false, pendentes: [pendente(1)] });
    const shopee = fakeShopee({});

    expect((await rodar(createShopeeItemsHydrateHandler, banco, shopee)).outcome).toEqual({ status: "done", processed: 0 });
    expect(banco.ops).toEqual([{ op: "rpc", nome: "shopee_items_hydrate_lock", args: { p_shopee_shop_id: LOJA_ID, p_ttl_seconds: 900 } }]);
    expect(shopee.chamadas).toEqual([]);
  });

  it("nada pendente: solta a trava e termina sem renovar token nem chamar a Shopee", async () => {
    const banco = fakeDb({ pendentes: [] });
    const shopee = fakeShopee({});

    expect((await rodar(createShopeeItemsHydrateHandler, banco, shopee)).outcome).toEqual({ status: "done", processed: 0 });
    expect(shopee.chamadas).toEqual([]);
    expect(soltouATrava(banco.ops)).toBe(true);
  });

  it("grava variações ANTES do item; preço só sem variação; o não devolvido fica marcado, sem apagar nada", async () => {
    const banco = fakeDb({ pendentes: [pendente(1), pendente(2), pendente(3)] });
    const shopee = fakeShopee({
      "/api/v2/product/get_item_base_info": detalheCom(SEM_VARIACAO, COM_VARIACAO),
      "/api/v2/product/get_model_list": () => VARIACOES,
    });

    const { outcome, enfileirados, logs } = await rodar(createShopeeItemsHydrateHandler, banco, shopee);

    expect(outcome).toEqual({ status: "done", processed: 3 });
    expect(shopee.chamadas.map((u) => u.pathname)).toEqual(["/api/v2/product/get_item_base_info", "/api/v2/product/get_model_list"]);
    expect(shopee.chamadas[0]?.searchParams.get("item_id_list")).toBe("1,2,3");

    // A ordem das escritas por item: variações (apaga, insere), depois o item.
    const sequencia = escritas(banco.ops).map((o) =>
      o.op === "update" || o.op === "delete" ? `${o.op}:${o.table}:${String(o.filtros.item_id ?? o.filtros.id)}` : `${o.op}:${o.table}`,
    );

    expect(sequencia).toEqual([
      "delete:shopee_item_models:1",
      "update:shopee_items:1",
      "delete:shopee_item_models:2",
      "insert:shopee_item_models",
      "update:shopee_items:2",
      "update:shopee_items:3",
      `update:shopee_shops:${LOJA_ID}`,
    ]);

    const doItem = (id: number) =>
      escritas(banco.ops).find((o) => o.op === "update" && o.table === "shopee_items" && o.filtros.item_id === id);

    expect(doItem(1)).toMatchObject({
      row: {
        item_sku: " painel-01 ",
        has_model: false,
        current_price: 149.9,
        available_stock: 7,
        details_update_time: new Date((AGORA_S - 100) * 1000).toISOString(),
        details_error: null,
        details_synced_at: NOW.toISOString(),
      },
    });
    // O relógio da Shopee nunca é trocado pelo do worker, nem regride.
    const item1 = doItem(1);

    expect(item1?.op === "update" ? "shopee_updated_at" in item1.row : null).toBe(false);
    // Com variação: sem preço nem estoque no item; sem update_time no detalhe, vale o da lista.
    expect(doItem(2)).toMatchObject({ row: { has_model: true, item_sku: null, current_price: null, details_update_time: LISTA_VIU } });
    expect(doItem(3)).toEqual({
      op: "update",
      table: "shopee_items",
      row: { details_error: "nao_devolvido", details_synced_at: NOW.toISOString() },
      filtros: { shopee_shop_id: LOJA_ID, item_id: 3 },
    });
    expect(banco.ops).toContainEqual({
      op: "insert",
      table: "shopee_item_models",
      rows: [
        expect.objectContaining({ item_id: 2, model_id: 21, model_name: "Azul", model_sku: "BAU-AZUL", current_price: 99.9 }),
        expect.objectContaining({ item_id: 2, model_id: 22, model_name: "Preto", model_sku: null, model_status: "MODEL_UNAVAILABLE" }),
      ],
    });
    expect(logs.find((l) => l.message === "shopee_items_hydrate_sem_detalhe")?.campos).toMatchObject({
      itens: [{ item_id: 3, motivo: "nao_devolvido" }],
    });
    expect(enfileirados).toEqual([]);
  });

  it("variações recusadas de vez (com prefixo de módulo): só aquele item fica marcado, as variações dele ficam, a fila segue", async () => {
    const banco = fakeDb({ pendentes: [pendente(2), pendente(1)] });
    const shopee = fakeShopee({
      "/api/v2/product/get_item_base_info": detalheCom(COM_VARIACAO, SEM_VARIACAO),
      "/api/v2/product/get_model_list": () => ({ error: "product.error_item_not_found", message: "x" }),
    });

    const { outcome } = await rodar(createShopeeItemsHydrateHandler, banco, shopee);

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(banco.ops).toContainEqual({
      op: "update",
      table: "shopee_items",
      row: { details_error: "variacoes:error_item_not_found", details_synced_at: NOW.toISOString() },
      filtros: { shopee_shop_id: LOJA_ID, item_id: 2 },
    });
    const apagadas = banco.ops.flatMap((o) => (o.op === "delete" ? [o.filtros.item_id] : []));

    expect(apagadas).toEqual([1]);
  });

  it("erro passageiro nas variações: a tarefa falha para repetir, e a trava é solta", async () => {
    const banco = fakeDb({ pendentes: [pendente(2)] });
    const { outcome } = await rodar(
      createShopeeItemsHydrateHandler,
      banco,
      fakeShopee({
        "/api/v2/product/get_item_base_info": detalheCom(COM_VARIACAO),
        "/api/v2/product/get_model_list": () => ({ error: "error_inner", message: "try later" }),
      }),
    );

    expect(outcome).toMatchObject({ status: "failed", retryable: true });
    expect(escritas(banco.ops).filter((o) => o.table === "shopee_items")).toEqual([]);
    expect(soltouATrava(banco.ops)).toBe(true);
  });

  it("lote recusado por erro definitivo: relê item a item e isola o ruim", async () => {
    const banco = fakeDb({ pendentes: [pendente(1), pendente(9)] });
    const shopee = fakeShopee({
      "/api/v2/product/get_item_base_info": (url) => {
        const ids = url.searchParams.get("item_id_list");

        if (ids === "1") return { error: "", response: { item_list: [SEM_VARIACAO] } };

        return { error: "error_param", message: "Wrong parameters" };
      },
    });

    const { outcome } = await rodar(createShopeeItemsHydrateHandler, banco, shopee);

    expect(outcome).toEqual({ status: "done", processed: 2 });
    expect(shopee.chamadas.map((u) => u.searchParams.get("item_id_list"))).toEqual(["1,9", "1", "9"]);
    expect(banco.ops).toContainEqual({
      op: "update",
      table: "shopee_items",
      row: { details_error: "error_param", details_synced_at: NOW.toISOString() },
      filtros: { shopee_shop_id: LOJA_ID, item_id: 9 },
    });
    expect(banco.ops).toContainEqual(expect.objectContaining({ op: "update", table: "shopee_items", filtros: { shopee_shop_id: LOJA_ID, item_id: 1 } }));
  });

  it("erro passageiro no lote: falha sem gravar item; lote cheio enfileira a continuação depois de soltar a trava", async () => {
    const ocupado = fakeDb({ pendentes: [pendente(1)] });
    const a = await rodar(
      createShopeeItemsHydrateHandler,
      ocupado,
      fakeShopee({ "/api/v2/product/get_item_base_info": () => ({ error: "error_system_busy", message: "x" }) }),
    );

    expect(a.outcome).toMatchObject({ status: "failed", retryable: true });
    expect(escritas(ocupado.ops).filter((o) => o.table === "shopee_items")).toEqual([]);

    const cheio = Array.from({ length: 50 }, (_, i) => i + 1);
    const banco = fakeDb({ pendentes: cheio.map(pendente) });
    const b = await rodar(
      createShopeeItemsHydrateHandler,
      banco,
      fakeShopee({ "/api/v2/product/get_item_base_info": detalheCom(...cheio.map((item_id) => ({ ...SEM_VARIACAO, item_id }))) }),
    );

    expect(b.outcome).toEqual({ status: "done", processed: 50 });
    expect(soltouATrava(banco.ops)).toBe(true);
    expect(b.enfileirados).toEqual([
      {
        jobType: "shopee.items.hydrate",
        organizationId: ORG,
        dedupeKey: `shopee-items-hydrate:${LOJA_ID}:mais:${String(AGORA_S)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA_ID },
      },
    ]);
  });
});
