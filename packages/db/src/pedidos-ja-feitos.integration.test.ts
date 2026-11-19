import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A visão classifica o catálogo inteiro a cada chamada; a frio passa de 5 s.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * "Já fiz o pedido" e a importação de pedidos anteriores (D-760 a D-764)
 * contra o Postgres de verdade — os dez cenários do pedido do dono:
 *
 *  1. pedido externo de 1.000 com necessidade de 1.200 → sugere 200;
 *  2. pedidos confirmados acima da necessidade → sugere 0;
 *  3. pedido só planejado → a necessidade continua inteira;
 *  4. a mesma requisição/referência/planilha duas vezes → um pedido, um trânsito;
 *  5. recebimento parcial → só o saldo continua pendente;
 *  6. cancelamento → deixa de reduzir a necessidade;
 *  7. código ambíguo → não vincula sozinho;
 *  8. pedido interno já existente → candidato a vínculo, sem segundo trânsito;
 *  9. chegada prevista e atraso visíveis, sem recomprar o que já foi pedido;
 * 10. outra organização (e perfil sem acesso a compras) não lê nem escreve;
 * 11. invoice do fornecedor (D-767): preço e documento guardados, mesmo SKU
 *     somado, custo só na moeda certa e SKU que já está no pedido recusado.
 *
 * Organização própria, apagada no fim. Exige o Supabase local no ar.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG = "77777777-0000-4000-8000-00000000d760";
const OUTRA_ORG = "77777777-0000-4000-8000-00000001d760";
const ADMIN = "aaaaaaaa-0000-4000-8000-00000000d760";
const ANALISTA = "aaaaaaaa-0000-4000-8000-00000001d760";
const INTRUSO = "aaaaaaaa-0000-4000-8000-00000002d760";
const CONTA = "aaaa7600-0000-4000-8000-00000000aaaa";

let client: Client;
const sku: Record<string, string> = {};
let fornecedor = "";
let hoje = "";

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

async function one<T>(userId: string, sql: string, params: unknown[] = []): Promise<T> {
  const row = (await asUser<T>(userId, sql, params))[0];

  if (row === undefined) throw new Error(`sem linha: ${sql}`);

  return row;
}

interface Registro {
  resultado: string;
  pedido: { id: string; orderNumber: number; status: string } | null;
  candidatos: { motivo: string; purchaseOrderId: string; skuId: string | null; pendente: number | null }[];
}

interface RegistroInput {
  requestId: string;
  itens: { skuId: string; quantity: number }[];
  situacao: "PLANEJADO" | "PEDIDO_REALIZADO";
  referencia?: string | null;
  fornecedorId?: string | null;
  previsao?: string | null;
  confirmar?: boolean;
  usuario?: string;
  org?: string;
}

async function registrar(input: RegistroInput): Promise<Registro> {
  const row = await one<{ r: Registro }>(
    input.usuario ?? ADMIN,
    `select public.register_placed_purchase_order(
       p_organization_id => $1, p_request_id => $2, p_items => $3::jsonb, p_situacao => $4,
       p_supplier_id => $5, p_external_reference => $6, p_expected_at => $7, p_confirm_new => $8) as r`,
    [
      input.org ?? ORG,
      input.requestId,
      JSON.stringify(input.itens),
      input.situacao,
      input.fornecedorId ?? null,
      input.referencia ?? null,
      input.previsao ?? null,
      input.confirmar ?? false,
    ],
  );

  return row.r;
}

interface LinhaVisao {
  sku_id: string;
  transito: number;
  suggested_quantity: number | null;
  compra_pendente: number | null;
  compra_planejada: number | null;
  compra_proxima_chegada: string | null;
  compra_atrasada: boolean | null;
  compra_pedidos: number | null;
}

interface Visao {
  total: number;
  linhas: LinhaVisao[];
  contagens_compra: Record<string, number> | null;
}

async function visao(usuario = ADMIN, compra: string | null = null): Promise<Visao> {
  const row = await one<{ v: Visao }>(
    usuario,
    "select public.get_replenishment_overview($1, $2::date, null, 'D760', null, 100, 0, $3) as v",
    [ORG, hoje, compra],
  );

  return row.v;
}

async function linha(nome: string, usuario = ADMIN): Promise<LinhaVisao> {
  const v = await visao(usuario);
  const l = v.linhas.find((x) => x.sku_id === sku[nome]);

  if (l === undefined) throw new Error(`SKU ${nome} fora da visão`);

  return l;
}

async function transito(skuId: string): Promise<number> {
  const r = await client.query<{ t: string | null }>(
    "select sum(qty_delta)::text as t from public.stock_movements where sku_id = $1 and location_kind = 'TRANSITO'",
    [skuId],
  );

  return Number(r.rows[0]?.t ?? 0);
}

async function local(skuId: string): Promise<number> {
  const r = await client.query<{ t: string | null }>(
    "select sum(qty_delta)::text as t from public.stock_movements where sku_id = $1 and location_kind = 'LOCAL'",
    [skuId],
  );

  return Number(r.rows[0]?.t ?? 0);
}

