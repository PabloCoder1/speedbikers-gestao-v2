import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Alerta de venda abaixo da margem (D-858) contra o Postgres de verdade.
 *
 * - A margem de cada pedido coberto é a de `get_sku_margins` (5X):
 *   (recebido − custo) ÷ valor de venda.
 * - A meta é a da marca: 40% para as importadas (comparadas sem espaço nem
 *   caixa, no SKU ou num componente do kit), 30% para o resto.
 * - Só o pedido coberto é julgado: sem frete, sem custo ou com dois itens fica
 *   de fora; venda antes de `active_since` também.
 * - O alerta cai uma vez por pedido, com um `domain_event` que vira
 *   notificação; a segunda rodada não repete.
 * - Configuração: e-mail inválido é recusado; só ADMIN e GESTOR alteram.
 *
 * Organização própria, apagada no fim. Exige o Supabase local no ar.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG = "77777777-0000-4000-8000-00000000d858";
const ADMIN = "aaaaaaaa-0000-4000-8000-00000000d858";
const ANALISTA = "aaaaaaaa-0000-4000-8000-00000001d858";
const GESTOR = "aaaaaaaa-0000-4000-8000-00000002d858";
const CONTA = "aaaa8580-0000-4000-8000-00000000aaaa";
const LOJA = "dddd8580-0000-4000-8000-0000000a0858";
const AGORA = "2026-08-12T12:00:00Z";

/*
  Pedidos do ML (todos de 10/08, depois de active_since = 01/08):
  9908580001  NAV ×1 a 100, comissão 5, frete 5  → recebido 90, custo 60 → 30%  < 40% (importada)  → ALERTA
  9908580002  GEN ×1 a 100, comissão 5, frete 5  → 30%, meta 30%                                   → não
  9908580003  GEN ×1 a 100, comissão 10, frete 5 → recebido 85 → 25%                               → ALERTA
  9908580004  GEN ×1 a 100, sem frete observado                                                    → não julgado
  9908580005  SEMCUSTO ×1 a 100                                                                    → não julgado
  9908580006  GEN + NAV no mesmo pedido                                                            → não julgado
  9908580007  GEN ×1 a 100 a 20%, mas em 20/07, antes de ligar                                     → não julgado
  9908580008  KIT (1 NAV + 1 GEN, custo 50) ×1 a 100, comissão 5, frete 5 → 40%, meta 40%          → não
  9908580009  OFFR (marca "off  racer") ×1 a 200, comissão 20, frete 10 → recebido 170, custo 100 → 35% → ALERTA
*/
const PEDIDOS = Array.from({ length: 9 }, (_, i) => 9908580001 + i);

let client: Client;
const sku: Record<string, string> = {};

