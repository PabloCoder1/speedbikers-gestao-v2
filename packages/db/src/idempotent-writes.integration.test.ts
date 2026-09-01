import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "./types.js";

/**
 * Prova, contra Postgres + PostgREST reais e pelo MESMO cliente que o worker
 * usa, que gravar duas vezes o mesmo movimento de estoque ou o mesmo evento
 * de domínio continua produzindo UMA linha — sem erro no meio.
 *
 * **Por que este teste existe (D-092).** As duas gravações passaram de
 * `INSERT` com o 23505 absorvido no cliente para `ON CONFLICT DO NOTHING`. A
 * motivação foi observabilidade: cada rejeição virava uma linha ERROR no log
 * do Postgres, e a reconciliação horária reprocessa a mesma janela de pedidos,
 * o que produzia ~9.800 erros esperados por dia — o bastante para enterrar um
 * erro de verdade.
 *
 * Mas a troca mexe na garantia mais crítica do projeto: `idempotency_key`
 * UNIQUE é o que torna a dupla movimentação de estoque **fisicamente
 * impossível** (D-019). Se `ignoreDuplicates` se comportasse diferente do
 * esperado — por exemplo, o alvo de conflito errado fazendo a PRIMEIRA
 * inserção virar no-op — o sintoma seria estoque parando de ser registrado em
 * silêncio. Isso não pode depender de leitura de documentação: precisa de
 * medição, e de medição que fique.
 *
 * Testar com mock não serviria: o que está sob teste é o comportamento do
 * PostgREST e do Postgres, não o do nosso código.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ORGANIZATION_ID = randomUUID();
// SKU novo a cada execução: o saldo precisa começar em zero para a asserção
// de `inventory_balances` medir a aplicação DESTE teste, não a soma de todas
// as execuções anteriores (o ledger é append-only e não é limpo — mesma
// convenção já registrada em `rls.integration.test.ts`).
const SKU_ID = randomUUID();
const ACCOUNT_ID = randomUUID();
// `orders.id` e bigint e vem do Mercado Livre — um valor alto e proximo do
// real, longe de qualquer sequencia.
const ORDER_ID = 2_000_000_000_000_000 + Math.floor(Number(process.hrtime.bigint() % 1_000_000n));
const IDEMPOTENCY_KEY = `d092-teste:${randomUUID()}`;
const DEDUP_KEY = `d092-teste:${randomUUID()}`;

const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY ?? "sem-chave", {
  auth: { persistSession: false, autoRefreshToken: false },
});

beforeAll(async () => {
  if (SERVICE_ROLE_KEY === undefined) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY não definida — exporte com `eval \"$(pnpm exec supabase status -o env)\"`.",
    );
  }

  const organization = await db
    .from("organizations")
    .insert({ id: ORGANIZATION_ID, name: "D-092 idempotência", slug: `d092-${ORGANIZATION_ID.slice(0, 8)}` });

  if (organization.error !== null) {
    throw organization.error;
  }

  const sku = await db
    .from("skus")
    .insert({ id: SKU_ID, organization_id: ORGANIZATION_ID, sku: `D092-${SKU_ID.slice(0, 8)}` });

  if (sku.error !== null) {
    throw sku.error;
  }

  // Fixture do teste de D-189, abaixo.
  const account = await db.from("ml_accounts").insert({
    id: ACCOUNT_ID,
    organization_id: ORGANIZATION_ID,
    label: "D-189",
    slug: `d189-${ACCOUNT_ID.slice(0, 8)}`,
  });

  if (account.error !== null) {
    throw account.error;
  }

  const order = await db.from("orders").insert({
    id: ORDER_ID,
    organization_id: ORGANIZATION_ID,
    ml_account_id: ACCOUNT_ID,
    status: "paid",
    date_created: new Date().toISOString(),
    date_last_updated: new Date().toISOString(),
    total_amount: 100,
    currency_id: "BRL",
  });

  if (order.error !== null) {
    throw order.error;
  }
});

afterAll(async () => {
  // `stock_movements` e `domain_events` são append-only e recusam DELETE até
  // do `service_role`; apagar a organização também não os leva junto (a FK do
  // SKU é `on delete restrict`). As linhas ficam, como ficariam em produção.
  await db.from("order_items").delete().eq("order_id", ORDER_ID);
  await db.from("orders").delete().eq("id", ORDER_ID);
  await db.from("ml_accounts").delete().eq("id", ACCOUNT_ID);
  await db.from("organizations").delete().eq("id", ORGANIZATION_ID);
});

describe("gravação idempotente por ON CONFLICT DO NOTHING (D-092)", () => {
  it("o mesmo `idempotency_key` gravado duas vezes produz UMA linha, sem erro", async () => {
    const movement = {
      organization_id: ORGANIZATION_ID,
      sku_id: SKU_ID,
      location_kind: "LOCAL",
      qty_delta: -3,
      movement_type: "VENDA_ML",
      source_type: "ORDER",
      source_id: "d092-order",
      idempotency_key: IDEMPOTENCY_KEY,
      occurred_at: new Date().toISOString(),
    };

    const primeira = await db
      .from("stock_movements")
      .upsert(movement, { onConflict: "idempotency_key", ignoreDuplicates: true });
    const segunda = await db
      .from("stock_movements")
      .upsert(movement, { onConflict: "idempotency_key", ignoreDuplicates: true });

    // Nenhuma das duas pode devolver erro: é isso que tira as ~9.800 linhas
    // ERROR por dia do log do Postgres.
    expect(primeira.error).toBeNull();
    expect(segunda.error).toBeNull();

    const rows = await db
      .from("stock_movements")
      .select("id")
      .eq("idempotency_key", IDEMPOTENCY_KEY);

    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(1);
  });

  it("a projeção de saldo aplica o movimento UMA vez — a garantia de D-019 continua de pé", async () => {
    // O teste acima prova que não há linha duplicada. Este prova o que
    // realmente importa para o negócio: o trigger que mantém
    // `inventory_balances` rodou uma vez só. Uma dupla aplicação aqui seria
    // estoque errado em produção, não um detalhe de log.
    const balance = await db
      .from("inventory_balances")
      .select("quantity")
      .eq("sku_id", SKU_ID)
      .eq("location_kind", "LOCAL")
      .maybeSingle();

    expect(balance.error).toBeNull();
    expect(Number(balance.data?.quantity)).toBe(-3);
  });

  it("o mesmo `dedup_key` gravado duas vezes produz UM evento, sem erro", async () => {
    const event = {
      organization_id: ORGANIZATION_ID,
      ml_account_id: null,
      occurred_at: new Date().toISOString(),
      event_type: "stock.balance.diverged",
      entity_type: "sku",
      entity_id: SKU_ID,
      before: {},
      after: {},
      severity: "critico",
      source: "system",
      dedup_key: DEDUP_KEY,
    };

    const primeira = await db
      .from("domain_events")
      .upsert(event, { onConflict: "dedup_key", ignoreDuplicates: true });
    const segunda = await db
      .from("domain_events")
      .upsert(event, { onConflict: "dedup_key", ignoreDuplicates: true });

    expect(primeira.error).toBeNull();
    expect(segunda.error).toBeNull();

    const rows = await db.from("domain_events").select("id").eq("dedup_key", DEDUP_KEY);

    expect(rows.error).toBeNull();
    expect(rows.data).toHaveLength(1);
  });

  it("um payload DIFERENTE com a mesma chave não sobrescreve o original", async () => {
    // `ignoreDuplicates` tem que ser DO NOTHING, nunca DO UPDATE: reescrever
    // um movimento já gravado é exatamente o que o ledger append-only existe
    // para impedir (D-019).
    const conflitante = await db.from("stock_movements").upsert(
      {
        organization_id: ORGANIZATION_ID,
        sku_id: SKU_ID,
        location_kind: "LOCAL",
        qty_delta: -999,
        movement_type: "CANCELAMENTO_ML",
        source_type: "ORDER",
        source_id: "d092-order",
        idempotency_key: IDEMPOTENCY_KEY,
        occurred_at: new Date().toISOString(),
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    );

    expect(conflitante.error).toBeNull();

    const rows = await db
      .from("stock_movements")
      .select("qty_delta, movement_type")
      .eq("idempotency_key", IDEMPOTENCY_KEY);

    expect(rows.data).toHaveLength(1);
    expect(Number(rows.data?.[0]?.qty_delta)).toBe(-3);
    expect(rows.data?.[0]?.movement_type).toBe("VENDA_ML");
  });
});


/**
 * D-189 — a substituicao de itens deixou de ser `delete` + `insert` e passou a
 * ser `upsert` + exclusao da cauda, para que nao exista instante em que o
 * pedido esteja sem itens.
 *
 * `onConflict: "order_id,position"` e uma STRING interpretada pelo servidor,
 * exatamente a classe que o fake das suites de unidade ignora (a licao de
 * D-188). Se o alvo do conflito estivesse errado, o sintoma seria a segunda
 * gravacao DUPLICAR o item em vez de substitui-lo — e nenhum teste de unidade
 * veria.
 */
