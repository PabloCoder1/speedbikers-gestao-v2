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
const SEM_ORG = "cccccccc-0000-4000-8000-000000000004";

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

/**
 * Como `asUser`, mas COMMITA em vez de reverter.
 *
 * `asUser` reverte de propósito — é o que permite testar leitura sem
 * `afterEach` de limpeza. Mas uma chamada de RPC como `resolve_link_candidate`
 * só prova o que promete se o efeito (o vínculo criado, o candidato fechado)
 * sobreviver à transação, porque a asserção seguinte lê com uma conexão nova
 * — aqui, uma consulta direta sem `asUser`.
 */
async function asUserPersist<T>(userId: string, sql: string): Promise<T[]> {
  await client.query("begin");

  try {
    await client.query("set local role authenticated");
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: userId }),
    ]);

    const result = await client.query(sql);

    await client.query("commit");

    return result.rows as T[];
  } catch (error) {
    await client.query("rollback");
    throw error;
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
       'outra@rls.test','x',now(),'{"full_name":"Outra"}',now(),now()),
      ($4,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
       'sem-org@rls.test','x',now(),'{"full_name":"Sem organização"}',now(),now())
    on conflict (id) do nothing
  `, [ADMIN_SB, ANALISTA_SB, DE_OUTRA_ORG, SEM_ORG]);

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
  // link_candidates antes: referencia erp_import_rows e ml_accounts, que os
  // passos seguintes apagam.
  await client.query(`delete from public.link_candidates where sku_key = 'RLSTEST-CANDIDATO'`);

  // Componentes primeiro: `on delete restrict` impede apagar um produto que
  // compõe kit — que é justamente a garantia testada acima.
  await client.query(`
    delete from public.sku_listing_links
    where sku_id in (select id from public.skus where sku like 'RLSTEST%')
  `);
  await client.query("delete from public.erp_import_batches where file_name like 'rlstest%'");
  await client.query("delete from public.ml_accounts where slug like 'rlstest%'");
  await client.query(`
    delete from public.sku_components
    where kit_sku_id in (select id from public.skus where sku like 'RLSTEST%')
       or component_sku_id in (select id from public.skus where sku like 'RLSTEST%')
  `);
  await client.query("delete from public.skus where sku like 'RLSTEST%'");
  await client.query("delete from auth.users where email like '%@rls.test'");

  // As duas organizações de teste NÃO são apagadas: a suíte de observabilidade
  // de sincronização, acima, grava em `sync_runs`/`sync_errors` — append-only
  // por desenho, com `ml_accounts.id` referenciado por `on delete restrict`.
  // Uma vez que a conta de teste tem histórico, a cascata de `organizations`
  // até `ml_accounts` fica bloqueada — exatamente a garantia que a suíte
  // prova ("é append-only: nem um DELETE direto do dono passa"). É o preço
  // correto de testar contra Postgres real: o ambiente local acumula até o
  // próximo `supabase db reset --local`.
  await client.end();
});

describe("perfil criado automaticamente", () => {
  it("todo usuário do Auth ganha uma linha em profiles", async () => {
    const rows = await client.query<{ count: string }>(
      "select count(*) from public.profiles where id = any($1)",
      [[ADMIN_SB, ANALISTA_SB, DE_OUTRA_ORG, SEM_ORG]],
    );

    expect(rows.rows[0]?.count).toBe("4");
  });
});

describe("catálogo de métricas", () => {
  it("membro autenticado lê as seis definições canônicas", async () => {
    const rows = await asUser<{ id: string }>(ADMIN_SB, "select id from public.metric_definitions");

    expect(rows).toHaveLength(6);
  });

  it("authenticated sem organização não lê definição nenhuma", async () => {
    const rows = await asUser(SEM_ORG, "select id from public.metric_definitions");

    expect(rows).toHaveLength(0);
  });

  it("anon não lê o catálogo", async () => {
    await expect(asAnon("select * from public.metric_definitions")).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("authenticated não altera o espelho da documentação", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        "update public.metric_definitions set name = 'Alterada' where id = 'receita_bruta'",
      ),
    ).rejects.toThrow(/permission denied/i);
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


describe("catálogo", () => {
  it("normaliza sku_key e deriva is_imported do código fiscal", async () => {
    const rows = await client.query<{ sku_key: string; is_imported: boolean }>(
      `insert into public.skus (organization_id, sku, kind, origin_code)
       values ($1,'RLSTEST-bau98','PRODUTO',1)
       returning sku_key, is_imported`,
      [ORG_SB],
    );

    expect(rows.rows[0]?.sku_key).toBe("RLSTEST-BAU98");
    expect(rows.rows[0]?.is_imported).toBe(true);
  });

  it("recusa SKU duplicado que difere só na caixa", async () => {
    await expect(
      client.query(
        `insert into public.skus (organization_id, sku, kind) values ($1,'rlstest-BAU98','PRODUTO')`,
        [ORG_SB],
      ),
    ).rejects.toThrow(/skus_org_key_unique/);
  });

  it("origem nacional não marca importado", async () => {
    const rows = await client.query<{ is_imported: boolean }>(
      `insert into public.skus (organization_id, sku, kind, origin_code)
       values ($1,'RLSTEST-nacional','PRODUTO',0) returning is_imported`,
      [ORG_SB],
    );

    expect(rows.rows[0]?.is_imported).toBe(false);
  });

  it("recusa código de origem fora da tabela fiscal", async () => {
    await expect(
      client.query(
        `insert into public.skus (organization_id, sku, kind, origin_code)
         values ($1,'RLSTEST-invalida','PRODUTO',9)`,
        [ORG_SB],
      ),
    ).rejects.toThrow(/origin_code/);
  });
});

describe("composição de kit", () => {
  it("PRODUTO não pode ter componente", async () => {
    await client.query(
      `insert into public.skus (organization_id, sku, kind) values ($1,'RLSTEST-comp','PRODUTO')`,
      [ORG_SB],
    );

    await expect(
      client.query(
        `insert into public.sku_components (kit_sku_id, component_sku_id, quantity)
         select a.id, b.id, 1 from public.skus a, public.skus b
         where a.sku_key='RLSTEST-NACIONAL' and b.sku_key='RLSTEST-COMP'`,
      ),
    ).rejects.toThrow(/nao e KIT/);
  });

  it("componente precisa ser PRODUTO — kit aninhado é recusado", async () => {
    await client.query(
      `insert into public.skus (organization_id, sku, kind) values
         ($1,'RLSTEST-kit1','KIT'), ($1,'RLSTEST-kit2','KIT')`,
      [ORG_SB],
    );

    await expect(
      client.query(
        `insert into public.sku_components (kit_sku_id, component_sku_id, quantity)
         select a.id, b.id, 1 from public.skus a, public.skus b
         where a.sku_key='RLSTEST-KIT1' and b.sku_key='RLSTEST-KIT2'`,
      ),
    ).rejects.toThrow(/precisa ser PRODUTO/);
  });

  it("aceita componente válido com quantidade fracionária", async () => {
    const rows = await client.query(
      `insert into public.sku_components (kit_sku_id, component_sku_id, quantity)
       select a.id, b.id, 2.5 from public.skus a, public.skus b
       where a.sku_key='RLSTEST-KIT1' and b.sku_key='RLSTEST-COMP'
       returning quantity`,
    );

    expect(rows.rows).toHaveLength(1);
  });

  it("apagar produto que compõe kit é recusado", async () => {
    await expect(
      client.query(`delete from public.skus where sku_key='RLSTEST-COMP'`),
    ).rejects.toThrow(/violates foreign key/i);
  });
});

describe("RLS do catálogo", () => {
  it("membro da organização enxerga os SKUs", async () => {
    const rows = await asUser(ADMIN_SB, "select id from public.skus");

    expect(rows.length).toBeGreaterThan(0);
  });

  it("usuário de outra organização não enxerga nenhum", async () => {
    const rows = await asUser(DE_OUTRA_ORG, "select id from public.skus");

    expect(rows).toHaveLength(0);
  });

  it("anon é recusado no catálogo", async () => {
    await expect(asAnon("select * from public.skus")).rejects.toThrow(/permission denied/i);
  });

  it("authenticated não escreve no catálogo: importação é do worker", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `insert into public.skus (organization_id, sku, kind) values ('${ORG_SB}','RLSTEST-hack','PRODUTO')`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });
});


describe("contas Mercado Livre", () => {
  const CONTA_A = "aaaa1111-0000-4000-8000-00000000aaaa";
  const CONTA_B = "bbbb2222-0000-4000-8000-00000000bbbb";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
       values ($1,$3,'Conta A','rlstest-conta-a',111,'CONNECTED',now()),
              ($2,$3,'Conta B','rlstest-conta-b',222,'CONNECTED',now())
       on conflict do nothing`,
      [CONTA_A, CONTA_B, ORG_SB],
    );

    // O ANALISTA recebe permissão apenas na Conta A.
    await client.query(
      `insert into public.user_account_permissions (user_id, ml_account_id)
       values ($1,$2) on conflict do nothing`,
      [ANALISTA_SB, CONTA_A],
    );
  });

  it("slug aceita só o charset que o Cloud Tasks permite em nome de fila", async () => {
    await expect(
      client.query(
        `insert into public.ml_accounts (organization_id,label,slug) values ($1,'X','rlstest.ponto')`,
        [ORG_SB],
      ),
    ).rejects.toThrow(/ml_accounts_slug_check/);
  });

  it("CONNECTED sem seller_id é recusado", async () => {
    await expect(
      client.query(
        `insert into public.ml_accounts (organization_id,label,slug,status)
         values ($1,'X','rlstest-incoerente','CONNECTED')`,
        [ORG_SB],
      ),
    ).rejects.toThrow(/ml_accounts_status_coherent/);
  });

  it("ADMIN enxerga todas as contas da organização", async () => {
    const rows = await asUser(ADMIN_SB, "select id from public.ml_accounts");

    expect(rows.length).toBeGreaterThanOrEqual(2);
  });

  it("ANALISTA enxerga apenas a conta em que tem permissão", async () => {
    const rows = await asUser<{ slug: string }>(ANALISTA_SB, "select slug from public.ml_accounts");

    expect(rows.map((r) => r.slug)).toEqual(["rlstest-conta-a"]);
  });

  it("usuário de outra organização não enxerga conta nenhuma", async () => {
    const rows = await asUser(DE_OUTRA_ORG, "select id from public.ml_accounts");

    expect(rows).toHaveLength(0);
  });

  it("ANALISTA não concede permissão de conta a si mesmo", async () => {
    await expect(
      asUser(
        ANALISTA_SB,
        `insert into public.user_account_permissions (user_id, ml_account_id)
         values ('${ANALISTA_SB}','${CONTA_B}')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("credenciais são inalcançáveis pela Data API", () => {
  it.each(["ml_credentials", "ml_oauth_states"])("authenticated é recusado em %s", async (t) => {
    await expect(asUser(ADMIN_SB, `select * from public.${t}`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it.each(["ml_credentials", "ml_oauth_states"])("anon é recusado em %s", async (t) => {
    await expect(asAnon(`select * from public.${t}`)).rejects.toThrow(/permission denied/i);
  });

  it("token em texto claro é recusado pelo banco", async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug)
       values ('cccc3333-0000-4000-8000-00000000cccc',$1,'C','rlstest-claro')
       on conflict do nothing`,
      [ORG_SB],
    );

    // Guarda contra o erro óbvio: salvar o token do jeito que o ML devolve.
    await expect(
      client.query(
        `insert into public.ml_credentials
           (ml_account_id, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at)
         values ('cccc3333-0000-4000-8000-00000000cccc','APP_USR-123456','TG-abc',now())`,
      ),
    ).rejects.toThrow(/ml_credentials_looks_encrypted/);
  });

  it("aceita ciphertext", async () => {
    const rows = await client.query(
      `insert into public.ml_credentials
         (ml_account_id, access_token_ciphertext, refresh_token_ciphertext, access_token_expires_at)
       values ('cccc3333-0000-4000-8000-00000000cccc','v1:9f8a7b...','v1:3c2d1e...',now())
       returning ml_account_id`,
    );

    expect(rows.rows).toHaveLength(1);
  });
});