async function limpar(): Promise<void> {
  // Os gatilhos pertencem à tabela inteira, não à organização do teste.
  // A transação mantém o ALTER TABLE bloqueado até todos estarem ativos.
  await client.query("begin");

  try {
    for (const t of ["purchase_order_events", "purchase_order_review_decisions", "stock_movements"]) {
      await client.query(`alter table public.${t} disable trigger user`);
    }

    for (const org of [ORG, OUTRA_ORG]) {
      await client.query("delete from public.purchase_import_batches where organization_id = $1", [org]);
      await client.query("delete from public.purchase_order_events where organization_id = $1", [org]);
      await client.query("delete from public.purchase_orders where organization_id = $1", [org]);
      await client.query("delete from public.stock_movements where organization_id = $1", [org]);
      await client.query("delete from public.inventory_balances where organization_id = $1", [org]);
    }

    for (const t of ["purchase_order_events", "purchase_order_review_decisions", "stock_movements"]) {
      await client.query(`alter table public.${t} enable trigger user`);
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();
  await limpar();

  hoje = (await client.query<{ d: string }>("select ((now() at time zone 'America/Sao_Paulo')::date)::text as d")).rows[0]?.d ?? "";

  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
     select u.id, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', u.email, 'x', now(), '{}', now(), now()
     from (values ($1::uuid, 'admin-d760@rls.test'), ($2::uuid, 'analista-d760@rls.test'), ($3::uuid, 'intruso-d760@rls.test')) as u (id, email)
     on conflict (id) do nothing`,
    [ADMIN, ANALISTA, INTRUSO],
  );
  await client.query(
    "insert into public.organizations (id, name, slug) values ($1, 'Org D-760', 'org-d760'), ($2, 'Outra D-760', 'outra-d760') on conflict (id) do nothing",
    [ORG, OUTRA_ORG],
  );
  await client.query(
    `insert into public.organization_members (organization_id, user_id, role)
     values ($1, $3, 'ADMIN'), ($1, $4, 'ANALISTA'), ($2, $5, 'ADMIN') on conflict do nothing`,
    [ORG, OUTRA_ORG, ADMIN, ANALISTA, INTRUSO],
  );
  await client.query(
    `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
     values ($1, $2, 'Conta D760', 'd760-conta', 7601, 'CONNECTED', now()) on conflict do nothing`,
    [CONTA, ORG],
  );
  await client.query("insert into public.user_account_permissions (user_id, ml_account_id) values ($1, $2) on conflict do nothing", [
    ANALISTA,
    CONTA,
  ]);

  const nomes = ["D760-EXT", "D760-COBRE", "D760-PLAN", "D760-DUP", "D760-PARC", "D760-CANC", "D760-INT", "D760-ATRASO", "D760-PLAN-A", "D760-PLAN-B"];
  const r = await client.query<{ id: string; sku: string }>(
    `insert into public.skus (organization_id, sku, kind, purchase_cost, barcode, created_at)
     select $1, n, 'PRODUTO', 10, case when n = 'D760-PLAN-A' then '96385074' end, now() - interval '400 days'
     from unnest($2::text[]) n
     on conflict on constraint skus_org_key_unique do update set sku = excluded.sku
     returning id, sku`,
    [ORG, nomes],
  );

  for (const row of r.rows) sku[row.sku] = row.id;

  // 90 dias de venda: 20/dia em todos (60 dias de janela → 1.200), menos o COBRE (10/dia).
  await client.query(
    `insert into public.daily_sku_metrics (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
     select $1, $2, s.id, d::date, case when s.sku = 'D760-COBRE' then 10 else 20 end, 100, 1, 1
     from public.skus s, generate_series($3::date - 89, $3::date, interval '1 day') d
     where s.organization_id = $1
     on conflict do nothing`,
    [ORG, CONTA, hoje],
  );

  // Padrão da organização: prazo 30 + cobertura 30 → janela de 60 dias.
  await client.query(
    `insert into public.replenishment_settings (organization_id, lead_time_days, target_coverage_days, safety_stock_days)
     values ($1, 30, 30, 0) on conflict do nothing`,
    [ORG],
  );
  // COBRE: prazo 20 + cobertura 30 → 50 dias × 10 = 500.
  await client.query(
    `insert into public.replenishment_settings (organization_id, sku_id, lead_time_days, target_coverage_days, safety_stock_days)
     values ($1, $2, 20, 30, 0) on conflict do nothing`,
    [ORG, sku["D760-COBRE"]],
  );

  const f = await client.query<{ id: string }>(
    "insert into public.suppliers (organization_id, name, created_by) values ($1, 'Fornecedor D760', $2) returning id",
    [ORG, ADMIN],
  );
  fornecedor = f.rows[0]?.id ?? "";
});

afterAll(async () => {
  await limpar();
  await client.query("delete from public.replenishment_settings where organization_id = $1", [ORG]);
  await client.query("delete from public.daily_sku_metrics where ml_account_id = $1", [CONTA]);
  await client.query("delete from public.suppliers where organization_id = $1", [ORG]);
  await client.end();
});

describe("a base: sem pedido, a necessidade inteira", () => {
  it("20/dia × 60 dias = 1.200 e 10/dia × 50 dias = 500", async () => {
    expect(await linha("D760-EXT")).toMatchObject({ suggested_quantity: 1200, compra_pendente: 0, compra_planejada: 0 });
    expect(await linha("D760-COBRE")).toMatchObject({ suggested_quantity: 500 });
  });
});

describe("Cenário 1 — pedido externo existente", () => {
  it("1.000 já pedidas: o trânsito nasce uma vez e a sugestão vira 200", async () => {
    const r = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c001",
      itens: [{ skuId: sku["D760-EXT"] ?? "", quantity: 1000 }],
      situacao: "PEDIDO_REALIZADO",
      referencia: "30632-1",
      fornecedorId: fornecedor,
    });

    expect(r.resultado).toBe("CRIADO");
    expect(r.pedido?.status).toBe("ORDERED");
    expect(await transito(sku["D760-EXT"] ?? "")).toBe(1000);
    expect(await linha("D760-EXT")).toMatchObject({
      transito: 1000,
      suggested_quantity: 200,
      compra_pendente: 1000,
      compra_pedidos: 1,
    });

    const po = await client.query("select origin, external_reference, is_import from public.purchase_orders where id = $1", [r.pedido?.id]);
    expect(po.rows[0]).toMatchObject({ origin: "EXTERNO_MANUAL", external_reference: "30632-1" });

    const eventos = await client.query<{ event_type: string }>(
      "select event_type from public.purchase_order_events where purchase_order_id = $1 order by occurred_at, event_type",
      [r.pedido?.id],
    );
    expect(eventos.rows.map((e) => e.event_type)).toEqual(
      expect.arrayContaining(["CREATED", "EXTERNAL_REGISTERED", "APPROVED", "ORDERED"]),
    );
  });
});

describe("Cenário 2 — pedido atende toda a necessidade", () => {
  it("600 confirmadas em dois pedidos contra 500: nenhuma compra nova", async () => {
    await registrar({
      requestId: "00000000-0000-4000-8000-00000000c002",
      itens: [{ skuId: sku["D760-COBRE"] ?? "", quantity: 400 }],
      situacao: "PEDIDO_REALIZADO",
      referencia: "31011",
    });
    // Segundo pedido do mesmo SKU: o sistema avisa e o usuário confirma que é outro.
    const aviso = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c003",
      itens: [{ skuId: sku["D760-COBRE"] ?? "", quantity: 200 }],
      situacao: "PEDIDO_REALIZADO",
      referencia: "30585",
    });
    expect(aviso.resultado).toBe("POSSIVEL_DUPLICIDADE");
    expect(aviso.candidatos[0]).toMatchObject({ motivo: "MESMO_SKU_EM_ABERTO", pendente: 400 });

    const ok = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c003",
      itens: [{ skuId: sku["D760-COBRE"] ?? "", quantity: 200 }],
      situacao: "PEDIDO_REALIZADO",
      referencia: "30585",
      confirmar: true,
    });
    expect(ok.resultado).toBe("CRIADO");

    expect(await linha("D760-COBRE")).toMatchObject({ transito: 600, suggested_quantity: 0, compra_pendente: 600, compra_pedidos: 2 });
  });
});

describe("Cenário 3 — pedido apenas planejado", () => {
  it("planejado não gera trânsito e a necessidade de 1.200 continua", async () => {
    const r = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c004",
      itens: [{ skuId: sku["D760-PLAN"] ?? "", quantity: 500 }],
      situacao: "PLANEJADO",
      referencia: "31205",
    });

    expect(r).toMatchObject({ resultado: "CRIADO", pedido: { status: "DRAFT" } });
    expect(await transito(sku["D760-PLAN"] ?? "")).toBe(0);
    expect(await linha("D760-PLAN")).toMatchObject({ suggested_quantity: 1200, compra_pendente: 0, compra_planejada: 500 });

    const planejados = await visao(ADMIN, "PLANEJADO");
    expect(planejados.linhas.map((l) => l.sku_id)).toContain(sku["D760-PLAN"]);
    expect(planejados.linhas.map((l) => l.sku_id)).not.toContain(sku["D760-EXT"]);
  });
});

describe("Cenário 4 — registro duplicado", () => {
  it("a mesma requisição duas vezes devolve o mesmo pedido, sem segundo trânsito", async () => {
    const entrada: RegistroInput = {
      requestId: "00000000-0000-4000-8000-00000000c005",
      itens: [{ skuId: sku["D760-DUP"] ?? "", quantity: 300 }],
      situacao: "PEDIDO_REALIZADO",
      referencia: "JS31205",
      fornecedorId: fornecedor,
    };
    const a = await registrar(entrada);
    const b = await registrar(entrada);

    expect(a.resultado).toBe("CRIADO");
    expect(b).toMatchObject({ resultado: "JA_REGISTRADO", pedido: { id: a.pedido?.id } });
    expect(await transito(sku["D760-DUP"] ?? "")).toBe(300);
  });

  it("a mesma referência do mesmo fornecedor, com outra requisição, nunca vira outro pedido", async () => {
    const c = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c006",
      itens: [{ skuId: sku["D760-DUP"] ?? "", quantity: 300 }],
      situacao: "PEDIDO_REALIZADO",
      referencia: " js31205 ",
      fornecedorId: fornecedor,
      confirmar: true,
    });

    expect(c.resultado).toBe("REFERENCIA_EXISTENTE");
    expect(await transito(sku["D760-DUP"] ?? "")).toBe(300);
  });

  it("duas abas ao mesmo tempo: um pedido só", async () => {
    const extra = new Client({ connectionString: DB_URL });
    await extra.connect();

    const chamar = async (c: Client): Promise<string> => {
      await c.query("begin");
      await c.query("set local role authenticated");
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN })]);
      const r = await c.query<{ r: Registro }>(
        `select public.register_placed_purchase_order($1, $2, $3::jsonb, 'PEDIDO_REALIZADO', p_external_reference => '31604-1', p_confirm_new => true) as r`,
        [ORG, "00000000-0000-4000-8000-00000000c007", JSON.stringify([{ skuId: sku["D760-DUP"], quantity: 50 }])],
      );
      await c.query("select pg_sleep(0.2)");
      await c.query("commit");

      return r.rows[0]?.r.resultado ?? "";
    };

    // O SKU já tem pedido aberto (o usuário confirmou que é outro); a corrida é da MESMA requisição.
    const resultados = await Promise.all([chamar(client), chamar(extra)]);
    await extra.end();

    expect(resultados.sort()).toEqual(["CRIADO", "JA_REGISTRADO"]);
    expect(await transito(sku["D760-DUP"] ?? "")).toBe(350);
  });
});

describe("Cenário 5 — recebimento parcial", () => {
  it("1.000 pedidas, 300 recebidas: 700 pendentes, e a mesma chegada não conta duas vezes", async () => {
    const r = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c008",
      itens: [{ skuId: sku["D760-PARC"] ?? "", quantity: 1000 }],
      situacao: "PEDIDO_REALIZADO",
      referencia: "31604-2",
    });
    const item = await client.query<{ id: string }>("select id from public.purchase_order_items where purchase_order_id = $1", [r.pedido?.id]);
    const chegada = [{ itemId: item.rows[0]?.id, quantity: 300 }];

    for (let i = 0; i < 2; i++) {
      await asUser(ADMIN, "select public.receive_purchase_order_items($1, $2::jsonb, $3)", [
        r.pedido?.id,
        JSON.stringify(chegada),
        "00000000-0000-4000-8000-00000000c009",
      ]);
    }

    expect(await transito(sku["D760-PARC"] ?? "")).toBe(700);
    // D-792: o que chegou entra no estoque da loja — uma vez só, na mesma requisição.
    expect(await local(sku["D760-PARC"] ?? "")).toBe(300);
    // 1.200 de necessidade − 300 na loja − 700 a caminho. Antes de D-792 o recebido
    // sumia do estoque e a sugestão voltava a pedir por ele (500).
    expect(await linha("D760-PARC")).toMatchObject({ compra_pendente: 700, suggested_quantity: 200 });

    await expect(
      asUser(ADMIN, "select public.receive_purchase_order_items($1, $2::jsonb, $3)", [
        r.pedido?.id,
        JSON.stringify([{ itemId: item.rows[0]?.id, quantity: 701 }]),
        "00000000-0000-4000-8000-00000000c010",
      ]),
    ).rejects.toThrow(/acima do pedido/);
  });
});

describe("Cenário 6 — cancelamento", () => {
  it("o pedido cancelado deixa de reduzir a necessidade", async () => {
    const r = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c011",
      itens: [{ skuId: sku["D760-CANC"] ?? "", quantity: 800 }],
      situacao: "PEDIDO_REALIZADO",
    });
    expect(await linha("D760-CANC")).toMatchObject({ suggested_quantity: 400 });

    await asUser(ADMIN, "select public.cancel_purchase_order($1, 'fornecedor desistiu')", [r.pedido?.id]);

    expect(await transito(sku["D760-CANC"] ?? "")).toBe(0);
    expect(await linha("D760-CANC")).toMatchObject({ suggested_quantity: 1200, compra_pendente: 0, compra_pedidos: 0 });
  });
});

describe("Cenário 8 — pedido interno já existente", () => {
  it("o externo encontra o interno, vincula só a referência e não cria trânsito novo", async () => {
    const interno = await one<{ id: string }>(
      ADMIN,
      `select (public.create_purchase_order($1, $2::jsonb, $3)).id as id`,
      [ORG, JSON.stringify([{ skuId: sku["D760-INT"], skuSnapshot: "D760-INT", quantityOrdered: 1000 }]), fornecedor],
    );
    await asUser(ADMIN, "select public.approve_purchase_order($1)", [interno.id]);
    await asUser(ADMIN, "select public.mark_purchase_order_ordered($1)", [interno.id]);
    expect(await transito(sku["D760-INT"] ?? "")).toBe(1000);

    const r = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c012",
      itens: [{ skuId: sku["D760-INT"] ?? "", quantity: 1000 }],
      situacao: "PEDIDO_REALIZADO",
      referencia: "30632-2",
      fornecedorId: fornecedor,
    });
    expect(r.resultado).toBe("POSSIVEL_DUPLICIDADE");
    expect(r.candidatos).toEqual([expect.objectContaining({ motivo: "MESMO_SKU_EM_ABERTO", purchaseOrderId: interno.id })]);

    await asUser(ADMIN, "select public.link_purchase_order_external_reference($1, '30632-2')", [interno.id]);
    expect(await transito(sku["D760-INT"] ?? "")).toBe(1000);

    // Agora a referência existe: registrar de novo é recusado, nunca duplicado.
    const de_novo = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c013",
      itens: [{ skuId: sku["D760-INT"] ?? "", quantity: 1000 }],
      situacao: "PEDIDO_REALIZADO",
      referencia: "30632-2",
      fornecedorId: fornecedor,
      confirmar: true,
    });
    expect(de_novo.resultado).toBe("REFERENCIA_EXISTENTE");

    const po = await client.query("select origin, external_reference, status from public.purchase_orders where id = $1", [interno.id]);
    expect(po.rows[0]).toMatchObject({ origin: "INTERNO", external_reference: "30632-2", status: "ORDERED" });

    // O interno não aceita acréscimo por esta porta.
    await expect(
      asUser(ADMIN, "select public.add_purchase_order_items_placed($1, $2::jsonb, $3)", [
        interno.id,
        JSON.stringify([{ skuId: sku["D760-EXT"], quantity: 1 }]),
        "00000000-0000-4000-8000-00000000c014",
      ]),
    ).rejects.toThrow(/pedido interno/);
  });
});

describe("Cenário 9 — prazo de chegada", () => {
  it("previsão vencida aparece como atraso, e o pedido continua descontando uma vez só", async () => {
    const r = await registrar({
      requestId: "00000000-0000-4000-8000-00000000c015",
      itens: [{ skuId: sku["D760-ATRASO"] ?? "", quantity: 1200 }],
      situacao: "PEDIDO_REALIZADO",
      previsao: "2026-01-10T12:00:00-03:00",
    });

    expect(await linha("D760-ATRASO")).toMatchObject({ suggested_quantity: 0, compra_pendente: 1200, compra_atrasada: true });
    expect((await visao(ADMIN, "ATRASADO")).linhas.map((l) => l.sku_id)).toEqual([sku["D760-ATRASO"]]);

    // Nova previsão: deixa de estar atrasado, vira "chegada prevista".
    await asUser(ADMIN, "select public.set_purchase_order_expected_at($1, now() + interval '120 days', 'navio atrasou')", [r.pedido?.id]);
    const l = await linha("D760-ATRASO");
    expect(l.compra_atrasada).toBe(false);
    expect(l.compra_proxima_chegada).not.toBeNull();
    expect((await visao(ADMIN, "CHEGADA_PREVISTA")).linhas.map((x) => x.sku_id)).toContain(sku["D760-ATRASO"]);

    const ev = await client.query<{ metadata: unknown }>("select metadata from public.purchase_order_events where purchase_order_id = $1 and event_type = 'EXPECTED_CHANGED'", [
      r.pedido?.id,
    ]);
    expect(ev.rows[0]?.metadata).toMatchObject({ note: "navio atrasou" });
  });

  it("os filtros de compra fecham com as contagens", async () => {
    const v = await visao();
    const complementar = await visao(ADMIN, "COMPLEMENTAR");

    expect(v.contagens_compra).toMatchObject({ complementar: complementar.total });
    expect(complementar.linhas.map((l) => l.sku_id)).toContain(sku["D760-EXT"]);
    expect(complementar.linhas.map((l) => l.sku_id)).not.toContain(sku["D760-COBRE"]);
  });
});

describe("Cenário 7 — importação, código ambíguo e planilha repetida", () => {
  const SHA = "a".repeat(64);
  let lote = "";

  const linhas = [
    // Exata pelo código.
    { sheet: "PEÇAS", row: 5, column: "F", code: "d760-plan-b", description: "PASTILHA", quantityRaw: "120", quantity: 120, quantityNeedsConfirmation: false, reference: "40001" },
    // Só pelo EAN válido: provável, nunca automática.
    { sheet: "PEÇAS", row: 6, column: "F", code: "XYZ-999", ean: "96385074", description: "MANOPLA", quantityRaw: "80", quantity: 80, quantityNeedsConfirmation: false, reference: "40001" },
    // O mesmo código com duas descrições no arquivo: ambíguo (o KPP08).
    { sheet: "PEÇAS", row: 7, column: "F", code: "D760-EXT", description: "KIT POLIA 8MM", quantityRaw: "10", quantity: 10, quantityNeedsConfirmation: false, reference: "40001" },
    { sheet: "BAU", row: 3, column: "G", code: "D760-EXT", description: "KIT POLIA 10MM", quantityRaw: "10", quantity: 10, quantityNeedsConfirmation: false, reference: "40001" },
    // "200 + 200" e coluna sem cabeçalho: preservados, a confirmar.
    { sheet: "PEÇAS", row: 8, column: "H", code: "D760-PLAN-B", description: "PASTILHA", quantityRaw: "200 + 200", quantity: 400, quantityNeedsConfirmation: true, reference: null, notes: "NÃO VENDE" },
    { sheet: "PEÇAS", row: 9, column: "F", code: "NAO-EXISTE", description: "?", quantityRaw: "5", quantity: 5, quantityNeedsConfirmation: false, reference: "40001" },
  ];

  it("vincula só a exata e preserva o texto original", async () => {
    const r = await one<{ r: { batchId: string; existente: boolean } }>(
      ADMIN,
      "select public.create_purchase_import_batch($1, 'CONTROLE.xlsx', $2, array['PEÇAS','BAU'], $3::jsonb) as r",
      [ORG, SHA, JSON.stringify(linhas)],
    );
    lote = r.r.batchId;
    expect(r.r.existente).toBe(false);

    const rows = await client.query<{ row_number: number; sheet_name: string; match_status: string; sku_id: string | null; resolution: string; source_quantity_raw: string; quantity_confirmed: boolean; source_notes: string | null }>(
      "select row_number, sheet_name, match_status, sku_id, resolution, source_quantity_raw, quantity_confirmed, source_notes from public.purchase_import_rows where batch_id = $1 order by sheet_name, row_number",
      [lote],
    );
    const por = (aba: string, n: number) => rows.rows.find((x) => x.sheet_name === aba && x.row_number === n);

    expect(por("PEÇAS", 5)).toMatchObject({ match_status: "EXATA", sku_id: sku["D760-PLAN-B"], resolution: "VINCULADA" });
    expect(por("PEÇAS", 6)).toMatchObject({ match_status: "PROVAVEL", sku_id: null, resolution: "PENDENTE" });
    expect(por("PEÇAS", 7)).toMatchObject({ match_status: "AMBIGUA", sku_id: null });
    expect(por("BAU", 3)).toMatchObject({ match_status: "AMBIGUA", sku_id: null });
    expect(por("PEÇAS", 8)).toMatchObject({ source_quantity_raw: "200 + 200", quantity_confirmed: false, source_notes: "NÃO VENDE" });
    expect(por("PEÇAS", 9)).toMatchObject({ match_status: "NAO_ENCONTRADA" });
  });

  it("o mesmo arquivo de novo devolve o mesmo lote", async () => {
    const r = await one<{ r: { batchId: string; existente: boolean } }>(
      ADMIN,
      "select public.create_purchase_import_batch($1, 'CONTROLE (1).xlsx', $2, array['PEÇAS'], $3::jsonb) as r",
      [ORG, SHA, JSON.stringify(linhas)],
    );
    expect(r.r).toEqual({ batchId: lote, existente: true });
  });

  it("a pré-visualização conta o que falta e a ambígua não entra no pedido", async () => {
    const v = await one<{ v: { resumo: Record<string, number>; grupos: { referencia: string | null; vinculadas: number }[] } }>(
      ADMIN,
      "select public.get_purchase_import_batch($1) as v",
      [lote],
    );
    // A linha "200 + 200" tem o mesmo código da 5: também é exata, mas a quantidade espera confirmação.
    expect(v.v.resumo).toMatchObject({ exatas: 2, provaveis: 1, ambiguas: 2, nao_encontradas: 1, quantidade_a_confirmar: 1, sem_referencia: 1 });

    // Sem vínculo explícito, a linha ambígua não pode ser "vinculada".
    await expect(
      asUser(ADMIN, "select public.resolve_purchase_import_rows($1, $2::jsonb)", [
        lote,
        JSON.stringify([{ rowId: (await client.query<{ id: string }>("select id from public.purchase_import_rows where batch_id = $1 and sheet_name = 'BAU'", [lote])).rows[0]?.id, resolution: "VINCULADA" }]),
      ]),
    ).rejects.toThrow(/escolha o SKU/);

    // Confirma a provável pelo clique; a "200 + 200" ganha referência e quantidade confirmada.
    const ids = await client.query<{ id: string; row_number: number; sheet_name: string }>(
      "select id, row_number, sheet_name from public.purchase_import_rows where batch_id = $1",
      [lote],
    );
    const id = (aba: string, n: number) => ids.rows.find((x) => x.sheet_name === aba && x.row_number === n)?.id;
    await asUser(ADMIN, "select public.resolve_purchase_import_rows($1, $2::jsonb)", [
      lote,
      JSON.stringify([
        { rowId: id("PEÇAS", 6), skuId: sku["D760-PLAN-A"] },
        { rowId: id("PEÇAS", 8), resolution: "IGNORADA" },
        { rowId: id("PEÇAS", 9), resolution: "IGNORADA" },
      ]),
    ]);

    const hist = await client.query<{ n: number }>("select count(*)::int as n from public.purchase_import_row_events where row_id = $1", [id("PEÇAS", 6)]);
    expect(hist.rows[0]?.n).toBe(1);
  });

  it("gravar a referência duas vezes cria um pedido e um trânsito; nunca ORDERED sem a escolha", async () => {
    const commit = async (): Promise<Registro> =>
      (
        await one<{ r: Registro }>(ADMIN, "select public.commit_purchase_import_group($1, '40001', 'PEDIDO_REALIZADO', p_confirm_new => true) as r", [lote])
      ).r;

    const a = await commit();
    const b = await commit();

    expect(a).toMatchObject({ resultado: "CRIADO", pedido: { status: "ORDERED" } });
    expect(b.resultado).toBe("NADA_A_REGISTRAR");
    expect(await transito(sku["D760-PLAN-B"] ?? "")).toBe(120);
    expect(await transito(sku["D760-PLAN-A"] ?? "")).toBe(80);

    const ambiguas = await client.query<{ n: number }>(
      "select count(*)::int as n from public.purchase_import_rows where batch_id = $1 and match_status = 'AMBIGUA' and purchase_order_id is null",
      [lote],
    );
    expect(ambiguas.rows[0]?.n).toBe(2);

    await expect(
      asUser(ADMIN, "select public.commit_purchase_import_group($1, '40001', 'ORDERED')", [lote]),
    ).resolves.toBeDefined(); // nada pendente: não chega a validar a situação
    await expect(
      asUser(ADMIN, "select public.register_placed_purchase_order($1, gen_random_uuid(), $2::jsonb, 'ORDERED')", [
        ORG,
        JSON.stringify([{ skuId: sku["D760-EXT"], quantity: 1 }]),
      ]),
    ).rejects.toThrow(/PLANEJADO ou PEDIDO_REALIZADO/);
  });
});

describe("Cenário 11 — invoice do fornecedor (D-767)", () => {
  const SHA = "b".repeat(64);
  const DOC = { tipo: "COMERCIAL", numero: "INV-9100-2", data: "Sep 28,2026", dataIso: "2026-09-28", bl: "BLTESTE", container: "CONT123", lixo: "x" };
  let lote = "";
  let existente = "";
  const inv: Record<string, string> = {};

  beforeAll(async () => {
    const r = await client.query<{ id: string; sku: string }>(
      `insert into public.skus (organization_id, sku, kind, purchase_cost, created_at)
       select $1, n, 'PRODUTO', 10, now() from unnest($2::text[]) n
       on conflict on constraint skus_org_key_unique do update set sku = excluded.sku
       returning id, sku`,
      [ORG, ["D766-A", "D766-B"]],
    );

    for (const row of r.rows) inv[row.sku] = row.id;

    // O pedido JS9100 já existe, em dólar, com 100 un do A.
    const p = await one<{ r: Registro }>(
      ADMIN,
      `select public.register_placed_purchase_order(
         p_organization_id => $1, p_request_id => gen_random_uuid(), p_items => $2::jsonb, p_situacao => 'PEDIDO_REALIZADO',
         p_external_reference => 'JS9100', p_currency => 'USD', p_confirm_new => true) as r`,
      [ORG, JSON.stringify([{ skuId: inv["D766-A"], quantity: 100 }])],
    );

    existente = p.r.pedido?.id ?? "";
  });

  const linha = (row: number, code: string, qty: number, ref: string, price: number | null, extra: Record<string, unknown> = {}) => ({
    sheet: "INV", row, column: "G", code, ncm: "87141000", description: `ITEM ${code}`, quantityRaw: String(qty), quantity: qty,
    quantityNeedsConfirmation: false, reference: ref, unitPrice: price, amount: price === null ? null : Math.round(qty * price * 100) / 100,
    currency: "USD", unit: "PCS", document: DOC, ...extra,
  });

  it("guarda preço, valor, moeda, unidade e o documento — só as chaves conhecidas", async () => {
    const linhas = [
      // Referência em minúsculas e com espaço: a mesma do pedido JS9100.
      linha(19, "D766-A", 80, "js 9100", 1.06),
      // O mesmo item partido em duas linhas (80 + 20), mesmo preço.
      linha(20, "D766-B", 80, "js 9100", 0.91),
      linha(21, "D766-B", 20, "js 9100", 0.91),
      // Outro pedido: o mesmo SKU com dois preços — o custo não é escolhido.
      linha(22, "D766-B", 50, "JS9200", 1.3),
      linha(23, "D766-B", 10, "JS9200", 1.5, { currency: "usd", unitPrice: "abc", unit: " " }),
    ];
    const r = await one<{ r: { batchId: string } }>(
      ADMIN,
      "select public.create_purchase_import_batch($1, 'INV-9100-2.xlsx', $2, array['INV'], $3::jsonb) as r",
      [ORG, SHA, JSON.stringify(linhas)],
    );

    lote = r.r.batchId;

    const rows = await client.query<{ row_number: number; source_unit_price: string | null; source_amount: string | null; source_currency: string | null; source_unit: string | null; source_document: Record<string, string> | null }>(
      "select row_number, source_unit_price::text, source_amount::text, source_currency, source_unit, source_document from public.purchase_import_rows where batch_id = $1 order by row_number",
      [lote],
    );

    expect(rows.rows[0]).toMatchObject({ source_unit_price: "1.0600", source_amount: "84.80", source_currency: "USD", source_unit: "PCS" });
    expect(rows.rows[0]?.source_document).toEqual({
      tipo: "COMERCIAL", numero: "INV-9100-2", data: "Sep 28,2026", dataIso: "2026-09-28", bl: "BLTESTE", container: "CONT123",
    });
    // Preço que não é número não vira preço; moeda em minúsculas é normalizada; unidade vazia some.
    expect(rows.rows[4]).toMatchObject({ source_unit_price: null, source_currency: "USD", source_unit: null });
  });

  it("a pré-visualização acha o pedido existente pela referência e mostra o que já está nele", async () => {
    const v = await one<{ v: { resumo: Record<string, number>; grupos: Record<string, unknown>[]; linhas: Record<string, unknown>[] } }>(
      ADMIN,
      "select public.get_purchase_import_batch($1) as v",
      [lote],
    );
    const g = v.v.grupos.find((x) => x.referenciaKey === "JS9100");

    expect(g).toMatchObject({ pedidoExistente: { id: existente, currency: "USD" }, jaNoPedido: 1, moeda: "USD", skuRepetido: 2 });
    expect(Number(g?.valor)).toBeCloseTo(84.8 + 72.8 + 18.2, 2);
    expect((g?.documento as Record<string, string>).numero).toBe("INV-9100-2");
    expect(v.v.resumo.ja_no_pedido).toBe(1);
    expect(v.v.linhas.find((l) => l.row === 19)).toMatchObject({ jaNoPedido: 100, unitPrice: 1.06, currency: "USD", unit: "PCS" });
    expect(v.v.linhas.find((l) => l.row === 20)?.jaNoPedido).toBeNull();
  });

  it("acrescentar ao pedido: SKU que já está nele é recusado; o resto entra somado, com custo em dólar", async () => {
    const commit = (ref: string, alvo: string | null) =>
      asUser<{ r: Registro }>(
        ADMIN,
        "select public.commit_purchase_import_group($1, $2, 'PEDIDO_REALIZADO', p_confirm_new => true, p_target_order_id => $3) as r",
        [lote, ref, alvo],
      );

    await expect(commit("js 9100", existente)).rejects.toThrow(/ja esta neste pedido/);

    const a = await client.query<{ id: string }>("select id from public.purchase_import_rows where batch_id = $1 and row_number = 19", [lote]);

    await asUser(ADMIN, "select public.resolve_purchase_import_rows($1, $2::jsonb)", [lote, JSON.stringify([{ rowId: a.rows[0]?.id, resolution: "IGNORADA" }])]);

    const transitoAntes = await transito(inv["D766-B"] ?? "");
    const r = (await commit("js 9100", existente))[0]?.r;

    expect(r?.resultado).toBe("ACRESCENTADO");

    const itens = await client.query<{ sku_id: string; quantity_ordered: string; unit_cost: string | null }>(
      "select sku_id, quantity_ordered::text, unit_cost::text from public.purchase_order_items where purchase_order_id = $1 order by position",
      [existente],
    );

    expect(itens.rows).toEqual([
      { sku_id: inv["D766-A"], quantity_ordered: "100.000", unit_cost: null },
      { sku_id: inv["D766-B"], quantity_ordered: "100.000", unit_cost: "0.9100" },
    ]);
    // 80 + 20 entram uma vez, num item só.
    expect((await transito(inv["D766-B"] ?? "")) - transitoAntes).toBe(100);

    const registradas = await client.query<{ n: number }>(
      "select count(*)::int as n from public.purchase_import_rows where batch_id = $1 and resolution = 'REGISTRADA' and purchase_order_item_id is not null",
      [lote],
    );

    expect(registradas.rows[0]?.n).toBe(2);
  });

  it("pedido novo: moeda do documento; SKU com dois preços fica sem custo", async () => {
    const r = await one<{ r: Registro }>(
      ADMIN,
      "select public.commit_purchase_import_group($1, 'JS9200', 'PEDIDO_REALIZADO', p_confirm_new => true) as r",
      [lote],
    );

    expect(r.r.resultado).toBe("CRIADO");

    const po = await client.query<{ currency: string; quantity_ordered: string; unit_cost: string | null }>(
      `select o.currency, i.quantity_ordered::text, i.unit_cost::text
       from public.purchase_orders o join public.purchase_order_items i on i.purchase_order_id = o.id
       where o.id = $1`,
      [r.r.pedido?.id],
    );

    expect(po.rows).toEqual([{ currency: "USD", quantity_ordered: "60.000", unit_cost: null }]);
  });
});

describe("Cenário 12 — SKU que não existe, criado da invoice (D-792)", () => {
  const SHA = "c".repeat(64);
  let lote = "";

  const linha = (row: number, code: string, description: string, ncm: string | null) => ({
    sheet: "INV", row, column: "G", code, ncm, description, quantityRaw: "10", quantity: 10,
    quantityNeedsConfirmation: false, reference: "JS9300", unitPrice: 1, amount: 10, currency: "USD", unit: "PCS",
  });

  // O beforeAll geral grava venda para todo SKU da organização: o SKU criado aqui sai junto.
  const apagarSkus = async (): Promise<void> => {
    await client.query("delete from public.purchase_import_batches where organization_id = $1 and file_sha256 = $2", [ORG, SHA]);
    await client.query(
      "delete from public.daily_sku_metrics where sku_id in (select id from public.skus where organization_id = $1 and sku_key like 'D768-%')",
      [ORG],
    );
    await client.query("delete from public.skus where organization_id = $1 and sku_key like 'D768-%'", [ORG]);
  };

  afterAll(apagarSkus);

  beforeAll(async () => {
    await apagarSkus();
    await client.query("insert into public.skus (organization_id, sku, kind, created_at) values ($1, 'D768-KC0030', 'PRODUTO', now())", [ORG]);

    const r = await one<{ r: { batchId: string } }>(
      ADMIN,
      "select public.create_purchase_import_batch($1, 'INV-9300.xlsx', $2, array['INV'], $3::jsonb) as r",
      [
        ORG,
        SHA,
        JSON.stringify([
          // O mesmo código em duas linhas: um SKU só.
          linha(10, "D768-NOVO", "BAU TRASEIRO 45L PRETO", "87141000"),
          linha(11, "d768-novo ", "BAU TRASEIRO 45L PRETO", "87141000"),
          // Parecido com D768-KC0030 (zero à esquerda): não nasce duplicado.
          linha(12, "D768-KC30", "KIT CAPA", "8714"),
        ]),
      ],
    );

    lote = r.r.batchId;
  });

  const linhasDoLote = () =>
    client.query<{ row_number: number; sku_id: string | null; resolution: string }>(
      "select row_number, sku_id, resolution from public.purchase_import_rows where batch_id = $1 order by row_number",
      [lote],
    );

  it("o analista não cria SKU", async () => {
    await expect(asUser(ANALISTA, "select public.create_skus_from_import_rows($1)", [lote])).rejects.toThrow(/sem permissao/);
  });

  it("cria com o código, o nome e o NCM da linha, vincula as duas linhas e recusa o parecido", async () => {
    const kc = (await linhasDoLote()).rows.find((l) => l.row_number === 12);
    const r = await one<{ r: { criados: number; vinculados: number; semCodigo: number; parecidos: { code: string; parecido: string }[] } }>(
      ADMIN,
      "select public.create_skus_from_import_rows($1, $2::uuid[]) as r",
      // Todas as linhas pela lista: a do parecido pode ter vindo como provável.
      [lote, (await client.query<{ id: string }>("select id from public.purchase_import_rows where batch_id = $1", [lote])).rows.map((x) => x.id)],
    );

    expect(r.r).toMatchObject({ criados: 1, vinculados: 2, semCodigo: 0 });
    expect(r.r.parecidos).toEqual([expect.objectContaining({ code: "D768-KC30", parecido: "D768-KC0030" })]);

    const novo = await client.query<{ id: string; sku: string; title: string | null; ncm: string | null; kind: string }>(
      "select id, sku, title, ncm, kind from public.skus where organization_id = $1 and sku_key = 'D768-NOVO'",
      [ORG],
    );

    expect(novo.rows.map((n) => ({ sku: n.sku, title: n.title, ncm: n.ncm, kind: n.kind }))).toEqual([{ sku: "D768-NOVO", title: "BAU TRASEIRO 45L PRETO", ncm: "87141000", kind: "PRODUTO" }]);

    const linhas = (await linhasDoLote()).rows;

    expect(linhas.filter((l) => l.sku_id === novo.rows[0]?.id).map((l) => l.resolution)).toEqual(["VINCULADA", "VINCULADA"]);
    expect(linhas.find((l) => l.row_number === 12)).toMatchObject({ sku_id: kc?.sku_id ?? null });

    const kcs = await client.query<{ n: number }>("select count(*)::int as n from public.skus where organization_id = $1 and sku_key like 'D768-KC%'", [ORG]);

    expect(kcs.rows[0]?.n).toBe(1);

    const eventos = await client.query<{ n: number }>(
      "select count(*)::int as n from public.purchase_import_row_events e join public.purchase_import_rows r on r.id = e.row_id where r.batch_id = $1 and e.event_type = 'RESOLVED'",
      [lote],
    );

    expect(eventos.rows[0]?.n).toBe(2);
  });

  it("de novo, nada muda: a linha vinculada não cria outro SKU", async () => {
    const r = await one<{ r: { criados: number; vinculados: number } }>(ADMIN, "select public.create_skus_from_import_rows($1) as r", [lote]);

    expect(r.r).toMatchObject({ criados: 0, vinculados: 0 });

    const n = await client.query<{ n: number }>("select count(*)::int as n from public.skus where organization_id = $1 and sku_key like 'D768-%'", [ORG]);

    expect(n.rows[0]?.n).toBe(2);
  });
});

describe("Cenário 10 — segurança", () => {
  it("outra organização não registra, não lê pedidos e não importa em nome de terceiros", async () => {
    await expect(
      registrar({
        requestId: "00000000-0000-4000-8000-00000000c020",
        itens: [{ skuId: sku["D760-EXT"] ?? "", quantity: 1 }],
        situacao: "PEDIDO_REALIZADO",
        usuario: INTRUSO,
      }),
    ).rejects.toThrow(/sem permissao/);

    // Na própria organização, o SKU da outra não existe.
    await expect(
      registrar({
        requestId: "00000000-0000-4000-8000-00000000c021",
        itens: [{ skuId: sku["D760-EXT"] ?? "", quantity: 1 }],
        situacao: "PEDIDO_REALIZADO",
        usuario: INTRUSO,
        org: OUTRA_ORG,
      }),
    ).rejects.toThrow(/SKU nao encontrado/);

    const abertos = await one<{ r: unknown }>(INTRUSO, "select public.get_open_purchases_for_skus($1, $2::uuid[]) as r", [ORG, [sku["D760-EXT"]]]);
    expect(abertos.r).toBeNull();

    const pedidos = await asUser(INTRUSO, "select id from public.purchase_orders where organization_id = $1", [ORG]);
    expect(pedidos).toHaveLength(0);

    const lotes = await asUser(INTRUSO, "select id from public.purchase_import_batches where organization_id = $1", [ORG]);
    expect(lotes).toHaveLength(0);

    await expect(
      asUser(INTRUSO, "select public.create_purchase_import_batch($1, 'x.xlsx', $2, '{}', $3::jsonb)", [
        ORG,
        "b".repeat(64),
        JSON.stringify([{ sheet: "A", row: 1, column: "A", quantityRaw: "1", quantity: 1 }]),
      ]),
    ).rejects.toThrow(/sem permissao/);

    const qualquerPedido = await client.query<{ id: string }>("select id from public.purchase_orders where organization_id = $1 limit 1", [ORG]);
    await expect(
      asUser(INTRUSO, "select public.set_purchase_order_expected_at($1, now())", [qualquerPedido.rows[0]?.id]),
    ).rejects.toThrow(/sem permissao/);
    await expect(
      asUser(INTRUSO, "select public.link_purchase_order_external_reference($1, 'X')", [qualquerPedido.rows[0]?.id]),
    ).rejects.toThrow(/sem permissao/);
  });

  it("perfil sem acesso a compras vê o pedido como DESCONHECIDO, nunca como 'sem pedido'", async () => {
    const l = await linha("D760-EXT", ANALISTA);

    expect(l.suggested_quantity).toBe(200);
    expect(l).toMatchObject({ compra_pendente: null, compra_planejada: null, compra_atrasada: null });
    expect((await visao(ANALISTA)).contagens_compra).toBeNull();
    await expect(visao(ANALISTA, "ENCOMENDADO")).rejects.toThrow(/sem permissao/);
  });

  it("a escrita direta nas tabelas da importação é recusada", async () => {
    await expect(
      asUser(ADMIN, "update public.purchase_import_rows set resolution = 'VINCULADA' where organization_id = $1", [ORG]),
    ).rejects.toThrow(/permission denied/);
  });
});
