import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Testes de RLS contra o Postgres real.
 *
 * `docs/TESTING.md`, regra 2: **todo policy tem teste negativo**. Provar que o
 * autorizado enxerga não prova nada — no Modelo A (D-012) o `web` lê o banco
 * direto, então a policy é a segurança do sistema.
 *
 * Testar contra mock não serviria: o que está sendo verificado é o
 * comportamento do Postgres, não o do nosso código.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const ORG_SB = "11111111-0000-4000-8000-000000000001";
const ORG_OUTRA = "22222222-0000-4000-8000-000000000002";

const ADMIN_SB = "aaaaaaaa-0000-4000-8000-000000000001";
const ANALISTA_SB = "aaaaaaaa-0000-4000-8000-000000000002";
const DE_OUTRA_ORG = "bbbbbbbb-0000-4000-8000-000000000003";

let client: Client;

/**
 * Executa uma consulta como um usuário autenticado específico.
 *
 * O `set local` só vale dentro de transação — fora dela o Postgres descarta em
 * silêncio, o papel continua sendo o dono da tabela, e o teste passa a medir
 * nada. Foi exatamente esse o erro na primeira verificação manual.
 */
async function asUser<T>(userId: string, sql: string): Promise<T[]> {
  await client.query("begin");

  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId }),
    ]);

    const result = await client.query(sql);

    return result.rows as T[];
  } finally {
    await client.query("rollback");
  }
}

async function asAnon<T>(sql: string): Promise<T[]> {
  await client.query("begin");

  try {
    await client.query("set local role anon");

    const result = await client.query(sql);

    return result.rows as T[];
  } finally {
    await client.query("rollback");
  }
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  await client.query(`
    insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                            email_confirmed_at, raw_user_meta_data, created_at, updated_at)
    values
      ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
       'admin@rls.test','x',now(),'{"full_name":"Admin"}',now(),now()),
      ($2,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
       'analista@rls.test','x',now(),'{"full_name":"Analista"}',now(),now()),
      ($3,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
       'outra@rls.test','x',now(),'{"full_name":"Outra"}',now(),now())
    on conflict (id) do nothing
  `, [ADMIN_SB, ANALISTA_SB, DE_OUTRA_ORG]);

  await client.query(`
    insert into public.organizations (id, name, slug)
    values ($1,'Speed Bikers RLS','speed-bikers-rls'), ($2,'Outra RLS','outra-rls')
    on conflict (id) do nothing
  `, [ORG_SB, ORG_OUTRA]);

  await client.query(`
    insert into public.organization_members (organization_id, user_id, role)
    values ($1,$3,'ADMIN'), ($1,$4,'ANALISTA'), ($2,$5,'ADMIN')
    on conflict do nothing
  `, [ORG_SB, ORG_OUTRA, ADMIN_SB, ANALISTA_SB, DE_OUTRA_ORG]);
});

afterAll(async () => {
  await client.query("delete from auth.users where email like '%@rls.test'");
  await client.query("delete from public.organizations where slug in ('speed-bikers-rls','outra-rls')");
  await client.end();
});

describe("perfil criado automaticamente", () => {
  it("todo usuário do Auth ganha uma linha em profiles", async () => {
    const rows = await client.query<{ count: string }>(
      "select count(*) from public.profiles where id = any($1)",
      [[ADMIN_SB, ANALISTA_SB, DE_OUTRA_ORG]],
    );

    expect(rows.rows[0]?.count).toBe("3");
  });
});

describe("isolamento entre organizações", () => {
  it("membro vê apenas a própria organização", async () => {
    const rows = await asUser<{ slug: string }>(ANALISTA_SB, "select slug from public.organizations");

    expect(rows.map((r) => r.slug)).toEqual(["speed-bikers-rls"]);
  });

  it("usuário de outra empresa NÃO enxerga a Speed Bikers", async () => {
    const rows = await asUser<{ slug: string }>(DE_OUTRA_ORG, "select slug from public.organizations");

    expect(rows.map((r) => r.slug)).toEqual(["outra-rls"]);
    expect(rows.map((r) => r.slug)).not.toContain("speed-bikers-rls");
  });

  it("membros são visíveis apenas dentro da organização", async () => {
    const rows = await asUser(DE_OUTRA_ORG, "select user_id from public.organization_members");

    expect(rows).toHaveLength(1);
  });

  it("perfis de outra organização não vazam", async () => {
    const rows = await asUser<{ id: string }>(DE_OUTRA_ORG, "select id from public.profiles");

    expect(rows.map((r) => r.id)).not.toContain(ADMIN_SB);
  });
});

describe("anon não tem acesso a nada", () => {
  it.each(["organizations", "profiles", "organization_members"])(
    "recusa leitura de %s",
    async (table) => {
      await expect(asAnon(`select * from public.${table}`)).rejects.toThrow(/permission denied/i);
    },
  );
});

describe("concessão de papel é privilégio de ADMIN", () => {
  it("ANALISTA não consegue conceder papel", async () => {
    await expect(
      asUser(
        ANALISTA_SB,
        `insert into public.organization_members (organization_id,user_id,role)
         values ('${ORG_SB}','${DE_OUTRA_ORG}','OPERADOR')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("ADMIN consegue conceder papel na própria organização", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `insert into public.organization_members (organization_id,user_id,role)
         values ('${ORG_SB}','${DE_OUTRA_ORG}','OPERADOR')`,
      ),
    ).resolves.toBeDefined();
  });

  it("ADMIN não alcança organização alheia", async () => {
    const rows = await asUser(
      ADMIN_SB,
      `update public.organization_members set role='VISUALIZADOR'
       where organization_id='${ORG_OUTRA}' returning user_id`,
    );

    expect(rows).toHaveLength(0);
  });
});

describe("perfil próprio", () => {
  it("usuário não altera o perfil de outro", async () => {
    const rows = await asUser(
      ANALISTA_SB,
      `update public.profiles set full_name='invadido' where id='${ADMIN_SB}' returning id`,
    );

    expect(rows).toHaveLength(0);
  });

  it("usuário altera o próprio perfil", async () => {
    const rows = await asUser(
      ANALISTA_SB,
      `update public.profiles set full_name='Novo Nome' where id='${ANALISTA_SB}' returning full_name`,
    );

    expect(rows).toHaveLength(1);
  });
});

describe("job_runs permanece fechada", () => {
  it("nem authenticated lê: RLS habilitada sem policy nenhuma", async () => {
    await expect(asUser(ADMIN_SB, "select * from public.job_runs")).rejects.toThrow(
      /permission denied/i,
    );
  });
});