describe("substituicao de itens por upsert em (order_id, position) (D-189)", () => {
  const item = (title: string) => ({
    order_id: ORDER_ID,
    organization_id: ORGANIZATION_ID,
    ml_account_id: ACCOUNT_ID,
    position: 0,
    item_id: "MLB999999999",
    variation_id: null,
    title,
    quantity: 1,
    unit_price: 100,
    currency_id: "BRL",
  });

  it("gravar duas vezes a mesma posicao SUBSTITUI, nao duplica", async () => {
    const primeira = await db.from("order_items").upsert([item("primeira versao")], {
      onConflict: "order_id,position",
    });

    expect(primeira.error).toBeNull();

    const segunda = await db.from("order_items").upsert([item("segunda versao")], {
      onConflict: "order_id,position",
    });

    expect(segunda.error).toBeNull();

    const linhas = await db.from("order_items").select("position, title").eq("order_id", ORDER_ID);

    expect(linhas.error).toBeNull();
    expect(linhas.data).toEqual([{ position: 0, title: "segunda versao" }]);
  });

  // D-190 — a razao pela qual o lote desduplica antes de gravar.
  //
  // `ON CONFLICT DO UPDATE` recusa a MESMA chave duas vezes no MESMO comando.
  // Sequencialmente isso nunca foi problema: dois upserts do mesmo pedido sao
  // dois comandos. Em lote e um so, e o Mercado Livre pagina por offset — uma
  // order atualizada durante a varredura pode aparecer duas vezes.
  //
  // Este teste prova que o erro e REAL, nao hipotese. Sem ele, a
  // desduplicacao em `page-writes.ts` pareceria defensiva demais e alguem a
  // removeria.
  it("a mesma chave DUAS VEZES no mesmo upsert e recusada pelo Postgres (D-190)", async () => {
    const duplicado = await db.from("order_items").upsert([item("primeira"), item("segunda")], {
      onConflict: "order_id,position",
    });

    expect(duplicado.error).not.toBeNull();
    expect(duplicado.error?.message).toMatch(/affect row a second time/i);
  });

  it("a exclusao da cauda nao toca nas posicoes que o pedido atual ocupa", async () => {
    // Um pedido que ja teve 3 itens e agora tem 1: as posicoes 1 e 2 sao a
    // cauda, e a 0 tem de sobreviver.
    await db.from("order_items").upsert([{ ...item("mantem"), position: 0 }, { ...item("cauda 1"), position: 1 }, { ...item("cauda 2"), position: 2 }], {
      onConflict: "order_id,position",
    });

    const exclusao = await db.from("order_items").delete().eq("order_id", ORDER_ID).gte("position", 1);

    expect(exclusao.error).toBeNull();

    const linhas = await db.from("order_items").select("position, title").eq("order_id", ORDER_ID);

    expect(linhas.data).toEqual([{ position: 0, title: "mantem" }]);
  });
});
