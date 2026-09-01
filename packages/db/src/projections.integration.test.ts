import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SKU_LINK_WITH_KIND_SELECT } from "./projections.js";
import type { SkuLinkWithKindRow } from "./projections.js";
import type { Database } from "./types.js";

/**
 * O portão da projeção do embed (D-188).
 *
 * **Por que este arquivo existe.** Um `select=` do PostgREST é uma linguagem
 * própria, avaliada só no servidor. Os fakes das suítes de unidade ignoram a
 * string inteira (`select: () => self`) — de propósito, porque modelá-la seria
 * reimplementar o PostgREST. Consequência: uma projeção errada passa VERDE em
 * toda a suíte de unidade e só quebra em produção.
 *
 * Isso não é hipotético. A primeira forma escrita para este embed,
 * `skus(kind, sku_components(...))`, é recusada com **PGRST201** porque
 * `sku_components` tem duas chaves estrangeiras para `skus` (`kit_sku_id` e
 * `component_sku_id`) e o PostgREST não escolhe sozinho. Nenhum teste de
 * unidade veria isso.
 *
 * O teste importa a constante de `projections.ts` — nunca copia a string.
 * Copiar faria o teste provar uma string que o código não usa.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ORGANIZATION_ID = randomUUID();
const ACCOUNT_ID = randomUUID();
const KIT_ID = randomUUID();
const COMPONENT_ID = randomUUID();
const SIMPLE_ID = randomUUID();
const ITEM_KIT = `MLB${String(Date.now()).slice(-9)}1`;
const ITEM_SIMPLE = `MLB${String(Date.now()).slice(-9)}2`;

const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY ?? "sem-chave", {
  auth: { persistSession: false, autoRefreshToken: false },
});

// O cliente devolve um builder THENABLE, não uma `Promise` — `PromiseLike` é
// o tipo certo, e é o que permite `await` sem prometer o que não existe.
async function inserirOuFalhar(operacao: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const resultado = await operacao;

  if (resultado.error !== null) {
    throw new Error(resultado.error.message);
  }
}

beforeAll(async () => {
  if (SERVICE_ROLE_KEY === undefined) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY não definida — exporte com `eval \"$(pnpm exec supabase status -o env)\"`.",
    );
  }

  await inserirOuFalhar(
    db
      .from("organizations")
      .insert({ id: ORGANIZATION_ID, name: "D-188 projeção", slug: `d188-${ORGANIZATION_ID.slice(0, 8)}` }),
  );

  await inserirOuFalhar(
    db.from("ml_accounts").insert({
      id: ACCOUNT_ID,
      organization_id: ORGANIZATION_ID,
      label: "D-188",
      slug: `d188-${ACCOUNT_ID.slice(0, 8)}`,
    }),
  );

  await inserirOuFalhar(
    db.from("skus").insert([
      { id: KIT_ID, organization_id: ORGANIZATION_ID, sku: `D188-KIT-${KIT_ID.slice(0, 8)}`, kind: "KIT" },
      {
        id: COMPONENT_ID,
        organization_id: ORGANIZATION_ID,
        sku: `D188-PECA-${COMPONENT_ID.slice(0, 8)}`,
        kind: "PRODUTO",
      },
      {
        id: SIMPLE_ID,
        organization_id: ORGANIZATION_ID,
        sku: `D188-SIMPLES-${SIMPLE_ID.slice(0, 8)}`,
        kind: "PRODUTO",
      },
    ]),
  );

  await inserirOuFalhar(
    db.from("sku_components").insert({ kit_sku_id: KIT_ID, component_sku_id: COMPONENT_ID, quantity: 3 }),
  );

  await inserirOuFalhar(
    db.from("sku_listing_links").insert([
      {
        organization_id: ORGANIZATION_ID,
        ml_account_id: ACCOUNT_ID,
        ref_kind: "ITEM",
        item_id: ITEM_KIT,
        variation_id: null,
        sku_id: KIT_ID,
        source: "MANUAL",
      },
      {
        organization_id: ORGANIZATION_ID,
        ml_account_id: ACCOUNT_ID,
        ref_kind: "ITEM",
        item_id: ITEM_SIMPLE,
        variation_id: "12345",
        sku_id: SIMPLE_ID,
        source: "MANUAL",
      },
    ]),
  );
});

afterAll(async () => {
  await db.from("sku_listing_links").delete().eq("organization_id", ORGANIZATION_ID);
  await db.from("sku_components").delete().eq("kit_sku_id", KIT_ID);
  await db.from("skus").delete().eq("organization_id", ORGANIZATION_ID);
  await db.from("ml_accounts").delete().eq("id", ACCOUNT_ID);
  await db.from("organizations").delete().eq("id", ORGANIZATION_ID);
});

describe("projeção do vínculo com kind e componentes (D-188)", () => {
  it("o embed resolve, e a forma é a que o worker assume", async () => {
    const resultado = await db
      .from("sku_listing_links")
      .select(SKU_LINK_WITH_KIND_SELECT)
      .eq("ml_account_id", ACCOUNT_ID)
      .eq("ref_kind", "ITEM")
      .in("item_id", [ITEM_KIT, ITEM_SIMPLE])
      .order("item_id");

    // Um PGRST201 (relacionamento ambíguo) chegaria aqui como erro, e é o
    // caso que nenhum teste de unidade pega.
    expect(resultado.error).toBeNull();

    const linhas = resultado.data as unknown as SkuLinkWithKindRow[];

    expect(linhas).toHaveLength(2);

    const kit = linhas.find((linha) => linha.item_id === ITEM_KIT);
    const simples = linhas.find((linha) => linha.item_id === ITEM_SIMPLE);

    // `skus` é OBJETO, não array: a relação é muitos-para-um. Se viesse array,
    // `resolved.skus.kind` seria `undefined` e todo KIT viraria PRODUTO.
    expect(kit?.skus).toMatchObject({ kind: "KIT" });
    expect(Array.isArray(kit?.skus)).toBe(false);

    // `sku_components` é ARRAY, e traz o lado certo da relação: o componente
    // do kit, não o kit do componente. Trocar a FK inverteria a decomposição.
    expect(kit?.skus?.sku_components).toEqual([{ component_sku_id: COMPONENT_ID, quantity: 3 }]);

    // Num SKU simples o array vem VAZIO, não ausente — é o que permite
    // `?? []` ser desnecessário e a ausência significar erro.
    expect(simples?.skus).toMatchObject({ kind: "PRODUTO" });
    expect(simples?.skus?.sku_components).toEqual([]);

    // `variation_id` sobrevive como string: é `text` no banco, e a chave do
    // mapa depende disso (D-186).
    expect(simples?.variation_id).toBe("12345");
    expect(kit?.variation_id).toBeNull();
  });

  it("sem nomear a chave estrangeira, o PostgREST RECUSA — é por isso que o nome está na constante", async () => {
    // A forma ingênua. Documentada aqui para que ninguém a "simplifique" de
    // volta achando que o `!sku_components_kit_sku_id_fkey` é ruído.
    const ingenua = await db
      .from("sku_listing_links")
      .select("id, skus(kind, sku_components(component_sku_id, quantity))")
      .eq("ml_account_id", ACCOUNT_ID)
      .limit(1);

    expect(ingenua.error).not.toBeNull();
    expect(ingenua.error?.code).toBe("PGRST201");
  });
});
