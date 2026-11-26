import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Integridade da Central Financeira (`20261126235000`) contra Postgres real.
 *
 * 1. Nenhuma referência atravessa organizações: CNPJ, conta do ML, loja da
 *    Shopee e despesa de outra organização são recusados pela chave composta,
 *    mesmo para quem é ADMIN da organização da linha.
 * 2. A trilha de auditoria sobrevive à exclusão da despesa, com o evento
 *    'deleted'.
 * 3. O mês fechado trava a despesa (criar, alterar, apagar), e reabrir destrava.
 *    O fechamento não é apagável pela sessão.
 *
 * Organizações próprias, apagadas no fim. Exige o Supabase local no ar.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG_A = "88888888-0000-4000-8000-00000000c501";
const ORG_B = "88888888-0000-4000-8000-00000000c502";
const ADMIN_A = "bbbbbbbb-0000-4000-8000-00000000c501";
const ADMIN_B = "bbbbbbbb-0000-4000-8000-00000000c502";
const CONTA_A = "cccccccc-0000-4000-8000-00000000c501";
const CONTA_B = "cccccccc-0000-4000-8000-00000000c502";
const LOJA_B = "dddddddd-0000-4000-8000-00000000c502";
const LOJA_A = "dddddddd-0000-4000-8000-00000000c501";
const LOJA_A_NAO_LIDA = "dddddddd-0000-4000-8000-00000000c503";

let client: Client;
let entidadeA = "";
let entidadeB = "";
let despesaB = "";

async function asUser<T>(userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  await client.query("begin");
  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId })]);
    const res = await client.query(sql, params);
    await client.query("commit");
    return res.rows as T[];
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

async function limpar(): Promise<void> {
  await client.query("delete from public.monthly_financial_closings where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.operational_expenses where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.operational_expense_history where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.fiscal_entities where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.daily_account_metrics where ml_account_id in ($1, $2)", [CONTA_A, CONTA_B]);
  await client.query("delete from public.shopee_shops where id in ($1, $2, $3)", [LOJA_B, LOJA_A, LOJA_A_NAO_LIDA]);
  await client.query("delete from public.ml_accounts where id in ($1, $2)", [CONTA_A, CONTA_B]);
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  await client.query(
    `insert into public.organizations (id, name, slug) values ($1, 'Org Integ A', 'org-integ-a'), ($2, 'Org Integ B', 'org-integ-b') on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );

  for (const [id, email] of [
    [ADMIN_A, "admin-integ-a@example.com"],
    [ADMIN_B, "admin-integ-b@example.com"],
  ] as const) {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change, email_change_token_new, email_change_token_current, phone_change, phone_change_token, reauthentication_token)
       values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, 'x', now(), '{}', now(), now(), '', '', '', '', '', '', '', '')
       on conflict (id) do nothing`,
      [id, email],
    );
  }

  await client.query(
    `insert into public.organization_members (organization_id, user_id, role)
     values ($1, $2, 'ADMIN'), ($3, $4, 'ADMIN')
     on conflict (organization_id, user_id) do nothing`,
    [ORG_A, ADMIN_A, ORG_B, ADMIN_B],
  );

  await limpar();

  await client.query(
    `insert into public.ml_accounts (id, organization_id, slug, label, seller_id, status, connected_at)
     values ($1, $2, 'conta-integ-a', 'Conta Integ A', 985001, 'CONNECTED', now()),
            ($3, $4, 'conta-integ-b', 'Conta Integ B', 985002, 'CONNECTED', now())`,
    [CONTA_A, ORG_A, CONTA_B, ORG_B],
  );
  await client.query(
    `insert into public.shopee_shops (id, organization_id, environment, shop_id, shop_name, status, connected_at)
     values ($1, $2, 'live', 985002, 'Loja Integ B', 'CONNECTED', now())`,
    [LOJA_B, ORG_B],
  );

  const a = await client.query<{ id: string }>(
    `insert into public.fiscal_entities (organization_id, legal_name, cnpj, tax_regime)
     values ($1, 'Integ A LTDA', '11222333000181', 'simples_nacional') returning id`,
    [ORG_A],
  );
  const b = await client.query<{ id: string }>(
    `insert into public.fiscal_entities (organization_id, legal_name, cnpj, tax_regime)
     values ($1, 'Integ B LTDA', '44555666000102', 'lucro_presumido') returning id`,
    [ORG_B],
  );
  entidadeA = a.rows[0]?.id ?? "";
  entidadeB = b.rows[0]?.id ?? "";

  const d = await client.query<{ id: string }>(
    `insert into public.operational_expenses (organization_id, name, category, cost_type, planned_amount, competence_date)
     values ($1, 'Aluguel B', 'aluguel', 'fixo', 100, '2026-09-10') returning id`,
    [ORG_B],
  );
  despesaB = d.rows[0]?.id ?? "";
});