describe("vínculo SKU ↔ anúncio", () => {
  const CONTA = "aaaa1111-0000-4000-8000-00000000aaaa";
  let skuId = "";

  beforeAll(async () => {
    const r = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,'RLSTEST-link','PRODUTO')
       returning id`,
      [ORG_SB],
    );
    skuId = r.rows[0]?.id ?? "";
  });

  async function link(fields: string, values: string): Promise<unknown> {
    return await client.query(
      `insert into public.sku_listing_links (organization_id, ml_account_id, sku_id, ${fields})
       values ($1,$2,$3,${values})`,
      [ORG_SB, CONTA, skuId],
    );
  }

  it("aceita anúncio sem variação", async () => {
    await expect(link("ref_kind,item_id", "'ITEM','MLB900000001'")).resolves.toBeDefined();
  });

  it("recusa o MESMO anúncio sem variação duas vezes", async () => {
    // A armadilha: NULL não colide com NULL num UNIQUE comum. Só o índice
    // parcial pega este caso — e ele é 3.579 dos vínculos reais.
    await expect(link("ref_kind,item_id", "'ITEM','MLB900000001'")).rejects.toThrow(
      /sku_listing_links_item_only_unique/,
    );
  });

  it("aceita o mesmo anúncio com variação", async () => {
    await expect(
      link("ref_kind,item_id,variation_id", "'ITEM','MLB900000001','205704879161'"),
    ).resolves.toBeDefined();
  });

  it("recusa a mesma variação duas vezes", async () => {
    await expect(
      link("ref_kind,item_id,variation_id", "'ITEM','MLB900000001','205704879161'"),
    ).rejects.toThrow(/sku_listing_links_item_variation_unique/);
  });

  it("recusa variação não numérica — o ERP repetindo o MLB", async () => {
    await expect(
      link("ref_kind,item_id,variation_id", "'ITEM','MLB900000002','MLB900000002'"),
    ).rejects.toThrow(/variation_id_check/);
  });

  it("recusa USER_PRODUCT carregando item_id junto", async () => {
    await expect(
      link("ref_kind,item_id,user_product_id", "'USER_PRODUCT','MLB1','MLBU4818089142'"),
    ).rejects.toThrow(/sku_listing_links_ref_shape/);
  });

  it("aceita user product isolado", async () => {
    await expect(
      link("ref_kind,user_product_id", "'USER_PRODUCT','MLBU4818089142'"),
    ).resolves.toBeDefined();
  });

  it("recusa vínculo cruzando organizações", async () => {
    const outro = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,'RLSTEST-outro','PRODUTO')
       returning id`,
      [ORG_OUTRA],
    );

    await expect(
      client.query(
        `insert into public.sku_listing_links (organization_id, ml_account_id, sku_id, ref_kind, item_id)
         values ($1,$2,$3,'ITEM','MLB900000009')`,
        [ORG_SB, CONTA, outro.rows[0]?.id],
      ),
    ).rejects.toThrow(/outra organizacao/);
  });

  it("ANALISTA sem permissão na conta não enxerga o vínculo", async () => {
    const rows = await asUser(DE_OUTRA_ORG, "select id from public.sku_listing_links");

    expect(rows).toHaveLength(0);
  });

  it("anon é recusado", async () => {
    await expect(asAnon("select * from public.sku_listing_links")).rejects.toThrow(
      /permission denied/i,
    );
  });
});


