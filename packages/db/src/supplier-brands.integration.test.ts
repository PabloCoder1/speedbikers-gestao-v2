import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "./types.js";

/**
 * O teto de 1.000 do PostgREST, provado contra o banco de verdade (D-194).
 *
 * **Por que este arquivo existe.** Três telas (`/estoque`, `/reposicao`,
 * `/reposicao/configuracoes`) montavam o filtro de marcas lendo
 * `skus.supplier_brand` de TODAS as linhas e deduzindo as distintas com
 * `new Set(...)`. Medido no Dev: **3.550 linhas trafegadas para produzir 19
 * valores** — e o corte de 1.000 do PostgREST fazia **10 das 19 marcas nunca
 * aparecerem no filtro**.
 *
 * O corte é a classe D-131: `error` volta NULO e `data` volta com exatamente
 * 1.000 linhas. **Não quebra, mente.** Nenhum teste de unidade vê isso, porque
 * os fakes devolvem o array inteiro que o teste mandou — modelar o teto seria
 * reimplementar o PostgREST.
 *
 * Por isso este teste é de INTEGRAÇÃO e insere mais de 1.000 SKUs: é a única
 * forma de o teto existir de verdade. As marcas são distribuídas de propósito
 * para que as duas últimas caiam INTEIRAMENTE fora da primeira página — que é
 * o formato do defeito em produção, onde a ordenação por `supplier_brand`
 * fazia sobreviver só as alfabeticamente primeiras.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ORGANIZATION_ID = randomUUID();
const ORGANIZATION_VIZINHA = randomUUID();

// O teto do PostgREST configurado no projeto (`max_rows`). Está aqui como
// número explícito porque é ele que o teste precisa ultrapassar — se um dia
// mudar, é este valor que muda, e o teste continua provando a mesma coisa.
const TETO_POSTGREST = 1000;

// Dez marcas "gordas" que sozinhas já estouram o teto, e duas "magras" que só
// existem depois dele.
const MARCAS_GORDAS = 10;
const POR_MARCA_GORDA = 105; // 1.050 linhas — passa de 1.000 antes da marca 11
const MARCAS_MAGRAS = 2;
const POR_MARCA_MAGRA = 30;

const TOTAL_MARCAS = MARCAS_GORDAS + MARCAS_MAGRAS;
const TOTAL_SKUS = MARCAS_GORDAS * POR_MARCA_GORDA + MARCAS_MAGRAS * POR_MARCA_MAGRA;

const PREFIXO = `D194-${ORGANIZATION_ID.slice(0, 8)}`;

function nomeDaMarca(indice: number): string {
  // Zero à esquerda para a ordem alfabética coincidir com a numérica: sem
  // isso, "MARCA-10" viria antes de "MARCA-2" e a montagem do caso se perde.
  return `${PREFIXO} MARCA-${String(indice).padStart(2, "0")}`;
}

const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY ?? "sem-chave", {
  auth: { persistSession: false, autoRefreshToken: false },
});

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
    db.from("organizations").insert([
      { id: ORGANIZATION_ID, name: "D-194 marcas", slug: `d194-${ORGANIZATION_ID.slice(0, 8)}` },
      { id: ORGANIZATION_VIZINHA, name: "D-194 vizinha", slug: `d194v-${ORGANIZATION_VIZINHA.slice(0, 8)}` },
    ]),
  );

  // Duas travas do catálogo moldam a fixture: `skus_supplier_brand_source_coherent`
  // exige marca e procedência juntas ou nenhuma das duas, e
  // `skus_supplier_brand_manual_dated` exige data quando a procedência é
  // MANUAL. DERIVED é o valor certo aqui — ninguém decidiu estas marcas.
  const linhas: {
    organization_id: string;
    sku: string;
    kind: "PRODUTO";
    supplier_brand: string | null;
    supplier_brand_source: string | null;
  }[] = [];

  for (let marca = 1; marca <= MARCAS_GORDAS; marca += 1) {
    for (let i = 0; i < POR_MARCA_GORDA; i += 1) {
      linhas.push({
        organization_id: ORGANIZATION_ID,
        sku: `${PREFIXO}-G${String(marca)}-${String(i)}`,
        kind: "PRODUTO",
        supplier_brand: nomeDaMarca(marca),
        supplier_brand_source: "DERIVED",
      });
    }
  }

  for (let marca = MARCAS_GORDAS + 1; marca <= TOTAL_MARCAS; marca += 1) {
    for (let i = 0; i < POR_MARCA_MAGRA; i += 1) {
      linhas.push({
        organization_id: ORGANIZATION_ID,
        sku: `${PREFIXO}-M${String(marca)}-${String(i)}`,
        kind: "PRODUTO",
        supplier_brand: nomeDaMarca(marca),
        supplier_brand_source: "DERIVED",
      });
    }
  }

  // Um SKU sem marca: a tela não pode ganhar uma opção vazia no filtro.
  linhas.push({
    organization_id: ORGANIZATION_ID,
    sku: `${PREFIXO}-SEM-MARCA`,
    kind: "PRODUTO",
    supplier_brand: null,
    supplier_brand_source: null,
  });

  // Uma marca da organização vizinha, para o escopo do parâmetro ser provado
  // com dado que existe — filtro que "funciona" sobre tabela vazia não prova.
  linhas.push({
    organization_id: ORGANIZATION_VIZINHA,
    sku: `${PREFIXO}-VIZINHA`,
    kind: "PRODUTO",
    supplier_brand: `${PREFIXO} MARCA-DA-VIZINHA`,
    supplier_brand_source: "DERIVED",
  });

  // Em lotes: o INSERT inteiro numa tacada só estoura o corpo da requisição.
  for (let i = 0; i < linhas.length; i += 500) {
    await inserirOuFalhar(db.from("skus").insert(linhas.slice(i, i + 500)));
  }
});

afterAll(async () => {
  await db.from("skus").delete().eq("organization_id", ORGANIZATION_ID);
  await db.from("skus").delete().eq("organization_id", ORGANIZATION_VIZINHA);
  await db.from("organizations").delete().eq("id", ORGANIZATION_ID);
  await db.from("organizations").delete().eq("id", ORGANIZATION_VIZINHA);
});

describe("marcas do filtro de estoque e reposição (D-194)", () => {
  it("a forma ANTIGA trunca em silêncio e esconde as duas últimas marcas", async () => {
    // Este teste não guarda a correção: guarda o MOTIVO dela. Se ele começar a
    // passar com todas as marcas, o teto mudou e o caso precisa ser remontado
    // — não é motivo para apagá-lo.
    const resultado = await db
      .from("skus")
      .select("supplier_brand")
      .eq("organization_id", ORGANIZATION_ID)
      .not("supplier_brand", "is", null)
      .order("supplier_brand");

    // O formato exato do defeito: nenhum erro, e menos linhas do que existem.
    expect(resultado.error).toBeNull();
    expect(resultado.data).toHaveLength(TETO_POSTGREST);
    expect(TOTAL_SKUS).toBeGreaterThan(TETO_POSTGREST);

    const marcas = [...new Set((resultado.data ?? []).map((linha) => linha.supplier_brand))];

    // Dez das doze. As duas de fora não aparecem no filtro, e a tela não tem
    // como saber: `error` é nulo.
    expect(marcas).toHaveLength(MARCAS_GORDAS);
    expect(marcas).not.toContain(nomeDaMarca(TOTAL_MARCAS));
  });

  it("a RPC devolve TODAS as marcas, já distintas e ordenadas", async () => {
    const resultado = await db.rpc("get_supplier_brands", { p_organization_id: ORGANIZATION_ID });

    expect(resultado.error).toBeNull();

    const marcas = (resultado.data ?? []).map((linha) => linha.supplier_brand);

    expect(marcas).toEqual(Array.from({ length: TOTAL_MARCAS }, (_, i) => nomeDaMarca(i + 1)));

    // O ponto da fatia em um número: 12 valores atravessam a rede no lugar de
    // 1.000 linhas truncadas de 1.111.
    expect(marcas).toHaveLength(TOTAL_MARCAS);
    expect(marcas.length).toBeLessThan(TETO_POSTGREST);
  });

  it("não devolve marca nula, nem repetida", async () => {
    const resultado = await db.rpc("get_supplier_brands", { p_organization_id: ORGANIZATION_ID });
    const marcas = (resultado.data ?? []).map((linha) => linha.supplier_brand);

    // A tela consome direto: sem `Set`, sem `.filter(b => b !== null)`.
    expect(marcas).not.toContain(null);
    expect(new Set(marcas).size).toBe(marcas.length);
  });

  it("o parâmetro escopa por organização", async () => {
    const daqui = await db.rpc("get_supplier_brands", { p_organization_id: ORGANIZATION_ID });
    const davizinha = await db.rpc("get_supplier_brands", { p_organization_id: ORGANIZATION_VIZINHA });

    expect((daqui.data ?? []).map((l) => l.supplier_brand)).not.toContain(`${PREFIXO} MARCA-DA-VIZINHA`);
    expect((davizinha.data ?? []).map((l) => l.supplier_brand)).toEqual([`${PREFIXO} MARCA-DA-VIZINHA`]);

    // Aqui o cliente é `service_role`, que passa por cima da RLS — o que este
    // teste prova é o FILTRO do parâmetro, não a autorização. A metade de
    // segurança (RLS de verdade, com usuário autenticado de outra organização)
    // está em `rls.integration.test.ts`, onde há sessão com papel real.
  });
});
