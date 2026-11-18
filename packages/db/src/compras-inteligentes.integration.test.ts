import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Compras inteligentes (D-720 a D-725) contra o Postgres de verdade.
 *
 * - `get_sku_margins`: equivalência com `get_faturamento` (ML) e
 *   `get_shopee_faturamento_por_sku` (Shopee) no mesmo SKU e período; o
 *   consolidado é a soma dos valores; a RLS por conta recorta o que entra.
 * - `get_purchase_analysis`: pedidos sobrepostos, 1ª venda e dias de ruptura
 *   reconstruídos do ledger.
 * - O ciclo do pedido: criação idempotente, decisões de revisão (inclusive do
 *   item retirado), concorrência otimista, recebimento parcial idempotente,
 *   cancelamento só do pendente, etapa logística, custos e fornecedor × SKU.
 *
 * Organização própria, apagada no fim. Exige o Supabase local no ar.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG = "77777777-0000-4000-8000-00000000d720";
const ADMIN = "aaaaaaaa-0000-4000-8000-00000000d720";
const ANALISTA = "aaaaaaaa-0000-4000-8000-00000001d720";
const GESTOR = "aaaaaaaa-0000-4000-8000-00000002d720";
const CONTA_A = "aaaa7200-0000-4000-8000-00000000aaaa";
const CONTA_B = "aaaa7200-0000-4000-8000-00000000bbbb";
const LOJA = "dddd7200-0000-4000-8000-0000000a0720";
const PEDIDOS_ML = [9907200001, 9907200002, 9907200003, 9907200004, 9907200005];
const DE = "2026-08-10";
const ATE = "2026-08-11";

let client: Client;
let skuA = "";
let skuB = "";
let kit = "";
let skuC = "";
let fornecedor = "";