describe("importação do UpSeller", () => {
  const HASH_A = "a".repeat(64);
  const BATCH = "b1000000-0000-4000-8000-00000000000b";

  beforeAll(async () => {
    await client.query(
      `insert into public.erp_import_batches (id, organization_id, kind, storage_path, content_hash, file_name)
       values ($1,$2,'PRODUCTS','erp-imports/2026-08/p.xlsx',$3,'rlstest-export.xlsx')
       on conflict do nothing`,
      [BATCH, ORG_SB, HASH_A],
    );
  });

  it("o MESMO arquivo não entra duas vezes", async () => {
    // Sem isto, reenviar a planilha duplicaria vínculo e sobrescreveria o
    // catálogo sem ninguém notar.
    await expect(
      client.query(
        `insert into public.erp_import_batches (organization_id, kind, storage_path, content_hash, file_name)
         values ($1,'KITS','outro/caminho.xlsx',$2,'rlstest-outro.xlsx')`,
        [ORG_SB, HASH_A],
      ),
    ).rejects.toThrow(/erp_import_batches_hash_unique/);
  });

  it("o mesmo arquivo em OUTRA organização é permitido", async () => {
    await expect(
      client.query(
        `insert into public.erp_import_batches (organization_id, kind, storage_path, content_hash, file_name)
         values ($1,'PRODUCTS','x',$2,'rlstest-outraorg.xlsx')`,
        [ORG_OUTRA, HASH_A],
      ),
    ).resolves.toBeDefined();
  });

  it("APLICADO exige responsável — aplicação sem autor não é auditável", async () => {
    await expect(
      client.query(
        `update public.erp_import_batches set status='APPLIED', applied_at=now() where id=$1`,
        [BATCH],
      ),
    ).rejects.toThrow(/applied_coherent/);
  });

  it("hash fora do tamanho de um SHA-256 é recusado", async () => {
    await expect(
      client.query(
        `insert into public.erp_import_batches (organization_id, kind, storage_path, content_hash, file_name)
         values ($1,'STOCK','x','abc','rlstest-hash.xlsx')`,
        [ORG_SB],
      ),
    ).rejects.toThrow(/content_hash/);
  });

  it("linha OK não pode carregar motivo de erro", async () => {
    await expect(
      client.query(
        `insert into public.erp_import_rows (batch_id,row_number,status,reason,payload)
         values ($1,1,'OK','deu ruim','{}')`,
        [BATCH],
      ),
    ).rejects.toThrow(/reason_matches_status/);
  });

  it("distingue SKIPPED de INVALID — decisão versus erro", async () => {
    const rows = await client.query(
      `insert into public.erp_import_rows (batch_id,row_number,status,reason,payload) values
         ($1,10,'SKIPPED','canal fora do Mercado Livre','{}'),
         ($1,11,'INVALID','variação não numérica','{}')
       returning status`,
      [BATCH],
    );

    expect(rows.rows).toHaveLength(2);
  });

  it("snapshot de estoque aceita SKU que ainda não existe na V3", async () => {
    // Saldo de SKU desconhecido continua sendo informação — é justamente o
    // caso que a conferência precisa mostrar.
    const rows = await client.query(
      `insert into public.erp_stock_snapshots
         (organization_id,batch_id,sku_key,warehouse,on_hand,available,captured_at)
       values ($1,$2,'SKU-QUE-NAO-EXISTE','ESTOQUE LOJA',4,4,now())
       returning sku_id`,
      [ORG_SB, BATCH],
    );

    expect(rows.rows[0]).toMatchObject({ sku_id: null });
  });

  it("mesmo SKU e armazém não se repetem dentro do lote", async () => {
    await expect(
      client.query(
        `insert into public.erp_stock_snapshots
           (organization_id,batch_id,sku_key,warehouse,on_hand,available,captured_at)
         values ($1,$2,'SKU-QUE-NAO-EXISTE','ESTOQUE LOJA',9,9,now())`,
        [ORG_SB, BATCH],
      ),
    ).rejects.toThrow(/unique_per_batch/);
  });
});

