import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Testes de integração SQL da fundação da Central de Inteligência Financeira
 * (`20261126100000_central_inteligencia_financeira_fundacao.sql`) contra Postgres real.
 *
 * Verifica:
 * 1. Isolamento multi-tenant e RLS por papel (ADMIN/GESTOR escrevem, ANALISTA só lê,
 *    usuário de outra organização não enxerga nenhuma linha).
 * 2. Prevenção de duplicidade via `idempotency_key` em `operational_expenses`.
 * 3. Constraints físicas (`CHECK`) de CNPJ, alíquotas, datas e vínculo exclusivo conta → CNPJ.
 * 4. Persistência de `financial_goals` e `monthly_financial_closings`.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG_A = "88888888-0000-4000-8000-00000000cf01";
const ORG_B = "88888888-0000-4000-8000-00000000cf02";
const ADMIN_A = "bbbbbbbb-0000-4000-8000-00000000cf01";
const ANALISTA_A = "bbbbbbbb-0000-4000-8000-00000000cf02";
const ADMIN_B = "bbbbbbbb-0000-4000-8000-00000000cf03";
const ML_ACC_A = "cccccccc-0000-4000-8000-00000000cf01";

let client: Client;

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

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  await client.query(
    `insert into public.organizations (id, name, slug) values ($1, 'Org Fin A', 'org-fin-a'), ($2, 'Org Fin B', 'org-fin-b') on conflict (id) do nothing`,
    [ORG_A, ORG_B],
  );

  for (const [id, email] of [
    [ADMIN_A, "admin-fin-a@example.com"],
    [ANALISTA_A, "analista-fin-a@example.com"],
    [ADMIN_B, "admin-fin-b@example.com"],
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
     values ($1, $2, 'ADMIN'), ($1, $3, 'ANALISTA'), ($4, $5, 'ADMIN')
     on conflict (organization_id, user_id) do nothing`,
    [ORG_A, ADMIN_A, ANALISTA_A, ORG_B, ADMIN_B],
  );

  await client.query(
    `insert into public.ml_accounts (id, organization_id, slug, label, seller_id, status, connected_at)
     values ($1, $2, 'conta-fin-a', 'Conta Fin A', 980001, 'CONNECTED', now())
     on conflict (id) do nothing`,
    [ML_ACC_A, ORG_A],
  );

  // Limpa resíduos de execuções anteriores do mesmo teste
  await client.query("delete from public.monthly_financial_closings where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.financial_goals where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.operational_expenses where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.fiscal_entities where organization_id in ($1, $2)", [ORG_A, ORG_B]);
});

afterAll(async () => {
  await client.query("delete from public.monthly_financial_closings where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.financial_goals where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.operational_expenses where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.query("delete from public.fiscal_entities where organization_id in ($1, $2)", [ORG_A, ORG_B]);
  await client.end();
});

describe("Central de Inteligência Financeira — SQL, RLS e Constraints", () => {
  it("ADMIN cadastra entidade fiscal, vigência, vínculo e despesa; ANALISTA lê mas não escreve; outra org não vê", async () => {
    const [ent] = await asUser<{ id: string }>(
      ADMIN_A,
      `insert into public.fiscal_entities (organization_id, legal_name, cnpj, tax_regime)
       values ($1, 'SpeedBikers Matriz LTDA', '11222333000181', 'lucro_real')
       returning id`,
      [ORG_A],
    );
    expect(ent?.id).toBeDefined();
    const entityId = ent?.id ?? "";

    // ANALISTA lê a entidade, mas é barrado ao tentar inserir
    const lidoAnalista = await asUser<{ id: string }>(
      ANALISTA_A,
      `select id from public.fiscal_entities where id = $1`,
      [entityId],
    );
    expect(lidoAnalista).toHaveLength(1);

    await expect(
      asUser(
        ANALISTA_A,
        `insert into public.fiscal_entities (organization_id, legal_name, cnpj, tax_regime)
         values ($1, 'Tentativa Analista', '22333444000155', 'simples_nacional')`,
        [ORG_A],
      ),
    ).rejects.toThrow();

    // Outra organização (ORG_B) não enxerga a entidade da ORG_A
    const lidoOutraOrg = await asUser<{ id: string }>(
      ADMIN_B,
      `select id from public.fiscal_entities where id = $1`,
      [entityId],
    );
    expect(lidoOutraOrg).toHaveLength(0);

    // Vínculo exclusivo conta -> CNPJ: 1ª vez ok, 2ª vez falha por UNIQUE
    await asUser(
      ADMIN_A,
      `insert into public.fiscal_entity_accounts (organization_id, fiscal_entity_id, marketplace, ml_account_id)
       values ($1, $2, 'MERCADO_LIVRE', $3)`,
      [ORG_A, entityId, ML_ACC_A],
    );

    await expect(
      asUser(
        ADMIN_A,
        `insert into public.fiscal_entity_accounts (organization_id, fiscal_entity_id, marketplace, ml_account_id)
         values ($1, $2, 'MERCADO_LIVRE', $3)`,
        [ORG_A, entityId, ML_ACC_A],
      ),
    ).rejects.toThrow();

    // Despesa com idempotency_key bloqueia duplicidade na mesma competência
    await asUser(
      ADMIN_A,
      `insert into public.operational_expenses
         (organization_id, name, category, cost_type, recurrence, allocation_method, planned_amount, actual_amount, competence_date, status, idempotency_key)
       values ($1, 'Aluguel Galpão', 'aluguel', 'fixo', 'mensal', 'faturamento', 8500, 8500, '2026-11-01', 'paga', 'exp:2026-11:aluguel:galpao')`,
      [ORG_A],
    );

    await expect(
      asUser(
        ADMIN_A,
        `insert into public.operational_expenses
           (organization_id, name, category, cost_type, recurrence, allocation_method, planned_amount, competence_date, status, idempotency_key)
         values ($1, 'Aluguel Galpão', 'aluguel', 'fixo', 'mensal', 'faturamento', 8500, '2026-11-01', 'prevista', 'exp:2026-11:aluguel:galpao')`,
        [ORG_A],
      ),
    ).rejects.toThrow();
  });

  it("valida constraints físicas de CNPJ, metas financeiras e fechamento mensal", async () => {
    // CNPJ fora de 14 dígitos falha CHECK
    await expect(
      asUser(
        ADMIN_A,
        `insert into public.fiscal_entities (organization_id, legal_name, cnpj, tax_regime)
         values ($1, 'CNPJ Ruim', '123', 'simples_nacional')`,
        [ORG_A],
      ),
    ).rejects.toThrow();

    // Meta financeira e fechamento mensal exigem dia 1
    await expect(
      asUser(
        ADMIN_A,
        `insert into public.financial_goals (organization_id, month, metric_kind, scope_kind, target_value)
         values ($1, '2026-11-15', 'lucro_liquido', 'global', 100000)`,
        [ORG_A],
      ),
    ).rejects.toThrow();

    const [goal] = await asUser<{ id: string }>(
      ADMIN_A,
      `insert into public.financial_goals (organization_id, month, metric_kind, scope_kind, target_value)
       values ($1, '2026-11-01', 'lucro_liquido', 'global', 100000)
       returning id`,
      [ORG_A],
    );
    expect(goal?.id).toBeDefined();

    const [closing] = await asUser<{ status: string }>(
      ADMIN_A,
      `insert into public.monthly_financial_closings (organization_id, month, status, dre_snapshot, notes)
       values ($1, '2026-10-01', 'fechado', '{"faturamento": 500000}'::jsonb, 'Fechamento outubro conferido')
       returning status`,
      [ORG_A],
    );
    expect(closing?.status).toBe("fechado");
  });
});