async function asUser<T>(userId: string, sql: string, persist = false): Promise<T[]> {
  await client.query("begin");

  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
    const result = await client.query(sql);

    await client.query(persist ? "commit" : "rollback");

    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function one<T>(userId: string, sql: string, persist = false): Promise<T> {
  const rows = await asUser<T>(userId, sql, persist);
  const row = rows[0];

  if (row === undefined) throw new Error(`sem linha: ${sql}`);

  return row;
}

interface Totais {
  unidades: number;
  pedidos: number;
  receita: number;
  pedidos_cobertos: number;
  receita_coberta: number | null;
  recebido_coberto: number | null;
  custo_coberto: number | null;
  pedidos_custo_atual: number;
}

interface MargemSku {
  sku_id: string;
  total: Totais | null;
  marketplaces: (Totais & { marketplace: string })[];
  contas: (Totais & { marketplace: string; conta_id: string; conta: string })[];
}

interface Margens {
  margem_minima: number;
  canais: { tiktok_shop: { lojas: number; pedidos_lidos: boolean }; shopee: { lojas_lidas: number } };
  skus: MargemSku[];
}

async function margens(usuario: string, skus: string[], de = DE, ate = ATE): Promise<Margens> {
  const row = await one<{ m: Margens }>(
    usuario,
    `select public.get_sku_margins('${ORG}', array[${skus.map((s) => `'${s}'::uuid`).join(",")}], '${de}', '${ate}') as m`,
  );

  return row.m;
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
     select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.email, 'x', now(), '{}', now(), now()
     from (values ($1::uuid, 'admin-d720@rls.test'), ($2::uuid, 'analista-d720@rls.test'), ($3::uuid, 'gestor-d720@rls.test')) as u (id, email)
     on conflict (id) do nothing`,
    [ADMIN, ANALISTA, GESTOR],
  );
  await client.query("insert into public.organizations (id, name, slug) values ($1, 'Org D-720', 'org-d720') on conflict (id) do nothing", [ORG]);
  await client.query(
    `insert into public.organization_members (organization_id, user_id, role)
     values ($1, $2, 'ADMIN'), ($1, $3, 'ANALISTA'), ($1, $4, 'GESTOR') on conflict do nothing`,
    [ORG, ADMIN, ANALISTA, GESTOR],
  );
  await client.query(
    `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
     values ($1, $3, 'Conta A', 'd720-conta-a', 7201, 'CONNECTED', now()),
            ($2, $3, 'Conta B', 'd720-conta-b', 7202, 'CONNECTED', now())
     on conflict do nothing`,
    [CONTA_A, CONTA_B, ORG],
  );
  // O analista só enxerga a Conta A.
  await client.query("insert into public.user_account_permissions (user_id, ml_account_id) values ($1, $2) on conflict do nothing", [
    ANALISTA,
    CONTA_A,
  ]);

  const skus = await client.query<{ id: string; sku_key: string }>(
    `insert into public.skus (organization_id, sku, kind, purchase_cost, created_at)
     values ($1, 'D720-A', 'PRODUTO', 20, now() - interval '400 days'),
            ($1, 'D720-B', 'PRODUTO', 30, now() - interval '400 days'),
            ($1, 'D720-KIT', 'KIT', null, now() - interval '400 days'),
            ($1, 'D720-C', 'PRODUTO', 5, now() - interval '10 days')
     on conflict on constraint skus_org_key_unique do update set sku = excluded.sku
     returning id, sku_key`,
    [ORG],
  );

  skuA = skus.rows.find((r) => r.sku_key === "D720-A")?.id ?? "";
  skuB = skus.rows.find((r) => r.sku_key === "D720-B")?.id ?? "";
  kit = skus.rows.find((r) => r.sku_key === "D720-KIT")?.id ?? "";
  skuC = skus.rows.find((r) => r.sku_key === "D720-C")?.id ?? "";

  // Custo histórico de A em 10/08 = 25 (hoje 20). O kit = 2 A + 1 C.
  await client.query(
    `insert into public.sku_cost_history (organization_id, sku_id, previous_cost, new_cost, changed_by_role, changed_at)
     values ($1, $2, null, 25, 'postgres', '2026-07-01 12:00:00+00')`,
    [ORG, skuA],
  );
  await client.query("insert into public.sku_components (kit_sku_id, component_sku_id, quantity) values ($1, $2, 2), ($1, $3, 1) on conflict do nothing", [
    kit,
    skuA,
    skuC,
  ]);

  /*
    Mercado Livre:
    9907200001  Conta A  A ×2 a 50 (100)  comissão 5/un  frete 15  → recebido 100−10−15 = 75, custo 2×25 = 50
    9907200002  Conta B  A ×1 a 60        comissão 6     frete 10  → recebido 44, custo 25
    9907200003  Conta A  KIT ×1 a 80      comissão 8     frete 12  → recebido 60, custo 2×25+5 = 55
    9907200004  Conta A  A ×1 a 40        sem frete observado      → não coberto
    9907200005  Conta A  A, cancelado                              → fora
  */
  await client.query(
    `insert into public.orders (id, organization_id, ml_account_id, pack_id, status, date_created, date_last_updated, total_amount, currency_id)
     values ($1, $6, $7, null, 'paid', '2026-08-10 15:00:00+00', '2026-08-10 15:05:00+00', 100, 'BRL'),
            ($2, $6, $8, null, 'paid', '2026-08-10 16:00:00+00', '2026-08-10 16:05:00+00', 60, 'BRL'),
            ($3, $6, $7, null, 'paid', '2026-08-11 15:00:00+00', '2026-08-11 15:05:00+00', 80, 'BRL'),
            ($4, $6, $7, null, 'paid', '2026-08-11 16:00:00+00', '2026-08-11 16:05:00+00', 40, 'BRL'),
            ($5, $6, $7, null, 'cancelled', '2026-08-11 17:00:00+00', '2026-08-11 17:05:00+00', 999, 'BRL')
     on conflict (id) do nothing`,
    [...PEDIDOS_ML, ORG, CONTA_A, CONTA_B],
  );
  await client.query(
    `insert into public.order_items (order_id, organization_id, ml_account_id, position, item_id, variation_id, title, quantity, unit_price, currency_id, sku_id, sale_fee)
     values ($1, $6, $7, 0, 'MLB972001', null, 'A', 2, 50, 'BRL', $9, 5),
            ($2, $6, $8, 0, 'MLB972002', null, 'A', 1, 60, 'BRL', $9, 6),
            ($3, $6, $7, 0, 'MLB972003', null, 'Kit', 1, 80, 'BRL', $10, 8),
            ($4, $6, $7, 0, 'MLB972004', null, 'A', 1, 40, 'BRL', $9, 4),
            ($5, $6, $7, 0, 'MLB972005', null, 'A', 1, 999, 'BRL', $9, 99)
     on conflict do nothing`,
    [...PEDIDOS_ML, ORG, CONTA_A, CONTA_B, skuA, kit],
  );
  await client.query(
    `insert into public.order_financials (order_id, organization_id, ml_account_id, seller_shipping_cost, seller_discount)
     values ($1, $4, $5, 15, 0), ($2, $4, $6, 10, 0), ($3, $4, $5, 12, null)
     on conflict (order_id) do nothing`,
    [PEDIDOS_ML[0], PEDIDOS_ML[1], PEDIDOS_ML[2], ORG, CONTA_A, CONTA_B],
  );

  // Shopee: S1 A ×1 a 100, escrow 70 + ajuste −5 → recebido 65, custo 25. S2 B sem financeiro.
  await client.query(
    `insert into public.shopee_shops (id, organization_id, environment, shop_id, shop_name, status, connected_at, orders_synced_until, orders_last_success_at)
     values ($1, $2, 'live', 990720001, 'Loja D720', 'CONNECTED', now() - interval '90 days', now(), now())
     on conflict do nothing`,
    [LOJA, ORG],
  );

  for (const [sn, escrow, ajuste] of [
    ["S1", 70, -5],
    ["S2", null, null],
  ] as const) {
    const json = escrow === null ? null : JSON.stringify({ order_discounted_price: 100, escrow_amount: escrow, total_adjustment_amount: ajuste });

    await client.query(
      `insert into public.shopee_orders (shopee_shop_id, organization_id, order_sn, order_status, shopee_created_at, shopee_updated_at, paid_at, escrow_amount, order_income, financials_synced_at, total_adjustment_amount)
       values ($1, $2, $3, 'COMPLETED', '2026-08-10T15:00:00Z', '2026-08-10T15:00:00Z', '2026-08-10T15:00:00Z', $4, $5::jsonb, case when $5::jsonb is null then null else now() end, $6)
       on conflict do nothing`,
      [LOJA, ORG, sn, escrow, json, ajuste],
    );
  }

  await client.query(
    `insert into public.shopee_order_items (shopee_shop_id, order_sn, position, organization_id, item_id, quantity, discounted_price, sku_id, vinculo_via)
     values ($1, 'S1', 0, $2, 1, 1, 100, $3, 'SKU_DO_PEDIDO'), ($1, 'S2', 0, $2, 1, 1, 100, $4, 'SKU_DO_PEDIDO')
     on conflict do nothing`,
    [LOJA, ORG, skuA, skuB],
  );

  await client.query("insert into public.tiktok_shops (organization_id, shop_id, shop_name, status) values ($1, 'tt-d720', 'TikTok D720', 'CONNECTED') on conflict do nothing", [
    ORG,
  ]).catch(() => undefined);

  const f = await client.query<{ id: string }>(
    "insert into public.suppliers (organization_id, name) values ($1, 'Fornecedor D720') on conflict (organization_id, name) do update set name = excluded.name returning id",
    [ORG],
  );

  fornecedor = f.rows[0]?.id ?? "";
});

afterAll(async () => {
  // ALTER TABLE mantém a trava até COMMIT: nenhuma outra suíte insere
  // movimentos enquanto o gatilho de projeção está desligado. ROLLBACK
  // restaura os gatilhos também quando a limpeza falha.
  await client.query("begin");

  try {
    // Append-only no teste: o dono da tabela desliga a trava só para limpar a organização própria.
    for (const t of ["purchase_order_events", "purchase_order_review_decisions", "stock_movements"]) {
      await client.query(`alter table public.${t} disable trigger user`);
    }

    await client.query("delete from public.purchase_order_review_decisions where organization_id = $1", [ORG]);
    await client.query("delete from public.purchase_order_events where organization_id = $1", [ORG]);
    await client.query("delete from public.purchase_orders where organization_id = $1", [ORG]);
    await client.query("delete from public.stock_movements where organization_id = $1", [ORG]);
    await client.query("delete from public.inventory_balances where organization_id = $1", [ORG]);

    for (const t of ["purchase_order_events", "purchase_order_review_decisions", "stock_movements"]) {
      await client.query(`alter table public.${t} enable trigger user`);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
  await client.query("delete from public.order_financials where order_id = any($1)", [PEDIDOS_ML]);
  await client.query("delete from public.orders where id = any($1)", [PEDIDOS_ML]);
  await client.query("delete from public.fulfillment_stock_snapshots where organization_id = $1", [ORG]);
  await client.query("delete from public.shopee_shops where id = $1", [LOJA]);
  await client.end();
});

describe("get_sku_margins (D-720)", () => {
  it("ML por conta: a mesma conta de get_faturamento no mesmo SKU", async () => {
    const m = await margens(ADMIN, [skuA]);
    const a = m.skus[0];
    const contaA = a?.contas.find((c) => c.conta_id === CONTA_A);

    // Conta A: pedidos 1 (coberto) e 4 (sem frete).
    expect(contaA).toMatchObject({
      marketplace: "MERCADO_LIVRE",
      conta: "Conta A",
      unidades: 3,
      pedidos: 2,
      receita: 140,
      pedidos_cobertos: 1,
      receita_coberta: 100,
      recebido_coberto: 75,
      custo_coberto: 50,
      pedidos_custo_atual: 0,
    });

    const fat = await one<{ f: { por_sku: { maior_receita: { sku_id: string; receita_coberta: number; resultado_venda: number; custo_produtos: number }[] } } }>(
      ADMIN,
      `select public.get_faturamento('${DE}', '${ATE}', '${CONTA_A}', true) as f`,
    );
    const linhaFat = fat.f.por_sku.maior_receita.find((x) => x.sku_id === skuA);

    expect(linhaFat?.receita_coberta).toBe(contaA?.receita_coberta);
    expect(linhaFat?.custo_produtos).toBe(contaA?.custo_coberto);
    expect(linhaFat?.resultado_venda).toBe((contaA?.recebido_coberto ?? 0) - (contaA?.custo_coberto ?? 0));
  });

  it("Shopee por loja: a mesma conta de get_shopee_faturamento_por_sku", async () => {
    const m = await margens(ADMIN, [skuA]);
    const loja = m.skus[0]?.contas.find((c) => c.marketplace === "SHOPEE");
    const ref = await one<{ receita_coberta: string; recebido_coberto: string; custo_produtos: string; resultado_venda: string }>(
      ADMIN,
      `select * from public.get_shopee_faturamento_por_sku('${ORG}', '${DE}', '${ATE}', null, 'receita') where sku_id = '${skuA}'`,
    );

    expect(loja).toMatchObject({ conta: "Loja D720", unidades: 1, pedidos_cobertos: 1, receita_coberta: 100, recebido_coberto: 65, custo_coberto: 25 });
    expect(Number(ref.receita_coberta)).toBe(loja?.receita_coberta);
    expect(Number(ref.custo_produtos)).toBe(loja?.custo_coberto);
    expect(Number(ref.resultado_venda)).toBe((loja?.recebido_coberto ?? 0) - (loja?.custo_coberto ?? 0));
  });

  it("consolidado = soma dos valores das contas e lojas", async () => {
    const a = (await margens(ADMIN, [skuA])).skus[0];

    // ML A (100/75/50) + ML B (60/44/25) + Shopee (100/65/25).
    expect(a?.total).toMatchObject({ receita_coberta: 260, recebido_coberto: 184, custo_coberto: 100, pedidos_cobertos: 3 });
    expect(a?.marketplaces.map((x) => [x.marketplace, x.receita_coberta])).toEqual([
      ["MERCADO_LIVRE", 160],
      ["SHOPEE", 100],
    ]);
  });

  it("kit: custo pelos componentes na data da venda", async () => {
    const k = (await margens(ADMIN, [kit])).skus[0];

    expect(k?.total).toMatchObject({ receita_coberta: 80, recebido_coberto: 60, custo_coberto: 55 });
  });

  it("SKU sem custo nem venda coberta: totais nulos, nunca zero", async () => {
    const b = (await margens(ADMIN, [skuB])).skus[0];

    // Só o S2, sem financeiro.
    expect(b?.total).toMatchObject({ pedidos: 1, pedidos_cobertos: 0, receita_coberta: null, recebido_coberto: null });
  });

  it("RLS: o analista só soma a conta que ele alcança", async () => {
    const a = (await margens(ANALISTA, [skuA])).skus[0];

    expect(a?.contas.map((c) => c.conta_id)).not.toContain(CONTA_B);
    expect(a?.contas.some((c) => c.marketplace === "SHOPEE")).toBe(false);
  });

  it("TikTok Shop: só a contagem de lojas, sem pedidos lidos", async () => {
    const m = await margens(ADMIN, [skuA]);

    expect(m.canais.tiktok_shop.pedidos_lidos).toBe(false);
    expect(m.margem_minima).toBe(0.1);
  });

  it("recusa período inválido e lista grande demais", async () => {
    await expect(margens(ADMIN, [skuA], ATE, DE)).rejects.toThrow(/periodo invalido/);
    await expect(margens(ADMIN, [skuA], "2025-01-01", ATE)).rejects.toThrow(/366 dias/);
    await expect(
      asUser(ADMIN, `select public.get_sku_margins('${ORG}', array(select gen_random_uuid() from generate_series(1, 501)), '${DE}', '${ATE}')`),
    ).rejects.toThrow(/500 skus/);
  });
});

describe("ciclo do pedido (D-722 a D-725)", () => {
  const ITENS = (q = 10) =>
    `'[{"skuId":"${skuA}","skuSnapshot":"D720-A","titleSnapshot":"A","quantityOrdered":${String(q)},"unitCost":20,"recommendedQuantity":6,"reviewRecommendation":"REDUZIR","reviewDecision":"MANTER","reviewReason":"CAMPANHA"},{"skuId":"${skuC}","skuSnapshot":"D720-C","quantityOrdered":4,"unitCost":5}]'::jsonb`;
  const REVISAO = `'[{"skuId":"${skuB}","skuSnapshot":"D720-B","recommendation":"RETIRAR","decision":"RETIRAR","quantityBefore":50,"quantityAfter":0,"recommendedQuantity":0,"unitCost":30},{"skuId":"${skuA}","skuSnapshot":"D720-A","recommendation":"REDUZIR","decision":"MANTER","quantityBefore":10,"quantityAfter":10,"reason":"CAMPANHA","note":"Black Friday"}]'::jsonb`;

  it("criação idempotente por request_id e decisões gravadas, inclusive do item retirado", async () => {
    const req = "11111111-2222-4333-8444-555555555555";
    const sql = `select id from public.create_purchase_order('${ORG}', ${ITENS()}, '${fornecedor}', null, null, null, null, '${req}', false, null, ${REVISAO})`;
    const a = await one<{ id: string }>(GESTOR, sql, true);
    const b = await one<{ id: string }>(GESTOR, sql, true);

    expect(b.id).toBe(a.id);

    const pedidos = await client.query<{ n: number }>("select count(*)::int as n from public.purchase_orders where organization_id = $1 and request_id = $2", [ORG, req]);
    const decisoes = await client.query<{ decision: string; reason: string | null }>(
      "select decision, reason from public.purchase_order_review_decisions where purchase_order_id = $1 order by sku_snapshot",
      [a.id],
    );
    const item = await client.query<{ review_decision: string; review_reason: string; recommended_quantity: string }>(
      "select review_decision, review_reason, recommended_quantity from public.purchase_order_items where purchase_order_id = $1 and sku_snapshot = 'D720-A'",
      [a.id],
    );

    expect(pedidos.rows[0]?.n).toBe(1);
    expect(decisoes.rows).toEqual([
      { decision: "MANTER", reason: "CAMPANHA" },
      { decision: "RETIRAR", reason: null },
    ]);
    expect(item.rows[0]).toEqual({ review_decision: "MANTER", review_reason: "CAMPANHA", recommended_quantity: "6.000" });
  });

  it("o analista não cria pedido nem grava decisão", async () => {
    await expect(asUser(ANALISTA, `select public.create_purchase_order('${ORG}', ${ITENS()})`)).rejects.toThrow(/sem permissao/);
  });

  it("edição recusa quando outra pessoa salvou no meio", async () => {
    // `::text`: o `Date` do driver perde os microssegundos; a tela recebe o texto inteiro do PostgREST.
    const po = await one<{ id: string; lido: string }>(GESTOR, `select id, updated_at::text as lido from public.create_purchase_order('${ORG}', ${ITENS()})`, true);

    await asUser(GESTOR, `select public.update_purchase_order_draft('${po.id}', ${ITENS(8)}, p_expected_updated_at => '${po.lido}')`, true);
    await expect(
      asUser(GESTOR, `select public.update_purchase_order_draft('${po.id}', ${ITENS(7)}, p_expected_updated_at => '${po.lido}')`),
    ).rejects.toThrow(/alterado por outra pessoa/);
  });

  it("recebimento parcial: baixa o trânsito do que chegou, idempotente, e fecha quando chega tudo", async () => {
    const po = await one<{ id: string }>(GESTOR, `select id from public.create_purchase_order('${ORG}', ${ITENS()})`, true);

    await asUser(GESTOR, `select public.approve_purchase_order('${po.id}')`, true);
    await asUser(GESTOR, `select public.mark_purchase_order_ordered('${po.id}')`, true);

    const itens = await client.query<{ id: string; sku_snapshot: string }>("select id, sku_snapshot from public.purchase_order_items where purchase_order_id = $1", [po.id]);
    const itemA = itens.rows.find((r) => r.sku_snapshot === "D720-A")?.id ?? "";
    const itemC = itens.rows.find((r) => r.sku_snapshot === "D720-C")?.id ?? "";
    const transito = async (): Promise<number> =>
      Number(
        (
          await client.query<{ q: string }>(
            "select coalesce(sum(quantity), 0) as q from public.inventory_balances where sku_id = $1 and location_kind = 'TRANSITO'",
            [skuA],
          )
        ).rows[0]?.q ?? 0,
      );
    const antes = await transito();
    const req1 = "aaaaaaaa-1111-4000-8000-000000000001";
    const receber = (req: string, itensJson: string) =>
      asUser<{ status: string }>(GESTOR, `select status from public.receive_purchase_order_items('${po.id}', '${itensJson}'::jsonb, '${req}')`, true);

    const parcial = await receber(req1, JSON.stringify([{ itemId: itemA, quantity: 4 }]));

    expect(parcial[0]?.status).toBe("ORDERED");
    expect(await transito()).toBe(antes - 4);

    // A mesma requisição de novo: nada muda.
    await receber(req1, JSON.stringify([{ itemId: itemA, quantity: 4 }]));
    expect(await transito()).toBe(antes - 4);

    await expect(receber("aaaaaaaa-1111-4000-8000-000000000002", JSON.stringify([{ itemId: itemA, quantity: 7 }]))).rejects.toThrow(/acima do pedido/);

    const final = await receber(
      "aaaaaaaa-1111-4000-8000-000000000003",
      JSON.stringify([
        { itemId: itemA, quantity: 6 },
        { itemId: itemC, quantity: 4 },
      ]),
    );

    expect(final[0]?.status).toBe("RECEIVED");
    expect(await transito()).toBe(antes - 10);
  });

  it("cancelar depois de receber parte fecha só o pendente", async () => {
    const po = await one<{ id: string }>(GESTOR, `select id from public.create_purchase_order('${ORG}', ${ITENS()})`, true);

    await asUser(GESTOR, `select public.approve_purchase_order('${po.id}')`, true);
    await asUser(GESTOR, `select public.mark_purchase_order_ordered('${po.id}')`, true);

    const itemA = (await client.query<{ id: string }>("select id from public.purchase_order_items where purchase_order_id = $1 and sku_snapshot = 'D720-A'", [po.id])).rows[0]?.id;

    await asUser(GESTOR, `select public.receive_purchase_order_items('${po.id}', '[{"itemId":"${itemA ?? ""}","quantity":3}]'::jsonb, gen_random_uuid())`, true);
    await asUser(GESTOR, `select public.cancel_purchase_order('${po.id}', 'teste')`, true);

    const mov = await client.query<{ total: string }>(
      "select sum(qty_delta)::text as total from public.stock_movements where source_id = $1 and sku_id = $2 and location_kind = 'TRANSITO'",
      [po.id, skuA],
    );

    // +10 no pedido feito, −3 no recebido, −7 no cancelado: o trânsito do pedido zera.
    expect(Number(mov.rows[0]?.total)).toBe(0);
  });

  it("etapa logística validada pelo status e zerada na troca de status", async () => {
    const po = await one<{ id: string }>(GESTOR, `select id from public.create_purchase_order('${ORG}', ${ITENS()})`, true);

    await asUser(GESTOR, `select public.set_purchase_order_stage('${po.id}', 'COTACAO')`, true);
    await expect(asUser(GESTOR, `select public.set_purchase_order_stage('${po.id}', 'EMBARCADO')`)).rejects.toThrow(/nao vale/);
    await asUser(GESTOR, `select public.approve_purchase_order('${po.id}')`, true);

    const depois = await client.query<{ logistics_stage: string | null }>("select logistics_stage from public.purchase_orders where id = $1", [po.id]);

    expect(depois.rows[0]?.logistics_stage).toBeNull();
  });

  it("custos de importação: estimado e realizado em separado, câmbio pendente nunca vira 1", async () => {
    const po = await one<{ id: string }>(
      GESTOR,
      `select id from public.create_purchase_order('${ORG}', ${ITENS()}, null, null, 'USD', null, null, null, true, null)`,
      true,
    );

    await asUser(GESTOR, `select public.upsert_purchase_order_cost('${po.id}', 'FRETE_INTERNACIONAL', 50)`, true);

    const semCambio = await one<{ l: { cambio: number | null; cambio_pendente: boolean; produtos_brl: number | null } }>(
      GESTOR,
      `select public.get_purchase_order_landed_cost('${po.id}') as l`,
    );

    expect(semCambio.l).toMatchObject({ cambio: null, cambio_pendente: true, produtos_brl: null });

    await client.query("update public.purchase_orders set exchange_rate = 5 where id = $1", [po.id]);

    const comCambio = await one<{ l: { produtos_brl: number; adicionais_estimados_brl: number; itens: { sku: string; custo_chegada_estimado_brl: number }[] } }>(
      GESTOR,
      `select public.get_purchase_order_landed_cost('${po.id}') as l`,
    );

    // Produtos: (10×20 + 4×5) × 5 = 1.100; frete 50 → +4,545%.
    expect(comCambio.l.produtos_brl).toBe(1100);
    expect(comCambio.l.adicionais_estimados_brl).toBe(50);
    expect(comCambio.l.itens.find((i) => i.sku === "D720-A")?.custo_chegada_estimado_brl).toBeCloseTo(104.5455, 3);
  });

  it("fornecedor × SKU: um preferido por SKU, e o analista não grava", async () => {
    const outro = (
      await client.query<{ id: string }>(
        "insert into public.suppliers (organization_id, name) values ($1, 'Outro D720') on conflict (organization_id, name) do update set name = excluded.name returning id",
        [ORG],
      )
    ).rows[0]?.id;

    await asUser(GESTOR, `select public.upsert_supplier_sku('${fornecedor}', '${skuA}', 'FX-1', null, 18, 'BRL', 20, 12, 30, true)`, true);
    await asUser(GESTOR, `select public.upsert_supplier_sku('${outro ?? ""}', '${skuA}', 'OX-1', null, 17, 'BRL', null, null, null, true)`, true);

    const pref = await client.query<{ supplier_id: string }>("select supplier_id from public.supplier_skus where sku_id = $1 and is_preferred", [skuA]);

    expect(pref.rows).toEqual([{ supplier_id: outro }]);
    await expect(asUser(ANALISTA, `select public.upsert_supplier_sku('${fornecedor}', '${skuB}')`)).rejects.toThrow(/sem permissao/);

    const lista = await one<{ l: { total: number; linhas: { sku: string; minimum_order_quantity: number; pedidos: number }[] } }>(
      ADMIN,
      `select public.get_supplier_skus('${fornecedor}') as l`,
    );

    expect(lista.l.total).toBe(1);
    expect(lista.l.linhas[0]).toMatchObject({ sku: "D720-A", minimum_order_quantity: 20 });
  });
});

describe("get_purchase_analysis (D-721)", () => {
  it("pedidos sobrepostos, 1ª venda, regra do fornecedor e ruptura reconstruída", async () => {
    // Saldo LOCAL de C: zerado até entrar 5 há 20 dias e de novo desde a saída há 10 → ~9 + ~11 dias.
    await client.query(
      `insert into public.stock_movements (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
       values ($1, $2, 'LOCAL', 5, 'ENTRADA_NFE', 'd720-c-entrada', now() - interval '20 days'),
              ($1, $2, 'LOCAL', -5, 'SAIDA_NFE', 'd720-c-saida', now() - interval '10 days')`,
      [ORG, skuC],
    );

    const a = await one<{
      a: {
        new_product_days: number;
        linhas: {
          sku_id: string;
          other_open_quantity: number;
          stockout_days_30: number | null;
          days_since_first_sale: number | null;
          days_since_created: number;
          supplier_rule: { minimum_order_quantity: number; pack_multiple: number } | null;
        }[];
      };
    }>(ADMIN, `select public.get_purchase_analysis('${ORG}', array['${skuA}'::uuid, '${skuC}'::uuid], null, null, '${fornecedor}') as a`);

    const linhaA = a.a.linhas.find((l) => l.sku_id === skuA);
    const linhaC = a.a.linhas.find((l) => l.sku_id === skuC);

    expect(a.a.new_product_days).toBe(60);
    // Rascunhos e aprovados dos testes acima com A (o recebido e os cancelados ficam fora).
    expect(linhaA?.other_open_quantity).toBeGreaterThan(0);
    expect(linhaA?.days_since_first_sale).not.toBeNull();
    expect(linhaA?.supplier_rule).toMatchObject({ minimum_order_quantity: 20, pack_multiple: 12 });
    expect(linhaC?.days_since_created).toBeLessThanOrEqual(11);
    // A fronteira do dia de São Paulo pode deslocar um dia para cada lado.
    expect(linhaC?.stockout_days_30).toBeGreaterThanOrEqual(19);
    expect(linhaC?.stockout_days_30).toBeLessThanOrEqual(21);

    // Full positivo capturado há 5 dias vale por 3 dias (a janela canônica, D-173):
    // esses dias deixam de ser ruptura mesmo com o LOCAL zerado.
    await client.query(
      `insert into public.fulfillment_stock_snapshots (organization_id, ml_account_id, inventory_id, item_id, sku_id, quantity, captured_at)
       values ($1, $2, 'INV-D720', 'MLB972099', $3, 4, now() - interval '5 days')`,
      [ORG, CONTA_A, skuC],
    );

    const comFull = await one<{ a: { linhas: { sku_id: string; stockout_days_30: number | null }[] } }>(
      ADMIN,
      `select public.get_purchase_analysis('${ORG}', array['${skuC}'::uuid]) as a`,
    );
    const semFull = linhaC?.stockout_days_30 ?? 0;
    const agora = comFull.a.linhas[0]?.stockout_days_30 ?? 0;

    expect(semFull - agora).toBeGreaterThanOrEqual(2);
    expect(semFull - agora).toBeLessThanOrEqual(4);
  });

  it("estoque virtual: ruptura desconhecida, nunca zero", async () => {
    await client.query("update public.skus set stock_is_virtual = true where id = $1", [skuB]);

    const a = await one<{ a: { linhas: { sku_id: string; stockout_days_30: number | null }[] } }>(
      ADMIN,
      `select public.get_purchase_analysis('${ORG}', array['${skuB}'::uuid]) as a`,
    );

    expect(a.a.linhas[0]?.stockout_days_30).toBeNull();
    await client.query("update public.skus set stock_is_virtual = false where id = $1", [skuB]);
  });
});