afterAll(async () => {
  await limpar();
  await client.end();
});

describe("Central Financeira — integridade (20261126235000)", () => {
  it("o ADMIN de A não vincula CNPJ, conta do ML nem loja Shopee de B", async () => {
    await expect(
      asUser(
        ADMIN_A,
        `insert into public.fiscal_entity_accounts (organization_id, fiscal_entity_id, marketplace, ml_account_id)
         values ($1, $2, 'MERCADO_LIVRE', $3)`,
        [ORG_A, entidadeB, CONTA_A],
      ),
    ).rejects.toThrow(/foreign key/i);

    await expect(
      asUser(
        ADMIN_A,
        `insert into public.fiscal_entity_accounts (organization_id, fiscal_entity_id, marketplace, ml_account_id)
         values ($1, $2, 'MERCADO_LIVRE', $3)`,
        [ORG_A, entidadeA, CONTA_B],
      ),
    ).rejects.toThrow(/foreign key/i);

    await expect(
      asUser(
        ADMIN_A,
        `insert into public.fiscal_entity_accounts (organization_id, fiscal_entity_id, marketplace, shopee_shop_id)
         values ($1, $2, 'SHOPEE', $3)`,
        [ORG_A, entidadeA, LOJA_B],
      ),
    ).rejects.toThrow(/foreign key/i);

    await expect(
      asUser(
        ADMIN_A,
        `insert into public.fiscal_entity_tax_configs (organization_id, fiscal_entity_id, tax_regime, valid_from, nominal_rate, effective_sales_rate)
         values ($1, $2, 'lucro_presumido', '2026-01-01', 0.1, 0.1)`,
        [ORG_A, entidadeB],
      ),
    ).rejects.toThrow(/foreign key/i);

    // Controle: dentro da própria organização, o vínculo passa.
    await asUser(
      ADMIN_A,
      `insert into public.fiscal_entity_accounts (organization_id, fiscal_entity_id, marketplace, ml_account_id)
       values ($1, $2, 'MERCADO_LIVRE', $3)`,
      [ORG_A, entidadeA, CONTA_A],
    );
  });

  it("despesa e rateio não apontam para outra organização", async () => {
    for (const [coluna, valor] of [
      ["fiscal_entity_id", entidadeB],
      ["ml_account_id", CONTA_B],
      ["shopee_shop_id", LOJA_B],
    ] as const) {
      await expect(
        asUser(
          ADMIN_A,
          `insert into public.operational_expenses (organization_id, name, category, cost_type, planned_amount, competence_date, ${coluna})
           values ($1, 'Cruzada', 'outras', 'fixo', 10, '2026-09-10', $2)`,
          [ORG_A, valor],
        ),
      ).rejects.toThrow(/foreign key/i);
    }

    await expect(
      asUser(
        ADMIN_A,
        `insert into public.operational_expense_allocations (organization_id, expense_id, target_type, target_id, target_label, allocation_percentage, allocated_amount)
         values ($1, $2, 'marketplace', 'MERCADO_LIVRE', 'ML', 1, 100)`,
        [ORG_A, despesaB],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("apagar o CNPJ solta a despesa sem apagá-la nem mudar a organização", async () => {
    const ent = await asUser<{ id: string }>(
      ADMIN_A,
      `insert into public.fiscal_entities (organization_id, legal_name, cnpj, tax_regime)
       values ($1, 'Integ A Filial', '77888999000110', 'simples_nacional') returning id`,
      [ORG_A],
    );
    const entId = ent[0]?.id ?? "";
    const desp = await asUser<{ id: string }>(
      ADMIN_A,
      `insert into public.operational_expenses (organization_id, name, category, cost_type, planned_amount, competence_date, fiscal_entity_id)
       values ($1, 'Contador', 'contabilidade', 'fixo', 50, '2026-09-11', $2) returning id`,
      [ORG_A, entId],
    );

    await asUser(ADMIN_A, `delete from public.fiscal_entities where id = $1`, [entId]);

    const depois = await asUser<{ organization_id: string; fiscal_entity_id: string | null }>(
      ADMIN_A,
      `select organization_id, fiscal_entity_id from public.operational_expenses where id = $1`,
      [desp[0]?.id],
    );
    expect(depois).toEqual([{ organization_id: ORG_A, fiscal_entity_id: null }]);
  });

  it("a trilha fica depois que a despesa é apagada, com o evento 'deleted'", async () => {
    const desp = await asUser<{ id: string }>(
      ADMIN_A,
      `insert into public.operational_expenses (organization_id, name, category, cost_type, planned_amount, competence_date)
       values ($1, 'Internet', 'internet', 'fixo', 120, '2026-09-12') returning id`,
      [ORG_A],
    );
    const id = desp[0]?.id ?? "";

    await asUser(ADMIN_A, `update public.operational_expenses set actual_amount = 118 where id = $1`, [id]);
    await asUser(ADMIN_A, `delete from public.operational_expenses where id = $1`, [id]);

    const trilha = await asUser<{ action: string; nome: string | null }>(
      ADMIN_A,
      `select action, coalesce(after_data, before_data)->>'name' as nome
       from public.operational_expense_history where expense_id = $1 order by changed_at, id`,
      [id],
    );
    expect(trilha.map((t) => t.action)).toEqual(["created", "updated", "deleted"]);
    expect(trilha.every((t) => t.nome === "Internet")).toBe(true);
  });

  it("o mês fechado trava a despesa; reaberto, destrava; o fechamento não é apagado pela sessão", async () => {
    const desp = await asUser<{ id: string }>(
      ADMIN_A,
      `insert into public.operational_expenses (organization_id, name, category, cost_type, planned_amount, competence_date)
       values ($1, 'Energia', 'energia_eletrica', 'fixo', 300, '2026-08-05') returning id`,
      [ORG_A],
    );
    const id = desp[0]?.id ?? "";

    await asUser(
      ADMIN_A,
      `insert into public.monthly_financial_closings (organization_id, month, status, dre_snapshot)
       values ($1, '2026-08-01', 'fechado', '{}'::jsonb)`,
      [ORG_A],
    );

    await expect(
      asUser(ADMIN_A, `update public.operational_expenses set actual_amount = 290 where id = $1`, [id]),
    ).rejects.toThrow(/fechada/);
    await expect(asUser(ADMIN_A, `delete from public.operational_expenses where id = $1`, [id])).rejects.toThrow(
      /fechada/,
    );
    await expect(
      asUser(
        ADMIN_A,
        `insert into public.operational_expenses (organization_id, name, category, cost_type, planned_amount, competence_date)
         values ($1, 'Retroativa', 'outras', 'variavel', 10, '2026-08-20')`,
        [ORG_A],
      ),
    ).rejects.toThrow(/fechada/);
    // Mover a despesa para fora do mês fechado também é alteração do mês fechado.
    await expect(
      asUser(ADMIN_A, `update public.operational_expenses set competence_date = '2026-09-05' where id = $1`, [id]),
    ).rejects.toThrow(/fechada/);

    // A sessão não apaga o fechamento (a linha continua lá).
    await asUser(ADMIN_A, `delete from public.monthly_financial_closings where organization_id = $1`, [ORG_A]).catch(
      () => undefined,
    );
    const fechamentos = await client.query(
      `select status from public.monthly_financial_closings where organization_id = $1`,
      [ORG_A],
    );
    expect(fechamentos.rows).toEqual([{ status: "fechado" }]);

    // Reaberto, a despesa volta a ser editável; outro mês nunca travou.
    await asUser(
      ADMIN_A,
      `update public.monthly_financial_closings set status = 'reaberto' where organization_id = $1 and month = '2026-08-01'`,
      [ORG_A],
    );
    const editada = await asUser<{ actual_amount: string }>(
      ADMIN_A,
      `update public.operational_expenses set actual_amount = 290 where id = $1 returning actual_amount`,
      [id],
    );
    expect(editada).toEqual([{ actual_amount: "290.00" }]);
  });
});

describe("Central Financeira — rateio por faturamento multicanal (20261126235500)", () => {
  it("pesa a conta do ML e a loja da Shopee pela receita bruta conhecida, sob a RLS", async () => {
    await client.query(
      `insert into public.daily_account_metrics (organization_id, ml_account_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1, $2, '2026-11-10', 3, 700.00, 3, 3), ($1, $2, '2026-11-11', 1, 300.00, 1, 1),
              ($1, $2, '2026-12-01', 9, 999.00, 9, 9)`,
      [ORG_A, CONTA_A],
    );
    await client.query(
      `insert into public.shopee_shops (id, organization_id, environment, shop_id, shop_name, status, connected_at, orders_last_success_at)
       values ($1, $3, 'live', 985001, 'Loja Integ A', 'CONNECTED', now(), now()),
              ($2, $3, 'live', 985003, 'Loja Integ A nunca lida', 'CONNECTED', now(), null)`,
      [LOJA_A, LOJA_A_NAO_LIDA, ORG_A],
    );

    // Pedidos da loja lida (criados às 12h de São Paulo):
    //   P1 válido, receita do financeiro (250);
    //   P2 válido, receita pelos itens (2 × 75 = 150);
    //   P3 cancelado; P4 sem pagamento; P5 válido de receita desconhecida (item de preço 0);
    //   P6 válido, mas fora do intervalo. Só P1 e P2 contam: 400.
    const pedido = async (loja: string, sn: string, status: string, pago: boolean, dia: string, renda: string | null): Promise<void> => {
      await client.query(
        `insert into public.shopee_orders (shopee_shop_id, organization_id, order_sn, order_status, shopee_created_at, shopee_updated_at, paid_at, order_income)
         values ($1, $2, $3, $4, ($5::date + time '12:00') at time zone 'America/Sao_Paulo', now(),
                 case when $6 then ($5::date + time '12:00') at time zone 'America/Sao_Paulo' end, $7::jsonb)`,
        [loja, ORG_A, sn, status, dia, pago, renda],
      );
    };
    const item = async (loja: string, sn: string, preco: number, qtd: number): Promise<void> => {
      await client.query(
        `insert into public.shopee_order_items (shopee_shop_id, order_sn, position, organization_id, item_id, item_sku, quantity, discounted_price)
         values ($1, $2, 0, $3, 77, 'SKU-77', $4, $5)`,
        [loja, sn, ORG_A, qtd, preco],
      );
    };
    await pedido(LOJA_A, "C426P1", "COMPLETED", true, "2026-11-05", '{"order_discounted_price": 250}');
    await item(LOJA_A, "C426P1", 250, 1);
    await pedido(LOJA_A, "C426P2", "SHIPPED", true, "2026-11-30", null);
    await item(LOJA_A, "C426P2", 75, 2);
    await pedido(LOJA_A, "C426P3", "CANCELLED", true, "2026-11-06", '{"order_discounted_price": 900}');
    await pedido(LOJA_A, "C426P4", "UNPAID", false, "2026-11-07", '{"order_discounted_price": 900}');
    await pedido(LOJA_A, "C426P5", "COMPLETED", true, "2026-11-08", null);
    await item(LOJA_A, "C426P5", 0, 1);
    await pedido(LOJA_A, "C426P6", "COMPLETED", true, "2026-12-01", '{"order_discounted_price": 900}');
    // A loja nunca lida não entra, mesmo com pedido válido.
    await pedido(LOJA_A_NAO_LIDA, "C426N1", "COMPLETED", true, "2026-11-05", '{"order_discounted_price": 500}');

    const sql = `select marketplace, conta_id, receita_bruta
                 from public.get_faturamento_por_conta_multicanal($1, '2026-11-01', '2026-11-30')
                 order by marketplace`;
    const linhasA = await asUser<{ marketplace: string; conta_id: string; receita_bruta: string }>(ADMIN_A, sql, [ORG_A]);
    expect(linhasA).toEqual([
      { marketplace: "MERCADO_LIVRE", conta_id: CONTA_A, receita_bruta: "1000.00" },
      { marketplace: "SHOPEE", conta_id: LOJA_A, receita_bruta: "400.00" },
    ]);

    // O ADMIN de outra organização lê vazio.
    expect(await asUser(ADMIN_B, sql, [ORG_A])).toHaveLength(0);
    // anon não executa.
    await expect(
      (async () => {
        await client.query("begin");
        try {
          await client.query("set local role anon");
          await client.query("select * from public.get_faturamento_por_conta_multicanal($1, '2026-11-01', '2026-11-30')", [ORG_A]);
        } finally {
          await client.query("rollback");
        }
      })(),
    ).rejects.toThrow(/permission denied/i);
  });
});
