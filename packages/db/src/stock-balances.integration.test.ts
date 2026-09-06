import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "./types.js";

/**
 * `get_stock_balances` page-first, provado contra o banco de verdade (D-196).
 *
 * **O que mudou.** Full e último movimento eram calculados para TODOS os SKUs
 * e só então paginados — 313.941 linhas lidas no Dev para enriquecer as 50 da
 * tela. Passam a ser calculados por `lateral`, depois do `limit`, só para os
 * SKUs que a página devolve.
 *
 * **O que este arquivo guarda.** Page-first tem três formas conhecidas de dar
 * errado, e nenhuma delas aparece num teste de unidade com fake:
 *
 *   1. `total_count` virar o tamanho da PÁGINA em vez do total filtrado — o
 *      `count(*) over ()` precisa continuar rodando antes do `limit`;
 *   2. o enriquecimento sair DESLOCADO na segunda página, colando o Full de
 *      um SKU na linha de outro (o defeito clássico de mover a lateral para
 *      depois de um `offset`);
 *   3. a janela de frescor de 3 dias, que veio junto com a definição canônica
 *      de D-173, contar snapshot velho — ou, ao contrário, descartar o
 *      recente.
 *
 * Guarda também o GRÃO: um SKU com dois buckets (`inventory_id`) tem de somar
 * os dois. Era esse o defeito que D-173 mediu em outras RPCs (7.098 contra
 * 8.408 unidades), e esta função passou a usar a mesma definição.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ORGANIZATION_ID = randomUUID();
const CONTA_A = randomUUID();
const CONTA_B = randomUUID();

const PREFIXO = `D196-${ORGANIZATION_ID.slice(0, 8)}`;

// SKUs suficientes para haver segunda página com `p_limit` pequeno. O nome
// carrega o índice com zero à esquerda porque a RPC ordena por `sku` — sem
// isso "…-10" viria antes de "…-2" e a montagem do caso se perde.
const TOTAL_SKUS = 12;
const PAGINA = 5;

function nomeDoSku(indice: number): string {
  return `${PREFIXO}-${String(indice).padStart(2, "0")}`;
}

const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY ?? "sem-chave", {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function ok(operacao: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const resultado = await operacao;

  if (resultado.error !== null) {
    throw new Error(resultado.error.message);
  }
}

interface Linha {
  sku: string;
  full_quantity: string | null;
  last_movement_at: string | null;
  local_quantity: string;
  total_count: number;
}

async function balancos(limite: number, offset: number): Promise<Linha[]> {
  const { data, error } = await db.rpc("get_stock_balances", {
    p_organization_id: ORGANIZATION_ID,
    p_limit: limite,
    p_offset: offset,
  });

  if (error !== null) throw new Error(error.message);

  return data as unknown as Linha[];
}

const idPorSku = new Map<string, string>();

beforeAll(async () => {
  if (SERVICE_ROLE_KEY === undefined) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY não definida — exporte com `eval \"$(pnpm exec supabase status -o env)\"`.",
    );
  }

  await ok(
    db
      .from("organizations")
      .insert([{ id: ORGANIZATION_ID, name: "D-196 estoque", slug: `d196-${ORGANIZATION_ID.slice(0, 8)}` }]),
  );

  await ok(
    db.from("ml_accounts").insert([
      { id: CONTA_A, organization_id: ORGANIZATION_ID, slug: `${PREFIXO}-a`.toLowerCase(), label: "Conta A" },
      { id: CONTA_B, organization_id: ORGANIZATION_ID, slug: `${PREFIXO}-b`.toLowerCase(), label: "Conta B" },
    ]),
  );

  const skus = Array.from({ length: TOTAL_SKUS }, (_, i) => ({
    organization_id: ORGANIZATION_ID,
    sku: nomeDoSku(i + 1),
    kind: "PRODUTO" as const,
  }));

  const inseridos = await db.from("skus").insert(skus).select("id, sku");

  if (inseridos.error !== null) throw new Error(inseridos.error.message);

  for (const linha of inseridos.data) {
    idPorSku.set(linha.sku, linha.id);
  }

  // Saldo para TODOS: a RPC parte de `inventory_balances`, então SKU sem
  // saldo simplesmente não aparece — e o teste precisa das 12 linhas.
  // O saldo nasce de movimento, que é o que alimenta a projeção.
  const movimentos = Array.from({ length: TOTAL_SKUS }, (_, i) => ({
    organization_id: ORGANIZATION_ID,
    sku_id: idPorSku.get(nomeDoSku(i + 1)) ?? "",
    location_kind: "LOCAL" as const,
    qty_delta: 10 + i,
    movement_type: "ENTRADA_NFE" as const,
    source_type: "DOCUMENT" as const,
    source_id: `${PREFIXO}-doc`,
    idempotency_key: `${PREFIXO}:mov:${String(i + 1)}`,
    // Datas distintas e CRESCENTES com o índice: o último movimento de cada
    // SKU é único e identificável, que é o que o teste 2 confere.
    occurred_at: new Date(Date.UTC(2026, 7, 1 + i, 12, 0, 0)).toISOString(),
  }));

  await ok(db.from("stock_movements").insert(movimentos));

  // Um movimento MAIS ANTIGO no SKU 01, para provar que a lateral pega o
  // maior `occurred_at` e não simplesmente o primeiro que o índice devolve.
  await ok(
    db.from("stock_movements").insert([
      {
        organization_id: ORGANIZATION_ID,
        sku_id: idPorSku.get(nomeDoSku(1)) ?? "",
        location_kind: "LOCAL",
        qty_delta: 1,
        movement_type: "ENTRADA_NFE",
        source_type: "DOCUMENT",
        source_id: `${PREFIXO}-doc`,
        idempotency_key: `${PREFIXO}:mov:antigo`,
        occurred_at: "2026-01-01T00:00:00Z",
      },
    ]),
  );

  const agora = new Date().toISOString();
  const quatroDiasAtras = new Date(Date.now() - 4 * 86_400_000).toISOString();

  await ok(
    db.from("fulfillment_stock_snapshots").insert([
      // SKU 01 — DOIS buckets, em contas diferentes, ambos recentes: o grão
      // de D-173 manda somar os dois (3 + 4 = 7), não escolher um.
      {
        organization_id: ORGANIZATION_ID,
        ml_account_id: CONTA_A,
        inventory_id: `${PREFIXO}-INV-A`,
        item_id: "MLB900100901",
        sku_id: idPorSku.get(nomeDoSku(1)) ?? "",
        quantity: 3,
        captured_at: agora,
      },
      {
        organization_id: ORGANIZATION_ID,
        ml_account_id: CONTA_B,
        inventory_id: `${PREFIXO}-INV-B`,
        item_id: "MLB900100902",
        sku_id: idPorSku.get(nomeDoSku(1)) ?? "",
        quantity: 4,
        captured_at: agora,
      },
      // Mesmo bucket do SKU 01, captura ANTIGA e com quantidade absurda: se
      // aparecer no resultado, o `distinct on` pegou a linha errada.
      {
        organization_id: ORGANIZATION_ID,
        ml_account_id: CONTA_A,
        inventory_id: `${PREFIXO}-INV-A`,
        item_id: "MLB900100901",
        sku_id: idPorSku.get(nomeDoSku(1)) ?? "",
        quantity: 999,
        captured_at: new Date(Date.now() - 3_600_000).toISOString(),
      },
      // SKU 08 — está na SEGUNDA página com `p_limit` 5. É a linha que prova
      // que o enriquecimento não sai deslocado depois do `offset`.
      {
        organization_id: ORGANIZATION_ID,
        ml_account_id: CONTA_A,
        inventory_id: `${PREFIXO}-INV-08`,
        item_id: "MLB900100908",
        sku_id: idPorSku.get(nomeDoSku(8)) ?? "",
        quantity: 55,
        captured_at: agora,
      },
      // SKU 12 — só tem captura de 4 DIAS atrás: fora da janela de frescor,
      // tem de voltar NULO. É a metade "não conta" do teste da janela.
      {
        organization_id: ORGANIZATION_ID,
        ml_account_id: CONTA_A,
        inventory_id: `${PREFIXO}-INV-12`,
        item_id: "MLB900100912",
        sku_id: idPorSku.get(nomeDoSku(12)) ?? "",
        quantity: 77,
        captured_at: quatroDiasAtras,
      },
    ]),
  );
});

afterAll(async () => {
  await db.from("fulfillment_stock_snapshots").delete().eq("organization_id", ORGANIZATION_ID);
  await db.from("stock_movements").delete().eq("organization_id", ORGANIZATION_ID);
  await db.from("inventory_balances").delete().eq("organization_id", ORGANIZATION_ID);
  await db.from("skus").delete().eq("organization_id", ORGANIZATION_ID);
  await db.from("ml_accounts").delete().eq("organization_id", ORGANIZATION_ID);
  await db.from("organizations").delete().eq("id", ORGANIZATION_ID);
});

describe("get_stock_balances page-first (D-196)", () => {
  it("total_count continua sendo o total FILTRADO, não o tamanho da página", async () => {
    const primeira = await balancos(PAGINA, 0);

    expect(primeira).toHaveLength(PAGINA);
    // A regressão que page-first convida: mover o `count(*) over ()` para
    // depois do `limit` faria isto virar 5.
    expect(primeira[0]?.total_count).toBe(TOTAL_SKUS);
  });

  it("soma os DOIS buckets do SKU e ignora a captura anterior do mesmo bucket", async () => {
    const primeira = await balancos(PAGINA, 0);
    const sku01 = primeira.find((l) => l.sku === nomeDoSku(1));

    // 3 (conta A) + 4 (conta B). O 999 é da mesma dupla conta+bucket numa
    // captura anterior: se entrasse, o número seria 1.006 ou 1.003.
    expect(sku01?.full_quantity).toBe("7.000");
  });

  it("pega o MAIOR occurred_at, não o primeiro que o índice devolver", async () => {
    const primeira = await balancos(PAGINA, 0);
    const sku01 = primeira.find((l) => l.sku === nomeDoSku(1));

    // O SKU 01 tem um movimento de 2026-01-01 e outro de 2026-08-01.
    // Comparado como INSTANTE, não como string: o formato exato de
    // serialização do timestamptz é assunto do PostgREST, não deste teste.
    expect(new Date(sku01?.last_movement_at ?? 0).toISOString()).toBe("2026-08-01T12:00:00.000Z");
  });

  it("enriquece a linha CERTA na segunda página, sem deslocamento", async () => {
    const segunda = await balancos(PAGINA, PAGINA);

    expect(segunda.map((l) => l.sku)).toEqual([
      nomeDoSku(6),
      nomeDoSku(7),
      nomeDoSku(8),
      nomeDoSku(9),
      nomeDoSku(10),
    ]);

    // O Full de 55 pertence ao SKU 08 e a nenhum outro — é este o teste que
    // falha se a lateral for aplicada sobre a janela errada.
    for (const linha of segunda) {
      expect(linha.full_quantity).toBe(linha.sku === nomeDoSku(8) ? "55.000" : null);
    }

    // E o último movimento acompanha o SKU, não a posição na página.
    const sku08 = segunda.find((l) => l.sku === nomeDoSku(8));

    expect(new Date(sku08?.last_movement_at ?? 0).toISOString()).toBe("2026-08-08T12:00:00.000Z");
  });

  it("snapshot fora da janela de 3 dias não conta como Full atual", async () => {
    const todas = await balancos(TOTAL_SKUS, 0);
    const sku12 = todas.find((l) => l.sku === nomeDoSku(12));

    // A captura existe e tem 77 unidades, mas é de 4 dias atrás: bucket que
    // não é recapturado não está mais no Full (D-173).
    expect(sku12?.full_quantity).toBeNull();
  });

  it("SKU sem Full devolve NULO, não zero — ausência não é quantidade", async () => {
    const todas = await balancos(TOTAL_SKUS, 0);
    const semFull = todas.filter((l) => l.full_quantity === null);

    // 12 SKUs, e só o 01 e o 08 têm Full dentro da janela.
    expect(semFull).toHaveLength(TOTAL_SKUS - 2);
  });

  it("a página inteira concorda com a soma linha a linha", async () => {
    const todas = await balancos(TOTAL_SKUS, 0);
    const soma = todas.reduce((acc, l) => acc + Number(l.full_quantity ?? 0), 0);

    expect(todas).toHaveLength(TOTAL_SKUS);
    expect(soma).toBe(7 + 55);
  });
});