describe("RLS da importação", () => {
  it("ADMIN enxerga os lotes", async () => {
    const rows = await asUser(ADMIN_SB, "select id from public.erp_import_batches");

    expect(rows.length).toBeGreaterThan(0);
  });

  it("ANALISTA não enxerga: importação é ato administrativo", async () => {
    const rows = await asUser(ANALISTA_SB, "select id from public.erp_import_batches");

    expect(rows).toHaveLength(0);
  });

  it("authenticated não escreve — a transição de status é comando na api", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `insert into public.erp_import_batches (organization_id,kind,storage_path,content_hash)
         values ('${ORG_SB}','STOCK','x','${"c".repeat(64)}')`,
      ),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });

  it("anon é recusado", async () => {
    await expect(asAnon("select * from public.erp_import_batches")).rejects.toThrow(
      /permission denied/i,
    );
  });
});

describe("Central de Vinculações", () => {
  const CONTA = "aaaa1111-0000-4000-8000-00000000aaaa"; // ANALISTA_SB tem permissão aqui.
  const HASH = "d".repeat(64);
  let batchId = "";
  let rowId = 0;
  let skuId = "";
  let otherOrgSkuId = "";

  beforeAll(async () => {
    const b = await client.query<{ id: string }>(
      `insert into public.erp_import_batches (organization_id, kind, storage_path, content_hash, file_name)
       values ($1,'LINKS','erp-imports/2026-08/l.xlsx',$2,'rlstest-links.xlsx')
       returning id`,
      [ORG_SB, HASH],
    );
    batchId = b.rows[0]?.id ?? "";

    const r = await client.query<{ id: number }>(
      `insert into public.erp_import_rows (batch_id, row_number, status, payload)
       values ($1, 2, 'OK', '{}') returning id`,
      [batchId],
    );
    rowId = r.rows[0]?.id ?? 0;

    const s = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,'RLSTEST-candidato','PRODUTO')
       returning id`,
      [ORG_SB],
    );
    skuId = s.rows[0]?.id ?? "";

    const o = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,'RLSTEST-candidato-outra','PRODUTO')
       returning id`,
      [ORG_OUTRA],
    );
    otherOrgSkuId = o.rows[0]?.id ?? "";
  });

  let nextRowNumber = 100;

  /**
   * Cada chamada usa uma linha de origem PRÓPRIA — `link_candidates` permite
   * só um candidato por linha (`link_candidates_source_row_unique`), e testes
   * independentes não podem depender da ordem de limpeza uns dos outros.
   */
  async function insertCandidate(): Promise<string> {
    nextRowNumber += 1;

    const r = await client.query<{ id: number }>(
      `insert into public.erp_import_rows (batch_id, row_number, status, payload)
       values ($1, $2, 'OK', '{}') returning id`,
      [batchId, nextRowNumber],
    );
    const ownRowId = r.rows[0]?.id ?? 0;

    const c = await client.query<{ id: string }>(
      `insert into public.link_candidates
         (organization_id, ml_account_id, source_row_id, sku_key, ref_kind, item_id, variation_id)
       values ($1,$2,$3,'RLSTEST-CANDIDATO','ITEM','MLB900000777',null)
       returning id`,
      [ORG_SB, CONTA, ownRowId],
    );

    return c.rows[0]?.id ?? "";
  }

  it("linha de origem duplicada é recusada — um candidato por linha", async () => {
    // Usa a linha do beforeAll diretamente: as duas tentativas precisam mirar
    // o MESMO source_row_id, o que o helper insertCandidate (uma linha nova
    // por chamada, de propósito) não serve para este caso.
    await client.query(
      `insert into public.link_candidates
         (organization_id, ml_account_id, source_row_id, sku_key, ref_kind, item_id)
       values ($1,$2,$3,'RLSTEST-CANDIDATO','ITEM','MLB900000777')`,
      [ORG_SB, CONTA, rowId],
    );

    await expect(
      client.query(
        `insert into public.link_candidates
           (organization_id, ml_account_id, source_row_id, sku_key, ref_kind, item_id)
         values ($1,$2,$3,'RLSTEST-CANDIDATO','ITEM','MLB900000778')`,
        [ORG_SB, CONTA, rowId],
      ),
    ).rejects.toThrow(/link_candidates_source_row_unique/);

    await client.query("delete from public.link_candidates where source_row_id = $1", [rowId]);
  });

  describe("RLS de leitura", () => {
    it("quem tem permissão na conta enxerga o candidato", async () => {
      const id = await insertCandidate();

      const rows = await asUser(ANALISTA_SB, "select id from public.link_candidates");

      expect(rows.map((r) => (r as { id: string }).id)).toContain(id);

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });

    it("ADMIN enxerga qualquer conta da própria organização", async () => {
      const id = await insertCandidate();

      const rows = await asUser(ADMIN_SB, "select id from public.link_candidates");

      expect(rows.map((r) => (r as { id: string }).id)).toContain(id);

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });

    it("usuário de outra organização não enxerga nada", async () => {
      const id = await insertCandidate();

      const rows = await asUser(DE_OUTRA_ORG, "select id from public.link_candidates");

      expect(rows).toHaveLength(0);

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });

    it("anon é recusado", async () => {
      await expect(asAnon("select * from public.link_candidates")).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  describe("escrita direta é recusada — só pelas duas funções", () => {
    it("authenticated não insere direto", async () => {
      await expect(
        asUser(
          ADMIN_SB,
          `insert into public.link_candidates
             (organization_id, ml_account_id, source_row_id, sku_key, ref_kind, item_id)
           values ('${ORG_SB}','${CONTA}',${String(rowId)},'RLSTEST-HACK','ITEM','MLB900000778')`,
        ),
      ).rejects.toThrow(/permission denied|row-level security/i);
    });

    it("authenticated não atualiza direto", async () => {
      const id = await insertCandidate();

      await expect(
        asUser(
          ADMIN_SB,
          `update public.link_candidates set status='DISMISSED' where id='${id}' returning id`,
        ),
      ).rejects.toThrow(/permission denied/i);

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });
  });

  describe("resolve_link_candidate", () => {
    it("sem acesso à conta é recusado", async () => {
      const id = await insertCandidate();

      await expect(
        asUser(DE_OUTRA_ORG, `select public.resolve_link_candidate('${id}','${skuId}')`),
      ).rejects.toThrow(/sem permissao/);

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });

    it("anon não tem EXECUTE — GRANT é a primeira barreira, não `auth.uid()` nulo", async () => {
      // O Supabase concede EXECUTE a anon/authenticated por padrão em toda
      // funcao nova do schema public — achado pelo linter de seguranca depois
      // do deploy (docs/HANDOFF.md). Sem a revogacao explicita, esta chamada
      // chegaria a rodar (e falhar só depois, por dentro).
      const id = await insertCandidate();

      await expect(
        asAnon(`select public.resolve_link_candidate('${id}','${skuId}')`),
      ).rejects.toThrow(/permission denied/i);

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });

    it("SKU de outra organização é recusado", async () => {
      const id = await insertCandidate();

      await expect(
        asUser(ADMIN_SB, `select public.resolve_link_candidate('${id}','${otherOrgSkuId}')`),
      ).rejects.toThrow(/outra organizacao/);

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });

    it("quem tem acesso resolve: cria o vínculo e fecha o candidato na mesma transação", async () => {
      const id = await insertCandidate();

      // ANALISTA enxerga (RLS de leitura, acima), mas confirmar é ato de
      // escrita — mesmos papéis de sku_listing_links_write_permitted.
      await asUserPersist(ADMIN_SB, `select public.resolve_link_candidate('${id}','${skuId}')`);

      const candidate = await client.query(
        `select status, resolution_method, resolved_sku_id from public.link_candidates where id=$1`,
        [id],
      );

      expect(candidate.rows[0]).toMatchObject({
        status: "RESOLVED",
        resolution_method: "MANUAL",
        resolved_sku_id: skuId,
      });

      const link = await client.query(
        `select sku_id, source from public.sku_listing_links where item_id='MLB900000777'`,
      );

      expect(link.rows[0]).toMatchObject({ sku_id: skuId, source: "MANUAL" });

      await client.query("delete from public.sku_listing_links where item_id='MLB900000777'");
      await client.query("delete from public.link_candidates where id = $1", [id]);
    });

    it("candidato já resolvido não pode ser resolvido de novo", async () => {
      const id = await insertCandidate();

      await asUserPersist(ADMIN_SB, `select public.resolve_link_candidate('${id}','${skuId}')`);

      await expect(
        asUserPersist(ADMIN_SB, `select public.resolve_link_candidate('${id}','${skuId}')`),
      ).rejects.toThrow(/nao esta aberto/);

      await client.query("delete from public.sku_listing_links where item_id='MLB900000777'");
      await client.query("delete from public.link_candidates where id = $1", [id]);
    });
  });

  describe("dismiss_link_candidate", () => {
    it("sem acesso à conta é recusado", async () => {
      const id = await insertCandidate();

      await expect(
        asUser(DE_OUTRA_ORG, `select public.dismiss_link_candidate('${id}')`),
      ).rejects.toThrow(/sem permissao/);

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });

    it("anon não tem EXECUTE", async () => {
      const id = await insertCandidate();

      await expect(asAnon(`select public.dismiss_link_candidate('${id}')`)).rejects.toThrow(
        /permission denied/i,
      );

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });

    it("quem tem acesso descarta, sem criar vínculo nenhum", async () => {
      const id = await insertCandidate();

      await asUserPersist(ADMIN_SB, `select public.dismiss_link_candidate('${id}')`);

      const candidate = await client.query(
        `select status, resolved_sku_id from public.link_candidates where id=$1`,
        [id],
      );

      expect(candidate.rows[0]).toMatchObject({ status: "DISMISSED", resolved_sku_id: null });

      const link = await client.query(
        `select id from public.sku_listing_links where item_id='MLB900000777'`,
      );

      expect(link.rows).toHaveLength(0);

      await client.query("delete from public.link_candidates where id = $1", [id]);
    });
  });
});

describe("observabilidade de sincronização", () => {
  // Conta PRÓPRIA, fora do padrão `rlstest%` que o afterAll global apaga: uma
  // vez que ela tiver um sync_runs, `on delete restrict` torna a conta
  // permanentemente indeletável (de propósito — ver a migration). Reusar
  // CONTA_A quebraria a limpeza das outras suítes.
  const CONTA = "cccc9999-0000-4000-8000-00000000cccc";

  let syncRunId = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de observabilidade','syncobs-conta','PENDING')
       on conflict do nothing`,
      [CONTA, ORG_SB],
    );

    await client.query(
      `insert into public.user_account_permissions (user_id, ml_account_id)
       values ($1,$2) on conflict do nothing`,
      [ANALISTA_SB, CONTA],
    );

    const run = await client.query<{ id: string }>(
      `insert into public.sync_runs
         (organization_id, ml_account_id, job_id, resource, channel, status, started_at, finished_at)
       values ($1,$2,gen_random_uuid(),'orders','webhook','done',now(),now())
       returning id`,
      [ORG_SB, CONTA],
    );
    syncRunId = run.rows[0]?.id ?? "";

    await client.query(
      `insert into public.sync_errors
         (organization_id, ml_account_id, sync_run_id, resource, error_class, message, occurred_at)
       values ($1,$2,$3,'orders','retryable','rlstest timeout',now())`,
      [ORG_SB, CONTA, syncRunId],
    );
  });

  // Sem afterAll de limpeza: as duas tabelas são append-only por desenho — a
  // própria suíte abaixo prova que nem um DELETE direto do dono passa. As
  // linhas de teste ficam, como ficariam em produção; o ambiente local é
  // recriado do zero por `supabase db reset` quando isso importar.

  it("finished_at antes de started_at é recusado", async () => {
    await expect(
      client.query(
        `insert into public.sync_runs
           (organization_id, ml_account_id, job_id, resource, channel, status, started_at, finished_at)
         values ($1,$2,gen_random_uuid(),'orders','webhook','done',now(),now() - interval '1 hour')`,
        [ORG_SB, CONTA],
      ),
    ).rejects.toThrow(/finished_after_started/);
  });

  it("status done com motivo de falha é recusado", async () => {
    await expect(
      client.query(
        `insert into public.sync_runs
           (organization_id, ml_account_id, job_id, resource, channel, status, reason, started_at, finished_at)
         values ($1,$2,gen_random_uuid(),'orders','webhook','done','deu ruim',now(),now())`,
        [ORG_SB, CONTA],
      ),
    ).rejects.toThrow(/reason_matches_status/);
  });

  it("é append-only: nem um UPDATE direto do dono passa", async () => {
    await expect(
      client.query(`update public.sync_runs set status='failed' where id=$1`, [syncRunId]),
    ).rejects.toThrow(/append-only/);
  });

  it("é append-only: nem um DELETE direto do dono passa", async () => {
    await expect(
      client.query(`delete from public.sync_runs where id=$1`, [syncRunId]),
    ).rejects.toThrow(/append-only/);
  });

  describe("RLS", () => {
    it("quem tem permissão na conta enxerga sync_runs e sync_errors", async () => {
      const runs = await asUser(ANALISTA_SB, "select id from public.sync_runs");
      const errors = await asUser(ANALISTA_SB, "select id from public.sync_errors");

      expect(runs.map((r) => (r as { id: string }).id)).toContain(syncRunId);
      expect(errors.length).toBeGreaterThan(0);
    });

    it("usuário de outra organização não enxerga nada", async () => {
      const runs = await asUser(DE_OUTRA_ORG, "select id from public.sync_runs");
      const errors = await asUser(DE_OUTRA_ORG, "select id from public.sync_errors");

      expect(runs).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it("anon é recusado nas duas tabelas", async () => {
      await expect(asAnon("select * from public.sync_runs")).rejects.toThrow(/permission denied/i);
      await expect(asAnon("select * from public.sync_errors")).rejects.toThrow(/permission denied/i);
    });

    it("authenticated não escreve — só service_role registra sincronização", async () => {
      await expect(
        asUser(
          ADMIN_SB,
          `insert into public.sync_runs
             (organization_id, ml_account_id, job_id, resource, channel, status, started_at, finished_at)
           values ('${ORG_SB}','${CONTA}',gen_random_uuid(),'orders','webhook','done',now(),now())`,
        ),
      ).rejects.toThrow(/permission denied|row-level security/i);
    });
  });
});