async function asUser<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await client.query("begin");

  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
    const result = await client.query(sql, params);

    await client.query("commit");

    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function detectar(): Promise<{ ativo: boolean; novos: number; notificadas: number; julgados?: { mercado_livre: number; shopee: number } }> {
  await client.query("begin");

  try {
    await client.query("set local role service_role");
    const r = await client.query<{ r: { ativo: boolean; novos: number; notificadas: number } }>(
      "select public.detectar_vendas_abaixo_da_margem($1, $2) as r",
      [ORG, AGORA],
    );

    await client.query("commit");

    return r.rows[0]?.r ?? { ativo: false, novos: 0, notificadas: 0 };
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

/**
 * Apaga o que a rodada cria e pode ser apagado. domain_events e
 * sku_cost_history são append-only: os eventos ficam (as consultas abaixo
 * filtram pelos alertas da rodada), e o histórico de custo é regravado igual.
 * Organização, conta, loja e SKUs são reaproveitados.
 */
async function limpar(): Promise<void> {
  await client.query("delete from public.sale_margin_alerts where organization_id = $1", [ORG]);
  await client.query("delete from public.shopee_order_items where organization_id = $1", [ORG]);
  await client.query("delete from public.shopee_orders where organization_id = $1", [ORG]);
  await client.query("delete from public.order_financials where order_id = any($1)", [PEDIDOS]);
  await client.query("delete from public.order_items where order_id = any($1)", [PEDIDOS]);
  await client.query("delete from public.orders where id = any($1)", [PEDIDOS]);
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();
  await limpar();

  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
     select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.email, 'x', now(), '{}', now(), now()
     from (values ($1::uuid, 'admin-d858@rls.test'), ($2::uuid, 'analista-d858@rls.test'), ($3::uuid, 'gestor-d858@rls.test')) as u (id, email)
     on conflict (id) do nothing`,
    [ADMIN, ANALISTA, GESTOR],
  );
  await client.query("insert into public.organizations (id, name, slug) values ($1, 'Org D-858', 'org-d858') on conflict (id) do nothing", [ORG]);
  await client.query(
    `insert into public.organization_members (organization_id, user_id, role)
     values ($1, $2, 'ADMIN'), ($1, $3, 'ANALISTA'), ($1, $4, 'GESTOR') on conflict do nothing`,
    [ORG, ADMIN, ANALISTA, GESTOR],
  );
  await client.query(
    `insert into public.margin_alert_settings (organization_id, active_since)
     values ($1, '2026-08-01T00:00:00Z')
     on conflict (organization_id) do update set active_since = excluded.active_since, enabled = true`,
    [ORG],
  );
  await client.query(
    `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
     values ($1, $2, 'Conta D858', 'd858-conta', 8581, 'CONNECTED', now())
     on conflict do nothing`,
    [CONTA, ORG],
  );

  const skus = await client.query<{ id: string; sku_key: string }>(
    `insert into public.skus (organization_id, sku, kind, purchase_cost, supplier_brand, supplier_brand_source, brand, title)
     values ($1, 'D858-NAV', 'PRODUTO', 60, 'Navetec', 'DERIVED', 'NAVETEC', 'Manete Navetec'),
            ($1, 'D858-GEN', 'PRODUTO', 60, null, null, 'NAVETEC', 'Retrovisor'),
            ($1, 'D858-SEMCUSTO', 'PRODUTO', null, null, null, null, 'Sem custo'),
            ($1, 'D858-KIT', 'KIT', null, null, null, null, 'Kit misto'),
            ($1, 'D858-OFFR', 'PRODUTO', 100, 'off  racer', 'DERIVED', null, 'Baú Off Racer')
     on conflict on constraint skus_org_key_unique do update set sku = excluded.sku
     returning id, sku_key`,
    [ORG],
  );

  for (const row of skus.rows) sku[row.sku_key.replace("D858-", "")] = row.id;

  // O kit custa 25 + 25 pelos componentes: o custo HISTÓRICO de NAV e GEN em
  // 10/08 é 25 (o cadastro de hoje diz 60). Só o kit lê os componentes, e o
  // pedido avulso de NAV e de GEN usa o mesmo histórico: por isso NAV e GEN
  // têm o histórico só a partir de 11/08 e o kit lê os componentes de 12/08.
  await client.query(
    "insert into public.sku_components (kit_sku_id, component_sku_id, quantity) values ($1, $2, 1), ($1, $3, 1) on conflict do nothing",
    [sku.KIT, sku.NAV, sku.GEN],
  );

  const pedido = (i: number, dia: string) => [PEDIDOS[i], dia] as const;
  const datas = [
    pedido(0, "2026-08-10 15:00:00+00"),
    pedido(1, "2026-08-10 15:10:00+00"),
    pedido(2, "2026-08-10 15:20:00+00"),
    pedido(3, "2026-08-10 15:30:00+00"),
    pedido(4, "2026-08-10 15:40:00+00"),
    pedido(5, "2026-08-10 15:50:00+00"),
    pedido(6, "2026-07-20 15:00:00+00"),
    pedido(7, "2026-08-10 16:00:00+00"),
    pedido(8, "2026-08-10 16:10:00+00"),
  ];

  for (const [id, dia] of datas) {
    await client.query(
      `insert into public.orders (id, organization_id, ml_account_id, pack_id, status, date_created, date_last_updated, total_amount, currency_id)
       values ($1, $2, $3, null, 'paid', $4, $4, 100, 'BRL') on conflict (id) do nothing`,
      [id, ORG, CONTA, dia],
    );
  }

  const itens: [number, number, string, number, number, number][] = [
    // pedido, posição, sku, quantidade, preço, comissão unitária
    [0, 0, "NAV", 1, 100, 5],
    [1, 0, "GEN", 1, 100, 5],
    [2, 0, "GEN", 1, 100, 10],
    [3, 0, "GEN", 1, 100, 5],
    [4, 0, "SEMCUSTO", 1, 100, 5],
    [5, 0, "GEN", 1, 100, 5],
    [5, 1, "NAV", 1, 100, 5],
    [6, 0, "GEN", 1, 100, 35],
    [7, 0, "KIT", 1, 100, 5],
    [8, 0, "OFFR", 1, 200, 20],
  ];

  for (const [i, pos, s, q, preco, comissao] of itens) {
    await client.query(
      `insert into public.order_items (order_id, organization_id, ml_account_id, position, item_id, variation_id, title, quantity, unit_price, currency_id, sku_id, sale_fee)
       values ($1, $2, $3, $4, $5, null, $6, $7, $8, 'BRL', $9, $10) on conflict do nothing`,
      [PEDIDOS[i], ORG, CONTA, pos, `MLB8580${String(i)}${String(pos)}`, s, q, preco, sku[s], comissao],
    );
  }

  // Frete do vendedor: todos, menos o 9908580004 (índice 3).
  for (const [i, frete] of [[0, 5], [1, 5], [2, 5], [4, 5], [5, 5], [6, 5], [7, 5], [8, 10]] as const) {
    await client.query(
      `insert into public.order_financials (order_id, organization_id, ml_account_id, seller_shipping_cost, seller_discount)
       values ($1, $2, $3, $4, 0) on conflict (order_id) do nothing`,
      [PEDIDOS[i], ORG, CONTA, frete],
    );
  }

  // Custo histórico dos componentes a partir de 10/08 15:55: só o kit (16:00) o vê.
  // O gatilho do insert de skus já grava um registro com a data de HOJE: a
  // guarda olha só ESTE instante, senão o banco novo da CI nunca o recebe.
  await client.query(
    `insert into public.sku_cost_history (organization_id, sku_id, previous_cost, new_cost, changed_by_role, changed_at)
     select $1, x.sku_id, 60, 25, 'postgres', '2026-08-10 15:55:00+00'
     from unnest(array[$2, $3]::uuid[]) as x (sku_id)
     where not exists (
       select 1 from public.sku_cost_history h
       where h.sku_id = x.sku_id and h.changed_at = '2026-08-10 15:55:00+00'
     )`,
    [ORG, sku.NAV, sku.GEN],
  );

  // Shopee (11/08, custo histórico 25): S1 GEN a 100, escrow 80 + ajuste −5 → 75 − 25 = 50%: não.
  // S3 NAV a 100, escrow 60 → 60 − 25 = 35% < 40%: ALERTA (importada).
  await client.query(
    `insert into public.shopee_shops (id, organization_id, environment, shop_id, shop_name, status, connected_at, orders_synced_until, orders_last_success_at)
     values ($1, $2, 'live', 990858001, 'Loja D858', 'CONNECTED', now() - interval '90 days', now(), now())
     on conflict do nothing`,
    [LOJA, ORG],
  );

  for (const [sn, escrow, ajuste, s] of [
    ["D858-S1", 80, -5, "GEN"],
    ["D858-S3", 60, 0, "NAV"],
  ] as const) {
    await client.query(
      `insert into public.shopee_orders (shopee_shop_id, organization_id, order_sn, order_status, shopee_created_at, shopee_updated_at, paid_at, escrow_amount, order_income, financials_synced_at, total_adjustment_amount)
       values ($1, $2, $3, 'COMPLETED', '2026-08-11T15:00:00Z', '2026-08-11T15:00:00Z', '2026-08-11T15:00:00Z', $4, $5::jsonb, now(), $6)
       on conflict do nothing`,
      [LOJA, ORG, sn, escrow, JSON.stringify({ order_discounted_price: 100, escrow_amount: escrow, total_adjustment_amount: ajuste }), ajuste],
    );
    await client.query(
      `insert into public.shopee_order_items (shopee_shop_id, order_sn, position, organization_id, item_id, quantity, discounted_price, sku_id, vinculo_via)
       values ($1, $2, 0, $3, 1, 1, 100, $4, 'SKU_DO_PEDIDO') on conflict do nothing`,
      [LOJA, sn, ORG, sku[s]],
    );
  }
});

afterAll(async () => {
  await limpar();
  await client.end();
});

interface Alerta {
  marketplace: string;
  order_ref: string;
  sku: string;
  imported: boolean;
  sale_value: string;
  net_received: string;
  product_cost: string;
  margin: string;
  min_margin: string;
  cost_is_current: boolean;
  email_status: string;
}

describe("detectar_vendas_abaixo_da_margem (D-858)", () => {
  it("alerta só as vendas cobertas abaixo da meta da marca", async () => {
    const r = await detectar();

    expect(r.ativo).toBe(true);
    expect(r.novos).toBe(4);
    expect(r.notificadas).toBe(4);

    const { rows } = await client.query<Alerta>(
      `select marketplace, order_ref, sku, imported, sale_value, net_received, product_cost, margin, min_margin, cost_is_current, email_status
       from public.sale_margin_alerts where organization_id = $1 order by order_ref`,
      [ORG],
    );

    expect(rows.map((a) => [a.marketplace, a.order_ref, a.sku, a.imported, Number(a.margin), Number(a.min_margin)])).toEqual([
      ["MERCADO_LIVRE", String(PEDIDOS[0]), "D858-NAV", true, 0.3, 0.4],
      ["MERCADO_LIVRE", String(PEDIDOS[2]), "D858-GEN", false, 0.25, 0.3],
      ["MERCADO_LIVRE", String(PEDIDOS[8]), "D858-OFFR", true, 0.35, 0.4],
      ["SHOPEE", "D858-S3", "D858-NAV", true, 0.35, 0.4],
    ]);

    const nav = rows[0];

    expect(nav && [Number(nav.sale_value), Number(nav.net_received), Number(nav.product_cost)]).toEqual([100, 90, 60]);
    expect(nav?.cost_is_current).toBe(true);
    expect(rows.every((a) => a.email_status === "pending")).toBe(true);
    // A Shopee leu o custo histórico (25) da data da venda.
    expect(Number(rows[3]?.product_cost)).toBe(25);
    expect(rows[3]?.cost_is_current).toBe(false);
  });

  it("grava o evento sale.margin.below e a notificação chega a quem alcança a conta", async () => {
    const { rows } = await client.query<{ event_type: string; severity: string; entity_type: string; after: Record<string, unknown> }>(
      `select event_type, severity, entity_type, after from public.domain_events where organization_id = $1 and event_type = 'sale.margin.below'
       and after->>'alerta_id' in (select a.id::text from public.sale_margin_alerts a where a.organization_id = $1) order by after->>'pedido'`,
      [ORG],
    );

    expect(rows).toHaveLength(4);
    expect(rows.every((e) => e.severity === "importante" && e.entity_type === "sku")).toBe(true);
    expect(rows[0]?.after).toMatchObject({ marketplace: "MERCADO_LIVRE", pedido: String(PEDIDOS[0]), conta: "Conta D858", sku: "D858-NAV", meta: 0.4, margem: 0.3 });

    const notificados = await client.query<{ user_id: string }>(
      `select distinct r.user_id from public.notification_recipients r
       join public.notifications n on n.id = r.notification_id
       join public.domain_events e on e.id = n.domain_event_id
       where e.organization_id = $1 and e.event_type = 'sale.margin.below'
         and e.after->>'alerta_id' in (select a.id::text from public.sale_margin_alerts a where a.organization_id = $1)`,
      [ORG],
    );

    // O analista sem permissão na conta não recebe; o ADMIN sempre.
    expect(notificados.rows.map((r) => r.user_id)).toContain(ADMIN);
    expect(notificados.rows.map((r) => r.user_id)).not.toContain(ANALISTA);
  });

  it("a segunda rodada não repete o alerta", async () => {
    const r = await detectar();

    expect(r.novos).toBe(0);
    expect(r.notificadas).toBe(0);
  });

  it("o pedido que ganha o frete depois é julgado na rodada seguinte", async () => {
    await client.query(
      "insert into public.order_financials (order_id, organization_id, ml_account_id, seller_shipping_cost, seller_discount) values ($1, $2, $3, 20, 0)",
      [PEDIDOS[3], ORG, CONTA],
    );

    const r = await detectar();

    // 100 − 5 − 20 − 60 = 15%.
    expect(r.novos).toBe(1);
  });

  it("desligado, não julga nada", async () => {
    await client.query("update public.margin_alert_settings set enabled = false where organization_id = $1", [ORG]);

    const r = await detectar();

    expect(r.ativo).toBe(false);
    await client.query("update public.margin_alert_settings set enabled = true where organization_id = $1", [ORG]);
  });

  it("quem é authenticated não executa o julgamento", async () => {
    await expect(asUser(ADMIN, "select public.detectar_vendas_abaixo_da_margem($1)", [ORG])).rejects.toThrow(/permission denied/);
  });
});

describe("margin_alert_settings (D-858)", () => {
  it("GESTOR grava a lista de e-mails; e-mail inválido é recusado", async () => {
    const gravado = await asUser<{ email_recipients: string[] }>(
      GESTOR,
      "update public.margin_alert_settings set email_recipients = array['a@exemplo.com', 'b@exemplo.com'] where organization_id = $1 returning email_recipients",
      [ORG],
    );

    expect(gravado[0]?.email_recipients).toEqual(["a@exemplo.com", "b@exemplo.com"]);

    await expect(
      asUser(GESTOR, "update public.margin_alert_settings set email_recipients = array['nao-e-email'] where organization_id = $1", [ORG]),
    ).rejects.toThrow(/check constraint/);
  });

  it("ANALISTA lê, mas não altera", async () => {
    const lido = await asUser<{ default_min_margin: string }>(ANALISTA, "select default_min_margin from public.margin_alert_settings where organization_id = $1", [ORG]);

    expect(Number(lido[0]?.default_min_margin)).toBe(0.3);

    const alterado = await asUser(ANALISTA, "update public.margin_alert_settings set default_min_margin = 0.1 where organization_id = $1 returning 1", [ORG]);

    expect(alterado).toHaveLength(0);
  });

  it("o analista sem a conta não lê o alerta dela", async () => {
    const lidos = await asUser(ANALISTA, "select 1 from public.sale_margin_alerts where organization_id = $1 and marketplace = 'MERCADO_LIVRE'", [ORG]);
    const doAdmin = await asUser(ADMIN, "select 1 from public.sale_margin_alerts where organization_id = $1 and marketplace = 'MERCADO_LIVRE'", [ORG]);

    expect(lidos).toHaveLength(0);
    expect(doAdmin.length).toBeGreaterThan(0);
  });
});
