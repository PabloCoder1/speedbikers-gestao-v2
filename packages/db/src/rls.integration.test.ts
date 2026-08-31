import {
  classifySalesTrend,
  classifyStockState,
  computePurchaseSuggestion,
  computeUsableStock,
  resolveReplenishmentPolicy,
} from "@sb/domain";
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

async function asServiceRole<T>(sql: string): Promise<T[]> {
  await client.query("begin");

  try {
    await client.query("set local role service_role");

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
  // Desde D-125, resolve_link_candidate/create_sku_listing_link tambem gravam
  // em sku_listing_link_events -- e os testes de resolve usam asUserPersist DE
  // PROPOSITO (o efeito precisa sobreviver a transacao). Evento persistido e
  // append-only: o trigger recusa DELETE de qualquer papel, e as FKs
  // `restrict` de ml_account_id/sku_id bloqueiam a limpeza de contas e SKUs
  // abaixo. Este afterAll falhou EM SILENCIO desde D-125 (a CI estava
  // vermelha por outros motivos e depois parou -- D-142). O bypass e ato de
  // manutencao do DONO da tabela, so no teardown do teste: o invariante
  // append-only vale para os papeis da aplicacao, e volta a valer na linha
  // seguinte.
  await client.query(
    "alter table public.sku_listing_link_events disable trigger sku_listing_link_events_no_mutation",
  );
  await client.query(`
    delete from public.sku_listing_link_events
    where ml_account_id in (select id from public.ml_accounts where slug like 'rlstest%')
       or sku_id in (select id from public.skus where sku like 'RLSTEST%')
  `);
  await client.query(
    "alter table public.sku_listing_link_events enable trigger sku_listing_link_events_no_mutation",
  );
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
  // SKUs seguem o MESMO precedente documentado abaixo para as organizações:
  // histórico legítimo bloqueia a exclusão, e o resíduo é aceito. Desde que os
  // fluxos de compra (RECEBIMENTO_TRANSITO), ajuste manual e NF-e persistem
  // movimentos de verdade (asUserPersist, de propósito), um SKU de teste com
  // ledger não é apagável — `stock_movements.sku_id` é RESTRICT e o ledger é
  // append-only POR DESENHO. Apagar só o que nada referencia mantém o teardown
  // verde sem desligar a proteção do ledger; o ambiente local acumula até o
  // próximo `supabase db reset --local`, como já acontece com as organizações.
  await client.query(`
    delete from public.skus s
    where s.sku like 'RLSTEST%'
      and not exists (select 1 from public.stock_movements m where m.sku_id = s.id)
      and not exists (select 1 from public.inventory_balances b where b.sku_id = s.id)
      and not exists (select 1 from public.daily_sku_metrics d where d.sku_id = s.id)
      and not exists (select 1 from public.order_items o where o.sku_id = s.id)
      and not exists (select 1 from public.fulfillment_stock_snapshots f where f.sku_id = s.id)
      and not exists (select 1 from public.support_case_links c where c.sku_id = s.id)
      and not exists (select 1 from public.sku_listing_link_events e where e.sku_id = s.id or e.previous_sku_id = s.id)
      and not exists (select 1 from public.sku_cost_history h where h.sku_id = s.id)
  `);

  // Conhecimento antes dos usuários: `created_by`/`confirmed_by` são
  // `on delete restrict` desde 2026-08-28 (D-118) — antes eram SET NULL, e o
  // UPDATE implícito violava `knowledge_entries_validation_coherent` numa
  // linha VALIDADO, derrubando a limpeza inteira e deixando resíduo para a
  // rodada seguinte. Mesma ordem já usada para `sku_components`/`skus`.
  await client.query(`
    delete from public.knowledge_entries
    where created_by in (select id from auth.users where email like '%@rls.test')
       or confirmed_by in (select id from auth.users where email like '%@rls.test')
  `);

  // Usuários: mesma regra. D-099 (2026-08-27) trocou os atores dos ledgers de
  // SET NULL para RESTRICT — desde então, apagar um usuário cujo perfil assina
  // um movimento, um pedido de compra ou um evento é IMPOSSÍVEL por desenho
  // (o cascade auth.users -> profiles esbarra no RESTRICT). Este delete
  // quebrou naquele dia e nunca apareceu: a CI ficou vermelha pelo guarda de
  // GRANTs na mesma data e depois parou por faturamento (D-142). Apaga só
  // quem não assina nada.
  await client.query(`
    delete from auth.users u
    where u.email like '%@rls.test'
      and not exists (select 1 from public.stock_movements m where m.created_by = u.id)
      and not exists (select 1 from public.purchase_orders p where p.created_by = u.id)
      and not exists (select 1 from public.purchase_order_events e where e.actor_user_id = u.id)
      and not exists (select 1 from public.sku_listing_link_events le where le.actor_user_id = u.id)
      and not exists (select 1 from public.support_case_events se where se.actor_user_id = u.id)
      and not exists (select 1 from public.support_reply_attempts ra where ra.requested_by = u.id)
  `);

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
  it("membro autenticado lê exatamente as definições canônicas registradas", async () => {
    // Conjunto EXATO, não contagem: a versão antiga fixava "seis" e quebrou
    // em silêncio... na CI, quando D-157 acrescentou as cinco de 5C — uma
    // contagem só diz QUE mudou, a lista diz O QUE mudou. Toda migration que
    // tocar metric_definitions atualiza esta lista junto (espelho de
    // docs/METRICS.md, como manda D-023).
    const rows = await asUser<{ id: string }>(ADMIN_SB, "select id from public.metric_definitions order by id");

    expect(rows.map((row) => row.id)).toEqual([
      "desconto_vendedor",
      "frete_vendedor",
      "margem_operacional_pedido",
      "pedidos",
      "pedidos_cancelados",
      "pedidos_por_pack",
      "preco_medio_praticado",
      "receita_bruta",
      "skus_distintos_vendidos",
      "taxa_cancelamento",
      "taxa_conversao",
      "taxas_ml",
      "ticket_medio",
      "unidades_vendidas",
      "valor_cancelado",
      "visitas",
    ]);
  });

  /**
   * As duas nasceram em D-170 e sao as PRIMEIRAS com grao de anuncio sem
   * grao de SKU — a fonte e por MLB, e nao ha como somar visitas de anuncios
   * distintos para um SKU sem vinculo completo. O teste guarda essa escolha:
   * se alguem acrescentar 'sku' aqui sem o read model que a sustente, a
   * definicao passa a prometer o que a tela nao tem.
   */
  it("visitas e taxa_conversao: grão de anúncio, sem grão de SKU (D-170)", async () => {
    const rows = await asUser<{ id: string; granularities: string; cancellation_treatment: string }>(
      ADMIN_SB,
      "select id, granularities::text as granularities, cancellation_treatment from public.metric_definitions where id in ('visitas','taxa_conversao') order by id",
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).toBe("taxa_conversao");
    expect(rows[0]?.granularities).toBe("{listing,account,organization}");
    expect(rows[1]?.id).toBe("visitas");
    expect(rows[1]?.granularities).toBe("{listing,account,organization}");
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

describe("métricas diárias de venda", () => {
  const CONTA_A = "aaaa1111-0000-4000-8000-00000000aaaa";
  const CONTA_B = "bbbb2222-0000-4000-8000-00000000bbbb";
  const CONTA_OUTRA = "dddd4444-0000-4000-8000-00000000dddd";
  const ORDER_IDS = [9900001001, 9900001002, 9900001003, 9900001004, 9900001005, 9900001006];
  const ORDER_PENDING_CANCEL = 9900001007;

  let skuA = "";
  let skuB = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts
         (id, organization_id, label, slug, seller_id, status, connected_at)
       values ($1,$2,'Conta de outra organização','rlstest-metrics-outra',333,'CONNECTED',now())
       on conflict do nothing`,
      [CONTA_OUTRA, ORG_OUTRA],
    );

    const skus = await client.query<{ id: string; sku_key: string }>(
      `insert into public.skus (organization_id, sku, kind)
       values ($1,'RLSTEST-METRIC-A','PRODUTO'), ($1,'RLSTEST-METRIC-B','PRODUTO')
       on conflict on constraint skus_org_key_unique do update set sku = excluded.sku
       returning id, sku_key`,
      [ORG_SB],
    );

    skuA = skus.rows.find((row) => row.sku_key === "RLSTEST-METRIC-A")?.id ?? "";
    skuB = skus.rows.find((row) => row.sku_key === "RLSTEST-METRIC-B")?.id ?? "";

    await client.query(
      `insert into public.orders
         (id, organization_id, ml_account_id, pack_id, status, date_created,
          date_last_updated, total_amount, currency_id)
       values
         ($1,$7,$8,770001,'paid','2026-08-20 13:00:00+00','2026-08-20 13:05:00+00',100,'BRL'),
         ($2,$7,$8,770001,'partially_refunded','2026-08-20 13:10:00+00','2026-08-20 13:15:00+00',50,'BRL'),
         -- 01:30 UTC do dia 21 ainda e 22:30 do dia 20 em Sao Paulo.
         ($3,$7,$8,null,'paid','2026-08-21 01:30:00+00','2026-08-21 01:35:00+00',30,'BRL'),
         ($4,$7,$8,null,'cancelled','2026-08-20 15:00:00+00','2026-08-20 15:05:00+00',999,'BRL'),
         ($5,$7,$9,null,'paid','2026-08-20 16:00:00+00','2026-08-20 16:05:00+00',40,'BRL'),
         ($6,$10,$11,null,'paid','2026-08-20 17:00:00+00','2026-08-20 17:05:00+00',20,'BRL')`,
      [...ORDER_IDS, ORG_SB, CONTA_A, CONTA_B, ORG_OUTRA, CONTA_OUTRA],
    );

    // sale_fee entrou com get_sales_expanded_summary (D-157): a taxa do item
    // CANCELADO ($4, fee 99) existe de propósito — prova que taxas_ml só soma
    // vendas válidas.
    await client.query(
      `insert into public.order_items
         (order_id, organization_id, ml_account_id, position, item_id, variation_id,
          title, quantity, unit_price, currency_id, sku_id, sale_fee)
       values
         ($1,$7,$8,0,'MLB900001',null,'Métrica A',2,50,'BRL',$12,10.50),
         ($2,$7,$8,0,'MLB900002','123','Métrica B',1,50,'BRL',$13,5.25),
         ($3,$7,$8,0,'MLB900001',null,'Métrica A',1,30,'BRL',$12,3.25),
         ($4,$7,$8,0,'MLB900001',null,'Cancelado',9,111,'BRL',$12,99),
         ($5,$7,$9,0,'MLB900003',null,'Sem vínculo',1,40,'BRL',null,4.00),
         ($6,$10,$11,0,'MLB900004',null,'Outra organização',1,20,'BRL',null,2.00)`,
      [...ORDER_IDS, ORG_SB, CONTA_A, CONTA_B, ORG_OUTRA, CONTA_OUTRA, skuA, skuB],
    );

    // Custos por pedido (D-166): 1001 e 1002 COBERTOS (frete E desconto
    // observados); 1003 com frete NULO (não observado) fica FORA da margem;
    // 1005 sem captura nenhuma. O cancelado (1004) nunca entra.
    await client.query(
      `insert into public.order_financials (order_id, organization_id, ml_account_id, seller_shipping_cost, seller_discount)
       values ($1,$4,$5,15.00,5.00), ($2,$4,$5,25.00,0.00), ($3,$4,$5,null,3.00)`,
      [ORDER_IDS[0], ORDER_IDS[1], ORDER_IDS[2], ORG_SB, CONTA_A],
    );

    // Pedido pending_cancel (D-157): conta como CANCELADO na taxa — mesma
    // semântica de order.cancelled em @sb/domain. Fora de ORDER_IDS para não
    // deslocar os posicionais do insert principal.
    await client.query(
      `insert into public.orders
         (id, organization_id, ml_account_id, pack_id, status, date_created,
          date_last_updated, total_amount, currency_id)
       values ($1,$2,$3,null,'pending_cancel','2026-08-20 18:00:00+00','2026-08-20 18:05:00+00',60,'BRL')`,
      [ORDER_PENDING_CANCEL, ORG_SB, CONTA_A],
    );

    await client.query(
      `select public.rebuild_daily_sales_metrics($1,$2,'2026-08-20','2026-08-20')
       union all
       select public.rebuild_daily_sales_metrics($1,$3,'2026-08-20','2026-08-20')
       union all
       select public.rebuild_daily_sales_metrics($4,$5,'2026-08-20','2026-08-20')`,
      [ORG_SB, CONTA_A, CONTA_B, ORG_OUTRA, CONTA_OUTRA],
    );
  });

  afterAll(async () => {
    const accounts = [CONTA_A, CONTA_B, CONTA_OUTRA];

    await client.query("delete from public.daily_listing_metrics where ml_account_id = any($1)", [
      accounts,
    ]);
    await client.query("delete from public.daily_sku_metrics where ml_account_id = any($1)", [
      accounts,
    ]);
    await client.query("delete from public.daily_account_metrics where ml_account_id = any($1)", [
      accounts,
    ]);
    await client.query("delete from public.orders where id = any($1)", [
      [...ORDER_IDS, ORDER_PENDING_CANCEL],
    ]);
    await client.query("delete from public.skus where id = any($1)", [[skuA, skuB]]);
    await client.query("delete from public.ml_accounts where id = $1", [CONTA_OUTRA]);
  });

  it("calcula as seis métricas diretamente no grão da conta", async () => {
    const result = await client.query<{
      units_sold: string;
      gross_revenue: string;
      orders_count: string;
      purchases_count: string;
      average_ticket: string;
      average_selling_price: string;
    }>(
      `select units_sold, gross_revenue, orders_count, purchases_count,
              average_ticket, average_selling_price
       from private.compute_daily_sales_metrics($1,'2026-08-20','2026-08-20',$2)
       where metric_grain = 'account'`,
      [ORG_SB, CONTA_A],
    );

    expect(result.rows[0]).toEqual({
      units_sold: "4",
      gross_revenue: "180.00",
      orders_count: "3",
      purchases_count: "2",
      average_ticket: "90.00",
      average_selling_price: "45.00",
    });
  });

  it("conta pack no grão pedido, sem somar contagens dos anúncios", async () => {
    const result = await client.query<{ account_purchases: string; listing_purchases: string }>(
      `with computed as (
         select *
         from private.compute_daily_sales_metrics($1,'2026-08-20','2026-08-20',$2)
       )
       select
         max(purchases_count) filter (where metric_grain = 'account') as account_purchases,
         sum(purchases_count) filter (where metric_grain = 'listing') as listing_purchases
       from computed`,
      [ORG_SB, CONTA_A],
    );

    expect(result.rows[0]).toEqual({ account_purchases: "2", listing_purchases: "3" });
  });

  it("as três tabelas são equivalentes à saída do cálculo compartilhado", async () => {
    const result = await client.query<{ differences: string }>(
      `with computed as (
         select metric_grain, organization_id, ml_account_id, mlb_id, variation_id, sku_id,
                metric_date, units_sold, gross_revenue, orders_count, purchases_count,
                average_ticket, average_selling_price
         from private.compute_daily_sales_metrics($1,'2026-08-20','2026-08-20')
       ),
       persisted as (
         select 'listing'::text as metric_grain, organization_id, ml_account_id,
                mlb_id, variation_id, null::uuid as sku_id, metric_date, units_sold,
                gross_revenue, orders_count, purchases_count, average_ticket,
                average_selling_price
         from public.daily_listing_metrics where organization_id = $1
         union all
         select 'sku'::text, organization_id, ml_account_id, null::text, null::text,
                sku_id, metric_date, units_sold, gross_revenue, orders_count,
                purchases_count, average_ticket, average_selling_price
         from public.daily_sku_metrics where organization_id = $1
         union all
         select 'account'::text, organization_id, ml_account_id, null::text, null::text,
                null::uuid, metric_date, units_sold, gross_revenue, orders_count,
                purchases_count, average_ticket, average_selling_price
         from public.daily_account_metrics where organization_id = $1
       ),
       differences as (
         (select * from computed except all select * from persisted)
         union all
         (select * from persisted except all select * from computed)
       )
       select count(*)::text as differences from differences`,
      [ORG_SB],
    );

    expect(result.rows[0]?.differences).toBe("0");
  });

  it("rebuild completo é idempotente e retorna as linhas materializadas", async () => {
    const first = await client.query<{ rebuilt: number }>(
      `select public.rebuild_daily_sales_metrics($1,$2,'2026-08-20','2026-08-20') as rebuilt`,
      [ORG_SB, CONTA_A],
    );
    const second = await client.query<{ rebuilt: number }>(
      `select public.rebuild_daily_sales_metrics($1,$2,'2026-08-20','2026-08-20') as rebuilt`,
      [ORG_SB, CONTA_A],
    );

    expect(first.rows[0]?.rebuilt).toBe(5);
    expect(second.rows[0]?.rebuilt).toBe(5);

    const counts = await client.query<{ total: string }>(
      `select count(*)::text as total
       from (
         select id from public.daily_listing_metrics where ml_account_id = $1
         union all
         select id from public.daily_sku_metrics where ml_account_id = $1
         union all
         select id from public.daily_account_metrics where ml_account_id = $1
       ) rows`,
      [CONTA_A],
    );

    expect(counts.rows[0]?.total).toBe("5");
  });

  it("incremental apaga projeção obsoleta quando o dia fica sem venda válida", async () => {
    try {
      await client.query(
        `update public.orders set status = 'cancelled' where id = any($1)`,
        [ORDER_IDS.slice(0, 3)],
      );

      const refreshed = await client.query<{ refreshed: number }>(
        `select public.recompute_daily_sales_metrics($1,$2,'2026-08-20') as refreshed`,
        [ORG_SB, CONTA_A],
      );

      expect(refreshed.rows[0]?.refreshed).toBe(0);

      const remaining = await client.query<{ total: string }>(
        `select (
           (select count(*) from public.daily_listing_metrics where ml_account_id = $1) +
           (select count(*) from public.daily_sku_metrics where ml_account_id = $1) +
           (select count(*) from public.daily_account_metrics where ml_account_id = $1)
         )::text as total`,
        [CONTA_A],
      );

      expect(remaining.rows[0]?.total).toBe("0");
    } finally {
      await client.query(
        `update public.orders
         set status = case when id = $2 then 'partially_refunded' else 'paid' end
         where id = any($1)`,
        [ORDER_IDS.slice(0, 3), ORDER_IDS[1]],
      );
      await client.query(
        `select public.recompute_daily_sales_metrics($1,$2,'2026-08-20')`,
        [ORG_SB, CONTA_A],
      );
    }
  });

  it("duas recomputações concorrentes da mesma conta são serializadas", async () => {
    const otherClient = new Client({ connectionString: DB_URL });
    await otherClient.connect();

    try {
      const sql = `select public.recompute_daily_sales_metrics(
        '${ORG_SB}','${CONTA_A}','2026-08-20'
      ) as refreshed`;
      const [first, second] = await Promise.all([
        client.query<{ refreshed: number }>(sql),
        otherClient.query<{ refreshed: number }>(sql),
      ]);

      expect(first.rows[0]?.refreshed).toBe(5);
      expect(second.rows[0]?.refreshed).toBe(5);
    } finally {
      await otherClient.end();
    }
  });

  it("mantém venda sem vínculo no bucket sku_id NULL", async () => {
    const result = await client.query<{ sku_id: string | null; gross_revenue: string }>(
      `select sku_id, gross_revenue
       from public.daily_sku_metrics
       where ml_account_id = $1 and metric_date = '2026-08-20'`,
      [CONTA_B],
    );

    expect(result.rows).toEqual([{ sku_id: null, gross_revenue: "40.00" }]);
  });

  it("NULL participa da unicidade do grão de anúncio e do bucket de SKU", async () => {
    await expect(
      client.query(
        `insert into public.daily_listing_metrics
           (organization_id, ml_account_id, mlb_id, variation_id, metric_date,
            units_sold, gross_revenue, orders_count, purchases_count)
         values ($1,$2,'MLB900001',null,'2026-08-20',1,1,1,1)`,
        [ORG_SB, CONTA_A],
      ),
    ).rejects.toThrow(/daily_listing_metrics_grain_unique/);

    await expect(
      client.query(
        `insert into public.daily_sku_metrics
           (organization_id, ml_account_id, sku_id, metric_date,
            units_sold, gross_revenue, orders_count, purchases_count)
         values ($1,$2,null,'2026-08-20',1,1,1,1)`,
        [ORG_SB, CONTA_B],
      ),
    ).rejects.toThrow(/daily_sku_metrics_grain_unique/);
  });

  describe("RLS", () => {
    it("ANALISTA vê somente os três grãos da conta permitida", async () => {
      const listing = await asUser<{ ml_account_id: string }>(
        ANALISTA_SB,
        "select ml_account_id from public.daily_listing_metrics",
      );
      const sku = await asUser<{ ml_account_id: string }>(
        ANALISTA_SB,
        "select ml_account_id from public.daily_sku_metrics",
      );
      const account = await asUser<{ ml_account_id: string }>(
        ANALISTA_SB,
        "select ml_account_id from public.daily_account_metrics",
      );

      expect(listing).toHaveLength(2);
      expect(sku).toHaveLength(2);
      expect(account).toHaveLength(1);
      expect([...listing, ...sku, ...account].every((row) => row.ml_account_id === CONTA_A)).toBe(
        true,
      );
    });

    it("usuário de outra organização não enxerga métricas da Speed Bikers", async () => {
      const rows = await asUser<{ ml_account_id: string }>(
        DE_OUTRA_ORG,
        "select ml_account_id from public.daily_account_metrics",
      );

      expect(rows).toEqual([{ ml_account_id: CONTA_OUTRA }]);
    });

    it.each(["daily_listing_metrics", "daily_sku_metrics", "daily_account_metrics"])(
      "anon é recusado em %s",
      async (table) => {
        await expect(asAnon(`select * from public.${table}`)).rejects.toThrow(/permission denied/i);
      },
    );

    it("authenticated não escreve nas projeções L3", async () => {
      await expect(
        asUser(
          ADMIN_SB,
          `insert into public.daily_account_metrics
             (organization_id, ml_account_id, metric_date,
              units_sold, gross_revenue, orders_count, purchases_count)
           values ('${ORG_SB}','${CONTA_A}','2026-08-21',1,1,1,1)`,
        ),
      ).rejects.toThrow(/permission denied|row-level security/i);
    });

    it("somente service_role executa as RPCs de materialização", async () => {
      const recomputeSql = `select public.recompute_daily_sales_metrics(
        '${ORG_SB}','${CONTA_A}','2026-08-20'
      ) as refreshed`;

      await expect(asUser(ADMIN_SB, recomputeSql)).rejects.toThrow(/permission denied/i);
      await expect(asAnon(recomputeSql)).rejects.toThrow(/permission denied/i);

      const rows = await asServiceRole<{ refreshed: number }>(recomputeSql);
      expect(rows[0]?.refreshed).toBe(5);
    });
  });

  // get_sales_summary (20260821190000) e get_sales_daily_series
  // (20260821210000, Dashboard de Vendas) nunca tinham teste de integração
  // — reaproveitam este fixture porque é o mesmo formato de dado
  // (organização com duas contas + uma conta de outra organização) que as
  // duas RPCs somam.
  describe("get_sales_summary e get_sales_daily_series", () => {
    it("get_sales_summary soma o grão organização a partir do rollup de conta (CONTA_A + CONTA_B)", async () => {
      const rows = await asUser<{
        units_sold: string;
        gross_revenue: string;
        orders_count: string;
        purchases_count: string;
      }>(
        ADMIN_SB,
        `select units_sold, gross_revenue, orders_count, purchases_count
         from public.get_sales_summary('2026-08-20','2026-08-20')`,
      );

      expect(rows[0]).toEqual({
        units_sold: "5",
        gross_revenue: "220.00",
        orders_count: "4",
        purchases_count: "3",
      });
    });

    it("get_sales_summary filtra por conta quando informado", async () => {
      const rows = await asUser<{ gross_revenue: string }>(
        ADMIN_SB,
        `select gross_revenue from public.get_sales_summary('2026-08-20','2026-08-20','${CONTA_A}')`,
      );

      expect(rows[0]?.gross_revenue).toBe("180.00");
    });

    it("get_sales_daily_series devolve uma linha por dia, sem fabricar dia zerado", async () => {
      const rows = await asUser<{ metric_date: string; gross_revenue: string }>(
        ADMIN_SB,
        // `::text`: o driver pg devolve `date` como objeto Date por padrão;
        // o cast evita comparar Date contra string no teste.
        `select metric_date::text, gross_revenue
         from public.get_sales_daily_series('2026-08-19','2026-08-21')
         order by metric_date`,
      );

      // Só 2026-08-20 tem linha em daily_account_metrics — 19 e 21 ficam
      // ausentes, não aparecem como R$ 0,00 fabricado.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ metric_date: "2026-08-20", gross_revenue: "220.00" });
    });

    it("get_sales_daily_series filtra por conta quando informado", async () => {
      const rows = await asUser<{ metric_date: string; gross_revenue: string }>(
        ADMIN_SB,
        `select metric_date::text, gross_revenue
         from public.get_sales_daily_series('2026-08-20','2026-08-20','${CONTA_A}')`,
      );

      expect(rows).toEqual([{ metric_date: "2026-08-20", gross_revenue: "180.00" }]);
    });

    it("usuário de outra organização só alcança os totais da própria organização", async () => {
      const summary = await asUser<{ gross_revenue: string }>(
        DE_OUTRA_ORG,
        `select gross_revenue from public.get_sales_summary('2026-08-20','2026-08-20')`,
      );
      const series = await asUser<{ gross_revenue: string }>(
        DE_OUTRA_ORG,
        `select gross_revenue from public.get_sales_daily_series('2026-08-20','2026-08-20')`,
      );

      // CONTA_OUTRA (própria organização) tem venda real neste dia — a prova
      // real é que o valor NUNCA é o total da Speed Bikers (220.00).
      expect(summary[0]?.gross_revenue).toBe("20.00");
      expect(series).toEqual([{ gross_revenue: "20.00" }]);
    });

    it("authenticated sem organização não alcança nenhuma linha", async () => {
      const summary = await asUser<{ gross_revenue: string }>(
        SEM_ORG,
        `select gross_revenue from public.get_sales_summary('2026-08-20','2026-08-20')`,
      );
      const series = await asUser(
        SEM_ORG,
        `select * from public.get_sales_daily_series('2026-08-20','2026-08-20')`,
      );

      // Sem linha nenhuma para somar: coalesce cai no literal 0, sem a
      // mesma escala decimal do round() — mesmo valor numérico, não é bug.
      expect(summary[0]?.gross_revenue).toBe("0");
      expect(series).toHaveLength(0);
    });

    it("anon é recusado nas duas RPCs", async () => {
      await expect(
        asAnon(`select * from public.get_sales_summary('2026-08-20','2026-08-20')`),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        asAnon(`select * from public.get_sales_daily_series('2026-08-20','2026-08-20')`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  // get_sales_expanded_summary (20260831114736, D-157) — as métricas 5C que
  // NÃO existem no rollup L3: cancelamento sai de orders direto, e a taxa
  // usa os dois lados da mesma leitura. Reaproveita o fixture acima, que já
  // tinha um pedido cancelado (999) — o pending_cancel e os sale_fee
  // entraram junto com a RPC.
  describe("get_sales_expanded_summary (D-157)", () => {
    const COLS =
      "taxas_ml, pedidos_cancelados, taxa_cancelamento, valor_cancelado, skus_distintos_vendidos";

    it("grão organização: taxa só de vendas válidas, pending_cancel conta como cancelado, bucket sem SKU excluído", async () => {
      const rows = await asUser<{
        taxas_ml: string;
        pedidos_cancelados: string;
        taxa_cancelamento: string;
        valor_cancelado: string;
        skus_distintos_vendidos: string;
      }>(ADMIN_SB, `select ${COLS} from public.get_sales_expanded_summary('2026-08-20','2026-08-20')`);

      expect(rows[0]).toEqual({
        // 10.50 + 5.25 + 3.25 + 4.00 — o fee 99 do pedido CANCELADO fica fora.
        taxas_ml: "23.00",
        // cancelled (999) + pending_cancel (60).
        pedidos_cancelados: "2",
        // 2 cancelados ÷ 6 elegíveis (4 válidos + 2 cancelados).
        taxa_cancelamento: "0.3333",
        valor_cancelado: "1059.00",
        // skuA + skuB — o item da CONTA_B vendeu sem vínculo (bucket nulo, fora).
        skus_distintos_vendidos: "2",
      });
    });

    it("filtra por conta quando informado", async () => {
      const rows = await asUser<{ taxas_ml: string; taxa_cancelamento: string }>(
        ADMIN_SB,
        `select ${COLS} from public.get_sales_expanded_summary('2026-08-20','2026-08-20','${CONTA_A}')`,
      );

      // CONTA_A: fees 10.50+5.25+3.25; 2 cancelados ÷ 5 elegíveis (3 válidos + 2).
      expect(rows[0]).toMatchObject({ taxas_ml: "19.00", taxa_cancelamento: "0.4000" });
    });

    it("usuário de outra organização só alcança a própria — e taxa 0 é 0 de verdade, não null", async () => {
      const rows = await asUser<{
        taxas_ml: string;
        pedidos_cancelados: string;
        taxa_cancelamento: string;
        skus_distintos_vendidos: string;
      }>(DE_OUTRA_ORG, `select ${COLS} from public.get_sales_expanded_summary('2026-08-20','2026-08-20')`);

      expect(rows[0]).toMatchObject({
        taxas_ml: "2.00",
        pedidos_cancelados: "0",
        // 0 cancelados ÷ 1 elegível: zero calculado, não indefinido.
        taxa_cancelamento: "0.0000",
        skus_distintos_vendidos: "0",
      });
    });

    it("sem pedido elegível a taxa é NULL — nunca 0% fingido", async () => {
      const rows = await asUser<{ taxa_cancelamento: string | null; pedidos_cancelados: string }>(
        SEM_ORG,
        `select ${COLS} from public.get_sales_expanded_summary('2026-08-20','2026-08-20')`,
      );

      expect(rows[0]?.pedidos_cancelados).toBe("0");
      expect(rows[0]?.taxa_cancelamento).toBeNull();
    });

    it("anon é recusado", async () => {
      await expect(
        asAnon(`select * from public.get_sales_expanded_summary('2026-08-20','2026-08-20')`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  // get_sales_today_summary (20260831115917, D-158) — a visão "hoje": as
  // MESMAS fórmulas canônicas avaliadas ao vivo sobre orders (L1). O teste
  // do grão organização é uma mini-prova de equivalência L1×L3: os números
  // têm de ser IGUAIS aos que o teste de get_sales_summary lê do rollup
  // sobre este mesmo fixture.
  describe("get_sales_today_summary (D-158)", () => {
    it("grão organização bate com o rollup L3 sobre o mesmo fixture — e o pedido de 01:30 UTC entra no dia civil SP", async () => {
      const rows = await asUser<{
        units_sold: string;
        gross_revenue: string;
        orders_count: string;
        purchases_count: string;
        last_order_at: string;
      }>(
        ADMIN_SB,
        `select units_sold, gross_revenue, orders_count, purchases_count, last_order_at::text
         from public.get_sales_today_summary('2026-08-20')`,
      );

      expect(rows[0]).toEqual({
        units_sold: "5",
        gross_revenue: "220.00",
        orders_count: "4",
        purchases_count: "3",
        // A última venda VÁLIDA do dia civil SP: 01:30 UTC do dia 21 = 22:30
        // do dia 20 em São Paulo. Cancelado/pending_cancel não contam.
        last_order_at: "2026-08-21 01:30:00+00",
      });
    });

    it("filtra por conta quando informado", async () => {
      const rows = await asUser<{ gross_revenue: string; purchases_count: string }>(
        ADMIN_SB,
        `select gross_revenue, purchases_count from public.get_sales_today_summary('2026-08-20','${CONTA_A}')`,
      );

      expect(rows[0]).toEqual({ gross_revenue: "180.00", purchases_count: "2" });
    });

    it("dia sem venda: zeros reais e last_order_at NULL — nunca um horário fingido", async () => {
      const rows = await asUser<{ orders_count: string; last_order_at: string | null }>(
        ADMIN_SB,
        `select orders_count, last_order_at from public.get_sales_today_summary('2019-01-01')`,
      );

      expect(rows[0]?.orders_count).toBe("0");
      expect(rows[0]?.last_order_at).toBeNull();
    });

    it("anon é recusado; authenticated sem organização não soma linha nenhuma", async () => {
      await expect(
        asAnon(`select * from public.get_sales_today_summary('2026-08-20')`),
      ).rejects.toThrow(/permission denied/i);

      const rows = await asUser<{ gross_revenue: string; last_order_at: string | null }>(
        SEM_ORG,
        `select gross_revenue, last_order_at from public.get_sales_today_summary('2026-08-20')`,
      );

      expect(rows[0]?.gross_revenue).toBe("0");
      expect(rows[0]?.last_order_at).toBeNull();
    });
  });

  // get_sales_margin_summary (20260831161834, D-166) — a margem só sobre
  // pedidos COBERTOS (frete E desconto observados), com cobertura declarada.
  describe("get_sales_margin_summary (D-166)", () => {
    const COLS =
      "orders_total, orders_covered, gross_revenue_covered, taxas_ml_covered, frete_vendedor, desconto_vendedor, margem_operacional";

    it("só pedidos cobertos entram — frete NULO exclui, cancelado nunca entra, e receita/taxas saem do MESMO subconjunto", async () => {
      const rows = await asUser<{
        orders_total: string;
        orders_covered: string;
        gross_revenue_covered: string;
        taxas_ml_covered: string;
        frete_vendedor: string;
        desconto_vendedor: string;
        margem_operacional: string;
      }>(ADMIN_SB, `select ${COLS} from public.get_sales_margin_summary('2026-08-20','2026-08-20')`);

      expect(rows[0]).toEqual({
        // 4 válidos na organização; só 1001 e 1002 têm os DOIS custos.
        orders_total: "4",
        orders_covered: "2",
        // Receita e taxas do MESMO subconjunto coberto (100+50; 10.50+5.25).
        gross_revenue_covered: "150.00",
        taxas_ml_covered: "15.75",
        frete_vendedor: "40.00",
        desconto_vendedor: "5.00",
        // 150 − 15.75 − 40 − 5.
        margem_operacional: "89.25",
      });
    });

    it("filtra por conta quando informado", async () => {
      const rows = await asUser<{ orders_total: string; margem_operacional: string }>(
        ADMIN_SB,
        `select ${COLS} from public.get_sales_margin_summary('2026-08-20','2026-08-20','${CONTA_A}')`,
      );

      expect(rows[0]).toMatchObject({ orders_total: "3", margem_operacional: "89.25" });
    });

    it("zero cobertura: TUDO nulo — recusa como contrato, nunca R$ 0,00 fingido", async () => {
      const rows = await asUser<{
        orders_total: string;
        orders_covered: string;
        margem_operacional: string | null;
        frete_vendedor: string | null;
      }>(ADMIN_SB, `select ${COLS} from public.get_sales_margin_summary('2019-01-01','2019-01-01')`);

      expect(rows[0]?.orders_covered).toBe("0");
      expect(rows[0]?.margem_operacional).toBeNull();
      expect(rows[0]?.frete_vendedor).toBeNull();
    });

    it("anon é recusado", async () => {
      await expect(
        asAnon(`select * from public.get_sales_margin_summary('2026-08-20','2026-08-20')`),
      ).rejects.toThrow(/permission denied/i);
    });
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

  // ---------------------------------------------------------------
  // ESCRITA sob RLS. Desde D-125 `authenticated` NAO escreve direto nesta
  // tabela: a policy `for all` foi removida e INSERT/UPDATE/DELETE revogados.
  // Antes disso, qualquer ADMIN/GESTOR/OPERADOR apagava vinculo pelo
  // PostgREST, sem interface e sem auditoria.
  // ---------------------------------------------------------------

  it("ADMIN NAO escreve direto: INSERT, UPDATE e DELETE sao recusados no GRANT", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `insert into public.sku_listing_links
           (organization_id, ml_account_id, sku_id, ref_kind, item_id)
         values ('${ORG_SB}','${CONTA}','${skuId}','ITEM','MLB900000201')`,
      ),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asUser(ADMIN_SB, `update public.sku_listing_links set sku_id = '${skuId}'`),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      asUser(ADMIN_SB, `delete from public.sku_listing_links where item_id = 'MLB900000001'`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("a RPC cria o vinculo E o evento CREATED na mesma transacao", async () => {
    // Este teste NASCEU falhando e nunca rodou numa CI verde (landou com a
    // esteira vermelha por D-130, depois ela parou por faturamento — D-142).
    // A versão original chamava a RPC num CTE e lia os eventos NA MESMA
    // instrução: o snapshot do SELECT externo é estabelecido no início da
    // instrução e não enxerga linhas inseridas por função volátil durante a
    // execução — devolvia [] com a RPC funcionando perfeitamente.
    //
    // A correção é transação explícita com instruções SEPARADAS (o contador
    // de comandos avança entre elas, então a segunda enxerga a primeira) e
    // ROLLBACK no fim — não `asUserPersist`: um evento comitado é
    // append-only e bloquearia para sempre, via FK, a limpeza de
    // `ml_accounts` do afterAll (foi exatamente o que a primeira tentativa
    // desta correção causou na CI seguinte).
    await client.query("begin");
    try {
      await client.query("set local role authenticated");
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: ADMIN_SB }),
      ]);

      const created = await client.query<{ id: string }>(
        `select (public.create_sku_listing_link('${CONTA}', 'MLB900000202', null, '${skuId}')).id`,
      );
      const linkId = created.rows[0]?.id ?? "";

      const rows = await client.query<{ event_type: string; actor_source: string }>(
        `select e.event_type, e.actor_source
         from public.sku_listing_link_events e
         where e.link_id = $1`,
        [linkId],
      );

      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]?.event_type).toBe("CREATED");
      expect(rows.rows[0]?.actor_source).toBe("HUMAN");
    } finally {
      await client.query("rollback");
    }
  });

  it("remover sem motivo e recusado — o motivo fica no historico", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `select public.remove_sku_listing_link(
           (public.create_sku_listing_link('${CONTA}','MLB900000203', null, '${skuId}')).id, '  ')`,
      ),
    ).rejects.toThrow(/motivo obrigatorio/i);
  });

  it("ANALISTA e recusado pela RPC — papel fora de ADMIN/GESTOR/OPERADOR", async () => {
    // Afiado pelo fixture: ANALISTA_SB TEM permissao nesta conta, entao
    // `has_account_access` passa e a recusa isola a dimensao de PAPEL.
    await expect(
      asUser(ANALISTA_SB, `select public.create_sku_listing_link('${CONTA}','MLB900000204', null, '${skuId}')`),
    ).rejects.toThrow(/sem permissao/i);
  });

  it("ADMIN de OUTRA organizacao nao opera vinculo da conta alheia", async () => {
    await expect(
      asUser(DE_OUTRA_ORG, `select public.create_sku_listing_link('${CONTA}','MLB900000205', null, '${skuId}')`),
    ).rejects.toThrow(/sem permissao/i);
  });

  it("sku_listing_link_events e append-only: UPDATE e DELETE sao recusados", async () => {
    await expect(
      asUser(ADMIN_SB, `update public.sku_listing_link_events set reason = 'x'`),
    ).rejects.toThrow(/permission denied|append-only/i);

    await expect(
      asUser(ADMIN_SB, `delete from public.sku_listing_link_events`),
    ).rejects.toThrow(/permission denied|append-only/i);
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
   * só um candidato por linha (`link_candidates_erp_source_row_unique` desde D-163), e testes
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
    ).rejects.toThrow(/link_candidates_erp_source_row_unique/);

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

describe("link_document_item", () => {
  let skuId = "";
  let otherOrgSkuId = "";
  const createdDocumentIds: string[] = [];
  let hashCounter = 0;

  beforeAll(async () => {
    const s = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,'RLSTEST-nfe-item','PRODUTO')
       returning id`,
      [ORG_SB],
    );
    skuId = s.rows[0]?.id ?? "";

    const o = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,'RLSTEST-nfe-item-outra','PRODUTO')
       returning id`,
      [ORG_OUTRA],
    );
    otherOrgSkuId = o.rows[0]?.id ?? "";
  });

  afterAll(async () => {
    // Cascata para document_items — mesmo raciocínio de link_candidates
    // acima, mas aqui a FK já faz o trabalho (`on delete cascade`).
    if (createdDocumentIds.length > 0) {
      await client.query("delete from public.documents where id = any($1)", [createdDocumentIds]);
    }
  });

  /** Cada chamada usa um `content_hash` PRÓPRIO — `documents_hash_unique` exige um por organização. */
  async function insertDocument(
    status: string,
    itemCount = 1,
  ): Promise<{ documentId: string; itemIds: number[] }> {
    hashCounter += 1;
    const hash = String(hashCounter).padStart(4, "0").repeat(16);

    const d = await client.query<{ id: string }>(
      `insert into public.documents
         (organization_id, status, storage_path, file_name, content_hash, total_items, resolved_items)
       values ($1,$2,'nfe/rlstest.xml','rlstest-nfe.xml',$3,$4,0)
       returning id`,
      [ORG_SB, status, hash, itemCount],
    );
    const documentId = d.rows[0]?.id ?? "";
    createdDocumentIds.push(documentId);

    const itemIds: number[] = [];

    for (let position = 0; position < itemCount; position += 1) {
      const r = await client.query<{ id: number }>(
        `insert into public.document_items
           (document_id, position, supplier_code, description, unit, quantity, unit_value, total_value)
         values ($1,$2,'COD-1','Item de teste','UN',1,10,10)
         returning id`,
        [documentId, position],
      );
      itemIds.push(r.rows[0]?.id ?? 0);
    }

    return { documentId, itemIds };
  }

  it("sem permissão (outra organização) é recusado", async () => {
    const { itemIds } = await insertDocument("PARSED");

    await expect(
      asUser(DE_OUTRA_ORG, `select public.link_document_item(${String(itemIds[0])},'${skuId}')`),
    ).rejects.toThrow(/sem permissao/);
  });

  it("anon não tem EXECUTE", async () => {
    const { itemIds } = await insertDocument("PARSED");

    await expect(
      asAnon(`select public.link_document_item(${String(itemIds[0])},'${skuId}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("SKU de outra organização é recusado", async () => {
    const { itemIds } = await insertDocument("PARSED");

    await expect(
      asUser(ADMIN_SB, `select public.link_document_item(${String(itemIds[0])},'${otherOrgSkuId}')`),
    ).rejects.toThrow(/outra organizacao/);
  });

  it("documento fora de conferência (não PARSED) é recusado", async () => {
    const { itemIds } = await insertDocument("APPLYING");

    await expect(
      asUser(ADMIN_SB, `select public.link_document_item(${String(itemIds[0])},'${skuId}')`),
    ).rejects.toThrow(/nao esta em conferencia/);
  });

  it("quem tem permissão vincula: grava sku_id e recalcula documents.resolved_items", async () => {
    const { documentId, itemIds } = await insertDocument("PARSED", 2);

    await asUserPersist(ADMIN_SB, `select public.link_document_item(${String(itemIds[0])},'${skuId}')`);

    const item = await client.query(`select sku_id from public.document_items where id=$1`, [itemIds[0]]);

    expect(item.rows[0]).toMatchObject({ sku_id: skuId });

    // Só 1 dos 2 itens está vinculado — resolved_items reflete exatamente isso,
    // não "todos" nem "zero".
    const doc = await client.query(`select resolved_items from public.documents where id=$1`, [documentId]);

    expect(doc.rows[0]).toMatchObject({ resolved_items: 1 });
  });

  it("p_sku_id omitido desvincula e recalcula resolved_items — mesma função, não duas", async () => {
    const { documentId, itemIds } = await insertDocument("PARSED", 1);

    await asUserPersist(ADMIN_SB, `select public.link_document_item(${String(itemIds[0])},'${skuId}')`);
    await asUserPersist(ADMIN_SB, `select public.link_document_item(${String(itemIds[0])})`);

    const item = await client.query(`select sku_id from public.document_items where id=$1`, [itemIds[0]]);

    expect(item.rows[0]).toMatchObject({ sku_id: null });

    const doc = await client.query(`select resolved_items from public.documents where id=$1`, [documentId]);

    expect(doc.rows[0]).toMatchObject({ resolved_items: 0 });
  });

  it("authenticated não atualiza document_items direto — só pela função", async () => {
    const { itemIds } = await insertDocument("PARSED");

    await expect(
      asUser(ADMIN_SB, `update public.document_items set sku_id='${skuId}' where id=${String(itemIds[0])} returning id`),
    ).rejects.toThrow(/permission denied/i);
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

  it("aceita resource 'questions' — a reconciliação de Perguntas grava aqui (D-089)", async () => {
    // D-087 deixou o CHECK sem 'questions' de propósito: um fetch por ID vindo
    // do webhook não tem janela, contagem nem frescor. A reconciliação tem, e
    // `20260825180000_add_questions_sync_resource.sql` alargou o CHECK.
    const run = await client.query<{ id: string }>(
      `insert into public.sync_runs
         (organization_id, ml_account_id, job_id, resource, channel, status, items_processed, started_at, finished_at)
       values ($1,$2,gen_random_uuid(),'questions','reconciliation','done',7,now(),now())
       returning id`,
      [ORG_SB, CONTA],
    );

    expect(run.rows).toHaveLength(1);

    await expect(
      client.query(
        `insert into public.sync_errors
           (organization_id, ml_account_id, sync_run_id, resource, error_class, message, occurred_at)
         values ($1,$2,$3,'questions','retryable','rlstest 429',now())`,
        [ORG_SB, CONTA, run.rows[0]?.id],
      ),
    ).resolves.toBeDefined();
  });

  it("aceita resource 'messages' — a reconciliação de Mensagens grava aqui", async () => {
    // Mesmo raciocínio de 'questions': o job por conversa é pontual e vive só
    // em `job_runs`; quem ganha linha aqui é a varredura por conta, que tem
    // janela, contagem e frescor. `20260826180000_add_messages_sync_resource.sql`.
    const run = await client.query<{ id: string }>(
      `insert into public.sync_runs
         (organization_id, ml_account_id, job_id, resource, channel, status, items_processed, started_at, finished_at)
       values ($1,$2,gen_random_uuid(),'messages','reconciliation','done',3,now(),now())
       returning id`,
      [ORG_SB, CONTA],
    );

    expect(run.rows).toHaveLength(1);

    await expect(
      client.query(
        `insert into public.sync_errors
           (organization_id, ml_account_id, sync_run_id, resource, error_class, message, occurred_at)
         values ($1,$2,$3,'messages','retryable','rlstest 429',now())`,
        [ORG_SB, CONTA, run.rows[0]?.id],
      ),
    ).resolves.toBeDefined();
  });

  it("resource fora do vocabulário fechado continua recusado", async () => {
    // O CHECK ainda é uma lista fechada — alargar para 'questions' não o
    // transformou em texto livre.
    await expect(
      client.query(
        `insert into public.sync_runs
           (organization_id, ml_account_id, job_id, resource, channel, status, started_at, finished_at)
         values ($1,$2,gen_random_uuid(),'inventado','reconciliation','done',now(),now())`,
        [ORG_SB, CONTA],
      ),
    ).rejects.toThrow(/resource_check/);
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

describe("ledger de estoque", () => {
  // Nome fora do padrão `RLSTEST%` que o afterAll global apaga: uma vez que
  // o SKU tiver stock_movements, `on delete restrict` o torna indeletável —
  // mesmo raciocínio já documentado para a conta de observabilidade de
  // sincronização, acima.
  const SKU_NOME = "STOCKTEST-cabo-freio";
  let skuId = "";

  // Usuário PRÓPRIO, e-mail fora do padrão `%@rls.test` que o afterAll
  // global apaga: `stock_movements.created_by` é `on delete restrict` (a
  // mesma proteção contra a armadilha do `cascade`/`set null` em tabela
  // append-only), então apagar este perfil depois de um AJUSTE_MANUAL
  // falharia — quebrando a limpeza de TODA a suíte, não só desta seção.
  const RESPONSAVEL_AJUSTE = "dddddddd-0000-4000-8000-000000000005";

  async function balanceOf(location: string): Promise<number> {
    const rows = await client.query<{ quantity: string }>(
      `select quantity from public.inventory_balances where sku_id=$1 and location_kind=$2`,
      [skuId, location],
    );

    return rows.rows[0] === undefined ? 0 : Number(rows.rows[0].quantity);
  }

  beforeAll(async () => {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'responsavel@stocktest.local','x',now(),'{"full_name":"Responsavel Stocktest"}',now(),now())
       on conflict (id) do nothing`,
      [RESPONSAVEL_AJUSTE],
    );

    await client.query(
      `insert into public.organization_members (organization_id, user_id, role)
       values ($1,$2,'ADMIN') on conflict do nothing`,
      [ORG_SB, RESPONSAVEL_AJUSTE],
    );

    const sku = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,$2,'PRODUTO') returning id`,
      [ORG_SB, SKU_NOME],
    );
    skuId = sku.rows[0]?.id ?? "";

    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
       values ($1,$2,'LOCAL',100,'ENTRADA_NFE','DOCUMENT','stocktest-doc-inicial','stocktest:entrada-inicial',now())`,
      [ORG_SB, skuId],
    );
  });

  // Sem afterAll de limpeza: append-only por desenho, mesma razão da
  // observabilidade de sincronização acima — o ambiente local acumula até o
  // próximo `supabase db reset --local`.

  it("a linha inicial já aparece na projeção, mantida pela trigger", async () => {
    expect(await balanceOf("LOCAL")).toBe(100);
  });

  it("qty_delta zero é recusado", async () => {
    await expect(
      client.query(
        `insert into public.stock_movements
           (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
         values ($1,$2,'LOCAL',0,'ENTRADA_NFE','stocktest:zero',now())`,
        [ORG_SB, skuId],
      ),
    ).rejects.toThrow(/stock_movements_qty_delta_check/);
  });

  it("movement_type fora do catálogo aprovado é recusado", async () => {
    await expect(
      client.query(
        `insert into public.stock_movements
           (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
         values ($1,$2,'LOCAL',1,'TIPO_INVENTADO','stocktest:tipo-invalido',now())`,
        [ORG_SB, skuId],
      ),
    ).rejects.toThrow(/stock_movements_movement_type_check/);
  });

  it("location_kind fora dos três estados observados é recusado — Full não é ledger (D-018)", async () => {
    await expect(
      client.query(
        `insert into public.stock_movements
           (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
         values ($1,$2,'FULL',1,'ENTRADA_NFE','stocktest:full-recusado',now())`,
        [ORG_SB, skuId],
      ),
    ).rejects.toThrow(/stock_movements_location_kind_check/);
  });

  it("AJUSTE_MANUAL sem created_by é recusado", async () => {
    await expect(
      client.query(
        `insert into public.stock_movements
           (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
         values ($1,$2,'LOCAL',1,'AJUSTE_MANUAL','stocktest:sem-responsavel',now())`,
        [ORG_SB, skuId],
      ),
    ).rejects.toThrow(/stock_movements_manual_has_creator/);
  });

  it("é append-only: nem um UPDATE direto do dono passa", async () => {
    await expect(
      client.query(`update public.stock_movements set qty_delta = 999 where sku_id = $1`, [skuId]),
    ).rejects.toThrow(/append-only/);
  });

  it("é append-only: nem um DELETE direto do dono passa", async () => {
    await expect(
      client.query(`delete from public.stock_movements where sku_id = $1`, [skuId]),
    ).rejects.toThrow(/append-only/);
  });

  it("idempotency_key repetida: rode duas vezes, um efeito só (docs/TESTING.md regra 1)", async () => {
    const key = "stocktest:idempotencia";

    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, reason, created_by, idempotency_key, occurred_at)
       values ($1,$2,'LOCAL',10,'AJUSTE_MANUAL','teste de idempotencia',$3,$4,now())`,
      [ORG_SB, skuId, RESPONSAVEL_AJUSTE, key],
    );

    const before = await balanceOf("LOCAL");

    await expect(
      client.query(
        `insert into public.stock_movements
           (organization_id, sku_id, location_kind, qty_delta, movement_type, reason, created_by, idempotency_key, occurred_at)
         values ($1,$2,'LOCAL',10,'AJUSTE_MANUAL','teste de idempotencia',$3,$4,now())`,
        [ORG_SB, skuId, RESPONSAVEL_AJUSTE, key],
      ),
    ).rejects.toThrow(/idempotency_key/);

    expect(await balanceOf("LOCAL")).toBe(before);
  });

  it("a trigger mantém a projeção consistente com o delta de novos movimentos", async () => {
    const before = await balanceOf("LOCAL");

    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
       values ($1,$2,'LOCAL',25,'ENTRADA_NFE','stocktest:trigger-entrada',now())`,
      [ORG_SB, skuId],
    );
    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
       values ($1,$2,'LOCAL',-5,'SAIDA_NFE','stocktest:trigger-saida',now())`,
      [ORG_SB, skuId],
    );

    expect(await balanceOf("LOCAL")).toBe(before + 20);
  });

  it("location_kind diferentes não se misturam na projeção", async () => {
    const localBefore = await balanceOf("LOCAL");

    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
       values ($1,$2,'TRANSITO',7,'ENTRADA_TRANSITO','stocktest:transito-entrada',now())`,
      [ORG_SB, skuId],
    );

    expect(await balanceOf("TRANSITO")).toBe(7);
    expect(await balanceOf("LOCAL")).toBe(localBefore);
  });

  it("compute_inventory_balances_from_ledger (job de conferência) bate com a projeção mantida por trigger", async () => {
    const recomputed = await asServiceRole<{ sku_id: string; location_kind: string; quantity: string }>(
      `select sku_id, location_kind, quantity
       from public.compute_inventory_balances_from_ledger('${ORG_SB}', '${skuId}')`,
    );

    const projected = await client.query<{ location_kind: string; quantity: string }>(
      `select location_kind, quantity from public.inventory_balances where sku_id=$1`,
      [skuId],
    );

    expect(recomputed.length).toBe(projected.rows.length);

    for (const row of projected.rows) {
      const match = recomputed.find((r) => r.location_kind === row.location_kind);

      expect(match?.quantity).toBe(row.quantity);
    }
  });

  it("authenticated não executa a função de conferência — só service_role", async () => {
    await expect(
      asUser(ADMIN_SB, `select * from public.compute_inventory_balances_from_ledger('${ORG_SB}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  describe("RLS", () => {
    it("membro da organização enxerga stock_movements e inventory_balances", async () => {
      const movements = await asUser(
        ANALISTA_SB,
        `select id from public.stock_movements where sku_id='${skuId}'`,
      );
      const balances = await asUser(
        ANALISTA_SB,
        `select id from public.inventory_balances where sku_id='${skuId}'`,
      );

      expect(movements.length).toBeGreaterThan(0);
      expect(balances.length).toBeGreaterThan(0);
    });

    it("usuário de outra organização não enxerga nada", async () => {
      const movements = await asUser(
        DE_OUTRA_ORG,
        `select id from public.stock_movements where sku_id='${skuId}'`,
      );
      const balances = await asUser(
        DE_OUTRA_ORG,
        `select id from public.inventory_balances where sku_id='${skuId}'`,
      );

      expect(movements).toHaveLength(0);
      expect(balances).toHaveLength(0);
    });

    it("anon é recusado nas duas tabelas", async () => {
      await expect(asAnon("select * from public.stock_movements")).rejects.toThrow(
        /permission denied/i,
      );
      await expect(asAnon("select * from public.inventory_balances")).rejects.toThrow(
        /permission denied/i,
      );
    });

    it("authenticated não escreve — só service_role registra movimento", async () => {
      await expect(
        asUser(
          ADMIN_SB,
          `insert into public.stock_movements
             (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
           values ('${ORG_SB}','${skuId}','LOCAL',1,'ENTRADA_NFE','stocktest:authenticated-bloqueado',now())`,
        ),
      ).rejects.toThrow(/permission denied|row-level security/i);
    });

    it("service_role registra movimento (prova positiva do GRANT)", async () => {
      await expect(
        asServiceRole(
          `insert into public.stock_movements
             (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
           values ('${ORG_SB}','${skuId}','LOCAL',1,'ENTRADA_NFE','stocktest:service-role-grava',now())`,
        ),
      ).resolves.toBeDefined();
    });

    it("authenticated não atualiza inventory_balances diretamente — só a trigger escreve", async () => {
      await expect(
        asUser(ADMIN_SB, `update public.inventory_balances set quantity=9999 where sku_id='${skuId}'`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("create_manual_stock_adjustment", () => {
    it("anon não executa", async () => {
      await expect(
        asAnon(`select * from public.create_manual_stock_adjustment('${ORG_SB}','${skuId}','LOCAL',1,'teste')`),
      ).rejects.toThrow(/permission denied/i);
    });

    it("ANALISTA (autenticado, sem ADMIN/GESTOR) é recusado", async () => {
      await expect(
        asUser(
          ANALISTA_SB,
          `select * from public.create_manual_stock_adjustment('${ORG_SB}','${skuId}','LOCAL',1,'teste')`,
        ),
      ).rejects.toThrow(/sem permissao/);
    });

    it("recusa SKU de outra organização", async () => {
      const other = await client.query<{ id: string }>(
        `insert into public.skus (organization_id, sku, kind) values ($1,'STOCKTEST-outra-org','PRODUTO') returning id`,
        [ORG_OUTRA],
      );
      const otherSkuId = other.rows[0]?.id ?? "";

      await expect(
        asUser(
          RESPONSAVEL_AJUSTE,
          `select * from public.create_manual_stock_adjustment('${ORG_SB}','${otherSkuId}','LOCAL',1,'teste')`,
        ),
      ).rejects.toThrow(/outra organizacao/);
    });

    it("recusa sem motivo", async () => {
      await expect(
        asUser(
          RESPONSAVEL_AJUSTE,
          `select * from public.create_manual_stock_adjustment('${ORG_SB}','${skuId}','LOCAL',1,'')`,
        ),
      ).rejects.toThrow(/exige um motivo/);
    });

    it("ADMIN registra o ajuste, grava reason e created_by, e a projeção reflete o delta", async () => {
      const before = await balanceOf("LOCAL");

      const adjustment = await asUserPersist<{ qty_delta: string; reason: string; created_by: string }>(
        RESPONSAVEL_AJUSTE,
        `select * from public.create_manual_stock_adjustment('${ORG_SB}','${skuId}','LOCAL',3,'contagem fisica divergente')`,
      );

      expect(adjustment[0]).toMatchObject({
        qty_delta: "3.000",
        reason: "contagem fisica divergente",
        created_by: RESPONSAVEL_AJUSTE,
      });
      expect(await balanceOf("LOCAL")).toBe(before + 3);
    });
  });
});

describe("reconciliação de estoque contra o UpSeller (D-029, D-054)", () => {
  const SKU_NOME = "RLSTEST-reconciliacao-cabo";
  let skuId = "";

  beforeAll(async () => {
    const sku = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,$2,'PRODUTO') returning id`,
      [ORG_SB, SKU_NOME],
    );
    skuId = sku.rows[0]?.id ?? "";

    // DOIS lotes distintos (`erp_stock_snapshots_unique_per_batch` é
    // `(batch_id, sku_key, warehouse)` — não inclui `captured_at`), mesmo
    // sku/warehouse, valores diferentes: simula duas reimportações reais da
    // planilha em momentos diferentes. Prova que a função pega o snapshot do
    // lote MAIS RECENTE, não soma nem pega o mais antigo.
    const oldBatch = await client.query<{ id: string }>(
      `insert into public.erp_import_batches (organization_id, kind, storage_path, content_hash, file_name)
       values ($1,'STOCK','erp-imports/2026-08/reconciliacao-antigo.xlsx',$2,'rlstest-reconciliacao-antigo.xlsx')
       returning id`,
      [ORG_SB, "e".repeat(64)],
    );

    await client.query(
      `insert into public.erp_stock_snapshots
         (organization_id, batch_id, sku_key, sku_id, warehouse, on_hand, available, reserved, captured_at)
       values ($1,$2,$3,$4,'ESTOQUE LOJA',100,90,10,now() - interval '2 days')`,
      [ORG_SB, oldBatch.rows[0]?.id ?? "", SKU_NOME.toUpperCase(), skuId],
    );

    const newBatch = await client.query<{ id: string }>(
      `insert into public.erp_import_batches (organization_id, kind, storage_path, content_hash, file_name)
       values ($1,'STOCK','erp-imports/2026-08/reconciliacao-novo.xlsx',$2,'rlstest-reconciliacao-novo.xlsx')
       returning id`,
      [ORG_SB, "f".repeat(64)],
    );

    await client.query(
      `insert into public.erp_stock_snapshots
         (organization_id, batch_id, sku_key, sku_id, warehouse, on_hand, available, reserved, captured_at)
       values ($1,$2,$3,$4,'ESTOQUE LOJA',60,50,10,now())`,
      [ORG_SB, newBatch.rows[0]?.id ?? "", SKU_NOME.toUpperCase(), skuId],
    );
  });

  it("anon não executa compute_erp_target_balances", async () => {
    await expect(
      asAnon(`select * from public.compute_erp_target_balances('${ORG_SB}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("authenticated não executa — só service_role, mesmo sendo ADMIN da organização", async () => {
    await expect(
      asUser(ADMIN_SB, `select * from public.compute_erp_target_balances('${ORG_SB}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("service_role traz o snapshot MAIS RECENTE por SKU, decomposto em LOCAL/RESERVADO", async () => {
    const rows = await client.query<{ sku_id: string; location_kind: string; quantity: string }>(
      `select sku_id, location_kind, quantity from public.compute_erp_target_balances('${ORG_SB}')
       where sku_id = '${skuId}' order by location_kind`,
    );

    // `numeric` chega como string via `pg` (node-postgres não trunca casas
    // decimais, ao contrário do PostgREST/produção) — Number() para comparar,
    // mesmo padrão de `balanceOf` no describe "ledger de estoque" acima.
    const parsed = rows.rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));

    expect(parsed).toEqual([
      { sku_id: skuId, location_kind: "LOCAL", quantity: 50 },
      { sku_id: skuId, location_kind: "RESERVADO", quantity: 10 },
    ]);
  });

  // D-132: o alvo é o snapshot ROLADO PARA A FRENTE. Sem isto a reconciliação
  // forçava `saldo := snapshot` e apagava a venda de cada dia enquanto
  // ninguém reimportasse a planilha do UpSeller — medido em produção, com o
  // ajuste do dia N sendo exatamente o oposto da venda do dia N-1.
  it("movimento POSTERIOR à captura entra no alvo — o retrato do ERP não apaga venda nossa (D-132)", async () => {
    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
       values ($1,$2,'LOCAL',-3,'VENDA_ML',$3, now() + interval '1 minute')`,
      [ORG_SB, skuId, `d132-venda:${skuId}`],
    );

    // E o ajuste da própria reconciliação NÃO entra: incluí-lo faria o alvo
    // perseguir o próprio rastro, que é o defeito circular que D-132 evita.
    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at)
       values ($1,$2,'LOCAL',999,'AJUSTE_RECONCILIACAO',$3, now() + interval '2 minutes')`,
      [ORG_SB, skuId, `d132-ajuste:${skuId}`],
    );

    const rows = await client.query<{ location_kind: string; quantity: string }>(
      `select location_kind, quantity from public.compute_erp_target_balances('${ORG_SB}')
       where sku_id = '${skuId}' order by location_kind`,
    );

    const parsed = rows.rows.map((r) => ({ ...r, quantity: Number(r.quantity) }));

    expect(parsed).toEqual([
      { location_kind: "LOCAL", quantity: 47 },
      { location_kind: "RESERVADO", quantity: 10 },
    ]);
  });

  describe("domain_events com ml_account_id nulo (D-054)", () => {
    let eventId = "";

    beforeAll(async () => {
      const event = await client.query<{ id: string }>(
        `insert into public.domain_events
           (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
         values ($1, null, now(), 'stock.balance.diverged', 'sku', $2, 'critico', 'system', $3)
         returning id`,
        [ORG_SB, skuId, `rlstest:stock.balance.diverged:${skuId}`],
      );
      eventId = event.rows[0]?.id ?? "";
    });

    it("qualquer membro da organização vê, mesmo sem has_account_access nenhum", async () => {
      const rows = await asUser(ANALISTA_SB, `select id from public.domain_events where id='${eventId}'`);

      expect(rows.map((r) => (r as { id: string }).id)).toContain(eventId);
    });

    it("usuário de outra organização não vê", async () => {
      const rows = await asUser(DE_OUTRA_ORG, `select id from public.domain_events where id='${eventId}'`);

      expect(rows).toHaveLength(0);
    });

    it("anon não vê", async () => {
      await expect(asAnon("select * from public.domain_events")).rejects.toThrow(/permission denied/i);
    });

    it("authenticated não insere direto — só service_role registra evento", async () => {
      await expect(
        asUser(
          ADMIN_SB,
          `insert into public.domain_events
             (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
           values ('${ORG_SB}', null, now(), 'stock.balance.diverged', 'sku', '${skuId}', 'critico', 'system', 'rlstest:hack')`,
        ),
      ).rejects.toThrow(/permission denied|row-level security/i);
    });
  });
});

describe("pedidos de compra (fornecedores, ciclo, histórico por evento)", () => {
  const ITEMS = `'[{"skuId":null,"skuSnapshot":"RLSTEST-compras-item","titleSnapshot":"Item de teste","quantityOrdered":10,"unitCost":5.5}]'::jsonb`;

  // Usuário PRÓPRIO, e-mail fora do padrão `%@rls.test` que o afterAll
  // global apaga: uma vez que ele tiver um purchase_orders no created_by
  // (`on delete restrict`), fica permanentemente indeletável — e o próprio
  // purchase_orders nunca sai, porque cascateia para purchase_order_events
  // (L2 append-only, DELETE sempre rejeitado pelo trigger). Reusar ADMIN_SB
  // quebraria a limpeza global das outras suítes deste arquivo — mesmo
  // raciocínio já documentado para a conta de observabilidade de
  // sincronização e para o SKU do ledger de estoque, acima.
  const ADMIN_COMPRAS = "dddd1111-0000-4000-8000-000000000011";

  beforeAll(async () => {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'admin@comprastest.internal','x',now(),'{"full_name":"Admin de compras"}',now(),now())
       on conflict (id) do nothing`,
      [ADMIN_COMPRAS],
    );

    await client.query(
      `insert into public.organization_members (organization_id, user_id, role)
       values ($1,$2,'ADMIN') on conflict do nothing`,
      [ORG_SB, ADMIN_COMPRAS],
    );
  });

  // Sem afterAll de limpeza: pedido de compra aprovado tem
  // purchase_order_events (append-only), então nem ele nem o fornecedor
  // referenciado (`on delete restrict`) saem — mesmo raciocínio de
  // sync_runs/stock_movements acima. As linhas de teste ficam, como
  // ficariam em produção; o ambiente local é recriado por
  // `supabase db reset` quando isso importar.

  it("anon não vê suppliers/purchase_orders/purchase_order_items/purchase_order_events", async () => {
    await expect(asAnon("select * from public.suppliers")).rejects.toThrow(/permission denied/i);
    await expect(asAnon("select * from public.purchase_orders")).rejects.toThrow(/permission denied/i);
    await expect(asAnon("select * from public.purchase_order_items")).rejects.toThrow(/permission denied/i);
    await expect(asAnon("select * from public.purchase_order_events")).rejects.toThrow(/permission denied/i);
  });

  it("anon não executa nenhuma das RPCs de escrita", async () => {
    await expect(
      asAnon(`select * from public.create_supplier('${ORG_SB}','RLSTEST anon fornecedor')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("ANALISTA (autenticado, sem ADMIN/GESTOR) é recusado ao criar fornecedor", async () => {
    await expect(
      asUser(ANALISTA_SB, `select * from public.create_supplier('${ORG_SB}','RLSTEST analista fornecedor')`),
    ).rejects.toThrow(/sem permissao/);
  });

  it("ANALISTA é recusado ao criar pedido de compra", async () => {
    await expect(
      asUser(ANALISTA_SB, `select * from public.create_purchase_order('${ORG_SB}',${ITEMS})`),
    ).rejects.toThrow(/sem permissao/);
  });

  it("create_purchase_order recusa fornecedor de outra organização", async () => {
    const other = await client.query<{ id: string }>(
      `insert into public.suppliers (organization_id, name) values ($1,'RLSTEST fornecedor outra org') returning id`,
      [ORG_OUTRA],
    );
    const otherSupplierId = other.rows[0]?.id ?? "";

    await expect(
      asUser(ADMIN_SB, `select * from public.create_purchase_order('${ORG_SB}',${ITEMS},'${otherSupplierId}')`),
    ).rejects.toThrow(/outra organizacao/);
  });

  it("create_purchase_order recusa pedido sem nenhum item", async () => {
    await expect(
      asUser(ADMIN_SB, `select * from public.create_purchase_order('${ORG_SB}','[]'::jsonb)`),
    ).rejects.toThrow(/ao menos um item/);
  });

  it("ADMIN percorre o ciclo completo: criar -> aprovar -> marcar como enviado -> receber, com histórico por evento", async () => {
    const supplier = await asUserPersist<{ id: string }>(
      ADMIN_COMPRAS,
      `select * from public.create_supplier('${ORG_SB}','RLSTEST fornecedor ciclo completo')`,
    );
    const supplierId = supplier[0]?.id ?? "";

    const order = await asUserPersist<{ id: string; status: string }>(
      ADMIN_COMPRAS,
      `select * from public.create_purchase_order('${ORG_SB}',${ITEMS},'${supplierId}')`,
    );
    const orderId = order[0]?.id ?? "";

    expect(order[0]?.status).toBe("DRAFT");

    const approved = await asUserPersist<{ status: string }>(
      ADMIN_COMPRAS,
      `select * from public.approve_purchase_order('${orderId}')`,
    );
    expect(approved[0]?.status).toBe("APPROVED");

    const ordered = await asUserPersist<{ status: string }>(
      ADMIN_COMPRAS,
      `select * from public.mark_purchase_order_ordered('${orderId}')`,
    );
    expect(ordered[0]?.status).toBe("ORDERED");

    const received = await asUserPersist<{ status: string }>(
      ADMIN_COMPRAS,
      `select * from public.receive_purchase_order('${orderId}')`,
    );
    expect(received[0]?.status).toBe("RECEIVED");

    const events = await client.query<{ event_type: string }>(
      `select event_type from public.purchase_order_events where purchase_order_id=$1 order by occurred_at`,
      [orderId],
    );
    expect(events.rows.map((r) => r.event_type)).toEqual(["CREATED", "APPROVED", "ORDERED", "RECEIVED"]);
  });

  it("aprovar um pedido que não está em rascunho é recusado", async () => {
    const order = await asUserPersist<{ id: string }>(
      ADMIN_COMPRAS,
      `select * from public.create_purchase_order('${ORG_SB}',${ITEMS})`,
    );
    const orderId = order[0]?.id ?? "";

    await asUserPersist(ADMIN_COMPRAS, `select * from public.approve_purchase_order('${orderId}')`);

    await expect(
      asUserPersist(ADMIN_COMPRAS, `select * from public.approve_purchase_order('${orderId}')`),
    ).rejects.toThrow(/nao esta em rascunho/);
  });

  it("cancelar um pedido já recebido (estado terminal) é recusado", async () => {
    const order = await asUserPersist<{ id: string }>(
      ADMIN_COMPRAS,
      `select * from public.create_purchase_order('${ORG_SB}',${ITEMS})`,
    );
    const orderId = order[0]?.id ?? "";

    await asUserPersist(ADMIN_COMPRAS, `select * from public.approve_purchase_order('${orderId}')`);
    await asUserPersist(ADMIN_COMPRAS, `select * from public.mark_purchase_order_ordered('${orderId}')`);
    await asUserPersist(ADMIN_COMPRAS, `select * from public.receive_purchase_order('${orderId}')`);

    await expect(
      asUserPersist(ADMIN_COMPRAS, `select * from public.cancel_purchase_order('${orderId}','motivo qualquer')`),
    ).rejects.toThrow(/estado terminal/);
  });

  it("cancelar um rascunho funciona e grava o motivo no evento", async () => {
    const order = await asUserPersist<{ id: string }>(
      ADMIN_COMPRAS,
      `select * from public.create_purchase_order('${ORG_SB}',${ITEMS})`,
    );
    const orderId = order[0]?.id ?? "";

    const cancelled = await asUserPersist<{ status: string; cancel_reason: string }>(
      ADMIN_COMPRAS,
      `select * from public.cancel_purchase_order('${orderId}','RLSTEST motivo do cancelamento')`,
    );

    expect(cancelled[0]).toMatchObject({ status: "CANCELLED", cancel_reason: "RLSTEST motivo do cancelamento" });

    const event = await client.query<{ metadata: { reason?: string } }>(
      `select metadata from public.purchase_order_events where purchase_order_id=$1 and event_type='CANCELLED'`,
      [orderId],
    );
    expect(event.rows[0]?.metadata).toEqual({ reason: "RLSTEST motivo do cancelamento" });
  });

  it("usuário de outra organização não vê o fornecedor nem o pedido criados", async () => {
    const supplier = await asUserPersist<{ id: string }>(
      ADMIN_COMPRAS,
      `select * from public.create_supplier('${ORG_SB}','RLSTEST fornecedor isolamento')`,
    );
    const supplierId = supplier[0]?.id ?? "";

    const rows = await asUser(DE_OUTRA_ORG, `select id from public.suppliers where id='${supplierId}'`);

    expect(rows).toHaveLength(0);
  });
});

describe("estoque em trânsito a partir do ciclo do pedido de compra (D-055)", () => {
  // Nome fora do padrão `RLSTEST%` que o afterAll global apaga: uma vez que
  // o SKU tiver stock_movements, `on delete restrict` o torna indeletável —
  // mesmo raciocínio já documentado para o SKU do ledger de estoque, acima.
  const SKU_NOME = "COMPRASTEST-parafuso";
  let skuId = "";

  // Usuário PRÓPRIO, mesma razão do describe de pedidos de compra acima:
  // uma vez com purchase_orders no created_by, fica permanentemente
  // indeletável — reusar ADMIN_SB quebraria a limpeza global.
  const ADMIN_TRANSITO = "dddd2222-0000-4000-8000-000000000022";

  async function balanceOf(location: string): Promise<number> {
    const rows = await client.query<{ quantity: string }>(
      `select quantity from public.inventory_balances where sku_id=$1 and location_kind=$2`,
      [skuId, location],
    );

    return rows.rows[0] === undefined ? 0 : Number(rows.rows[0].quantity);
  }

  async function movementCount(orderId: string): Promise<number> {
    const rows = await client.query<{ count: string }>(
      `select count(*)::text as count from public.stock_movements where source_type='PURCHASE_ORDER' and source_id=$1`,
      [orderId],
    );

    return Number(rows.rows[0]?.count ?? "0");
  }

  beforeAll(async () => {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'admin@transitotest.internal','x',now(),'{"full_name":"Admin de transito"}',now(),now())
       on conflict (id) do nothing`,
      [ADMIN_TRANSITO],
    );

    await client.query(
      `insert into public.organization_members (organization_id, user_id, role)
       values ($1,$2,'ADMIN') on conflict do nothing`,
      [ORG_SB, ADMIN_TRANSITO],
    );

    const sku = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,$2,'PRODUTO') returning id`,
      [ORG_SB, SKU_NOME],
    );
    skuId = sku.rows[0]?.id ?? "";
  });

  // Sem afterAll de limpeza: mesma razão do ledger de estoque acima — uma
  // vez que o SKU/pedido tiver stock_movements, ficam permanentemente
  // indeletáveis por desenho. O ambiente local acumula até o próximo
  // `supabase db reset --local`.

  it("ORDERED gera ENTRADA_TRANSITO com a quantidade pedida, sem tocar LOCAL", async () => {
    const localBefore = await balanceOf("LOCAL");
    const transitoBefore = await balanceOf("TRANSITO");

    const items = `'[{"skuId":"${skuId}","skuSnapshot":"${SKU_NOME}","titleSnapshot":"Parafuso","quantityOrdered":10,"unitCost":2.5}]'::jsonb`;

    const order = await asUserPersist<{ id: string }>(
      ADMIN_TRANSITO,
      `select * from public.create_purchase_order('${ORG_SB}',${items})`,
    );
    const orderId = order[0]?.id ?? "";

    await asUserPersist(ADMIN_TRANSITO, `select * from public.approve_purchase_order('${orderId}')`);
    await asUserPersist(ADMIN_TRANSITO, `select * from public.mark_purchase_order_ordered('${orderId}')`);

    expect(await balanceOf("TRANSITO")).toBe(transitoBefore + 10);
    expect(await balanceOf("LOCAL")).toBe(localBefore);

    const movement = await client.query<{ movement_type: string; qty_delta: string }>(
      `select movement_type, qty_delta from public.stock_movements where source_type='PURCHASE_ORDER' and source_id=$1`,
      [orderId],
    );
    expect(movement.rows).toHaveLength(1);
    expect(movement.rows[0]?.movement_type).toBe("ENTRADA_TRANSITO");
    expect(Number(movement.rows[0]?.qty_delta)).toBe(10);
  });

  it("RECEIVED fecha o TRANSITO com RECEBIMENTO_TRANSITO, sem gerar LOCAL — isso é responsabilidade da NF-e", async () => {
    const items = `'[{"skuId":"${skuId}","skuSnapshot":"${SKU_NOME}","titleSnapshot":"Parafuso","quantityOrdered":4,"unitCost":2.5}]'::jsonb`;

    const order = await asUserPersist<{ id: string }>(
      ADMIN_TRANSITO,
      `select * from public.create_purchase_order('${ORG_SB}',${items})`,
    );
    const orderId = order[0]?.id ?? "";

    await asUserPersist(ADMIN_TRANSITO, `select * from public.approve_purchase_order('${orderId}')`);
    await asUserPersist(ADMIN_TRANSITO, `select * from public.mark_purchase_order_ordered('${orderId}')`);

    const transitoAfterOrdered = await balanceOf("TRANSITO");
    const localBefore = await balanceOf("LOCAL");

    await asUserPersist(ADMIN_TRANSITO, `select * from public.receive_purchase_order('${orderId}')`);

    expect(await balanceOf("TRANSITO")).toBe(transitoAfterOrdered - 4);
    expect(await balanceOf("LOCAL")).toBe(localBefore);
    expect(await movementCount(orderId)).toBe(2);

    const received = await client.query<{ movement_type: string; qty_delta: string }>(
      `select movement_type, qty_delta from public.stock_movements
       where source_type='PURCHASE_ORDER' and source_id=$1 and movement_type='RECEBIMENTO_TRANSITO'`,
      [orderId],
    );
    expect(Number(received.rows[0]?.qty_delta)).toBe(-4);
  });

  it("cancelar um pedido ORDERED fecha o TRANSITO aberto", async () => {
    const items = `'[{"skuId":"${skuId}","skuSnapshot":"${SKU_NOME}","titleSnapshot":"Parafuso","quantityOrdered":6,"unitCost":2.5}]'::jsonb`;

    const order = await asUserPersist<{ id: string }>(
      ADMIN_TRANSITO,
      `select * from public.create_purchase_order('${ORG_SB}',${items})`,
    );
    const orderId = order[0]?.id ?? "";

    await asUserPersist(ADMIN_TRANSITO, `select * from public.approve_purchase_order('${orderId}')`);
    await asUserPersist(ADMIN_TRANSITO, `select * from public.mark_purchase_order_ordered('${orderId}')`);

    const transitoAfterOrdered = await balanceOf("TRANSITO");

    await asUserPersist(ADMIN_TRANSITO, `select * from public.cancel_purchase_order('${orderId}','trânsito cancelado')`);

    expect(await balanceOf("TRANSITO")).toBe(transitoAfterOrdered - 6);
    expect(await movementCount(orderId)).toBe(2);
  });

  it("cancelar um pedido em DRAFT não gera nenhum stock_movements — TRANSITO nunca abriu", async () => {
    const items = `'[{"skuId":"${skuId}","skuSnapshot":"${SKU_NOME}","titleSnapshot":"Parafuso","quantityOrdered":3,"unitCost":2.5}]'::jsonb`;

    const order = await asUserPersist<{ id: string }>(
      ADMIN_TRANSITO,
      `select * from public.create_purchase_order('${ORG_SB}',${items})`,
    );
    const orderId = order[0]?.id ?? "";

    await asUserPersist(ADMIN_TRANSITO, `select * from public.cancel_purchase_order('${orderId}','cancelado ainda em rascunho')`);

    expect(await movementCount(orderId)).toBe(0);
  });

  it("item sem SKU vinculado não gera stock_movements — resolve sozinho quando o vínculo nascer", async () => {
    const items = `'[{"skuId":null,"skuSnapshot":"COMPRASTEST-sem-vinculo","titleSnapshot":"Sem vinculo","quantityOrdered":5,"unitCost":1}]'::jsonb`;

    const order = await asUserPersist<{ id: string }>(
      ADMIN_TRANSITO,
      `select * from public.create_purchase_order('${ORG_SB}',${items})`,
    );
    const orderId = order[0]?.id ?? "";

    await asUserPersist(ADMIN_TRANSITO, `select * from public.approve_purchase_order('${orderId}')`);
    await asUserPersist(ADMIN_TRANSITO, `select * from public.mark_purchase_order_ordered('${orderId}')`);

    expect(await movementCount(orderId)).toBe(0);
  });

  /**
   * O invariante do PRD que D-149 trava em teste: "simular um pedido não pode
   * destruir o custo histórico do SKU". O custo do PEDIDO vive em
   * `purchase_order_items.unit_cost`; o CADASTRADO fica em
   * `skus.purchase_cost` e agora tem trilha (`sku_cost_history`) — criar um
   * pedido com custo próprio não toca nem um nem outro.
   */
  it("pedido com custo próprio NÃO toca o custo cadastrado nem gera história (D-149)", async () => {
    const sku = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind, purchase_cost)
       values ($1,'RLSTEST-compras-custo','PRODUTO',12.5) returning id`,
      [ORG_SB],
    );
    const skuId = sku.rows[0]?.id ?? "";

    const items = `'[{"skuId":"${skuId}","skuSnapshot":"RLSTEST-compras-custo","titleSnapshot":"Custo proprio","quantityOrdered":4,"unitCost":99.9}]'::jsonb`;

    await asUserPersist(ADMIN_TRANSITO, `select * from public.create_purchase_order('${ORG_SB}',${items})`);

    const cost = await client.query<{ purchase_cost: string }>(
      `select purchase_cost from public.skus where id = $1`,
      [skuId],
    );
    expect(Number(cost.rows[0]?.purchase_cost)).toBe(12.5);

    // Só a linha do nascimento (12.5) — o pedido não historia nada.
    const history = await client.query<{ n: string }>(
      `select count(*) as n from public.sku_cost_history where sku_id = $1`,
      [skuId],
    );
    expect(Number(history.rows[0]?.n)).toBe(1);
  });
});

describe("sku_cost_history (D-149, Fase 5D)", () => {
  // SKU com histórico de custo é INDELETÁVEL (FK restrict, o padrão das
  // tabelas de auditoria — a primeira versão usava CASCADE e a CI #270
  // mostrou a contradição: o cascade dispara o DELETE que o gatilho
  // append-only rejeita). O teardown pula esses SKUs pela guarda NOT EXISTS;
  // resíduo local acumula até o próximo reset, como nas organizações.
  let skuId = "";

  beforeAll(async () => {
    const sku = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind, purchase_cost)
       values ($1,'RLSTEST-CUSTO-hist','PRODUTO',12.5) returning id`,
      [ORG_SB],
    );

    skuId = sku.rows[0]?.id ?? "";
  });

  it("SKU que nasce com custo ganha a primeira linha — previous nulo, role de quem escreveu", async () => {
    const rows = await client.query<{ previous_cost: string | null; new_cost: string; changed_by_role: string }>(
      `select previous_cost, new_cost, changed_by_role from public.sku_cost_history where sku_id = $1`,
      [skuId],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.previous_cost).toBeNull();
    expect(Number(rows.rows[0]?.new_cost)).toBe(12.5);
    expect(rows.rows[0]?.changed_by_role).toBe("postgres");
  });

  it("mudar o custo gera linha com previous/new; update que não toca custo não gera nada", async () => {
    await client.query(`update public.skus set purchase_cost = 15 where id = $1`, [skuId]);
    // A sobrescrita silenciosa que motivou a fatia: título muda, custo não —
    // e o histórico NÃO ganha linha.
    await client.query(`update public.skus set title = 'renomeado' where id = $1`, [skuId]);

    const rows = await client.query<{ previous_cost: string; new_cost: string }>(
      `select previous_cost, new_cost from public.sku_cost_history where sku_id = $1 order by id`,
      [skuId],
    );

    expect(rows.rows).toHaveLength(2);
    expect(Number(rows.rows[1]?.previous_cost)).toBe(12.5);
    expect(Number(rows.rows[1]?.new_cost)).toBe(15);
  });

  it("apagar o custo registra a transição para nulo — o apagamento também é história", async () => {
    await client.query(`update public.skus set purchase_cost = null where id = $1`, [skuId]);

    const rows = await client.query<{ previous_cost: string; new_cost: string | null }>(
      `select previous_cost, new_cost from public.sku_cost_history where sku_id = $1 order by id desc limit 1`,
      [skuId],
    );

    expect(Number(rows.rows[0]?.previous_cost)).toBe(15);
    expect(rows.rows[0]?.new_cost).toBeNull();
  });

  it("é append-only: nem UPDATE nem DELETE do dono passam", async () => {
    await expect(
      client.query(`update public.sku_cost_history set new_cost = 99 where sku_id = $1`, [skuId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      client.query(`delete from public.sku_cost_history where sku_id = $1`, [skuId]),
    ).rejects.toThrow(/append-only/);
  });

  it("membro lê; usuário de outra organização não vê; anon é recusado", async () => {
    const member = await asUser<{ id: string }>(
      ADMIN_SB,
      `select id from public.sku_cost_history where sku_id = '${skuId}'`,
    );
    expect(member.length).toBeGreaterThan(0);

    const outra = await asUser<{ id: string }>(
      DE_OUTRA_ORG,
      `select id from public.sku_cost_history where sku_id = '${skuId}'`,
    );
    expect(outra).toHaveLength(0);

    await expect(asAnon("select * from public.sku_cost_history")).rejects.toThrow(/permission denied/i);
  });

  it("authenticated não insere direto — só a trigger escreve", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `insert into public.sku_cost_history (organization_id, sku_id, previous_cost, new_cost, changed_by_role)
         values ('${ORG_SB}','${skuId}',1,2,'hack')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("get_stock_coverage (D-058, Fase 5B)", () => {
  // Nome fora dos padrões que os afterAll apagam ('RLSTEST%' para skus,
  // 'rlstest%' para ml_accounts): uma vez com stock_movements/
  // daily_sku_metrics, `on delete restrict` torna os dois indeletáveis —
  // mesmo raciocínio já documentado para o SKU do ledger de estoque e a
  // conta de observabilidade de sincronização, acima.
  const SKU_NOME = "COVERAGETEST-freio-traseiro";
  const CONTA = "dddd3333-0000-4000-8000-000000000033";
  let skuId = "";

  const TODAY = "2026-08-23";
  const WINDOW_START = "2026-08-14"; // 10 dias antes, janela de 10 dias inclusive

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de cobertura','coveragetest-conta','PENDING')
       on conflict do nothing`,
      [CONTA, ORG_SB],
    );

    const sku = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,$2,'PRODUTO') returning id`,
      [ORG_SB, SKU_NOME],
    );
    skuId = sku.rows[0]?.id ?? "";

    // 20 unidades em LOCAL.
    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
       values ($1,$2,'LOCAL',20,'ENTRADA_NFE','DOCUMENT','coveragetest-doc','coveragetest:entrada',now())`,
      [ORG_SB, skuId],
    );

    // 10 unidades vendidas na janela de 10 dias (2026-08-14 a 2026-08-23) — média 1/dia.
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,$4,10,500,5,5)`,
      [ORG_SB, CONTA, skuId, TODAY],
    );
  });

  // Sem afterAll de limpeza: mesma razão do ledger de estoque acima — uma
  // vez que o SKU/conta tiver stock_movements/daily_sku_metrics, ficam
  // permanentemente indeletáveis por desenho.

  it("calcula cobertura: 20 em estoque / (10 vendidos em 10 dias = 1/dia) = 20 dias de cobertura", async () => {
    const rows = await asUser<{
      sku_id: string;
      local_quantity: string;
      units_sold: string;
      avg_daily_sales: string;
      days_of_coverage: string;
      is_ruptura: boolean;
    }>(
      ADMIN_SB,
      `select * from public.get_stock_coverage('${ORG_SB}','${WINDOW_START}','${TODAY}') where sku_id='${skuId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.local_quantity)).toBe(20);
    expect(Number(rows[0]?.units_sold)).toBe(10);
    expect(Number(rows[0]?.avg_daily_sales)).toBe(1);
    expect(Number(rows[0]?.days_of_coverage)).toBe(20);
    expect(rows[0]?.is_ruptura).toBe(false);
  });

  it("fora da janela de datas, a venda não conta — SKU ainda aparece pelo estoque, cobertura nula", async () => {
    // O SKU tem estoque LOCAL atual (sem filtro de data — projeção viva, não
    // histórico), então continua aparecendo mesmo sem venda na janela: é
    // item parado, não ausência de linha. `units_sold=0` -> `days_of_coverage`
    // nulo (CASE da função), não "Infinity".
    const rows = await asUser<{ units_sold: string; days_of_coverage: string | null }>(
      ADMIN_SB,
      `select * from public.get_stock_coverage('${ORG_SB}','2020-01-01','2020-01-02') where sku_id='${skuId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.units_sold)).toBe(0);
    expect(rows[0]?.days_of_coverage).toBeNull();
  });

  it("estoque zerado com venda no período: ruptura", async () => {
    const skuRuptura = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,'COVERAGETEST-em-ruptura','PRODUTO') returning id`,
      [ORG_SB],
    );
    const rupturaSkuId = skuRuptura.rows[0]?.id ?? "";

    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,$4,3,150,2,2)`,
      [ORG_SB, CONTA, rupturaSkuId, TODAY],
    );

    const rows = await asUser<{ is_ruptura: boolean; local_quantity: string }>(
      ADMIN_SB,
      `select * from public.get_stock_coverage('${ORG_SB}','${WINDOW_START}','${TODAY}') where sku_id='${rupturaSkuId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.local_quantity)).toBe(0);
    expect(rows[0]?.is_ruptura).toBe(true);
  });

  it("anon não executa", async () => {
    await expect(
      asAnon(`select * from public.get_stock_coverage('${ORG_SB}','${WINDOW_START}','${TODAY}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("usuário de outra organização não vê o SKU de cobertura desta organização", async () => {
    const rows = await asUser<{ sku_id: string }>(
      DE_OUTRA_ORG,
      `select * from public.get_stock_coverage('${ORG_SB}','${WINDOW_START}','${TODAY}') where sku_id='${skuId}'`,
    );

    expect(rows).toHaveLength(0);
  });

  // p_sku_id (D-080, simulador do Dashboard de SKU): filtro OPCIONAL
  // adicionado à assinatura existente, chamada sem ele continua varrendo
  // todos os SKUs (testes acima, inalterados).
  it("p_sku_id filtra para UM SKU só, sem precisar de WHERE do lado do cliente", async () => {
    const rows = await asUser<{ sku_id: string; days_of_coverage: string }>(
      ADMIN_SB,
      `select * from public.get_stock_coverage('${ORG_SB}','${WINDOW_START}','${TODAY}','${skuId}')`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sku_id).toBe(skuId);
    expect(Number(rows[0]?.days_of_coverage)).toBe(20);
  });

  it("p_sku_id nulo (omitido) continua varrendo todos os SKUs elegíveis da organização", async () => {
    const rows = await asUser<{ sku_id: string }>(
      ADMIN_SB,
      `select sku_id from public.get_stock_coverage('${ORG_SB}','${WINDOW_START}','${TODAY}')`,
    );

    expect(rows.map((row) => row.sku_id)).toContain(skuId);
  });
});

describe("get_purchase_suggestions (D-147, Fase 5D)", () => {
  // A RPC entrega INGREDIENTES; a fórmula da sugestão mora em @sb/domain
  // (computePurchaseSuggestion) — aqui se testa que cada parcela chega certa
  // e isolada por organização, nunca a conta.
  //
  // Mesmo raciocínio de nomes fora dos padrões de limpeza global, e mesma
  // ausência de afterAll — ver comentário equivalente no describe de
  // get_stock_coverage, acima.
  const CONTA = "ddddbbbb-0000-4000-8000-0000000000bb";
  const TODAY = "2026-08-23";
  let skuId = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de reposicao','purchtest-conta','PENDING')
       on conflict do nothing`,
      [CONTA, ORG_SB],
    );

    // Marca exige proveniência junto (D-133): `supplier_brand_source` casado
    // pelo CHECK, e 'MANUAL' exige `supplier_brand_set_at` — a CI #266 cobrou
    // exatamente isso quando a fixture veio só com o texto da marca.
    const sku = await client.query<{ id: string }>(
      `insert into public.skus
         (organization_id, sku, kind, supplier_brand, supplier_brand_source, supplier_brand_set_at, purchase_cost)
       values ($1,'PURCHTEST-pastilha','PRODUTO','PURCHTEST-MARCA','MANUAL',now(),12.5) returning id`,
      [ORG_SB],
    );
    skuId = sku.rows[0]?.id ?? "";

    // As três parcelas do pivô, em location_kinds distintos.
    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
       values
         ($1,$2,'LOCAL',30,'ENTRADA_NFE','DOCUMENT','purchtest-doc','purchtest:local',now()),
         ($1,$2,'RESERVADO',4,'RESERVA','DOCUMENT','purchtest-doc','purchtest:reservado',now()),
         ($1,$2,'TRANSITO',2,'ENTRADA_TRANSITO','DOCUMENT','purchtest-doc','purchtest:transito',now())`,
      [ORG_SB, skuId],
    );

    // Vendas: 10 dentro da janela de 30 e 5 fora dela mas dentro da de 90 —
    // é o que separa units_30d de units_90d.
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,$4::date,10,500,5,5),
              ($1,$2,$3,$4::date - 40,5,250,3,3)`,
      [ORG_SB, CONTA, skuId, TODAY],
    );

    // Full: duas capturas; só a mais RECENTE pode contar (captured_at é
    // carimbo por rodada, D-139) — a antiga carrega 99 de propósito.
    // item_id respeita o CHECK de formato real (^MLB[0-9]+$) — a CI #267
    // recusou 'MLBPURCH1'.
    await client.query(
      `insert into public.fulfillment_stock_snapshots
         (organization_id, ml_account_id, inventory_id, item_id, sku_id, quantity, captured_at)
       values ($1,$2,'PURCHINV1','MLB900100900',$3,99,'2026-08-13T12:00:00Z'),
              ($1,$2,'PURCHINV1','MLB900100900',$3,7,'2026-08-22T12:00:00Z')`,
      [ORG_SB, CONTA, skuId],
    );
  });

  it("entrega os ingredientes: parcelas do saldo, janelas de venda e o Full da ÚLTIMA captura", async () => {
    const rows = await asUser<{
      local_quantity: string;
      reservado: string;
      transito: string;
      full_quantity: string;
      units_30d: string;
      units_60d: string;
      units_90d: string;
      supplier_brand: string;
      purchase_cost: string;
    }>(
      ADMIN_SB,
      // Limite explícito e folgado: o WHERE roda DEPOIS da janela da função,
      // e a página default de 100 poderia esconder o SKU conforme as fixtures
      // dos outros describes crescem.
      `select * from public.get_purchase_suggestions('${ORG_SB}','${TODAY}', null, null, 10000, 0) where sku_id='${skuId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.local_quantity)).toBe(30);
    expect(Number(rows[0]?.reservado)).toBe(4);
    expect(Number(rows[0]?.transito)).toBe(2);
    // 7, não 99 nem 106: a captura antiga não conta.
    expect(Number(rows[0]?.full_quantity)).toBe(7);
    expect(Number(rows[0]?.units_30d)).toBe(10);
    expect(Number(rows[0]?.units_60d)).toBe(15);
    expect(Number(rows[0]?.units_90d)).toBe(15);
    expect(rows[0]?.supplier_brand).toBe("PURCHTEST-MARCA");
    expect(Number(rows[0]?.purchase_cost)).toBe(12.5);
  });

  it("o filtro de marca filtra e a CONTAGEM acompanha o conjunto filtrado, não o universo", async () => {
    const rows = await asUser<{ sku_id: string; total_count: string }>(
      ADMIN_SB,
      `select * from public.get_purchase_suggestions('${ORG_SB}','${TODAY}','PURCHTEST-MARCA')`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sku_id).toBe(skuId);
    expect(Number(rows[0]?.total_count)).toBe(1);
  });

  it("anon não executa", async () => {
    await expect(
      asAnon(`select * from public.get_purchase_suggestions('${ORG_SB}','${TODAY}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("usuário de outra organização não vê o SKU desta", async () => {
    const rows = await asUser<{ sku_id: string }>(
      DE_OUTRA_ORG,
      `select * from public.get_purchase_suggestions('${ORG_SB}','${TODAY}') where sku_id='${skuId}'`,
    );

    expect(rows).toHaveLength(0);
  });
});

describe("prioridade da sugestão de compra (D-150) — equivalência SQL × domínio", () => {
  // O TESTE DE EQUIVALÊNCIA que D-144/D-147 declararam para o dia em que a
  // fórmula ganhasse versão SQL: para CADA linha que a RPC devolve, o
  // domínio (@sb/domain) recebe os MESMOS ingredientes e precisa chegar ao
  // MESMO veredito (sugestão, estado, cobertura). Roda sobre todas as
  // fixtures vivas no banco neste ponto da suíte, mais quatro SKUs
  // plantados para forçar os ramos (urgente, ruptura, excesso, virtual).
  //
  // Marca própria (PURCHPRIO) para não contaminar o teste de filtro de
  // D-147, que afirma total_count=1 para PURCHTEST-MARCA. Nomes fora de
  // 'RLSTEST%': com métricas/ledger, os SKUs são indeletáveis por desenho.
  //
  // ERA PRÓPRIA (2025): a CI #272 mostrou que receita plantada em 2026-08
  // dilui a curva ABC do describe vizinho (o "SKU dominante" caiu de >95%
  // para 92,59% de share). A RPC recebe `p_date_to` explícito, então uma
  // janela inteira em 2025 mantém este describe consistente consigo mesmo
  // e invisível para todas as janelas de 2026 dos demais.
  const CONTA = "ddddbbbb-0000-4000-8000-0000000000bb";
  const TODAY = "2025-08-23";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de reposicao','purchtest-conta','PENDING')
       on conflict do nothing`,
      [CONTA, ORG_SB],
    );

    // A política da marca: janela 120 (15+90+15), teto 240.
    await client.query(
      `insert into public.replenishment_settings
         (organization_id, supplier_brand, lead_time_days, target_coverage_days, safety_stock_days, max_coverage_days)
       values ($1,'PURCHPRIO-MARCA',15,90,15,240)
       on conflict (organization_id, supplier_brand) where supplier_brand is not null do nothing`,
      [ORG_SB],
    );

    const skus = await client.query<{ id: string; sku: string }>(
      `insert into public.skus
         (organization_id, sku, kind, supplier_brand, supplier_brand_source, supplier_brand_set_at, stock_is_virtual)
       values
         ($1,'PURCHPRIO-urgente','PRODUTO','PURCHPRIO-MARCA','MANUAL',now(),false),
         ($1,'PURCHPRIO-ruptura','PRODUTO','PURCHPRIO-MARCA','MANUAL',now(),false),
         ($1,'PURCHPRIO-excesso','PRODUTO','PURCHPRIO-MARCA','MANUAL',now(),false),
         ($1,'PURCHPRIO-virtual','PRODUTO','PURCHPRIO-MARCA','MANUAL',now(),true)
       returning id, sku`,
      [ORG_SB],
    );
    const bySku = new Map(skus.rows.map((r) => [r.sku, r.id]));

    // 84 dias de métrica (1 un/dia) — dá história ≥ 84 para a ORGANIZAÇÃO
    // inteira e taxa 1,0 para o urgente. É o que destrava os ramos
    // não-recusados: sem isso, TODA linha cairia em HISTORICO_INCOMPLETO.
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       select $1, $2, $3, d::date, 1, 50, 1, 1
       from generate_series($4::date - 83, $4::date, interval '1 day') d`,
      [ORG_SB, CONTA, bySku.get("PURCHPRIO-urgente"), TODAY],
    );

    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,$4::date,15,750,5,5),
              ($1,$2,$5,$4::date,6,300,3,3),
              ($1,$2,$5,$4::date - 40,6,300,3,3),
              ($1,$2,$6,$4::date,15,750,5,5)`,
      [
        ORG_SB,
        CONTA,
        bySku.get("PURCHPRIO-ruptura"),
        TODAY,
        bySku.get("PURCHPRIO-excesso"),
        bySku.get("PURCHPRIO-virtual"),
      ],
    );

    // Saldos: urgente com 10 (cobertura 10 ≤ prazo 15); excesso com 1.000
    // (cobertura 5.000 > teto 240); ruptura sem saldo nenhum.
    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
       values
         ($1,$2,'LOCAL',10,'ENTRADA_NFE','DOCUMENT','purchprio-doc','purchprio:urgente',now()),
         ($1,$3,'LOCAL',1000,'ENTRADA_NFE','DOCUMENT','purchprio-doc','purchprio:excesso',now())`,
      [ORG_SB, bySku.get("PURCHPRIO-urgente"), bySku.get("PURCHPRIO-excesso")],
    );
  });

  interface PriorityRow {
    sku_id: string;
    sku: string;
    supplier_brand: string | null;
    stock_is_virtual: boolean;
    local_quantity: string;
    reservado: string;
    transito: string;
    full_quantity: string;
    units_15d: string;
    units_30d: string;
    units_60d: string;
    units_90d: string;
    history_days_90: string;
    abc_class: string | null;
    coverage_days: string | null;
    state: string | null;
    suggested_quantity: number | null;
  }

  async function fetchAll(): Promise<PriorityRow[]> {
    return asUser<PriorityRow>(
      ADMIN_SB,
      `select * from public.get_purchase_suggestions('${ORG_SB}','${TODAY}', null, null, 100000, 0)`,
    );
  }

  it("EQUIVALÊNCIA: para toda linha, o SQL e o domínio chegam ao mesmo veredito", async () => {
    const settingsResult = await client.query<{
      supplier_brand: string | null;
      sku_id: string | null;
      lead_time_days: number;
      target_coverage_days: number;
      safety_stock_days: number;
      max_coverage_days: number | null;
      policy_note: string | null;
    }>(`select * from public.replenishment_settings where organization_id = $1`, [ORG_SB]);

    const settings = settingsResult.rows.map((s) => ({
      supplierBrand: s.supplier_brand,
      skuId: s.sku_id,
      leadTimeDays: s.lead_time_days,
      targetCoverageDays: s.target_coverage_days,
      safetyStockDays: s.safety_stock_days,
      maxCoverageDays: s.max_coverage_days,
      policyNote: s.policy_note,
    }));

    const rows = await fetchAll();

    expect(rows.length).toBeGreaterThan(4);

    for (const row of rows) {
      const trend = classifySalesTrend({
        units15: Number(row.units_15d),
        units30: Number(row.units_30d),
        units60: Number(row.units_60d),
        units90: Number(row.units_90d),
        historyDays90: Number(row.history_days_90),
      });
      const usable = computeUsableStock({
        localQuantity: Number(row.local_quantity),
        fullQuantity: Number(row.full_quantity),
        transitQuantity: Number(row.transito),
        reservedQuantity: Number(row.reservado),
        stockIsVirtual: row.stock_is_virtual,
      });
      const policy = resolveReplenishmentPolicy(settings, {
        id: row.sku_id,
        supplierBrand: row.supplier_brand,
      });
      const suggestion = computePurchaseSuggestion({ policy, trend, usable });
      const stockState = classifyStockState({ policy, trend, usable });

      // `sku` no objeto para a falha DIZER qual linha divergiu.
      expect({
        sku: row.sku,
        suggested: row.suggested_quantity,
        state: row.state,
        coverage: row.coverage_days === null ? null : Number(row.coverage_days),
      }).toEqual({
        sku: row.sku,
        suggested: suggestion.suggestedQuantity,
        state: stockState.state,
        coverage: stockState.coverageDays,
      });
    }
  });

  it("os quatro ramos plantados saem com o estado esperado", async () => {
    const rows = await fetchAll();
    const bySku = new Map(rows.map((r) => [r.sku, r]));

    expect(bySku.get("PURCHPRIO-ruptura")?.state).toBe("RUPTURA");
    expect(bySku.get("PURCHPRIO-urgente")?.state).toBe("COMPRA_URGENTE");
    expect(Number(bySku.get("PURCHPRIO-urgente")?.suggested_quantity)).toBe(110);
    expect(bySku.get("PURCHPRIO-excesso")?.state).toBe("EXCESSO");
    expect(bySku.get("PURCHPRIO-virtual")?.state).toBeNull();
    expect(bySku.get("PURCHPRIO-virtual")?.suggested_quantity).toBeNull();
  });

  it("a ordem é a prioridade: ruptura > urgente > recusas > excesso", async () => {
    const order = (await fetchAll()).map((r) => r.sku);
    const at = (sku: string) => order.indexOf(sku);

    expect(at("PURCHPRIO-ruptura")).toBeGreaterThanOrEqual(0);
    expect(at("PURCHPRIO-ruptura")).toBeLessThan(at("PURCHPRIO-urgente"));
    // PURCHTEST-pastilha não tem política (marca sem regra): recusa, rank 4.
    expect(at("PURCHPRIO-urgente")).toBeLessThan(at("PURCHTEST-pastilha"));
    // EXCESSO fica DEPOIS das recusas: não é pendência de compra.
    expect(at("PURCHTEST-pastilha")).toBeLessThan(at("PURCHPRIO-excesso"));
  });
});

describe("get_sku_correlated_events (D-152, Fase 6B)", () => {
  // Era própria (2025-01) pelo mesmo motivo do describe da prioridade:
  // eventos plantados não podem vazar para janelas de outros describes.
  // Nomes fora de 'RLSTEST%': o SKU vira alvo de order_items e listings.
  const CONTA = "ddddcccc-0000-4000-8000-0000000000cc";
  const ORDER_ID = "900700100200";
  const FROM = "2025-01-01T00:00:00Z";
  const TO = "2025-01-31T00:00:00Z";
  let skuId = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de correlacao','corrtest-conta','PENDING')
       on conflict do nothing`,
      [CONTA, ORG_SB],
    );

    const sku = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind)
       values ($1,'CORRTEST-alvo','PRODUTO') returning id`,
      [ORG_SB],
    );
    skuId = sku.rows[0]?.id ?? "";

    await client.query(
      `insert into public.listings
         (organization_id, ml_account_id, item_id, title, status, price, currency_id, available_quantity, sku_id)
       values ($1,$2,'MLB900700100','Anuncio correlacionado','active',100,'BRL',5,$3)
       on conflict do nothing`,
      [ORG_SB, CONTA, skuId],
    );

    await client.query(
      `insert into public.orders
         (id, organization_id, ml_account_id, status, date_created, date_last_updated, total_amount, currency_id)
       values ($1,$2,$3,'cancelled','2025-01-09T12:00:00Z','2025-01-10T12:00:00Z',100,'BRL')
       on conflict do nothing`,
      [ORDER_ID, ORG_SB, CONTA],
    );

    await client.query(
      `insert into public.order_items
         (order_id, organization_id, ml_account_id, position, item_id, title, quantity, unit_price, currency_id, sku_id)
       values ($1,$2,$3,1,'MLB900700100','Item correlacionado',1,100,'BRL',$4)
       on conflict do nothing`,
      [ORDER_ID, ORG_SB, CONTA, skuId],
    );

    // Um evento por caminho de mapeamento, mais os dois que NÃO podem sair:
    // available_quantity.changed (excluído do vocabulário — é consequência
    // de venda, não causa) e um order com entity_id não numérico (guarda do
    // cast: descartado, nunca erro).
    await client.query(
      `insert into public.domain_events
         (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
       values
         ($1,$2,'2025-01-10T10:00:00Z','stock.depleted','sku',$3,'critico','system','corrtest:sku'),
         ($1,$2,'2025-01-10T11:00:00Z','listing.price.changed','listing','MLB900700100','informativo','system','corrtest:price'),
         ($1,$2,'2025-01-10T12:00:00Z','listing.available_quantity.changed','listing','MLB900700100','informativo','system','corrtest:qty'),
         ($1,$2,'2025-01-10T13:00:00Z','order.cancelled','order',$4,'importante','system','corrtest:order'),
         ($1,$2,'2025-01-10T14:00:00Z','order.cancelled','order','nao-numerico','importante','system','corrtest:badid')`,
      [ORG_SB, CONTA, skuId, ORDER_ID],
    );
  });

  it("mapeia os três caminhos ao SKU — e SÓ o vocabulário fechado", async () => {
    const rows = await asUser<{ sku_id: string; event_type: string }>(
      ADMIN_SB,
      `select * from public.get_sku_correlated_events('${ORG_SB}', array['${skuId}']::uuid[], '${FROM}', '${TO}')`,
    );

    const types = rows.map((r) => r.event_type).sort();

    // available_quantity.changed fora (excluído de propósito: 91% do ruído
    // medido, consequência de venda); o order de entity_id não numérico
    // descartado pela guarda em vez de derrubar a consulta.
    expect(types).toEqual(["listing.price.changed", "order.cancelled", "stock.depleted"]);
    expect(rows.every((r) => r.sku_id === skuId)).toBe(true);
  });

  it("SKU fora da lista de candidatos não traz nada — o filtro é por SKU, não por janela", async () => {
    const rows = await asUser<{ sku_id: string }>(
      ADMIN_SB,
      `select * from public.get_sku_correlated_events('${ORG_SB}', array['00000000-0000-4000-8000-000000000000']::uuid[], '${FROM}', '${TO}')`,
    );

    expect(rows).toHaveLength(0);
  });

  it("anon não executa", async () => {
    await expect(
      asAnon(`select * from public.get_sku_correlated_events('${ORG_SB}', array['${skuId}']::uuid[], '${FROM}', '${TO}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("usuário de outra organização não vê os eventos desta", async () => {
    const rows = await asUser<{ sku_id: string }>(
      DE_OUTRA_ORG,
      `select * from public.get_sku_correlated_events('${ORG_SB}', array['${skuId}']::uuid[], '${FROM}', '${TO}')`,
    );

    expect(rows).toHaveLength(0);
  });

  /**
   * D-153, sobre as MESMAS fixtures — e o contraste é o desenho: a
   * correlação devolve 3 eventos (vocabulário fechado); a TIMELINE devolve
   * 4, porque história não edita o passado — available_quantity.changed é
   * ruído como causa, mas É a história do estoque daquele SKU. O order de
   * entity_id não numérico continua fora nas duas (guarda de cast).
   */
  it("a TIMELINE (D-153) devolve os 4 eventos — história não edita o passado", async () => {
    const rows = await asUser<{
      event_type: string;
      entity_type: string;
      account_label: string | null;
      occurred_at: string;
    }>(ADMIN_SB, `select * from public.get_sku_timeline('${ORG_SB}', '${skuId}', 50)`);

    const types = rows.map((r) => r.event_type).sort();

    expect(types).toEqual([
      "listing.available_quantity.changed",
      "listing.price.changed",
      "order.cancelled",
      "stock.depleted",
    ]);
    // Ordem cronológica DECRESCENTE — o mais recente primeiro.
    const stamps = rows.map((r) => new Date(r.occurred_at).getTime());
    expect([...stamps].sort((a, b) => b - a)).toEqual(stamps);
    // O label da conta chega junto — a tela diz DE ONDE veio.
    expect(rows.every((r) => r.account_label === "Conta de correlacao")).toBe(true);
  });

  it("timeline: p_limit corta pelo mais recente; anon e outra organização são recusados", async () => {
    const rows = await asUser<{ event_type: string }>(
      ADMIN_SB,
      `select * from public.get_sku_timeline('${ORG_SB}', '${skuId}', 1)`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_type).toBe("order.cancelled");

    await expect(
      asAnon(`select * from public.get_sku_timeline('${ORG_SB}', '${skuId}', 50)`),
    ).rejects.toThrow(/permission denied/i);

    const outra = await asUser<{ event_type: string }>(
      DE_OUTRA_ORG,
      `select * from public.get_sku_timeline('${ORG_SB}', '${skuId}', 50)`,
    );
    expect(outra).toHaveLength(0);
  });
});

describe("get_sku_abc_curve (D-058, Fase 5B)", () => {
  // Mesmo raciocínio de nomes fora dos padrões de limpeza global, e mesma
  // ausência de afterAll — ver comentário equivalente no describe de
  // get_stock_coverage, acima.
  const CONTA_ABC = "dddd4444-0000-4000-8000-000000000044";
  const TODAY = "2026-08-23";
  const WINDOW_START = "2026-05-25"; // 90 dias antes, janela usada pela tela /curva-abc

  let skuAltaId = "";
  let skuBaixaId = "";
  let skuForaDaJanelaId = "";
  let skuComFullId = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta da curva ABC','abctest-conta','PENDING')
       on conflict do nothing`,
      [CONTA_ABC, ORG_SB],
    );

    const skus = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind)
       values
         ($1,'ABCTEST-alta-receita','PRODUTO'),
         ($1,'ABCTEST-baixa-receita','PRODUTO'),
         ($1,'ABCTEST-fora-da-janela','PRODUTO'),
         ($1,'ABCTEST-com-full','PRODUTO')
       returning id`,
      [ORG_SB],
    );
    skuAltaId = skus.rows[0]?.id ?? "";
    skuBaixaId = skus.rows[1]?.id ?? "";
    skuForaDaJanelaId = skus.rows[2]?.id ?? "";
    skuComFullId = skus.rows[3]?.id ?? "";

    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values
         ($1,$2,$3,$5,10,100000,10,10),
         ($1,$2,$4,$5,1,100,1,1),
         ($1,$2,$6,$5,2,200,2,2)`,
      [ORG_SB, CONTA_ABC, skuAltaId, skuBaixaId, TODAY, skuComFullId],
    );

    // Fora da janela de propósito: 2020, bem antes de WINDOW_START.
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,'2020-01-02',5,5000,5,5)`,
      [ORG_SB, CONTA_ABC, skuForaDaJanelaId],
    );

    await client.query(
      `insert into public.fulfillment_stock_snapshots
         (organization_id, ml_account_id, inventory_id, item_id, sku_id, quantity, captured_at)
       values ($1,$2,'abctest-inventory','MLB999999001',$3,42,now())`,
      [ORG_SB, CONTA_ABC, skuComFullId],
    );
  });

  // Sem afterAll de limpeza: mesma razão do ledger de estoque acima.

  it("SKU dominante (quase toda a receita) entra na curva como classe A", async () => {
    // Prova o motivo de existir cumulative_share_before na função: usar o
    // percentual acumulado APÓS somar o próprio SKU classificaria um SKU
    // dominante como C (seu acumulado sozinho já passa de 95%), quando ele é
    // justamente o item mais importante. ALTA (100000) domina a receita da
    // janela por uma ordem de grandeza sobre qualquer outro fixture do
    // arquivo — robusto mesmo com o resto do describe "cobertura" (acima)
    // deixando linhas de daily_sku_metrics sem limpeza na mesma organização.
    const rows = await asUser<{ sku_id: string; abc_class: string; cumulative_share: string }>(
      ADMIN_SB,
      `select * from public.get_sku_abc_curve('${ORG_SB}','${WINDOW_START}','${TODAY}') where sku_id='${skuAltaId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.abc_class).toBe("A");
    expect(Number(rows[0]?.cumulative_share)).toBeGreaterThan(95);
  });

  it("SKUs de contribuição marginal ficam na classe C, ordenados por percentual acumulado crescente", async () => {
    const rows = await asUser<{ sku_id: string; abc_class: string; cumulative_share: string; full_quantity: string }>(
      ADMIN_SB,
      `select * from public.get_sku_abc_curve('${ORG_SB}','${WINDOW_START}','${TODAY}')`,
    );

    const alta = rows.find((row) => row.sku_id === skuAltaId);
    const baixa = rows.find((row) => row.sku_id === skuBaixaId);
    const comFull = rows.find((row) => row.sku_id === skuComFullId);

    expect(alta).toBeDefined();
    expect(baixa).toBeDefined();
    expect(comFull).toBeDefined();
    expect(baixa?.abc_class).toBe("C");
    expect(comFull?.abc_class).toBe("C");
    expect(Number(alta?.cumulative_share)).toBeLessThan(Number(baixa?.cumulative_share));
    expect(Number(alta?.full_quantity)).toBe(0);
    expect(Number(baixa?.full_quantity)).toBe(0);
  });

  it("fora da janela de datas, o SKU nem aparece na curva — sem venda no período, não há o que classificar", async () => {
    const rows = await asUser<{ sku_id: string }>(
      ADMIN_SB,
      `select * from public.get_sku_abc_curve('${ORG_SB}','${WINDOW_START}','${TODAY}') where sku_id='${skuForaDaJanelaId}'`,
    );

    expect(rows).toHaveLength(0);
  });

  it("estoque em Full aparece no full_quantity do SKU vinculado", async () => {
    const rows = await asUser<{ full_quantity: string }>(
      ADMIN_SB,
      `select * from public.get_sku_abc_curve('${ORG_SB}','${WINDOW_START}','${TODAY}') where sku_id='${skuComFullId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.full_quantity)).toBe(42);
  });

  it("anon não executa", async () => {
    await expect(
      asAnon(`select * from public.get_sku_abc_curve('${ORG_SB}','${WINDOW_START}','${TODAY}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("usuário de outra organização não vê o SKU desta organização na curva", async () => {
    const rows = await asUser<{ sku_id: string }>(
      DE_OUTRA_ORG,
      `select * from public.get_sku_abc_curve('${ORG_SB}','${WINDOW_START}','${TODAY}') where sku_id='${skuAltaId}'`,
    );

    expect(rows).toHaveLength(0);
  });
});

describe("get_listing_sales (Fase 5B, Dashboards de SKU e de Anúncio)", () => {
  // Mesmo raciocínio de nomes fora dos padrões de limpeza global, e mesma
  // ausência de afterAll — ver comentário equivalente no describe de
  // get_stock_coverage, acima.
  const CONTA_ANUNCIO = "dddd6666-0000-4000-8000-000000000066";
  const MLB_ID = "MLB900100200";
  const MLB_FORA_DA_JANELA = "MLB900100201";
  const TODAY = "2026-08-23";
  const WINDOW_START = "2026-07-25"; // 30 dias antes, janela usada pela tela /anuncios

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de venda por anúncio','anunciotest-conta','PENDING')
       on conflict do nothing`,
      [CONTA_ANUNCIO, ORG_SB],
    );

    await client.query(
      `insert into public.daily_listing_metrics
         (organization_id, ml_account_id, mlb_id, variation_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values
         ($1,$2,$3,null,'2026-08-20',2,200,2,2),
         ($1,$2,$3,null,'2026-08-23',3,300,3,3),
         ($1,$2,$3,'123456','2026-08-23',9,900,9,9),
         ($1,$2,$4,null,'2020-01-02',5,500,5,5)`,
      [ORG_SB, CONTA_ANUNCIO, MLB_ID, MLB_FORA_DA_JANELA],
    );
  });

  // Sem afterAll de limpeza: mesma razão do ledger de estoque acima.

  it("soma venda por (conta, anúncio) no intervalo, INCLUINDO a linha com variação (D-123)", async () => {
    // Este teste afirmava 5/500, "ignorando a linha com variação" — que era o
    // comportamento ANTES de D-123. D-123 removeu o filtro `variation_id is
    // null` de propósito (R$ 469.593,20 escondidos, 15,4% da receita) e o
    // teste ficou obsoleto sem que ninguém visse: a CI já estava vermelha por
    // outro motivo (D-130) e depois parou de rodar (falha de faturamento,
    // D-142). O fixture tem 2+3 sem variação e 9 com — o total correto é 14.
    const rows = await asUser<{ ml_account_id: string; mlb_id: string; units_sold: string; gross_revenue: string }>(
      ADMIN_SB,
      `select * from public.get_listing_sales('${ORG_SB}','${WINDOW_START}','${TODAY}') where mlb_id='${MLB_ID}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.units_sold)).toBe(14);
    expect(Number(rows[0]?.gross_revenue)).toBe(1400);
  });

  it("fora da janela de datas, o anúncio nem aparece", async () => {
    const rows = await asUser<{ mlb_id: string }>(
      ADMIN_SB,
      `select * from public.get_listing_sales('${ORG_SB}','${WINDOW_START}','${TODAY}') where mlb_id='${MLB_FORA_DA_JANELA}'`,
    );

    expect(rows).toHaveLength(0);
  });

  it("anon não executa", async () => {
    await expect(
      asAnon(`select * from public.get_listing_sales('${ORG_SB}','${WINDOW_START}','${TODAY}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("usuário de outra organização não vê o anúncio desta organização", async () => {
    const rows = await asUser<{ mlb_id: string }>(
      DE_OUTRA_ORG,
      `select * from public.get_listing_sales('${ORG_SB}','${WINDOW_START}','${TODAY}') where mlb_id='${MLB_ID}'`,
    );

    expect(rows).toHaveLength(0);
  });
});

describe("get_sku_dashboard (Fase 5B, Dashboards de SKU e de Anúncio)", () => {
  // Mesmo raciocínio de nomes fora dos padrões de limpeza global, e mesma
  // ausência de afterAll — ver comentário equivalente no describe de
  // get_stock_coverage, acima.
  const CONTA_DASH = "dddd7777-0000-4000-8000-000000000077";
  const TODAY = "2026-08-23";
  const WINDOW_START = "2026-07-25"; // 30 dias antes, janela usada pela tela /skus/[skuId]

  let skuCompletoId = "";
  let skuSemMovimentoId = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta do dashboard de SKU','dashtest-conta','PENDING')
       on conflict do nothing`,
      [CONTA_DASH, ORG_SB],
    );

    const skus = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind)
       values ($1,'DASHTEST-produto-completo','PRODUTO'), ($1,'DASHTEST-sem-movimento','PRODUTO')
       returning id`,
      [ORG_SB],
    );
    skuCompletoId = skus.rows[0]?.id ?? "";
    skuSemMovimentoId = skus.rows[1]?.id ?? "";

    await client.query(
      `insert into public.inventory_balances (organization_id, sku_id, location_kind, quantity)
       values
         ($1,$2,'LOCAL',15),
         ($1,$2,'RESERVADO',3),
         ($1,$2,'TRANSITO',8)`,
      [ORG_SB, skuCompletoId],
    );

    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,$4,4,400,4,4)`,
      [ORG_SB, CONTA_DASH, skuCompletoId, TODAY],
    );

    await client.query(
      `insert into public.fulfillment_stock_snapshots
         (organization_id, ml_account_id, inventory_id, item_id, sku_id, quantity, captured_at)
       values ($1,$2,'dashtest-inventory','MLB900100300',$3,7,now())`,
      [ORG_SB, CONTA_DASH, skuCompletoId],
    );
  });

  // Sem afterAll de limpeza: mesma razão do ledger de estoque acima.

  it("resume estoque LOCAL/RESERVADO/TRANSITO, Full e venda somada no intervalo", async () => {
    const rows = await asUser<{
      local_quantity: string;
      reservado_quantity: string;
      transito_quantity: string;
      full_quantity: string;
      units_sold: string;
      gross_revenue: string;
    }>(
      ADMIN_SB,
      `select * from public.get_sku_dashboard('${ORG_SB}','${skuCompletoId}','${WINDOW_START}','${TODAY}')`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.local_quantity)).toBe(15);
    expect(Number(rows[0]?.reservado_quantity)).toBe(3);
    expect(Number(rows[0]?.transito_quantity)).toBe(8);
    expect(Number(rows[0]?.full_quantity)).toBe(7);
    expect(Number(rows[0]?.units_sold)).toBe(4);
    expect(Number(rows[0]?.gross_revenue)).toBe(400);
  });

  it("SKU sem movimento nenhum devolve uma linha com zeros, não linha ausente", async () => {
    const rows = await asUser<{ local_quantity: string; units_sold: string }>(
      ADMIN_SB,
      `select * from public.get_sku_dashboard('${ORG_SB}','${skuSemMovimentoId}','${WINDOW_START}','${TODAY}')`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.local_quantity)).toBe(0);
    expect(Number(rows[0]?.units_sold)).toBe(0);
  });

  it("anon não executa", async () => {
    await expect(
      asAnon(
        `select * from public.get_sku_dashboard('${ORG_SB}','${skuCompletoId}','${WINDOW_START}','${TODAY}')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("usuário de outra organização vê zeros, não o dado real desta organização", async () => {
    const rows = await asUser<{ local_quantity: string; units_sold: string }>(
      DE_OUTRA_ORG,
      `select * from public.get_sku_dashboard('${ORG_SB}','${skuCompletoId}','${WINDOW_START}','${TODAY}')`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.local_quantity)).toBe(0);
    expect(Number(rows[0]?.units_sold)).toBe(0);
  });
});

describe("daily_listing_visits e get_listing_traffic (D-032, Fase 5B)", () => {
  // Mesmo raciocínio de nomes fora dos padrões de limpeza global, e mesma
  // ausência de afterAll — ver comentário equivalente no describe de
  // get_stock_coverage, acima.
  const CONTA_TRAFEGO = "dddd8888-0000-4000-8000-000000000088";
  const ITEM_ID = "MLB900100500";
  const ITEM_SO_PEDIDO = "MLB900100501"; // tem pedido, mas nenhuma visita registrada.
  const TODAY = "2026-08-23";
  const WINDOW_START = "2026-07-25"; // 30 dias antes, janela usada pela tela /anuncios

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de tráfego','trafegotest-conta','PENDING')
       on conflict do nothing`,
      [CONTA_TRAFEGO, ORG_SB],
    );

    await client.query(
      `insert into public.daily_listing_visits
         (organization_id, ml_account_id, item_id, metric_date, visits, synced_at)
       values
         ($1,$2,$3,'2026-08-20',20,now()),
         ($1,$2,$3,$4,30,now()),
         ($1,$2,$3,'2020-01-02',999,now())`,
      [ORG_SB, CONTA_TRAFEGO, ITEM_ID, TODAY],
    );

    await client.query(
      `insert into public.daily_listing_metrics
         (organization_id, ml_account_id, mlb_id, variation_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values
         ($1,$2,$3,null,$4,5,500,5,5),
         ($1,$2,$5,null,$4,2,200,2,2),
         -- DIA SEM VISITA (2026-08-21 não está entre as datas de visita
         -- acima): é o caso que separa a conversão certa da errada em D-170.
         -- Somar estes 3 pedidos sobre um denominador que não cobre este dia
         -- é exatamente o que inflava a taxa acima de 100% em produção.
         ($1,$2,$3,null,'2026-08-21',3,300,3,3)`,
      [ORG_SB, CONTA_TRAFEGO, ITEM_ID, TODAY, ITEM_SO_PEDIDO],
    );
  });

  // Sem afterAll de limpeza: mesma razão do ledger de estoque acima.

  it("RLS da tabela: authenticated com acesso à conta lê, usuário de outra organização não vê nada", async () => {
    const own = await asUser<{ item_id: string }>(
      ADMIN_SB,
      `select * from public.daily_listing_visits where ml_account_id='${CONTA_TRAFEGO}'`,
    );
    expect(own.length).toBeGreaterThan(0);

    const outra = await asUser<{ item_id: string }>(
      DE_OUTRA_ORG,
      `select * from public.daily_listing_visits where ml_account_id='${CONTA_TRAFEGO}'`,
    );
    expect(outra).toHaveLength(0);
  });

  it("anon não lê daily_listing_visits", async () => {
    await expect(asAnon("select * from public.daily_listing_visits")).rejects.toThrow(/permission denied/i);
  });

  it("get_listing_traffic: conversão é FRAÇÃO e só sobre os dias observados (D-170)", async () => {
    const rows = await asUser<{
      item_id: string;
      visits: string;
      orders_count: string;
      days_observed: string;
      conversion_rate: string;
    }>(
      ADMIN_SB,
      `select * from public.get_listing_traffic('${ORG_SB}','${WINDOW_START}','${TODAY}') where item_id='${ITEM_ID}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.visits)).toBe(50);
    // Pedidos da JANELA INTEIRA: 5 no dia com visita + 3 no dia sem.
    expect(Number(rows[0]?.orders_count)).toBe(8);
    // Dois dias de coleta (20/08 e 23/08); 21/08 teve pedido, não visita.
    expect(Number(rows[0]?.days_observed)).toBe(2);
    // 5 pedidos observados ÷ 50 visitas = 0,1 — e NÃO 8/50 = 0,16, que é o
    // que a fórmula antiga faria ao misturar as duas janelas. Fração, não
    // percentual: a tela formata com formatPercent.
    expect(rows[0]?.conversion_rate).toBe("0.1000");
  });

  it("item com pedido mas sem visita no período: conversion_rate nulo, não Infinity", async () => {
    const rows = await asUser<{ visits: string; orders_count: string; conversion_rate: string | null }>(
      ADMIN_SB,
      `select * from public.get_listing_traffic('${ORG_SB}','${WINDOW_START}','${TODAY}') where item_id='${ITEM_SO_PEDIDO}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.visits)).toBe(0);
    expect(Number(rows[0]?.orders_count)).toBe(2);
    expect(rows[0]?.conversion_rate).toBeNull();
  });

  it("visita fora da janela de datas não conta na soma nem na cobertura", async () => {
    const rows = await asUser<{ visits: string; days_observed: string }>(
      ADMIN_SB,
      `select * from public.get_listing_traffic('${ORG_SB}','${WINDOW_START}','${TODAY}') where item_id='${ITEM_ID}'`,
    );

    // 20 + 30 = 50, sem contar as 999 de 2020-01-02 — que também não entram
    // em days_observed: dia fora da janela não é dia observado.
    expect(Number(rows[0]?.visits)).toBe(50);
    expect(Number(rows[0]?.days_observed)).toBe(2);
  });

  it("anon não executa get_listing_traffic", async () => {
    await expect(
      asAnon(`select * from public.get_listing_traffic('${ORG_SB}','${WINDOW_START}','${TODAY}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("usuário de outra organização não vê o anúncio desta organização em get_listing_traffic", async () => {
    const rows = await asUser<{ item_id: string }>(
      DE_OUTRA_ORG,
      `select * from public.get_listing_traffic('${ORG_SB}','${WINDOW_START}','${TODAY}') where item_id='${ITEM_ID}'`,
    );

    expect(rows).toHaveLength(0);
  });
});

// get_listing_dashboard_summary (20260831164303, D-168) — o resumo do
// Dashboard 360º do Anúncio: soma de UM anúncio, conversão NULL sem visita.
// Reusa deliberadamente a mesma fixture do describe de tráfego acima
// (mesmos UUIDs, inserts idempotentes) — o cenário é idêntico, só muda o
// grão da pergunta (um item, não a lista).
describe("get_listing_dashboard_summary (D-168, Dashboard 360º do Anúncio)", () => {
  const CONTA_TRAFEGO = "dddd8888-0000-4000-8000-000000000088";
  const ITEM_ID = "MLB900100500";
  const ITEM_SO_PEDIDO = "MLB900100501";
  const TODAY = "2026-08-23";
  const WINDOW_START = "2026-07-25";

  const CALL = (item: string) =>
    `select * from public.get_listing_dashboard_summary('${ORG_SB}','${CONTA_TRAFEGO}','${item}','${WINDOW_START}','${TODAY}')`;

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de tráfego','trafegotest-conta','PENDING')
       on conflict do nothing`,
      [CONTA_TRAFEGO, ORG_SB],
    );

    await client.query(
      `insert into public.daily_listing_visits
         (organization_id, ml_account_id, item_id, metric_date, visits, synced_at)
       values
         ($1,$2,$3,'2026-08-20',20,now()),
         ($1,$2,$3,$4,30,now()),
         ($1,$2,$3,'2020-01-02',999,now())
       on conflict do nothing`,
      [ORG_SB, CONTA_TRAFEGO, ITEM_ID, TODAY],
    );

    await client.query(
      `insert into public.daily_listing_metrics
         (organization_id, ml_account_id, mlb_id, variation_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values
         ($1,$2,$3,null,$4,5,500,5,5),
         ($1,$2,$5,null,$4,2,200,2,2),
         ($1,$2,$3,null,'2026-08-21',3,300,3,3)
       on conflict do nothing`,
      [ORG_SB, CONTA_TRAFEGO, ITEM_ID, TODAY, ITEM_SO_PEDIDO],
    );
  });

  it("soma vendas + visitas do item na janela e calcula conversão; visita fora da janela não conta", async () => {
    const rows = await asUser<{
      units_sold: string;
      gross_revenue: string;
      orders_count: string;
      visits: string;
      days_observed: string;
      conversion: string;
    }>(ADMIN_SB, CALL(ITEM_ID));

    expect(rows).toHaveLength(1);
    // Venda da JANELA INTEIRA: 5 unidades no dia observado + 3 no dia sem
    // visita. Estas três colunas não dependem da coleta de visitas.
    expect(Number(rows[0]?.units_sold)).toBe(8);
    expect(rows[0]?.gross_revenue).toBe("800.00");
    expect(Number(rows[0]?.orders_count)).toBe(8);
    // 20 + 30 = 50, sem as 999 de 2020-01-02.
    expect(Number(rows[0]?.visits)).toBe(50);
    expect(Number(rows[0]?.days_observed)).toBe(2);
    // 5 pedidos DOS DIAS OBSERVADOS ÷ 50 visitas (D-170) — não 8/50.
    expect(rows[0]?.conversion).toBe("0.1000");
  });

  it("item com pedido mas sem visita: conversão NULL, nunca Infinity nem zero fingido", async () => {
    const rows = await asUser<{ orders_count: string; visits: string; conversion: string | null }>(
      ADMIN_SB,
      CALL(ITEM_SO_PEDIDO),
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.orders_count)).toBe(2);
    expect(Number(rows[0]?.visits)).toBe(0);
    expect(rows[0]?.conversion).toBeNull();
  });

  it("security invoker: usuário de outra organização soma zero mesmo passando os IDs certos", async () => {
    const rows = await asUser<{ units_sold: string; visits: string; days_observed: string; conversion: string | null }>(
      DE_OUTRA_ORG,
      CALL(ITEM_ID),
    );

    // A RLS filtra ANTES da soma: os coalesce devolvem a linha zerada,
    // nunca os números da organização alheia.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.units_sold)).toBe(0);
    expect(Number(rows[0]?.visits)).toBe(0);
    expect(rows[0]?.conversion).toBeNull();
  });

  it("anon não executa get_listing_dashboard_summary", async () => {
    await expect(asAnon(CALL(ITEM_ID))).rejects.toThrow(/permission denied/i);
  });
});

// get_listings_dashboard — a RPC que a tela /anuncios realmente usa, e que
// ate D-170 nao tinha teste de integracao nenhum. Reusa a fixture de trafego
// (mesma conta, mesmo item, com o dia 21/08 que tem pedido e NAO tem visita).
describe("get_listings_dashboard (D-138; conversão canônica em D-170)", () => {
  const CONTA_TRAFEGO = "dddd8888-0000-4000-8000-000000000088";
  const ITEM_ID = "MLB900100500";
  const ITEM_SO_PEDIDO = "MLB900100501";
  const TODAY = "2026-08-23";
  const WINDOW_START = "2026-07-25";

  const CALL = `select * from public.get_listings_dashboard('${ORG_SB}','${WINDOW_START}','${TODAY}')`;

  beforeAll(async () => {
    // A funcao parte de `listings`: sem a linha do anuncio, a fixture de
    // metricas/visitas nao aparece.
    await client.query(
      `insert into public.listings
         (organization_id, ml_account_id, item_id, title, status, price, currency_id, available_quantity, synced_at)
       values
         ($1,$2,$3,'Anúncio com visitas observadas','ACTIVE',100,'BRL',5,now()),
         ($1,$2,$4,'Anúncio que vendeu sem visita','ACTIVE',200,'BRL',5,now())
       on conflict (ml_account_id, item_id) do nothing`,
      [ORG_SB, CONTA_TRAFEGO, ITEM_ID, ITEM_SO_PEDIDO],
    );
  });

  it("conversão é fração sobre os dias observados, com days_observed ao lado", async () => {
    const rows = await asUser<{
      item_id: string;
      visits: string;
      units_sold: string;
      days_observed: string;
      conversion_rate: string | null;
      total_count: string;
    }>(ADMIN_SB, `${CALL} where item_id='${ITEM_ID}'`);

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.visits)).toBe(50);
    // Venda da janela inteira (5 + 3), como nas outras RPCs.
    expect(Number(rows[0]?.units_sold)).toBe(8);
    expect(Number(rows[0]?.days_observed)).toBe(2);
    // 5 pedidos observados ÷ 50 visitas. A fórmula antiga dava "16.00"
    // (8/50 em percentual) — dois erros de uma vez.
    expect(rows[0]?.conversion_rate).toBe("0.1000");
  });

  it("anúncio que vendeu sem visita observada: taxa NULL e cobertura zero, nunca 0%", async () => {
    const rows = await asUser<{ visits: string; days_observed: string; conversion_rate: string | null }>(
      ADMIN_SB,
      `${CALL} where item_id='${ITEM_SO_PEDIDO}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.visits ?? 0)).toBe(0);
    expect(Number(rows[0]?.days_observed)).toBe(0);
    expect(rows[0]?.conversion_rate).toBeNull();
  });

  it("total_count conta o conjunto filtrado inteiro, não a página", async () => {
    const rows = await asUser<{ item_id: string; total_count: string }>(
      ADMIN_SB,
      `select * from public.get_listings_dashboard('${ORG_SB}','${WINDOW_START}','${TODAY}', null, null, 'all', 'MLB9001005', 1, 0)`,
    );

    // Uma linha na página, mas a contagem enxerga os dois anúncios da busca.
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.total_count)).toBe(2);
  });

  it("anon não executa get_listings_dashboard", async () => {
    await expect(asAnon(CALL)).rejects.toThrow(/permission denied/i);
  });

  it("usuário de outra organização não enxerga estes anúncios", async () => {
    const rows = await asUser<{ item_id: string }>(DE_OUTRA_ORG, `${CALL} where item_id='${ITEM_ID}'`);

    expect(rows).toHaveLength(0);
  });
});

describe("search_entities (Fase 5B, Busca universal)", () => {
  // Mesmo raciocínio de nomes fora dos padrões de limpeza global, e mesma
  // ausência de afterAll — ver comentário equivalente no describe de
  // get_stock_coverage, acima.
  const CONTA_BUSCA = "dddd9999-0000-4000-8000-000000000099";
  const SKU_NOME = "SEARCHTEST-guidao";
  const TERMO = "SEARCHTEST";

  let skuId = "";
  let purchaseOrderId = "";
  let orderNumber = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Loja Speedbikers Busca','buscatest-conta','PENDING')
       on conflict do nothing`,
      [CONTA_BUSCA, ORG_SB],
    );

    const sku = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,$2,'PRODUTO') returning id`,
      [ORG_SB, SKU_NOME],
    );
    skuId = sku.rows[0]?.id ?? "";

    await client.query(
      `insert into public.listings
         (organization_id, ml_account_id, item_id, sku_id, title, status, price, currency_id, available_quantity, synced_at)
       values ($1,$2,'MLB900100600',$3,'Guidão Esportivo Titan SEARCHTEST','active',99.9,'BRL',10,now())`,
      [ORG_SB, CONTA_BUSCA, skuId],
    );

    await client.query(
      `insert into public.suppliers (organization_id, name) values ($1,'SEARCHTEST Distribuidora')`,
      [ORG_SB],
    );

    const po = await client.query<{ id: string; order_number: string }>(
      `insert into public.purchase_orders (organization_id, created_by)
       values ($1,$2)
       returning id, order_number`,
      [ORG_SB, ADMIN_SB],
    );
    purchaseOrderId = po.rows[0]?.id ?? "";
    orderNumber = po.rows[0]?.order_number ?? "";
  });

  // SKU/listing/fornecedor/ml_account seguem sem afterAll de limpeza, mesma
  // razão do ledger de estoque acima. `purchase_orders`, aqui, É apagado: seu
  // `created_by` referencia `ADMIN_SB` (usuário `%@rls.test` COMPARTILHADO
  // entre describes) — sem apagar essa linha, o `delete from auth.users`
  // do afterAll GLOBAL do arquivo falha com FK violation
  // (`purchase_orders_created_by_fkey`), derrubando a suíte inteira. Sem
  // `purchase_order_events` associado (INSERT direto, não passou pela RPC de
  // negócio), então apagar é seguro — nenhum gatilho append-only bloqueia.
  afterAll(async () => {
    await client.query("delete from public.purchase_orders where id = $1", [purchaseOrderId]);
  });

  it("encontra SKU pelo código, com destino de navegação real (/skus/{id})", async () => {
    const rows = await asUser<{ entity_type: string; label: string; href: string }>(
      ADMIN_SB,
      `select * from public.search_entities('${ORG_SB}','${TERMO}') where entity_type='sku'`,
    );

    expect(rows.some((row) => row.label === SKU_NOME && row.href === `/skus/${skuId}`)).toBe(true);
  });

  it("encontra anúncio pelo título", async () => {
    const rows = await asUser<{ entity_type: string; label: string; href: string }>(
      ADMIN_SB,
      `select * from public.search_entities('${ORG_SB}','${TERMO}') where entity_type='anuncio'`,
    );

    expect(rows.some((row) => row.label.includes(TERMO) && row.href === "/anuncios")).toBe(true);
  });

  it("encontra fornecedor pelo nome", async () => {
    const rows = await asUser<{ entity_type: string; label: string; href: string }>(
      ADMIN_SB,
      `select * from public.search_entities('${ORG_SB}','${TERMO}') where entity_type='fornecedor'`,
    );

    expect(rows.some((row) => row.label === "SEARCHTEST Distribuidora" && row.href === "/fornecedores")).toBe(true);
  });

  it("encontra conta pelo label ou slug", async () => {
    const rows = await asUser<{ entity_type: string; label: string; href: string }>(
      ADMIN_SB,
      `select * from public.search_entities('${ORG_SB}','Speedbikers Busca') where entity_type='conta'`,
    );

    expect(rows.some((row) => row.label === "Loja Speedbikers Busca" && row.href === "/contas")).toBe(true);
  });

  it("encontra pedido de compra pelo número, com destino de navegação real (/compras/{id})", async () => {
    const rows = await asUser<{ entity_type: string; label: string; href: string }>(
      ADMIN_SB,
      `select * from public.search_entities('${ORG_SB}','${orderNumber}') where entity_type='pedido_compra'`,
    );

    expect(
      rows.some((row) => row.label === `Pedido #${orderNumber}` && row.href === `/compras/${purchaseOrderId}`),
    ).toBe(true);
  });

  it("busca vazia não devolve nada", async () => {
    const rows = await asUser(ADMIN_SB, `select * from public.search_entities('${ORG_SB}','')`);

    expect(rows).toHaveLength(0);
  });

  it("anon não executa", async () => {
    await expect(asAnon(`select * from public.search_entities('${ORG_SB}','${TERMO}')`)).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("usuário de outra organização não vê o SKU desta organização na busca", async () => {
    const rows = await asUser<{ label: string }>(
      DE_OUTRA_ORG,
      `select * from public.search_entities('${ORG_SB}','${TERMO}') where entity_type='sku'`,
    );

    expect(rows.some((row) => row.label === SKU_NOME)).toBe(false);
  });
});

describe("saved_filters / create_saved_filter / delete_saved_filter (Fase 5B, Filtros salvos)", () => {
  // `created_by` referencia `auth.users(id) on delete cascade` (diferente de
  // `purchase_orders.created_by`, que é RESTRICT por padrão) — usar ADMIN_SB/
  // ANALISTA_SB aqui é seguro: o afterAll global apagaria a linha em cascata
  // junto com o usuário, sem bloquear o DELETE de auth.users. Mesmo assim,
  // sem afterAll próprio: apagamos os filtros nós mesmos dentro dos testes
  // (é exatamente o que create/delete_saved_filter fazem), então não sobra
  // nada para limpar.
  const SCREEN = "/rlstest-tela";

  // `create_saved_filter`/`delete_saved_filter` usam `asUserPersist`, não
  // `asUser`: `asUser` reverte de propósito (comentário do próprio helper,
  // acima) — usá-lo para a escrita faz o INSERT nunca sobreviver até a
  // chamada seguinte, e o "upsert por nome" nunca encontra o conflito
  // (achado em CI: `overwritten.id` vinha diferente de `created.id`, cada
  // chamada criava uma linha nova numa transação que era desfeita na
  // sequência). Leituras de verificação continuam em `asUser` (não precisam
  // sobreviver à própria chamada).

  it("cria um filtro salvo; salvar de novo com o mesmo nome sobrescreve (upsert)", async () => {
    const created = await asUserPersist<{ id: string; name: string; params: Record<string, string> }>(
      ADMIN_SB,
      `select * from public.create_saved_filter('${ORG_SB}','${SCREEN}','Meu filtro','{"days":"30"}'::jsonb)`,
    );

    expect(created).toHaveLength(1);
    expect(created[0]?.params).toEqual({ days: "30" });

    const overwritten = await asUserPersist<{ id: string; params: Record<string, string> }>(
      ADMIN_SB,
      `select * from public.create_saved_filter('${ORG_SB}','${SCREEN}','Meu filtro','{"days":"60"}'::jsonb)`,
    );

    expect(overwritten[0]?.id).toBe(created[0]?.id);
    expect(overwritten[0]?.params).toEqual({ days: "60" });

    await asUserPersist(ADMIN_SB, `select public.delete_saved_filter('${created[0]?.id ?? ""}')`);
  });

  it("authenticated só vê os próprios filtros salvos (RLS por created_by)", async () => {
    const mine = await asUserPersist<{ id: string }>(
      ADMIN_SB,
      `select * from public.create_saved_filter('${ORG_SB}','${SCREEN}','Filtro do admin','{"a":"1"}'::jsonb)`,
    );
    const theirs = await asUserPersist<{ id: string }>(
      ANALISTA_SB,
      `select * from public.create_saved_filter('${ORG_SB}','${SCREEN}','Filtro do analista','{"b":"2"}'::jsonb)`,
    );

    const adminSees = await asUser<{ id: string }>(
      ADMIN_SB,
      `select id from public.saved_filters where screen = '${SCREEN}'`,
    );
    expect(adminSees.map((r) => r.id)).toContain(mine[0]?.id);
    expect(adminSees.map((r) => r.id)).not.toContain(theirs[0]?.id);

    await asUserPersist(ADMIN_SB, `select public.delete_saved_filter('${mine[0]?.id ?? ""}')`);
    await asUserPersist(ANALISTA_SB, `select public.delete_saved_filter('${theirs[0]?.id ?? ""}')`);
  });

  it("delete_saved_filter só apaga se o dono chamar — outro usuário não afeta nada", async () => {
    const created = await asUserPersist<{ id: string }>(
      ADMIN_SB,
      `select * from public.create_saved_filter('${ORG_SB}','${SCREEN}','Só o admin apaga','{}'::jsonb)`,
    );
    const filterId = created[0]?.id ?? "";

    await asUserPersist(ANALISTA_SB, `select public.delete_saved_filter('${filterId}')`);

    const stillThere = await asUser<{ id: string }>(
      ADMIN_SB,
      `select id from public.saved_filters where id = '${filterId}'`,
    );
    expect(stillThere).toHaveLength(1);

    await asUserPersist(ADMIN_SB, `select public.delete_saved_filter('${filterId}')`);

    const gone = await asUser<{ id: string }>(
      ADMIN_SB,
      `select id from public.saved_filters where id = '${filterId}'`,
    );
    expect(gone).toHaveLength(0);
  });

  it("create_saved_filter recusa organização da qual o usuário não é membro", async () => {
    await expect(
      asUser(ADMIN_SB, `select public.create_saved_filter('${ORG_OUTRA}','${SCREEN}','x','{}'::jsonb)`),
    ).rejects.toThrow(/sem permissao/i);
  });

  it("anon não lê nem escreve", async () => {
    await expect(asAnon(`select * from public.saved_filters`)).rejects.toThrow(/permission denied/i);
    await expect(
      asAnon(`select public.create_saved_filter('${ORG_SB}','${SCREEN}','x','{}'::jsonb)`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("get_sku_sales_baseline (Fase 6, Diagnóstico)", () => {
  // Mesmo raciocínio de nomes fora dos padrões de limpeza global, e mesma
  // ausência de afterAll — ver comentário equivalente no describe de
  // get_stock_coverage, acima.
  const CONTA_DIAG = "ddddaaaa-0000-4000-8000-0000000000aa";
  const CONTA_DIAG_2 = "ddddaaaa-0000-4000-8000-0000000000dd"; // segunda conta, só para o SKU multi-conta (D-081)
  const AS_OF = "2026-08-23"; // domingo (dow=0) — confirmado contra o Dev antes de escrever o teste.

  // Todas as datas abaixo caem no MESMO dia da semana que AS_OF (7 em 7 dias).
  const SAME_WEEKDAY = [
    "2026-08-16",
    "2026-08-09",
    "2026-08-02",
    "2026-07-26",
    "2026-07-19",
    "2026-07-12",
    "2026-07-05",
    "2026-06-28",
    "2026-06-21",
    "2026-06-14",
  ];
  const OTHER_WEEKDAY = "2026-08-19"; // quarta-feira — nunca deve entrar no baseline.

  let skuComAmostraId = "";
  let skuAmostraCurtaId = "";
  let skuDezOcorrenciasId = "";
  let skuMultiContaId = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values
         ($1,$3,'Conta de diagnóstico','diagtest-conta','PENDING'),
         ($2,$3,'Conta de diagnóstico 2','diagtest-conta-2','PENDING')
       on conflict do nothing`,
      [CONTA_DIAG, CONTA_DIAG_2, ORG_SB],
    );

    const skus = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind)
       values
         ($1,'DIAGTEST-com-amostra','PRODUTO'),
         ($1,'DIAGTEST-amostra-curta','PRODUTO'),
         ($1,'DIAGTEST-dez-ocorrencias','PRODUTO'),
         ($1,'DIAGTEST-multi-conta','PRODUTO')
       returning id`,
      [ORG_SB],
    );
    skuComAmostraId = skus.rows[0]?.id ?? "";
    skuAmostraCurtaId = skus.rows[1]?.id ?? "";
    skuDezOcorrenciasId = skus.rows[2]?.id ?? "";
    skuMultiContaId = skus.rows[3]?.id ?? "";

    // SKU com amostra suficiente: 4 ocorrências do mesmo dia da semana
    // (1,2,3,4 — média 2.5), mais uma linha de OUTRO dia da semana com valor
    // extremo (nunca deve entrar no cálculo), mais o valor do dia atual.
    const sameWeekdayValues = [1, 2, 3, 4];
    for (const [index, metricDate] of SAME_WEEKDAY.slice(0, 4).entries()) {
      await client.query(
        `insert into public.daily_sku_metrics
           (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
         values ($1,$2,$3,$4,$5,100,1,1)`,
        [ORG_SB, CONTA_DIAG, skuComAmostraId, metricDate, sameWeekdayValues[index]],
      );
    }
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,$4,999,1,1,1)`,
      [ORG_SB, CONTA_DIAG, skuComAmostraId, OTHER_WEEKDAY],
    );
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,$4,7,100,1,1)`,
      [ORG_SB, CONTA_DIAG, skuComAmostraId, AS_OF],
    );

    // SKU com amostra curta: só 3 ocorrências do mesmo dia da semana —
    // abaixo do mínimo de 4, não deve aparecer no resultado.
    for (const metricDate of SAME_WEEKDAY.slice(0, 3)) {
      await client.query(
        `insert into public.daily_sku_metrics
           (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
         values ($1,$2,$3,$4,5,100,1,1)`,
        [ORG_SB, CONTA_DIAG, skuAmostraCurtaId, metricDate],
      );
    }

    // SKU com DEZ ocorrências do mesmo dia da semana: as duas mais ANTIGAS
    // (índices 8 e 9, fora das 8 mais recentes) têm valor extremo (1000) —
    // se entrassem no cálculo, a média dispararia. As 8 mais recentes valem
    // 10 cada (média 10, desvio 0).
    for (const [index, metricDate] of SAME_WEEKDAY.entries()) {
      const value = index < 8 ? 10 : 1000;
      await client.query(
        `insert into public.daily_sku_metrics
           (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
         values ($1,$2,$3,$4,$5,100,1,1)`,
        [ORG_SB, CONTA_DIAG, skuDezOcorrenciasId, metricDate, value],
      );
    }

    // SKU vendido em DUAS contas no mesmo dia (D-081, regressão do bug real
    // de produção): daily_sku_metrics tem grão POR CONTA, então uma venda
    // multi-conta insere DUAS linhas para o mesmo (sku_id, metric_date). A
    // função precisa somar as duas ANTES de contar ocorrências/juntar com
    // o dia atual — do contrário devolve DUAS linhas para o mesmo SKU
    // (exatamente o que quebrou o upsert de `actions` em produção) e infla
    // a amostra do baseline. Primeira data do mesmo dia da semana (índice 0)
    // é dividida entre as duas contas (6+4=10); as outras três, uma conta só
    // (10 cada) — todas devem valer 10 no baseline. O dia atual (AS_OF)
    // também é dividido (5+3=8).
    const [multiContaDate, ...restoDatas] = SAME_WEEKDAY;

    if (multiContaDate !== undefined) {
      await client.query(
        `insert into public.daily_sku_metrics
           (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
         values
           ($1,$2,$4,$5,6,100,1,1),
           ($1,$3,$4,$5,4,100,1,1)`,
        [ORG_SB, CONTA_DIAG, CONTA_DIAG_2, skuMultiContaId, multiContaDate],
      );
    }

    for (const metricDate of restoDatas.slice(0, 3)) {
      await client.query(
        `insert into public.daily_sku_metrics
           (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
         values ($1,$2,$3,$4,10,100,1,1)`,
        [ORG_SB, CONTA_DIAG, skuMultiContaId, metricDate],
      );
    }

    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values
         ($1,$2,$4,$5,5,100,1,1),
         ($1,$3,$4,$5,3,100,1,1)`,
      [ORG_SB, CONTA_DIAG, CONTA_DIAG_2, skuMultiContaId, AS_OF],
    );
  });

  // Sem afterAll de limpeza: mesma razão do ledger de estoque acima.

  it("calcula baseline sobre o MESMO dia da semana — ignora linha de outro dia da semana", async () => {
    const rows = await asUser<{
      current_units_sold: string;
      baseline_mean: string;
      baseline_stddev: string;
      sample_count: string;
    }>(
      ADMIN_SB,
      `select * from public.get_sku_sales_baseline('${ORG_SB}','${AS_OF}') where sku_id='${skuComAmostraId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.current_units_sold)).toBe(7);
    expect(Number(rows[0]?.baseline_mean)).toBe(2.5);
    expect(Number(rows[0]?.sample_count)).toBe(4);
    expect(Number(rows[0]?.baseline_stddev)).toBeGreaterThan(0);
  });

  it("amostra abaixo de 4 ocorrências do mesmo dia da semana: SKU nem aparece", async () => {
    const rows = await asUser<{ sku_id: string }>(
      ADMIN_SB,
      `select * from public.get_sku_sales_baseline('${ORG_SB}','${AS_OF}') where sku_id='${skuAmostraCurtaId}'`,
    );

    expect(rows).toHaveLength(0);
  });

  it("limita a 8 ocorrências mais recentes do mesmo dia da semana — mais antigas não entram na média", async () => {
    const rows = await asUser<{ baseline_mean: string; sample_count: string }>(
      ADMIN_SB,
      `select * from public.get_sku_sales_baseline('${ORG_SB}','${AS_OF}') where sku_id='${skuDezOcorrenciasId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.sample_count)).toBe(8);
    expect(Number(rows[0]?.baseline_mean)).toBe(10);
  });

  it("anon não executa", async () => {
    await expect(
      asAnon(`select * from public.get_sku_sales_baseline('${ORG_SB}','${AS_OF}')`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("usuário de outra organização não vê o SKU desta organização", async () => {
    const rows = await asUser<{ sku_id: string }>(
      DE_OUTRA_ORG,
      `select * from public.get_sku_sales_baseline('${ORG_SB}','${AS_OF}') where sku_id='${skuComAmostraId}'`,
    );

    expect(rows).toHaveLength(0);
  });

  // p_sku_id (D-078, "O que aconteceu?" — ação contextual no Dashboard de
  // SKU): filtro OPCIONAL adicionado à assinatura existente, chamada sem
  // ele continua varrendo todos os SKUs (testes acima, inalterados).
  it("p_sku_id filtra para UM SKU só, sem precisar de WHERE do lado do cliente", async () => {
    const rows = await asUser<{ sku_id: string; sample_count: string }>(
      ADMIN_SB,
      `select * from public.get_sku_sales_baseline('${ORG_SB}','${AS_OF}','${skuComAmostraId}')`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sku_id).toBe(skuComAmostraId);
  });

  it("p_sku_id de um SKU sem amostra suficiente devolve zero linhas — mesma regra do filtro geral", async () => {
    const rows = await asUser<{ sku_id: string }>(
      ADMIN_SB,
      `select * from public.get_sku_sales_baseline('${ORG_SB}','${AS_OF}','${skuAmostraCurtaId}')`,
    );

    expect(rows).toHaveLength(0);
  });

  it("p_sku_id nulo (omitido) continua varrendo todos os SKUs elegíveis da organização", async () => {
    const rows = await asUser<{ sku_id: string }>(
      ADMIN_SB,
      `select sku_id from public.get_sku_sales_baseline('${ORG_SB}','${AS_OF}')`,
    );

    const skuIds = rows.map((row) => row.sku_id);

    expect(skuIds).toContain(skuComAmostraId);
    expect(skuIds).toContain(skuDezOcorrenciasId);
    expect(skuIds).not.toContain(skuAmostraCurtaId);
  });

  // Regressão do bug real de produção (D-081): get_sku_sales_baseline
  // devolvia DUAS linhas para um SKU vendido em duas contas no mesmo dia,
  // quebrando o upsert de `actions` em detect-sales-anomaly-actions.ts
  // ("ON CONFLICT DO UPDATE command cannot affect row a second time").
  it("SKU vendido em duas contas no mesmo dia: uma linha só, somada entre contas (D-081)", async () => {
    const rows = await asUser<{
      sku_id: string;
      current_units_sold: string;
      baseline_mean: string;
      sample_count: string;
    }>(
      ADMIN_SB,
      `select * from public.get_sku_sales_baseline('${ORG_SB}','${AS_OF}') where sku_id='${skuMultiContaId}'`,
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.current_units_sold)).toBe(8);
    expect(Number(rows[0]?.baseline_mean)).toBe(10);
    expect(Number(rows[0]?.sample_count)).toBe(4);
  });
});

describe("actions / update_action_status / get_sku_average_prices (Fase 6, Central de Ações, D-064)", () => {
  const CONTA_ACOES = "ddddaaaa-0000-4000-8000-0000000000bb";

  let skuPrecoId = "";
  let skuSemVendaId = "";
  let actionId = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de ações','acoestest-conta','PENDING')
       on conflict do nothing`,
      [CONTA_ACOES, ORG_SB],
    );

    const skus = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind)
       values ($1,'ACOESTEST-com-preco','PRODUTO'), ($1,'ACOESTEST-sem-venda','PRODUTO')
       returning id`,
      [ORG_SB],
    );
    skuPrecoId = skus.rows[0]?.id ?? "";
    skuSemVendaId = skus.rows[1]?.id ?? "";

    // Duas datas DENTRO da janela: preço médio esperado (100/2 + 60/1) / 2 = 55.
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values
         ($1,$2,$3,'2026-06-01',2,100,1,1),
         ($1,$2,$3,'2026-06-03',1,60,1,1)`,
      [ORG_SB, CONTA_ACOES, skuPrecoId],
    );
    // Fora da janela — nunca deve entrar na média.
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,'2026-05-01',1,999,1,1)`,
      [ORG_SB, CONTA_ACOES, skuPrecoId],
    );
    // skuSemVendaId nunca ganha linha em daily_sku_metrics: dia sem venda não gera
    // linha (orders_count > 0 é invariante da tabela, `20260821182620_create_daily_sales_metrics.sql`),
    // e é exatamente por isso que o SKU não deve aparecer no resultado.

    const action = await client.query<{ id: string }>(
      `insert into public.actions
         (organization_id, kind, severity, confidence, estimated_impact_brl, sku_id, evidence, recommendation, created_by, dedup_key)
       values ($1,'venda_anomala','alta','alta',150,$2,'{}'::jsonb,'Revisar.','system','acoestest:sku-preco:2026-06-05')
       returning id`,
      [ORG_SB, skuPrecoId],
    );
    actionId = action.rows[0]?.id ?? "";
  });

  // Sem afterAll de limpeza: mesmo raciocínio do describe de get_sku_sales_baseline,
  // acima — e `actions.assignee_id`/`actions.organization_id` têm `on delete cascade`
  // (deliberado, ver migration), então nem a limpeza global de auth.users fica
  // bloqueada por este fixture.

  describe("actions", () => {
    it("membro da organização vê as próprias ações", async () => {
      const rows = await asUser<{ id: string }>(ADMIN_SB, `select id from public.actions where id = '${actionId}'`);

      expect(rows).toHaveLength(1);
    });

    it("membro de outra organização não vê", async () => {
      const rows = await asUser<{ id: string }>(
        DE_OUTRA_ORG,
        `select id from public.actions where id = '${actionId}'`,
      );

      expect(rows).toHaveLength(0);
    });

    it("anon não vê nada", async () => {
      // Mesmo padrão de saved_filters (D-062): anon não tem GRANT SELECT
      // nenhum na tabela (`revoke all ... from anon, authenticated`), então o
      // Postgres barra em "permission denied" antes de chegar na RLS — não é
      // resultado vazio.
      await expect(asAnon(`select id from public.actions where id = '${actionId}'`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    it("authenticated não escreve direto — só via update_action_status", async () => {
      await expect(
        asUser(ADMIN_SB, `update public.actions set status = 'resolvido' where id = '${actionId}'`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("update_action_status", () => {
    it("membro assume a ação: status e assignee mudam e persistem", async () => {
      const rows = await asUserPersist<{ status: string; assignee_id: string }>(
        ADMIN_SB,
        `select * from public.update_action_status('${actionId}','em_andamento','${ADMIN_SB}')`,
      );

      expect(rows[0]?.status).toBe("em_andamento");
      expect(rows[0]?.assignee_id).toBe(ADMIN_SB);

      const persisted = await asUser<{ status: string }>(
        ADMIN_SB,
        `select status from public.actions where id = '${actionId}'`,
      );

      expect(persisted[0]?.status).toBe("em_andamento");
    });

    it("assignee omitido mantém o responsável já atribuído", async () => {
      const rows = await asUserPersist<{ status: string; assignee_id: string }>(
        ADMIN_SB,
        `select * from public.update_action_status('${actionId}','resolvido')`,
      );

      expect(rows[0]?.status).toBe("resolvido");
      expect(rows[0]?.assignee_id).toBe(ADMIN_SB);
    });

    it("membro de outra organização não pode atualizar", async () => {
      await expect(
        asUser(DE_OUTRA_ORG, `select * from public.update_action_status('${actionId}','descartado')`),
      ).rejects.toThrow(/sem permissao/i);
    });

    it("status inválido é rejeitado", async () => {
      await expect(
        asUser(ADMIN_SB, `select * from public.update_action_status('${actionId}','lixo')`),
      ).rejects.toThrow(/status invalido/i);
    });

    it("anon não executa", async () => {
      await expect(
        asAnon(`select * from public.update_action_status('${actionId}','resolvido')`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("get_sku_average_prices", () => {
    it("calcula a média por SKU dentro da janela — ignora datas fora e dias sem venda", async () => {
      const rows = await asUser<{ sku_id: string; average_price: string }>(
        ADMIN_SB,
        `select * from public.get_sku_average_prices('${ORG_SB}', array['${skuPrecoId}','${skuSemVendaId}']::uuid[], '2026-06-01', '2026-06-05')`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.sku_id).toBe(skuPrecoId);
      expect(Number(rows[0]?.average_price)).toBe(55);
    });

    it("anon não executa", async () => {
      await expect(
        asAnon(
          `select * from public.get_sku_average_prices('${ORG_SB}', array['${skuPrecoId}']::uuid[], '2026-06-01', '2026-06-05')`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    it("usuário de outra organização não vê o preço desta organização", async () => {
      const rows = await asUser<{ sku_id: string }>(
        DE_OUTRA_ORG,
        `select * from public.get_sku_average_prices('${ORG_SB}', array['${skuPrecoId}']::uuid[], '2026-06-01', '2026-06-05')`,
      );

      expect(rows).toHaveLength(0);
    });
  });
});

describe("action_decisions / action_outcomes / create_action_decision / get_sku_decision_snapshot (Fase 6, Memória de decisões, D-065)", () => {
  const CONTA_DECISOES = "ddddaaaa-0000-4000-8000-0000000000cc";
  // `action_decisions.created_by references auth.users on delete restrict`
  // (append-only por natureza, mesmo raciocínio de `stock_movements.created_by`)
  // — precisa de um usuário FORA do padrão `%@rls.test` que o afterAll global
  // apaga, senão o DELETE bate na FK. Mesma técnica de `RESPONSAVEL_AJUSTE`.
  const RESPONSAVEL_DECISAO = "dddddddd-0000-4000-8000-000000000007";

  let skuId = "";
  let actionId = "";
  let decisionId = "";

  beforeAll(async () => {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'responsavel@decisionstest.local','x',now(),'{"full_name":"Responsavel Decisionstest"}',now(),now())
       on conflict (id) do nothing`,
      [RESPONSAVEL_DECISAO],
    );

    await client.query(
      `insert into public.organization_members (organization_id, user_id, role)
       values ($1,$2,'ADMIN') on conflict do nothing`,
      [ORG_SB, RESPONSAVEL_DECISAO],
    );

    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1,$2,'Conta de decisões','decisoestest-conta','PENDING')
       on conflict do nothing`,
      [CONTA_DECISOES, ORG_SB],
    );

    const skus = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind)
       values ($1,'DECISAOTEST-sku','PRODUTO')
       returning id`,
      [ORG_SB],
    );
    skuId = skus.rows[0]?.id ?? "";

    // Janela de 7 dias terminando em 2026-06-03 (05-28 a 06-03): pega as duas
    // datas dentro (2 + 1 = 3 unidades, R$100 + R$60 = R$160).
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values
         ($1,$2,$3,'2026-06-01',2,100,1,1),
         ($1,$2,$3,'2026-06-03',1,60,1,1)`,
      [ORG_SB, CONTA_DECISOES, skuId],
    );

    // Fora da janela de 7 dias — nunca deve entrar na soma.
    await client.query(
      `insert into public.daily_sku_metrics
         (organization_id, ml_account_id, sku_id, metric_date, units_sold, gross_revenue, orders_count, purchases_count)
       values ($1,$2,$3,'2026-05-01',1,999,1,1)`,
      [ORG_SB, CONTA_DECISOES, skuId],
    );

    await client.query(
      `insert into public.inventory_balances (organization_id, sku_id, location_kind, quantity)
       values ($1,$2,'LOCAL',12)`,
      [ORG_SB, skuId],
    );

    const action = await client.query<{ id: string }>(
      `insert into public.actions
         (organization_id, kind, severity, confidence, estimated_impact_brl, sku_id, evidence, recommendation, created_by, dedup_key)
       values ($1,'venda_anomala','alta','alta',150,$2,'{}'::jsonb,'Revisar.','system','decisoestest:sku:2026-06-05')
       returning id`,
      [ORG_SB, skuId],
    );
    actionId = action.rows[0]?.id ?? "";
  });

  // Sem afterAll de limpeza: mesmo raciocínio do describe de D-064, acima —
  // e a decisão criada abaixo usa RESPONSAVEL_DECISAO (fora do padrão
  // `%@rls.test`) como `created_by`, então não bloqueia a limpeza global de
  // `auth.users` (mesma técnica de `RESPONSAVEL_AJUSTE`, achado original em
  // `stock_movements.created_by`).

  describe("get_sku_decision_snapshot", () => {
    it("soma vendas de 7 dias terminando em as_of, ignora data fora da janela e traz o estoque local", async () => {
      const rows = await asUser<{ snapshot: Record<string, unknown> }>(
        ADMIN_SB,
        `select public.get_sku_decision_snapshot('${ORG_SB}', '${skuId}', '2026-06-03') as snapshot`,
      );

      expect(rows[0]?.snapshot).toMatchObject({
        as_of: "2026-06-03",
        units_sold_7d: 3,
        avg_daily_units_7d: 0.43,
        avg_price_7d: 53.33,
        stock_local: 12,
      });
    });

    it("SKU sem venda nenhuma na janela: contadores zerados, avg_price_7d nulo (nunca zero inventado)", async () => {
      const skus = await client.query<{ id: string }>(
        `insert into public.skus (organization_id, sku, kind) values ($1,'DECISAOTEST-sem-venda','PRODUTO') returning id`,
        [ORG_SB],
      );
      const semVendaId = skus.rows[0]?.id ?? "";

      const rows = await asUser<{ snapshot: Record<string, unknown> }>(
        ADMIN_SB,
        `select public.get_sku_decision_snapshot('${ORG_SB}', '${semVendaId}', '2026-06-03') as snapshot`,
      );

      expect(rows[0]?.snapshot).toEqual({
        as_of: "2026-06-03",
        units_sold_7d: 0,
        avg_daily_units_7d: 0,
        avg_price_7d: null,
        stock_local: 0,
      });
    });
  });

  describe("create_action_decision", () => {
    it("membro da organização registra uma decisão — baseline_snapshot capturado na hora", async () => {
      const rows = await asUserPersist<{
        id: string;
        decision: string;
        action_id: string;
        created_by: string;
        baseline_snapshot: Record<string, unknown>;
      }>(
        RESPONSAVEL_DECISAO,
        `select * from public.create_action_decision('${actionId}', 'Repor estoque via fornecedor PLASMOTO')`,
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.decision).toBe("Repor estoque via fornecedor PLASMOTO");
      expect(rows[0]?.action_id).toBe(actionId);
      expect(rows[0]?.created_by).toBe(RESPONSAVEL_DECISAO);
      expect(rows[0]?.baseline_snapshot).toHaveProperty("as_of");
      expect(rows[0]?.baseline_snapshot).toHaveProperty("stock_local", 12);

      decisionId = rows[0]?.id ?? "";
    });

    it("membro de outra organização não pode registrar decisão nesta ação", async () => {
      await expect(
        asUser(DE_OUTRA_ORG, `select * from public.create_action_decision('${actionId}', 'tentativa')`),
      ).rejects.toThrow(/sem permissao/i);
    });

    it("decisão vazia (só espaço) é rejeitada", async () => {
      await expect(
        asUser(ADMIN_SB, `select * from public.create_action_decision('${actionId}', '   ')`),
      ).rejects.toThrow(/nao pode ser vazia/i);
    });

    it("ação inexistente é rejeitada", async () => {
      await expect(
        asUser(ADMIN_SB, `select * from public.create_action_decision(gen_random_uuid(), 'x')`),
      ).rejects.toThrow(/não encontrada/i);
    });

    it("anon não executa", async () => {
      await expect(asAnon(`select * from public.create_action_decision('${actionId}', 'x')`)).rejects.toThrow(
        /permission denied/i,
      );
    });
  });

  describe("action_decisions", () => {
    it("membro da organização vê a própria decisão", async () => {
      const rows = await asUser<{ id: string }>(
        ADMIN_SB,
        `select id from public.action_decisions where id = '${decisionId}'`,
      );

      expect(rows).toHaveLength(1);
    });

    it("membro de outra organização não vê", async () => {
      const rows = await asUser<{ id: string }>(
        DE_OUTRA_ORG,
        `select id from public.action_decisions where id = '${decisionId}'`,
      );

      expect(rows).toHaveLength(0);
    });

    it("anon não vê nada", async () => {
      await expect(
        asAnon(`select id from public.action_decisions where id = '${decisionId}'`),
      ).rejects.toThrow(/permission denied/i);
    });

    it("authenticated não escreve direto — só via create_action_decision", async () => {
      await expect(
        asUser(ADMIN_SB, `update public.action_decisions set decision = 'x' where id = '${decisionId}'`),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("action_outcomes", () => {
    // Sem RPC de escrita: só o worker grava (service_role), testado com fake
    // db em `apps/worker/src/handlers/measure-decision-outcomes.test.ts` —
    // aqui só a RLS de leitura, mesmo padrão de `actions`.
    let outcomeId = "";

    beforeAll(async () => {
      const outcome = await client.query<{ id: string }>(
        `insert into public.action_outcomes (organization_id, action_decision_id, window_days, outcome_snapshot)
         values ($1,$2,7,'{"as_of":"2026-06-10","units_sold_7d":5,"avg_daily_units_7d":0.71,"avg_price_7d":40,"stock_local":8}'::jsonb)
         returning id`,
        [ORG_SB, decisionId],
      );
      outcomeId = outcome.rows[0]?.id ?? "";
    });

    it("membro da organização vê", async () => {
      const rows = await asUser<{ id: string }>(
        ADMIN_SB,
        `select id from public.action_outcomes where id = '${outcomeId}'`,
      );

      expect(rows).toHaveLength(1);
    });

    it("membro de outra organização não vê", async () => {
      const rows = await asUser<{ id: string }>(
        DE_OUTRA_ORG,
        `select id from public.action_outcomes where id = '${outcomeId}'`,
      );

      expect(rows).toHaveLength(0);
    });

    it("anon não vê nada", async () => {
      await expect(asAnon(`select id from public.action_outcomes where id = '${outcomeId}'`)).rejects.toThrow(
        /permission denied/i,
      );
    });

    it("authenticated não escreve direto — só service_role (worker)", async () => {
      await expect(
        asUser(
          ADMIN_SB,
          `insert into public.action_outcomes (organization_id, action_decision_id, window_days, outcome_snapshot)
           values ('${ORG_SB}','${decisionId}',15,'{}'::jsonb)`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});

describe("notificações (fan-out de domain_events, D-073)", () => {
  // Contas PRÓPRIAS desta suíte, não as de "contas Mercado Livre" —
  // `domain_events` é append-only de verdade (nem o `client` superusuário
  // consegue apagar, `domain_events_reject_mutation` recusa incondicional).
  // Reusar CONTA_A/CONTA_B (slug `rlstest-conta-a/b`) prenderia essas contas
  // para sempre via `on delete restrict`, e o `afterAll` GLOBAL deste
  // arquivo tenta apagar `ml_accounts` com slug `rlstest%` — quebraria a
  // suíte inteira. Slug sem esse prefixo evita a colisão por completo, sem
  // precisar de nenhuma limpeza (mesmo padrão já aceito para outras contas
  // de teste deste arquivo que também nunca são apagadas).
  const CONTA_A = "eeee1111-0000-4000-8000-00000000eee1";
  const CONTA_B = "eeee2222-0000-4000-8000-00000000eee2";

  let orgWideEventId = "";
  let contaAEventId = "";
  let contaBEventId = "";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
       values ($1,$3,'Conta A (notificações)','notify-conta-a',444,'CONNECTED',now()),
              ($2,$3,'Conta B (notificações)','notify-conta-b',555,'CONNECTED',now())
       on conflict do nothing`,
      [CONTA_A, CONTA_B, ORG_SB],
    );

    await client.query(
      `insert into public.user_account_permissions (user_id, ml_account_id)
       values ($1,$2) on conflict do nothing`,
      [ANALISTA_SB, CONTA_A],
    );

    // Evento organizacional (sem conta) — mesmo padrão de stock.balance.diverged (D-054).
    const orgWide = await client.query<{ id: string }>(
      `insert into public.domain_events
         (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
       values ($1, null, now(), 'stock.balance.diverged', 'sku', 'rlstest-notify-sku', 'critico', 'system', $2)
       returning id`,
      [ORG_SB, `rlstest-notify:org-wide:${String(Date.now())}`],
    );
    orgWideEventId = orgWide.rows[0]?.id ?? "";

    // Evento na Conta A — ANALISTA_SB tem permissão explícita ali.
    const contaA = await client.query<{ id: string }>(
      `insert into public.domain_events
         (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
       values ($1, $2, now(), 'listing.price.changed', 'listing', 'MLB-rlstest-a', 'informativo', 'sync', $3)
       returning id`,
      [ORG_SB, CONTA_A, `rlstest-notify:conta-a:${String(Date.now())}`],
    );
    contaAEventId = contaA.rows[0]?.id ?? "";

    // Evento na Conta B — ANALISTA_SB NÃO tem permissão ali.
    const contaB = await client.query<{ id: string }>(
      `insert into public.domain_events
         (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
       values ($1, $2, now(), 'listing.price.changed', 'listing', 'MLB-rlstest-b', 'informativo', 'sync', $3)
       returning id`,
      [ORG_SB, CONTA_B, `rlstest-notify:conta-b:${String(Date.now())}`],
    );
    contaBEventId = contaB.rows[0]?.id ?? "";
  });

  // Sem `afterAll` de limpeza — `domain_events` é append-only de verdade
  // (nem o `client` superusuário apaga, `domain_events_reject_mutation`
  // recusa incondicional). As contas/eventos desta suíte ficam, como
  // ficariam em produção; mesmo raciocínio já aceito para outras contas de
  // teste deste arquivo (`docs/DATABASE.md`: "o ambiente local acumula até
  // o próximo `supabase db reset --local`").
  async function recipientsOf(domainEventId: string): Promise<string[]> {
    const rows = await client.query<{ user_id: string }>(
      `select nr.user_id from public.notification_recipients nr
       join public.notifications n on n.id = nr.notification_id
       where n.domain_event_id = $1`,
      [domainEventId],
    );

    return rows.rows.map((r) => r.user_id).sort();
  }

  describe("regra de destinatário (fan-out via trigger, sem RPC nem código de aplicação)", () => {
    // `toContain`, não `toEqual`: outras suítes deste arquivo criam usuários
    // ADMIN próprios em ORG_SB sem limpeza (mesmo padrão já documentado, ex.
    // ADMIN_COMPRAS) — eles legitimamente também são destinatários de
    // qualquer evento que ADMIN alcança. O que importa provar aqui é conter
    // (ou não) os dois usuários específicos deste teste, não o conjunto
    // fechado.
    it("evento organizacional (ml_account_id nulo) notifica qualquer membro da organização", async () => {
      const recipients = await recipientsOf(orgWideEventId);

      expect(recipients).toContain(ADMIN_SB);
      expect(recipients).toContain(ANALISTA_SB);
    });

    it("evento de conta COM permissão: ADMIN (alcança tudo) e quem tem permissão explícita são notificados", async () => {
      const recipients = await recipientsOf(contaAEventId);

      expect(recipients).toContain(ADMIN_SB);
      expect(recipients).toContain(ANALISTA_SB);
    });

    it("evento de conta SEM permissão: quem não tem acesso à conta fica de fora, mesmo sendo membro da organização", async () => {
      const recipients = await recipientsOf(contaBEventId);

      expect(recipients).toContain(ADMIN_SB);
      expect(recipients).not.toContain(ANALISTA_SB);
    });

    it("uma notificação por domain_event — UNIQUE em domain_event_id", async () => {
      const rows = await client.query<{ count: string }>(
        `select count(*) from public.notifications where domain_event_id = $1`,
        [orgWideEventId],
      );

      expect(rows.rows[0]?.count).toBe("1");
    });
  });

  describe("RLS de leitura", () => {
    it("ANALISTA vê a própria notificação (evento organizacional)", async () => {
      const rows = await asUser<{ id: string }>(
        ANALISTA_SB,
        `select n.id from public.notifications n
         join public.notification_recipients nr on nr.notification_id = n.id
         where n.domain_event_id = '${orgWideEventId}' and nr.user_id = '${ANALISTA_SB}'`,
      );

      expect(rows).toHaveLength(1);
    });

    it("ANALISTA não vê a notificação da Conta B — nunca virou destinatário", async () => {
      const rows = await asUser<{ id: string }>(
        ANALISTA_SB,
        `select n.id from public.notifications n where n.domain_event_id = '${contaBEventId}'`,
      );

      expect(rows).toHaveLength(0);
    });

    it("usuário de outra organização não vê nada", async () => {
      const rows = await asUser<{ id: string }>(
        DE_OUTRA_ORG,
        `select n.id from public.notifications n where n.domain_event_id = '${orgWideEventId}'`,
      );

      expect(rows).toHaveLength(0);
    });

    it("anon não vê notifications nem notification_recipients", async () => {
      await expect(asAnon("select * from public.notifications")).rejects.toThrow(/permission denied/i);
      await expect(asAnon("select * from public.notification_recipients")).rejects.toThrow(
        /permission denied/i,
      );
    });

    it("authenticated não insere direto em notifications — só o trigger, via service_role", async () => {
      await expect(
        asUser(
          ADMIN_SB,
          `insert into public.notifications (organization_id, domain_event_id)
           values ('${ORG_SB}','${orgWideEventId}')`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("marcar como lida — Server Action de escopo do usuário (ARCHITECTURE.md secao 4)", () => {
    it("usuário marca a própria notificação como lida", async () => {
      const rows = await asUserPersist<{ read_at: string | null }>(
        ANALISTA_SB,
        `update public.notification_recipients set read_at = now()
         where notification_id = (select id from public.notifications where domain_event_id = '${orgWideEventId}')
           and user_id = '${ANALISTA_SB}'
         returning read_at`,
      );

      expect(rows[0]?.read_at).not.toBeNull();
    });

    it("usuário não marca a notificação de outro usuário como lida", async () => {
      const rows = await asUser<{ read_at: string | null }>(
        ANALISTA_SB,
        `update public.notification_recipients set read_at = now()
         where notification_id = (select id from public.notifications where domain_event_id = '${orgWideEventId}')
           and user_id = '${ADMIN_SB}'
         returning read_at`,
      );

      expect(rows).toHaveLength(0);
    });
  });

  describe("notification_preferences NÃO suprime o fan-out — recipient sempre criado (correção 2026-08-24, D-076)", () => {
    // Até a correção D-076, a preferência filtrava a criação de
    // notification_recipients aqui mesmo — contradizia docs/NOTIFICATIONS.md
    // secao 1 ("o registro na Central de Notificações continua existindo
    // para consulta, só o alerta em tempo real é que respeita a
    // preferência"). Agora o recipient é sempre criado; a preferência só é
    // consultada pelo cliente (apps/web/lib/notification-preferences.ts) na
    // hora de decidir se mostra o toast, nunca aqui na trigger.
    let suppressedEventId = "";
    let belowThresholdEventId = "";

    beforeAll(async () => {
      // ANALISTA desativa listing.price.changed por completo.
      await client.query(
        `insert into public.notification_preferences (user_id, event_type, enabled)
         values ($1, 'listing.price.changed', false)
         on conflict do nothing`,
        [ANALISTA_SB],
      );

      const suppressed = await client.query<{ id: string }>(
        `insert into public.domain_events
           (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
         values ($1, $2, now(), 'listing.price.changed', 'listing', 'MLB-rlstest-suprimido', 'informativo', 'sync', $3)
         returning id`,
        [ORG_SB, CONTA_A, `rlstest-notify:suprimido:${String(Date.now())}`],
      );
      suppressedEventId = suppressed.rows[0]?.id ?? "";

      // ADMIN pede severidade mínima "importante" para listing.title.changed na Conta A.
      await client.query(
        `insert into public.notification_preferences (user_id, event_type, ml_account_id, min_severity)
         values ($1, 'listing.title.changed', $2, 'importante')
         on conflict do nothing`,
        [ADMIN_SB, CONTA_A],
      );

      const belowThreshold = await client.query<{ id: string }>(
        `insert into public.domain_events
           (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
         values ($1, $2, now(), 'listing.title.changed', 'listing', 'MLB-rlstest-severidade', 'informativo', 'sync', $3)
         returning id`,
        [ORG_SB, CONTA_A, `rlstest-notify:severidade:${String(Date.now())}`],
      );
      belowThresholdEventId = belowThreshold.rows[0]?.id ?? "";
    });

    it("enabled=false NÃO impede o recipient — o histórico continua existindo mesmo silenciado", async () => {
      const recipients = await recipientsOf(suppressedEventId);

      expect(recipients).toContain(ADMIN_SB);
      expect(recipients).toContain(ANALISTA_SB);
    });

    it("severidade abaixo do mínimo pedido também NÃO impede o recipient", async () => {
      const recipients = await recipientsOf(belowThresholdEventId);

      expect(recipients).toContain(ANALISTA_SB);
      expect(recipients).toContain(ADMIN_SB);
    });
  });

  describe("notification_preferences é autoatendida (sem RPC)", () => {
    it("usuário gerencia a própria preferência", async () => {
      const rows = await asUserPersist<{ id: string }>(
        ANALISTA_SB,
        `insert into public.notification_preferences (user_id, min_severity)
         values ('${ANALISTA_SB}', 'critico') returning id`,
      );

      expect(rows).toHaveLength(1);
    });

    it("usuário não cria preferência para outro usuário", async () => {
      await expect(
        asUser(
          ANALISTA_SB,
          `insert into public.notification_preferences (user_id, min_severity)
           values ('${ADMIN_SB}', 'critico')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it("usuário não vê preferência de outro", async () => {
      const rows = await asUser(
        ANALISTA_SB,
        `select id from public.notification_preferences where user_id = '${ADMIN_SB}'`,
      );

      expect(rows).toHaveLength(0);
    });
  });
});

describe("ai_runs (observabilidade de custo do Copiloto, D-077)", () => {
  // Linhas próprias desta suíte, sem afterAll de limpeza — mesma convenção
  // já aceita no resto do arquivo ("o ambiente local acumula até o
  // próximo supabase db reset --local").
  let analistaRunId = "";
  let adminRunId = "";

  beforeAll(async () => {
    const analistaRun = await client.query<{ id: string }>(
      `insert into public.ai_runs (organization_id, user_id, tool_names, scope, latency_ms)
       values ($1, $2, array['sales_summary'], '{"dateFrom":"2026-08-01","dateTo":"2026-08-24"}'::jsonb, 42)
       returning id`,
      [ORG_SB, ANALISTA_SB],
    );
    analistaRunId = analistaRun.rows[0]?.id ?? "";

    const adminRun = await client.query<{ id: string }>(
      `insert into public.ai_runs (organization_id, user_id, tool_names, scope, latency_ms)
       values ($1, $2, array['sales_period_comparison'], '{"dateFrom":"2026-08-01","dateTo":"2026-08-24"}'::jsonb, 88)
       returning id`,
      [ORG_SB, ADMIN_SB],
    );
    adminRunId = adminRun.rows[0]?.id ?? "";
  });

  it("usuário vê a própria execução", async () => {
    const rows = await asUser<{ id: string }>(
      ANALISTA_SB,
      `select id from public.ai_runs where id = '${analistaRunId}'`,
    );

    expect(rows).toHaveLength(1);
  });

  it("usuário sem ADMIN/GESTOR não vê a execução de outro", async () => {
    const rows = await asUser<{ id: string }>(ANALISTA_SB, `select id from public.ai_runs where id = '${adminRunId}'`);

    expect(rows).toHaveLength(0);
  });

  it("ADMIN vê a execução de qualquer membro da própria organização", async () => {
    const rows = await asUser<{ id: string }>(
      ADMIN_SB,
      `select id from public.ai_runs where id = '${analistaRunId}'`,
    );

    expect(rows).toHaveLength(1);
  });

  it("usuário de outra organização não vê nada, nem sendo ADMIN lá", async () => {
    const rows = await asUser<{ id: string }>(
      DE_OUTRA_ORG,
      `select id from public.ai_runs where organization_id = '${ORG_SB}'`,
    );

    expect(rows).toHaveLength(0);
  });

  it("anon não vê ai_runs", async () => {
    await expect(asAnon("select * from public.ai_runs")).rejects.toThrow(/permission denied/i);
  });

  it("authenticated não insere direto — só o service_role (a api grava depois de cada chamada)", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `insert into public.ai_runs (organization_id, user_id, tool_names, scope, latency_ms)
         values ('${ORG_SB}', '${ADMIN_SB}', array['sales_summary'], '{}'::jsonb, 1)`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("feature_suggestions (Sugestões de features, D-079)", () => {
  // Linhas próprias desta suíte, sem afterAll de limpeza — mesma convenção
  // já aceita no resto do arquivo.
  let analistaSuggestionId = "";

  beforeAll(async () => {
    const inserted = await client.query<{ id: string }>(
      `insert into public.feature_suggestions (organization_id, created_by, original_text)
       values ($1, $2, 'Seria ótimo ter um filtro por marca na tela de estoque.')
       returning id`,
      [ORG_SB, ANALISTA_SB],
    );
    analistaSuggestionId = inserted.rows[0]?.id ?? "";
  });

  it("qualquer membro insere a própria sugestão, com o texto original preservado", async () => {
    const rows = await asUserPersist<{ id: string; original_text: string; status: string }>(
      ANALISTA_SB,
      `insert into public.feature_suggestions (organization_id, created_by, original_text)
       values ('${ORG_SB}', '${ANALISTA_SB}', 'Outra ideia de melhoria, em texto livre.')
       returning id, original_text, status`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.original_text).toBe("Outra ideia de melhoria, em texto livre.");
    expect(rows[0]?.status).toBe("nova");
  });

  it("usuário não insere sugestão em nome de outro usuário", async () => {
    await expect(
      asUser(
        ANALISTA_SB,
        `insert into public.feature_suggestions (organization_id, created_by, original_text)
         values ('${ORG_SB}', '${ADMIN_SB}', 'Tentando enviar como outro usuário.')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("qualquer membro da organização vê as sugestões de todos, não só as próprias", async () => {
    const rows = await asUser<{ id: string }>(
      ADMIN_SB,
      `select id from public.feature_suggestions where id = '${analistaSuggestionId}'`,
    );

    expect(rows).toHaveLength(1);
  });

  it("usuário de outra organização não vê nada", async () => {
    const rows = await asUser<{ id: string }>(
      DE_OUTRA_ORG,
      `select id from public.feature_suggestions where id = '${analistaSuggestionId}'`,
    );

    expect(rows).toHaveLength(0);
  });

  it("ANALISTA não muda o status — só ADMIN/GESTOR pode triar", async () => {
    // UPDATE bloqueado por RLS não lança: a cláusula USING filtra a linha
    // como se não existisse para este usuário, então o UPDATE afeta ZERO
    // linhas em vez de rejeitar — mesmo comportamento já documentado em
    // "usuário não marca a notificação de outro usuário como lida" (D-073).
    // Diferente do INSERT acima, cujo WITH CHECK rejeita de verdade.
    const rows = await asUser<{ status: string }>(
      ANALISTA_SB,
      `update public.feature_suggestions set status = 'em_analise' where id = '${analistaSuggestionId}' returning status`,
    );

    expect(rows).toHaveLength(0);
  });

  it("ADMIN muda o status de uma sugestão de outro membro", async () => {
    const rows = await asUserPersist<{ status: string }>(
      ADMIN_SB,
      `update public.feature_suggestions set status = 'em_analise' where id = '${analistaSuggestionId}' returning status`,
    );

    expect(rows[0]?.status).toBe("em_analise");
  });

  it("anon não vê nem insere", async () => {
    await expect(asAnon("select * from public.feature_suggestions")).rejects.toThrow(/permission denied/i);
    await expect(
      asAnon(
        `insert into public.feature_suggestions (organization_id, created_by, original_text)
         values ('${ORG_SB}', '${ANALISTA_SB}', 'anon tentando inserir')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("support read model (Fase 7B, D-085; modelo D-084)", () => {
  const ACCOUNT_A = "f7011111-0000-4000-8000-000000000001";
  const ACCOUNT_B = "f7022222-0000-4000-8000-000000000002";
  const ACCOUNT_OTHER = "f7033333-0000-4000-8000-000000000003";

  const CASE_A = "f7111111-0000-4000-8000-000000000001";
  const CASE_B = "f7122222-0000-4000-8000-000000000002";
  const CASE_OTHER = "f7133333-0000-4000-8000-000000000003";
  const MESSAGE_A = "f7211111-0000-4000-8000-000000000001";
  const MESSAGE_B = "f7222222-0000-4000-8000-000000000002";
  const EVENT_A = "f7311111-0000-4000-8000-000000000001";
  const EVENT_B = "f7322222-0000-4000-8000-000000000002";
  const SKU_B = "f7411111-0000-4000-8000-000000000001";
  const LISTING_B = "f7511111-0000-4000-8000-000000000001";
  const ORDER_B = 9984002002;

  const SUPPORT_TABLES = [
    "support_cases",
    "support_messages",
    "support_case_links",
    "support_case_deadlines",
    "support_attachments",
    "support_case_events",
  ] as const;

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts
         (id, organization_id, label, slug, seller_id, status, connected_at)
       values
         ($1, $4, 'Support A', 'supporttest-conta-a', 840001, 'CONNECTED', now()),
         ($2, $4, 'Support B', 'supporttest-conta-b', 840002, 'CONNECTED', now()),
         ($3, $5, 'Support Other', 'supporttest-conta-other', 840003, 'CONNECTED', now())
       on conflict (id) do nothing`,
      [ACCOUNT_A, ACCOUNT_B, ACCOUNT_OTHER, ORG_SB, ORG_OUTRA],
    );

    await client.query(
      `insert into public.user_account_permissions (user_id, ml_account_id)
       values ($1, $2)
       on conflict do nothing`,
      [ANALISTA_SB, ACCOUNT_A],
    );

    await client.query(
      `insert into public.skus (id, organization_id, sku, kind, title)
       values ($1, $2, 'SUPPORTTEST-SKU-B', 'PRODUTO', 'SKU de suporte B')
       on conflict (id) do nothing`,
      [SKU_B, ORG_SB],
    );

    await client.query(
      `insert into public.orders
         (id, organization_id, ml_account_id, status, date_created,
          date_last_updated, total_amount, paid_amount, currency_id)
       values ($1, $2, $3, 'paid', now(), now(), 100, 100, 'BRL')
       on conflict (id) do nothing`,
      [ORDER_B, ORG_SB, ACCOUNT_B],
    );

    await client.query(
      `insert into public.listings
         (id, organization_id, ml_account_id, item_id, sku_id, title,
          status, price, currency_id, available_quantity)
       values ($1, $2, $3, 'MLB9984002002', $4, 'Anúncio suporte B',
               'active', 100, 'BRL', 10)
       on conflict (id) do nothing`,
      [LISTING_B, ORG_SB, ACCOUNT_B, SKU_B],
    );

    await client.query(
      `insert into public.support_cases
         (id, organization_id, ml_account_id, channel, external_case_key,
          external_case_id, external_status, internal_status, priority,
          remote_unread_count, last_activity_at)
       values
         ($1, $4, $5, 'POST_SALE_MESSAGE', 'message:order:9984001001',
          '9984001001', 'active', 'NOVO', 'NORMAL', 1, now()),
         ($2, $4, $6, 'CLAIM', 'claim:840002',
          '840002', 'opened', 'NOVO', 'CRITICA', 1, now()),
         ($3, $7, $8, 'QUESTION', 'question:840003',
          '840003', 'UNANSWERED', 'NOVO', 'NORMAL', 1, now())
       on conflict (id) do nothing`,
      [CASE_A, CASE_B, CASE_OTHER, ORG_SB, ACCOUNT_A, ACCOUNT_B, ORG_OUTRA, ACCOUNT_OTHER],
    );

    await client.query(
      `insert into public.support_messages
         (id, organization_id, ml_account_id, support_case_id,
          external_message_key, external_message_id, direction, sender_kind,
          body, body_state, occurred_at)
       values
         ($1, $5, $6, $3, 'message:mlb-support-a-1', 'mlb-support-a-1',
          'INBOUND', 'CUSTOMER', 'Mensagem A', 'AVAILABLE', now()),
         ($2, $5, $7, $4, 'claim-message:mlb-support-b-1', 'mlb-support-b-1',
          'INBOUND', 'CUSTOMER', 'Mensagem B', 'AVAILABLE', now())
       on conflict (id) do nothing`,
      [MESSAGE_A, MESSAGE_B, CASE_A, CASE_B, ORG_SB, ACCOUNT_A, ACCOUNT_B],
    );

    await client.query(
      `insert into public.support_case_links
         (organization_id, ml_account_id, support_case_id,
          external_entity_kind, external_entity_id, link_source)
       values
         ($1, $2, $3, 'ORDER', '9984001001', 'REMOTE'),
         ($1, $4, $5, 'RETURN', 'return-840002', 'REMOTE')
       on conflict do nothing`,
      [ORG_SB, ACCOUNT_A, CASE_A, ACCOUNT_B, CASE_B],
    );

    await client.query(
      `insert into public.support_case_links
         (organization_id, ml_account_id, support_case_id, order_id, link_source)
       values ($1, $2, $3, $4, 'REMOTE')
       on conflict do nothing`,
      [ORG_SB, ACCOUNT_B, CASE_B, ORDER_B],
    );

    await client.query(
      `insert into public.support_case_links
         (organization_id, ml_account_id, support_case_id, sku_id, link_source)
       values ($1, $2, $3, $4, 'ORDER_DERIVED')
       on conflict do nothing`,
      [ORG_SB, ACCOUNT_B, CASE_B, SKU_B],
    );

    await client.query(
      `insert into public.support_case_links
         (organization_id, ml_account_id, support_case_id, listing_id, link_source)
       values ($1, $2, $3, $4, 'LISTING_DERIVED')
       on conflict do nothing`,
      [ORG_SB, ACCOUNT_B, CASE_B, LISTING_B],
    );

    await client.query(
      `insert into public.support_case_deadlines
         (organization_id, ml_account_id, support_case_id, deadline_kind,
          source, policy_key, started_at, status)
       values ($1, $2, $3, 'NEXT_ACTION', 'ML_MESSAGE_RULE',
               'MLB_AGENT_48_BUSINESS_HOURS', now(), 'ACTIVE')
       on conflict do nothing`,
      [ORG_SB, ACCOUNT_A, CASE_A],
    );

    await client.query(
      `insert into public.support_case_deadlines
         (organization_id, ml_account_id, support_case_id, deadline_kind,
          source, source_reference, due_at, status)
       values ($1, $2, $3, 'NEXT_ACTION', 'ML_AVAILABLE_ACTION',
               'respond', now() + interval '1 day', 'ACTIVE')
       on conflict do nothing`,
      [ORG_SB, ACCOUNT_B, CASE_B],
    );

    await client.query(
      `insert into public.support_attachments
         (organization_id, ml_account_id, support_message_id,
          external_attachment_key, file_name, mime_type, size_bytes)
       values
         ($1, $2, $3, 'attachment-a', 'a.pdf', 'application/pdf', 100),
         ($1, $4, $5, 'attachment-b', 'b.txt', 'text/plain', 20)
       on conflict do nothing`,
      [ORG_SB, ACCOUNT_A, MESSAGE_A, ACCOUNT_B, MESSAGE_B],
    );

    await client.query(
      `insert into public.support_case_events
         (id, organization_id, ml_account_id, support_case_id,
          event_type, source, after, occurred_at, dedup_key)
       values
         ($1, $3, $4, $5, 'CASE_CREATED', 'RECONCILIATION',
          '{"status":"NOVO"}'::jsonb, now(), 'supporttest:event:a'),
         ($2, $3, $6, $7, 'CASE_CREATED', 'WEBHOOK',
          '{"status":"NOVO"}'::jsonb, now(), 'supporttest:event:b')
       on conflict (id) do nothing`,
      [EVENT_A, EVENT_B, ORG_SB, ACCOUNT_A, CASE_A, ACCOUNT_B, CASE_B],
    );
  });

  describe("RLS e GRANTs", () => {
    it.each(SUPPORT_TABLES)("ANALISTA vê somente a Conta A em %s", async (table) => {
      const rows = await asUser<{ ml_account_id: string }>(
        ANALISTA_SB,
        `select distinct ml_account_id from public.${table}
         where organization_id = '${ORG_SB}'
           and ml_account_id in ('${ACCOUNT_A}', '${ACCOUNT_B}')
         order by ml_account_id`,
      );

      expect(rows).toEqual([{ ml_account_id: ACCOUNT_A }]);
    });

    it.each(SUPPORT_TABLES)("ADMIN vê as duas contas da organização em %s", async (table) => {
      const rows = await asUser<{ ml_account_id: string }>(
        ADMIN_SB,
        `select distinct ml_account_id from public.${table}
         where organization_id = '${ORG_SB}'
           and ml_account_id in ('${ACCOUNT_A}', '${ACCOUNT_B}')
         order by ml_account_id`,
      );

      expect(rows).toEqual([{ ml_account_id: ACCOUNT_A }, { ml_account_id: ACCOUNT_B }]);
    });

    it.each(SUPPORT_TABLES)("ADMIN de outra organização não vê a Speed Bikers em %s", async (table) => {
      const rows = await asUser(
        DE_OUTRA_ORG,
        `select id from public.${table} where organization_id = '${ORG_SB}'`,
      );

      expect(rows).toHaveLength(0);
    });

    it.each(SUPPORT_TABLES)("anon não lê %s", async (table) => {
      await expect(asAnon(`select * from public.${table}`)).rejects.toThrow(/permission denied/i);
    });

    it("authenticated tem SELECT e nenhum privilégio de escrita nas seis tabelas", async () => {
      const rows = await client.query<{
        table_name: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(`
        select table_name,
               has_table_privilege('authenticated', 'public.' || table_name, 'select') as can_select,
               has_table_privilege('authenticated', 'public.' || table_name, 'insert') as can_insert,
               has_table_privilege('authenticated', 'public.' || table_name, 'update') as can_update,
               has_table_privilege('authenticated', 'public.' || table_name, 'delete') as can_delete
        from unnest(array[${SUPPORT_TABLES.map((table) => `'${table}'`).join(",")}]) as table_name
      `);

      expect(rows.rows).toHaveLength(SUPPORT_TABLES.length);
      expect(rows.rows.every((row) => row.can_select)).toBe(true);
      expect(rows.rows.every((row) => !row.can_insert && !row.can_update && !row.can_delete)).toBe(true);
    });

    it("service_role não tem UPDATE/DELETE em support_case_events", async () => {
      const rows = await client.query<{ can_insert: boolean; can_update: boolean; can_delete: boolean }>(`
        select
          has_table_privilege('service_role', 'public.support_case_events', 'insert') as can_insert,
          has_table_privilege('service_role', 'public.support_case_events', 'update') as can_update,
          has_table_privilege('service_role', 'public.support_case_events', 'delete') as can_delete
      `);

      expect(rows.rows[0]).toEqual({ can_insert: true, can_update: false, can_delete: false });
    });

    it("authenticated não insere case direto", async () => {
      await expect(
        asUser(
          ADMIN_SB,
          `insert into public.support_cases
             (organization_id, ml_account_id, channel, external_case_key,
              external_case_id, last_activity_at)
           values ('${ORG_SB}', '${ACCOUNT_A}', 'QUESTION',
                   'question:999999', '999999', now())`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  describe("coerência e idempotência físicas", () => {
    it("FK composta recusa mensagem que declara conta diferente do case", async () => {
      await expect(
        client.query(
          `insert into public.support_messages
             (organization_id, ml_account_id, support_case_id,
              external_message_key, direction, sender_kind, occurred_at)
           values ($1, $2, $3, 'message:wrong-scope', 'INBOUND', 'CUSTOMER', now())`,
          [ORG_SB, ACCOUNT_B, CASE_A],
        ),
      ).rejects.toThrow(/support_messages_case_scope_fkey/i);
    });

    it("link tipado recusa pedido de outra conta", async () => {
      await expect(
        client.query(
          `insert into public.support_case_links
             (organization_id, ml_account_id, support_case_id, order_id, link_source)
           values ($1, $2, $3, $4, 'REMOTE')`,
          [ORG_SB, ACCOUNT_A, CASE_A, ORDER_B],
        ),
      ).rejects.toThrow(/pedido fora da organização\/conta/i);
    });

    it("link exige exatamente um alvo", async () => {
      await expect(
        client.query(
          `insert into public.support_case_links
             (organization_id, ml_account_id, support_case_id,
              external_entity_kind, external_entity_id, order_id, link_source)
           values ($1, $2, $3, 'ORDER', 'duplicado', $4, 'REMOTE')`,
          [ORG_SB, ACCOUNT_B, CASE_B, ORDER_B],
        ),
      ).rejects.toThrow(/support_case_links_exactly_one_target/i);
    });

    it("faceta de mediação/devolução só existe em CLAIM", async () => {
      await expect(
        client.query(
          `insert into public.support_cases
             (organization_id, ml_account_id, channel, external_case_key,
              external_case_id, is_mediation, last_activity_at)
           values ($1, $2, 'QUESTION', 'question:999998', '999998', true, now())`,
          [ORG_SB, ACCOUNT_A],
        ),
      ).rejects.toThrow(/support_cases_claim_facets_coherent/i);
    });

    it("mesma chave externa não cria dois cases", async () => {
      await expect(
        client.query(
          `insert into public.support_cases
             (organization_id, ml_account_id, channel, external_case_key,
              external_case_id, last_activity_at)
           values ($1, $2, 'POST_SALE_MESSAGE',
                   'message:order:9984001001', '9984001001', now())`,
          [ORG_SB, ACCOUNT_A],
        ),
      ).rejects.toThrow(/support_cases_external_identity_unique/i);
    });

    it("mesma chave externa não cria duas mensagens no case", async () => {
      await expect(
        client.query(
          `insert into public.support_messages
             (organization_id, ml_account_id, support_case_id,
              external_message_key, direction, sender_kind, occurred_at)
           values ($1, $2, $3, 'message:mlb-support-a-1',
                   'INBOUND', 'CUSTOMER', now())`,
          [ORG_SB, ACCOUNT_A, CASE_A],
        ),
      ).rejects.toThrow(/support_messages_external_identity_unique/i);
    });

    it("deadline com source_reference NULL também é idempotente", async () => {
      await expect(
        client.query(
          `insert into public.support_case_deadlines
             (organization_id, ml_account_id, support_case_id,
              deadline_kind, source, policy_key, status)
           values ($1, $2, $3, 'NEXT_ACTION', 'ML_MESSAGE_RULE',
                   'MLB_AGENT_48_BUSINESS_HOURS', 'ACTIVE')`,
          [ORG_SB, ACCOUNT_A, CASE_A],
        ),
      ).rejects.toThrow(/support_case_deadlines_identity_unique/i);
    });

    it("mesma chave de anexo não duplica metadado", async () => {
      await expect(
        client.query(
          `insert into public.support_attachments
             (organization_id, ml_account_id, support_message_id,
              external_attachment_key)
           values ($1, $2, $3, 'attachment-a')`,
          [ORG_SB, ACCOUNT_A, MESSAGE_A],
        ),
      ).rejects.toThrow(/support_attachments_external_identity_unique/i);
    });

    it("mesma dedup_key não duplica evento", async () => {
      await expect(
        client.query(
          `insert into public.support_case_events
             (organization_id, ml_account_id, support_case_id,
              event_type, source, occurred_at, dedup_key)
           values ($1, $2, $3, 'CASE_CREATED', 'RECONCILIATION',
                   now(), 'supporttest:event:a')`,
          [ORG_SB, ACCOUNT_A, CASE_A],
        ),
      ).rejects.toThrow(/support_case_events_dedup_unique/i);
    });

    it("support_case_events é append-only até para o dono da tabela", async () => {
      await expect(
        client.query(
          `update public.support_case_events
           set event_type = 'TAMPERED'
           where id = $1`,
          [EVENT_A],
        ),
      ).rejects.toThrow(/append-only/i);

      await expect(
        client.query("delete from public.support_case_events where id = $1", [EVENT_B]),
      ).rejects.toThrow(/append-only/i);
    });

    it("UPSERT repetido de Pergunta converge para o mesmo case e a mesma mensagem", async () => {
      const firstCase = await client.query<{ id: string }>(
        `insert into public.support_cases
           (organization_id, ml_account_id, channel, external_case_key,
            external_case_id, external_status, internal_status, priority,
            last_activity_at)
         values ($1, $2, 'QUESTION', 'question:8499001', '8499001',
                 'UNANSWERED', 'NOVO', 'NORMAL', '2026-08-25T18:00:00Z')
         on conflict (organization_id, ml_account_id, channel, external_case_key)
         do update set external_status = excluded.external_status,
                       last_activity_at = excluded.last_activity_at
         returning id`,
        [ORG_SB, ACCOUNT_A],
      );

      const secondCase = await client.query<{ id: string }>(
        `insert into public.support_cases
           (organization_id, ml_account_id, channel, external_case_key,
            external_case_id, external_status, internal_status, priority,
            last_activity_at)
         values ($1, $2, 'QUESTION', 'question:8499001', '8499001',
                 'ANSWERED', 'NOVO', 'NORMAL', '2026-08-25T18:05:00Z')
         on conflict (organization_id, ml_account_id, channel, external_case_key)
         do update set external_status = excluded.external_status,
                       last_activity_at = excluded.last_activity_at
         returning id`,
        [ORG_SB, ACCOUNT_A],
      );

      expect(secondCase.rows[0]?.id).toBe(firstCase.rows[0]?.id);

      const supportCaseId = firstCase.rows[0]?.id;
      await client.query(
        `insert into public.support_messages
           (organization_id, ml_account_id, support_case_id,
            external_message_key, external_message_id, direction, sender_kind,
            body, body_state, remote_status, occurred_at)
         values ($1, $2, $3, 'question:8499001:question', '8499001',
                 'INBOUND', 'CUSTOMER', 'texto inicial', 'AVAILABLE',
                 'UNANSWERED', '2026-08-25T18:00:00Z')
         on conflict (support_case_id, external_message_key)
         do update set body = excluded.body,
                       remote_status = excluded.remote_status`,
        [ORG_SB, ACCOUNT_A, supportCaseId],
      );
      await client.query(
        `insert into public.support_messages
           (organization_id, ml_account_id, support_case_id,
            external_message_key, external_message_id, direction, sender_kind,
            body, body_state, remote_status, occurred_at)
         values ($1, $2, $3, 'question:8499001:question', '8499001',
                 'INBOUND', 'CUSTOMER', 'texto atualizado', 'AVAILABLE',
                 'ANSWERED', '2026-08-25T18:00:00Z')
         on conflict (support_case_id, external_message_key)
         do update set body = excluded.body,
                       remote_status = excluded.remote_status`,
        [ORG_SB, ACCOUNT_A, supportCaseId],
      );

      const result = await client.query<{ count: string; body: string; remote_status: string }>(
        `select count(*) over ()::text as count, body, remote_status
         from public.support_messages
         where support_case_id = $1
           and external_message_key = 'question:8499001:question'`,
        [supportCaseId],
      );

      expect(result.rows).toEqual([
        { count: "1", body: "texto atualizado", remote_status: "ANSWERED" },
      ]);
    });
  });
  describe("triage_support_case (Fase 7B, D-094)", () => {
    // Case dedicado: os outros do describe são lidos por testes de RLS que
    // esperam `internal_status = 'NOVO'`, e a triagem MUDA estado de verdade
    // (asUserPersist commita).
    const CASE_TRIAGE = "f7144444-0000-4000-8000-000000000004";

    // Ator dedicado, FORA do padrão `%@rls.test` que a limpeza global apaga —
    // mesma técnica de `RESPONSAVEL_AJUSTE` (D-065). Aqui o motivo é ainda
    // mais direto: `support_case_events.actor_user_id` é
    // `on delete set null`, e um SET NULL é um UPDATE — que o trigger
    // append-only de `support_case_events` RECUSA. Apagar o perfil de quem
    // triou quebraria a limpeza de TODA a suíte.
    //
    // Isso expõe um defeito latente do schema de D-085, registrado em D-094:
    // em produção, um usuário que já triou não pode ser removido, e o erro
    // que aparece fala de append-only, não de usuário em uso.
    const TRIADOR = "dddddddd-0000-4000-8000-000000000009";

    beforeAll(async () => {
      await client.query(
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                email_confirmed_at, raw_user_meta_data, created_at, updated_at)
         values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
                 'triador@supporttest.local','x',now(),'{"full_name":"Triador Supporttest"}',now(),now())
         on conflict (id) do nothing`,
        [TRIADOR],
      );

      await client.query(
        `insert into public.organization_members (organization_id, user_id, role)
         values ($1,$2,'GESTOR') on conflict do nothing`,
        [ORG_SB, TRIADOR],
      );

      // GESTOR não alcança conta por si só — `has_account_access` é
      // automático apenas para ADMIN (D-054). Precisa da permissão explícita,
      // que é justamente o que a triagem exige além do papel.
      await client.query(
        `insert into public.user_account_permissions (user_id, ml_account_id)
         values ($1, $2) on conflict do nothing`,
        [TRIADOR, ACCOUNT_A],
      );

      await client.query(
        `insert into public.support_cases
           (id, organization_id, ml_account_id, channel, external_case_key,
            external_case_id, external_status, internal_status, priority,
            remote_unread_count, last_activity_at)
         values ($1, $2, $3, 'QUESTION', 'question:840777', '840777',
                 'UNANSWERED', 'NOVO', 'NORMAL', 0, now())
         on conflict (id) do nothing`,
        [CASE_TRIAGE, ORG_SB, ACCOUNT_A],
      );
    });

    it("ADMIN tria: muda status E grava o evento na MESMA transação", async () => {
      await asUserPersist(
        TRIADOR,
        `select public.triage_support_case('${CASE_TRIAGE}'::uuid, 'EM_ATENDIMENTO')`,
      );

      const caso = await client.query<{ internal_status: string; resolved_at: string | null }>(
        `select internal_status, resolved_at from public.support_cases where id = $1`,
        [CASE_TRIAGE],
      );

      expect(caso.rows[0]?.internal_status).toBe("EM_ATENDIMENTO");
      expect(caso.rows[0]?.resolved_at).toBeNull();

      // O evento é o ponto da RPC existir: sem ele, um UPDATE solto teria o
      // mesmo efeito visível e perderia quem decidiu.
      const evento = await client.query<{ event_type: string; source: string; actor_user_id: string }>(
        `select event_type, source, actor_user_id from public.support_case_events
         where support_case_id = $1 order by created_at desc limit 1`,
        [CASE_TRIAGE],
      );

      expect(evento.rows[0]).toMatchObject({
        event_type: "support.case.triaged",
        source: "USER",
        actor_user_id: TRIADOR,
      });
    });

    it("RESOLVIDO preenche resolved_at sozinho — a interface não precisa saber da constraint", async () => {
      await asUserPersist(
        TRIADOR,
        `select public.triage_support_case('${CASE_TRIAGE}'::uuid, 'RESOLVIDO')`,
      );

      const caso = await client.query<{ resolved_at: string | null }>(
        `select resolved_at from public.support_cases where id = $1`,
        [CASE_TRIAGE],
      );

      expect(caso.rows[0]?.resolved_at).not.toBeNull();
    });

    it("reabrir limpa resolved_at — senão a constraint recusaria a própria reabertura", async () => {
      await asUserPersist(
        TRIADOR,
        `select public.triage_support_case('${CASE_TRIAGE}'::uuid, 'AGUARDANDO_CLIENTE')`,
      );

      const caso = await client.query<{ internal_status: string; resolved_at: string | null }>(
        `select internal_status, resolved_at from public.support_cases where id = $1`,
        [CASE_TRIAGE],
      );

      expect(caso.rows[0]).toEqual({ internal_status: "AGUARDANDO_CLIENTE", resolved_at: null });
    });

    it("atribui e depois libera o responsável", async () => {
      await asUserPersist(
        TRIADOR,
        `select public.triage_support_case('${CASE_TRIAGE}'::uuid, null, null, '${TRIADOR}'::uuid)`,
      );

      const atribuido = await client.query<{ assignee_id: string | null }>(
        `select assignee_id from public.support_cases where id = $1`,
        [CASE_TRIAGE],
      );
      expect(atribuido.rows[0]?.assignee_id).toBe(TRIADOR);

      await asUserPersist(
        TRIADOR,
        `select public.triage_support_case('${CASE_TRIAGE}'::uuid, null, null, null, true)`,
      );

      const liberado = await client.query<{ assignee_id: string | null }>(
        `select assignee_id from public.support_cases where id = $1`,
        [CASE_TRIAGE],
      );
      expect(liberado.rows[0]?.assignee_id).toBeNull();
    });

    it("chamada que não muda nada NÃO gera evento — histórico só guarda decisão real", async () => {
      const antes = await client.query<{ total: string }>(
        `select count(*)::text as total from public.support_case_events where support_case_id = $1`,
        [CASE_TRIAGE],
      );

      await asUserPersist(
        TRIADOR,
        `select public.triage_support_case('${CASE_TRIAGE}'::uuid, 'AGUARDANDO_CLIENTE')`,
      );

      const depois = await client.query<{ total: string }>(
        `select count(*)::text as total from public.support_case_events where support_case_id = $1`,
        [CASE_TRIAGE],
      );

      expect(depois.rows[0]?.total).toBe(antes.rows[0]?.total);
    });

    it("ANALISTA com acesso à conta é recusado pelo PAPEL", async () => {
      // ANALISTA_SB tem user_account_permissions em ACCOUNT_A: alcança o
      // atendimento para LER, mas triagem é ADMIN/GESTOR/OPERADOR (D-084).
      await expect(
        asUserPersist(
          ANALISTA_SB,
          `select public.triage_support_case('${CASE_TRIAGE}'::uuid, 'RESOLVIDO')`,
        ),
      ).rejects.toThrow(/papel sem permissao/i);
    });

    it("usuário sem acesso à conta é recusado ANTES do papel", async () => {
      await expect(
        asUserPersist(
          SEM_ORG,
          `select public.triage_support_case('${CASE_TRIAGE}'::uuid, 'RESOLVIDO')`,
        ),
      ).rejects.toThrow(/sem permissao para este atendimento/i);
    });

    it("status fora dos cinco valores é recusado", async () => {
      await expect(
        asUserPersist(
          TRIADOR,
          `select public.triage_support_case('${CASE_TRIAGE}'::uuid, 'FECHADO')`,
        ),
      ).rejects.toThrow(/status interno invalido/i);
    });

    it("responsável de OUTRA organização é recusado", async () => {
      // Sem esta checagem, o atendimento apareceria na lista de "meus
      // atendimentos" de alguém de fora da organização.
      await expect(
        asUserPersist(
          TRIADOR,
          `select public.triage_support_case('${CASE_TRIAGE}'::uuid, null, null, '${DE_OUTRA_ORG}'::uuid)`,
        ),
      ).rejects.toThrow(/nao pertence a esta organizacao/i);
    });

    it("atribuir e desatribuir na mesma chamada é recusado", async () => {
      await expect(
        asUserPersist(
          TRIADOR,
          `select public.triage_support_case('${CASE_TRIAGE}'::uuid, null, null, '${TRIADOR}'::uuid, true)`,
        ),
      ).rejects.toThrow(/atribuir e desatribuir/i);
    });

    it("anon não executa a RPC", async () => {
      await expect(
        asAnon(`select public.triage_support_case('${CASE_TRIAGE}'::uuid, 'RESOLVIDO')`),
      ).rejects.toThrow(/permission denied/i);
    });
  });
  describe("support_reply_attempts (Fase 7B, D-096)", () => {
    // Ator fora do padrao `%@rls.test`: `requested_by` e `on delete restrict`
    // (escolha de D-096, para o bloqueio ser explicito em vez de virar um erro
    // sobre append-only, como o defeito achado em D-094). Apagar este perfil
    // quebraria a limpeza global da suite.
    const RESPONDENTE = "dddddddd-0000-4000-8000-00000000000a";
    const ATTEMPT_OK = "eeeeeeee-0000-4000-8000-00000000000a";

    beforeAll(async () => {
      await client.query(
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                                email_confirmed_at, raw_user_meta_data, created_at, updated_at)
         values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
                 'respondente@supporttest.local','x',now(),'{"full_name":"Respondente Supporttest"}',now(),now())
         on conflict (id) do nothing`,
        [RESPONDENTE],
      );

      await client.query(
        `insert into public.organization_members (organization_id, user_id, role)
         values ($1,$2,'OPERADOR') on conflict do nothing`,
        [ORG_SB, RESPONDENTE],
      );

      await client.query(
        `insert into public.user_account_permissions (user_id, ml_account_id)
         values ($1, $2) on conflict do nothing`,
        [RESPONDENTE, ACCOUNT_A],
      );

      await client.query(
        `insert into public.support_reply_attempts
           (id, organization_id, ml_account_id, support_case_id, client_request_id,
            requested_by, final_text, status)
         values ($1, $2, $3, $4, 'req-d096-ok', $5, 'Serve sim, amigo.', 'PENDING')
         on conflict (id) do nothing`,
        [ATTEMPT_OK, ORG_SB, ACCOUNT_A, CASE_A, RESPONDENTE],
      );
    });

    it("PENDING nao pode nascer com desfecho preenchido", async () => {
      await expect(
        client.query(
          `insert into public.support_reply_attempts
             (organization_id, ml_account_id, support_case_id, client_request_id,
              requested_by, final_text, status, remote_message_id)
           values ($1,$2,$3,'req-d096-incoerente',$4,'texto','PENDING','123')`,
          [ORG_SB, ACCOUNT_A, CASE_A, RESPONDENTE],
        ),
      ).rejects.toThrow(/outcome_coherent/i);
    });

    it("SUCCEEDED exige resolved_at; FAILED exige error_code", async () => {
      await expect(
        client.query(
          `insert into public.support_reply_attempts
             (organization_id, ml_account_id, support_case_id, client_request_id,
              requested_by, final_text, status)
           values ($1,$2,$3,'req-d096-sem-resolved',$4,'texto','SUCCEEDED')`,
          [ORG_SB, ACCOUNT_A, CASE_A, RESPONDENTE],
        ),
      ).rejects.toThrow(/outcome_coherent/i);

      await expect(
        client.query(
          `insert into public.support_reply_attempts
             (organization_id, ml_account_id, support_case_id, client_request_id,
              requested_by, final_text, status, resolved_at)
           values ($1,$2,$3,'req-d096-sem-erro',$4,'texto','FAILED',now())`,
          [ORG_SB, ACCOUNT_A, CASE_A, RESPONDENTE],
        ),
      ).rejects.toThrow(/outcome_coherent/i);
    });

    it("texto acima de 2.000 caracteres e recusado no banco, nao so na API", async () => {
      await expect(
        client.query(
          `insert into public.support_reply_attempts
             (organization_id, ml_account_id, support_case_id, client_request_id,
              requested_by, final_text)
           values ($1,$2,$3,'req-d096-longo',$4,repeat('a', 2001))`,
          [ORG_SB, ACCOUNT_A, CASE_A, RESPONDENTE],
        ),
      ).rejects.toThrow(/final_text/i);
    });

    it("o MESMO client_request_id na organizacao e recusado — e a garantia contra resposta duplicada", async () => {
      await expect(
        client.query(
          `insert into public.support_reply_attempts
             (organization_id, ml_account_id, support_case_id, client_request_id,
              requested_by, final_text)
           values ($1,$2,$3,'req-d096-ok',$4,'outro texto')`,
          [ORG_SB, ACCOUNT_A, CASE_A, RESPONDENTE],
        ),
      ).rejects.toThrow(/client_request_unique/i);
    });

    it("DELETE e recusado ate para o dono da tabela", async () => {
      await expect(
        client.query(`delete from public.support_reply_attempts where id=$1`, [ATTEMPT_OK]),
      ).rejects.toThrow(/append-only/i);
    });

    it("UPDATE nao pode alterar o texto enviado nem quem pediu", async () => {
      await expect(
        client.query(
          `update public.support_reply_attempts set final_text='texto trocado' where id=$1`,
          [ATTEMPT_OK],
        ),
      ).rejects.toThrow(/so o desfecho pode ser atualizado/i);
    });

    it("PENDING transiciona UMA vez para terminal, e o desfecho nao pode ser reescrito", async () => {
      const primeira = await client.query(
        `update public.support_reply_attempts
           set status='SUCCEEDED', remote_message_id='9001', resolved_at=now()
         where id=$1 returning status`,
        [ATTEMPT_OK],
      );

      expect(primeira.rows[0]).toEqual({ status: "SUCCEEDED" });

      // Reentrega do Cloud Tasks nao pode reescrever um desfecho ja registrado.
      await expect(
        client.query(
          `update public.support_reply_attempts
             set status='FAILED', error_code='x', error_message='y'
           where id=$1`,
          [ATTEMPT_OK],
        ),
      ).rejects.toThrow(/ja resolvida/i);
    });

    it("quem alcanca a conta le as tentativas; quem nao alcanca, nao", async () => {
      const permitido = await asUser(
        RESPONDENTE,
        `select id from public.support_reply_attempts where id='${ATTEMPT_OK}'`,
      );
      const negado = await asUser(
        DE_OUTRA_ORG,
        `select id from public.support_reply_attempts where id='${ATTEMPT_OK}'`,
      );

      expect(permitido).toHaveLength(1);
      expect(negado).toHaveLength(0);
    });

    it("authenticated NAO escreve direto — o envio passa pela api, nunca pela tela", async () => {
      await expect(
        asUser(
          RESPONDENTE,
          `insert into public.support_reply_attempts
             (organization_id, ml_account_id, support_case_id, client_request_id,
              requested_by, final_text)
           values ('${ORG_SB}','${ACCOUNT_A}','${CASE_A}','req-d096-direto','${RESPONDENTE}','texto')`,
        ),
      ).rejects.toThrow(/permission denied|violates row-level security/i);
    });

    it("anon nao acessa", async () => {
      await expect(
        asAnon("select * from public.support_reply_attempts"),
      ).rejects.toThrow(/permission denied/i);
    });
  });
});

describe("apply_support_remote_transition (D-102)", () => {
  const CONTA_D102 = "ddddaaaa-0000-4000-8000-0000000d1020";
  const CASE_RESPONDIDA_FORA = "eeeeeeee-0000-4000-8000-0000000d1021";
  const CASE_TRIADO = "eeeeeeee-0000-4000-8000-0000000d1022";
  const CASE_REABRIR = "eeeeeeee-0000-4000-8000-0000000d1023";

  beforeAll(async () => {
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, status)
       values ($1, $2, 'Conta D-102', 'd102test-conta', 'PENDING')
       on conflict do nothing`,
      [CONTA_D102, ORG_SB],
    );

    await client.query(
      `insert into public.support_cases
         (id, organization_id, ml_account_id, channel, external_case_key,
          external_case_id, external_status, internal_status, priority,
          remote_unread_count, last_activity_at, resolved_at)
       values
         ($1, $4, $5, 'QUESTION', 'question:9102000001', '9102000001', 'ANSWERED', 'NOVO', 'NORMAL', 0, now(), null),
         ($2, $4, $5, 'QUESTION', 'question:9102000002', '9102000002', 'ANSWERED', 'EM_ATENDIMENTO', 'NORMAL', 0, now(), null),
         ($3, $4, $5, 'POST_SALE_MESSAGE', 'message:pack:9102000003', '9102000003', 'active', 'RESOLVIDO', 'NORMAL', 0, now(), now())
       on conflict (id) do nothing`,
      [CASE_RESPONDIDA_FORA, CASE_TRIADO, CASE_REABRIR, ORG_SB, CONTA_D102],
    );
  });

  it("pergunta respondida fora da V3: NOVO vira RESOLVIDO, com evento atômico de source WEBHOOK sem ator", async () => {
    const applied = await client.query<{ apply_support_remote_transition: boolean }>(
      `select public.apply_support_remote_transition(
         $1, array['NOVO'], 'RESOLVIDO', 'WEBHOOK',
         'support.case.auto_resolved', 'auto-resolve:${CASE_RESPONDIDA_FORA}',
         '2026-08-27T12:00:00Z'
       )`,
      [CASE_RESPONDIDA_FORA],
    );

    expect(applied.rows[0]?.apply_support_remote_transition).toBe(true);

    const caso = await client.query<{ internal_status: string; resolved_at: string | null }>(
      "select internal_status, resolved_at from public.support_cases where id = $1",
      [CASE_RESPONDIDA_FORA],
    );
    expect(caso.rows[0]?.internal_status).toBe("RESOLVIDO");
    expect(caso.rows[0]?.resolved_at).not.toBeNull();

    const evento = await client.query<{ source: string; actor_user_id: string | null }>(
      "select source, actor_user_id from public.support_case_events where support_case_id = $1 and event_type = 'support.case.auto_resolved'",
      [CASE_RESPONDIDA_FORA],
    );
    expect(evento.rows).toHaveLength(1);
    expect(evento.rows[0]).toEqual({ source: "WEBHOOK", actor_user_id: null });
  });

  it("case triado por humano (EM_ATENDIMENTO) NÃO é tocado — devolve false sem evento", async () => {
    const applied = await client.query<{ apply_support_remote_transition: boolean }>(
      `select public.apply_support_remote_transition(
         $1, array['NOVO'], 'RESOLVIDO', 'RECONCILIATION',
         'support.case.auto_resolved', 'auto-resolve:${CASE_TRIADO}', now()
       )`,
      [CASE_TRIADO],
    );

    expect(applied.rows[0]?.apply_support_remote_transition).toBe(false);

    const caso = await client.query<{ internal_status: string }>(
      "select internal_status from public.support_cases where id = $1",
      [CASE_TRIADO],
    );
    expect(caso.rows[0]?.internal_status).toBe("EM_ATENDIMENTO");

    const eventos = await client.query(
      "select 1 from public.support_case_events where support_case_id = $1",
      [CASE_TRIADO],
    );
    expect(eventos.rows).toHaveLength(0);
  });

  it("reabertura por inbound: RESOLVIDO volta a NOVO e resolved_at é limpo (constraint satisfeita)", async () => {
    const applied = await client.query<{ apply_support_remote_transition: boolean }>(
      `select public.apply_support_remote_transition(
         $1, array['AGUARDANDO_CLIENTE','RESOLVIDO'], 'NOVO', 'RECONCILIATION',
         'support.case.auto_reopened', 'auto-reopen:${CASE_REABRIR}:t1', now()
       )`,
      [CASE_REABRIR],
    );

    expect(applied.rows[0]?.apply_support_remote_transition).toBe(true);

    const caso = await client.query<{ internal_status: string; resolved_at: string | null }>(
      "select internal_status, resolved_at from public.support_cases where id = $1",
      [CASE_REABRIR],
    );
    expect(caso.rows[0]).toEqual({ internal_status: "NOVO", resolved_at: null });
  });

  it("source USER é recusada — ação humana usa triage_support_case", async () => {
    await expect(
      client.query(
        `select public.apply_support_remote_transition(
           $1, array['NOVO'], 'RESOLVIDO', 'USER',
           'support.case.auto_resolved', 'auto-resolve:user-x', now()
         )`,
        [CASE_TRIADO],
      ),
    ).rejects.toThrow(/source invalida/i);
  });

  it("authenticated não executa — só o worker (service_role) reage a dado remoto", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `select public.apply_support_remote_transition(
           '${CASE_TRIADO}', array['NOVO'], 'RESOLVIDO', 'WEBHOOK',
           'support.case.auto_resolved', 'auto-resolve:x', now()
         )`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("reply_templates (Templates de resposta, D-111)", () => {
  // Linhas próprias desta suíte, sem afterAll — mesma convenção do arquivo.
  let templateId = "";

  beforeAll(async () => {
    const inserted = await client.query<{ id: string }>(
      `insert into public.reply_templates (organization_id, created_by, name, body)
       values ($1, $2, 'Agradecimento D-111', 'Obrigado pelo contato!')
       returning id`,
      [ORG_SB, ADMIN_SB],
    );

    templateId = inserted.rows[0]?.id ?? "";
  });

  it("qualquer membro da organização lê os templates", async () => {
    const rows = await asUser<{ id: string }>(
      ANALISTA_SB,
      `select id from public.reply_templates where id = '${templateId}'`,
    );

    expect(rows).toHaveLength(1);
  });

  it("membro de OUTRA organização não vê", async () => {
    const rows = await asUser<{ id: string }>(
      DE_OUTRA_ORG,
      `select id from public.reply_templates where id = '${templateId}'`,
    );

    expect(rows).toHaveLength(0);
  });

  it("ADMIN cria template da própria organização", async () => {
    const rows = await asUserPersist<{ id: string }>(
      ADMIN_SB,
      `insert into public.reply_templates (organization_id, created_by, name, body)
       values ('${ORG_SB}', '${ADMIN_SB}', 'Criado pelo ADMIN D-111', 'Texto.')
       returning id`,
    );

    expect(rows).toHaveLength(1);
  });

  it("ANALISTA não cria — a policy exige ADMIN/GESTOR, não só membro", async () => {
    await expect(
      asUser(
        ANALISTA_SB,
        `insert into public.reply_templates (organization_id, created_by, name, body)
         values ('${ORG_SB}', '${ANALISTA_SB}', 'Tentativa do analista', 'Texto.')`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("ANALISTA não edita: RLS filtra e o UPDATE alcança zero linhas", async () => {
    const rows = await asUser<{ id: string }>(
      ANALISTA_SB,
      `update public.reply_templates set body = 'hackeado' where id = '${templateId}' returning id`,
    );

    expect(rows).toHaveLength(0);
  });

  it("ANALISTA não apaga pelo mesmo motivo", async () => {
    const rows = await asUser<{ id: string }>(
      ANALISTA_SB,
      `delete from public.reply_templates where id = '${templateId}' returning id`,
    );

    expect(rows).toHaveLength(0);
  });

  it("ADMIN edita e o updated_at anda sozinho (trigger)", async () => {
    const rows = await asUserPersist<{ moved: boolean }>(
      ADMIN_SB,
      `update public.reply_templates
         set body = 'Obrigado pelo contato! Editado.'
       where id = '${templateId}'
       returning updated_at > created_at as moved`,
    );

    expect(rows[0]?.moved).toBe(true);
  });

  it("nome repetido na organização é recusado pela UNIQUE", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `insert into public.reply_templates (organization_id, created_by, name, body)
         values ('${ORG_SB}', '${ADMIN_SB}', 'Agradecimento D-111', 'Duplicado.')`,
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("anon não lê nada — o GRANT foi revogado, nem RLS chega a rodar", async () => {
    await client.query("begin");

    try {
      await client.query("set local role anon");
      await expect(client.query("select id from public.reply_templates")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query("rollback");
    }
  });
});

describe("knowledge_entries (Base de Conhecimento Validada, D-113)", () => {
  let entryId = "";

  beforeAll(async () => {
    const inserted = await client.query<{ id: string }>(
      `insert into public.knowledge_entries (organization_id, created_by, kind, content, source)
       values ($1, $2, 'POLITICA', 'Troca em até 30 dias com nota fiscal.', 'CONFIRMACAO_INTERNA')
       returning id`,
      [ORG_SB, ADMIN_SB],
    );

    entryId = inserted.rows[0]?.id ?? "";
  });

  it("qualquer membro lê; outra organização não", async () => {
    const proprio = await asUser<{ id: string }>(
      ANALISTA_SB,
      `select id from public.knowledge_entries where id = '${entryId}'`,
    );
    const alheio = await asUser<{ id: string }>(
      DE_OUTRA_ORG,
      `select id from public.knowledge_entries where id = '${entryId}'`,
    );

    expect(proprio).toHaveLength(1);
    expect(alheio).toHaveLength(0);
  });

  it("qualquer membro SUGERE — o conhecimento nasce da operação inteira", async () => {
    const rows = await asUserPersist<{ status: string }>(
      ANALISTA_SB,
      `insert into public.knowledge_entries (organization_id, created_by, kind, content, source)
       values ('${ORG_SB}', '${ANALISTA_SB}', 'COMPATIBILIDADE', 'Compatível com CB 500X 2020+.', 'ATENDIMENTO')
       returning status`,
    );

    expect(rows[0]?.status).toBe("SUGERIDO");
  });

  it("nascer VALIDADO é recusado pela POLICY — validação nunca vem no insert", async () => {
    await expect(
      asUser(
        ANALISTA_SB,
        `insert into public.knowledge_entries (organization_id, created_by, kind, content, source, status, confirmed_by, confirmed_at)
         values ('${ORG_SB}', '${ANALISTA_SB}', 'OUTRO', 'burlando', 'CONFIRMACAO_INTERNA', 'VALIDADO', '${ANALISTA_SB}', now())`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("ANALISTA não valida: RLS filtra e o UPDATE alcança zero linhas", async () => {
    const rows = await asUser<{ id: string }>(
      ANALISTA_SB,
      `update public.knowledge_entries
         set status = 'VALIDADO', confirmed_by = '${ANALISTA_SB}', confirmed_at = now()
       where id = '${entryId}' returning id`,
    );

    expect(rows).toHaveLength(0);
  });

  it("ADMIN valida, com quem/quando gravados", async () => {
    const rows = await asUserPersist<{ status: string; confirmed_by: string }>(
      ADMIN_SB,
      `update public.knowledge_entries
         set status = 'VALIDADO', confirmed_by = '${ADMIN_SB}', confirmed_at = now()
       where id = '${entryId}' returning status, confirmed_by`,
    );

    expect(rows[0]?.status).toBe("VALIDADO");
    expect(rows[0]?.confirmed_by).toBe(ADMIN_SB);
  });

  it("VALIDADO sem confirmador é recusado pela constraint — confirmação anônima não existe", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `update public.knowledge_entries
           set status = 'VALIDADO', confirmed_by = null, confirmed_at = null
         where id = '${entryId}'`,
      ),
    ).rejects.toThrow(/knowledge_entries_validation_coherent/i);
  });

  it("DELETE não existe para authenticated — conhecimento errado vira REJEITADO/OBSOLETO", async () => {
    await expect(
      asUser(ADMIN_SB, `delete from public.knowledge_entries where id = '${entryId}'`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("get_support_metrics (Métricas de SAC, D-115)", () => {
  it("membro recebe UMA linha com todos os campos", async () => {
    const rows = await asUser<{ abertos_total: string; prazos_vencidos: string }>(
      ADMIN_SB,
      "select abertos_total, prazos_vencidos from public.get_support_metrics(7)",
    );

    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.abertos_total)).toBeGreaterThanOrEqual(0);
  });

  it("security invoker: a RLS decide o escopo — outra organização não conta os cases da nossa", async () => {
    // A fixture de support cria cases nas DUAS organizações (`CASE_OTHER` é
    // da ORG_OUTRA), então "zero para o vizinho" nunca foi a propriedade
    // certa — a versão anterior deste teste pedia 0 e era impossível de
    // passar. A propriedade real é IGUALDADE: o vizinho conta exatamente os
    // cases DELE, nem um a mais. Derivar o esperado do banco em vez de
    // fixar um número mantém o teste válido quando a fixture crescer.
    const propriosDaOutra = await client.query<{ abertos: string }>(
      `select count(*)::int as abertos from public.support_cases
        where organization_id = $1 and internal_status <> 'RESOLVIDO'`,
      [ORG_OUTRA],
    );

    const nossos = await asUser<{ abertos_total: string }>(
      ADMIN_SB,
      "select abertos_total from public.get_support_metrics(7)",
    );
    const alheios = await asUser<{ abertos_total: string }>(
      DE_OUTRA_ORG,
      "select abertos_total from public.get_support_metrics(7)",
    );

    expect(Number(nossos[0]?.abertos_total)).toBeGreaterThan(0);
    expect(Number(alheios[0]?.abertos_total)).toBe(Number(propriosDaOutra.rows[0]?.abertos));
    // E o vizinho conta MENOS que nós — a prova de que não enxerga os nossos.
    expect(Number(alheios[0]?.abertos_total)).toBeLessThan(Number(nossos[0]?.abertos_total));
  });

  it("anon não executa — o EXECUTE foi revogado", async () => {
    await client.query("begin");

    try {
      await client.query("set local role anon");
      await expect(client.query("select * from public.get_support_metrics(7)")).rejects.toThrow(
        /permission denied/i,
      );
    } finally {
      await client.query("rollback");
    }
  });
});

describe("republicação — listing_relists (Fase 9, D-159)", () => {
  // Ator e conta DEDICADOS, nunca apagados: `requested_by` e `ml_account_id`
  // são `on delete restrict`, e os eventos são append-only — mesmo
  // raciocínio de ADMIN_COMPRAS/observabilidade (reusar ADMIN_SB quebraria a
  // limpeza global). Sem afterAll, como manda o precedente.
  const ADMIN_RELIST = "ffff1111-0000-4000-8000-000000000031";
  const CONTA_RELIST = "ffff2222-0000-4000-8000-000000000032";

  let relistId = "";

  beforeAll(async () => {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'admin@relisttest.internal','x',now(),'{"full_name":"Admin de relist"}',now(),now())
       on conflict (id) do nothing`,
      [ADMIN_RELIST],
    );

    await client.query(
      `insert into public.organization_members (organization_id, user_id, role)
       values ($1,$2,'ADMIN') on conflict do nothing`,
      [ORG_SB, ADMIN_RELIST],
    );

    // Slug FORA do padrão de limpeza global ('rlstest%'): esta conta fica
    // referenciada por `listing_relists` com `on delete restrict`, então a
    // limpeza a pularia com erro — mesmo raciocínio de 'syncobs-conta'.
    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
       values ($1,$2,'Conta de relist','relist-conta',991,'CONNECTED',now())
       on conflict do nothing`,
      [CONTA_RELIST, ORG_SB],
    );

    const inserted = await client.query<{ id: string }>(
      `insert into public.listing_relists
         (organization_id, ml_account_id, parent_item_id, status, parent_snapshot, requested_by)
       values ($1,$2,'MLB910000001','REQUESTED','{"title":"pai"}',$3)
       returning id`,
      [ORG_SB, CONTA_RELIST, ADMIN_RELIST],
    );

    relistId = inserted.rows[0]?.id ?? "";

    await client.query(
      `insert into public.listing_relist_events
         (organization_id, ml_account_id, relist_id, from_status, to_status, actor_user_id)
       values ($1,$2,$3,null,'REQUESTED',$4)`,
      [ORG_SB, CONTA_RELIST, relistId, ADMIN_RELIST],
    );
  });

  it("membro da organização lê a operação e o histórico; outra organização não vê nada; anon é recusado", async () => {
    const own = await asUser<{ parent_item_id: string; status: string }>(
      ADMIN_RELIST,
      `select parent_item_id, status from public.listing_relists where id = '${relistId}'`,
    );
    expect(own).toEqual([{ parent_item_id: "MLB910000001", status: "REQUESTED" }]);

    const events = await asUser<{ to_status: string }>(
      ADMIN_RELIST,
      `select to_status from public.listing_relist_events where relist_id = '${relistId}'`,
    );
    expect(events).toEqual([{ to_status: "REQUESTED" }]);

    const outra = await asUser(DE_OUTRA_ORG, `select id from public.listing_relists`);
    expect(outra).toHaveLength(0);

    await expect(asAnon("select * from public.listing_relists")).rejects.toThrow(/permission denied/i);
    await expect(asAnon("select * from public.listing_relist_events")).rejects.toThrow(/permission denied/i);
  });

  it("authenticated não escreve direto — a escrita é do worker/RPC futura", async () => {
    await expect(
      asUser(
        ADMIN_RELIST,
        `insert into public.listing_relists
           (organization_id, ml_account_id, parent_item_id, parent_snapshot, requested_by)
         values ('${ORG_SB}','${CONTA_RELIST}','MLB910000099','{}','${ADMIN_RELIST}')`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("uma operação VIVA por pai — e o predicado do índice é RELIST_REOPENABLE_STATES do domínio", async () => {
    // Segunda operação para o MESMO pai com a primeira viva: rejeitada.
    await expect(
      client.query(
        `insert into public.listing_relists
           (organization_id, ml_account_id, parent_item_id, status, parent_snapshot, requested_by)
         values ($1,$2,'MLB910000001','REQUESTED','{}',$3)`,
        [ORG_SB, CONTA_RELIST, ADMIN_RELIST],
      ),
    ).rejects.toThrow(/one_live_per_parent/);

    // Primeira termina em estado REABRÍVEL (nada destrutivo no ML): nova
    // operação passa a ser permitida — a equivalência com o domínio.
    await client.query(`update public.listing_relists set status = 'PREFLIGHT_FAILED' where id = $1`, [relistId]);

    const second = await client.query<{ id: string }>(
      `insert into public.listing_relists
         (organization_id, ml_account_id, parent_item_id, status, parent_snapshot, requested_by)
       values ($1,$2,'MLB910000001','REQUESTED','{}',$3)
       returning id`,
      [ORG_SB, CONTA_RELIST, ADMIN_RELIST],
    );

    expect(second.rows).toHaveLength(1);

    // A nova é a VIVA agora; uma terceira é rejeitada de novo.
    await expect(
      client.query(
        `insert into public.listing_relists
           (organization_id, ml_account_id, parent_item_id, status, parent_snapshot, requested_by)
         values ($1,$2,'MLB910000001','REQUESTED','{}',$3)`,
        [ORG_SB, CONTA_RELIST, ADMIN_RELIST],
      ),
    ).rejects.toThrow(/one_live_per_parent/);
  });

  it("filho só existe a partir de RELISTED, e nunca pertence a duas operações", async () => {
    // Filho com status de meio de caminho: mentira estrutural, rejeitada.
    await expect(
      client.query(
        `insert into public.listing_relists
           (organization_id, ml_account_id, parent_item_id, child_item_id, status, parent_snapshot, requested_by)
         values ($1,$2,'MLB910000002','MLB910000102','CLOSING','{}',$3)`,
        [ORG_SB, CONTA_RELIST, ADMIN_RELIST],
      ),
    ).rejects.toThrow(/child_requires_state/);

    await client.query(
      `insert into public.listing_relists
         (organization_id, ml_account_id, parent_item_id, child_item_id, status, parent_snapshot, requested_by)
       values ($1,$2,'MLB910000002','MLB910000102','RELISTED','{}',$3)`,
      [ORG_SB, CONTA_RELIST, ADMIN_RELIST],
    );

    // O MESMO filho numa segunda operação (outro pai): rejeitado.
    await expect(
      client.query(
        `insert into public.listing_relists
           (organization_id, ml_account_id, parent_item_id, child_item_id, status, parent_snapshot, requested_by)
         values ($1,$2,'MLB910000003','MLB910000102','RELISTED','{}',$3)`,
        [ORG_SB, CONTA_RELIST, ADMIN_RELIST],
      ),
    ).rejects.toThrow(/child_unique/);
  });

  it("o histórico é append-only de verdade — UPDATE e DELETE rejeitados até para o superusuário", async () => {
    await expect(
      client.query(`update public.listing_relist_events set reason = 'x' where relist_id = $1`, [relistId]),
    ).rejects.toThrow(/append-only/);

    await expect(
      client.query(`delete from public.listing_relist_events where relist_id = $1`, [relistId]),
    ).rejects.toThrow(/append-only/);
  });
});

describe("remapeamento do relist — complete_listing_relist_remap (D-163)", () => {
  // Fixtures dedicadas e permanentes (fora dos padrões de limpeza global):
  // relists/eventos são append-only ou RESTRICT — mesmo precedente do
  // describe de listing_relists acima.
  const ADMIN_REMAP = "ffff5555-0000-4000-8000-000000000041";
  const CONTA_REMAP = "ffff6666-0000-4000-8000-000000000042";
  const PAI_ITEM = "MLB920000001";
  const FILHO_ITEM = "MLB920000101";
  const PAI_VAR = "MLB920000002";
  const FILHO_VAR = "MLB920000102";

  let opItemId = "";
  let opVarId = "";
  let skuAId = "";

  function remapSql(relistId: string, childItemId: string, variations: string): string {
    return `select * from public.complete_listing_relist_remap(
      '${relistId}', 'Filho ${childItemId}', 'active', 150.00, 'BRL', 3, 'MLB1234', '${variations}'::jsonb)`;
  }

  beforeAll(async () => {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'admin@relistremap.internal','x',now(),'{"full_name":"Admin de remap"}',now(),now())
       on conflict (id) do nothing`,
      [ADMIN_REMAP],
    );

    await client.query(
      `insert into public.organization_members (organization_id, user_id, role)
       values ($1,$2,'ADMIN') on conflict do nothing`,
      [ORG_SB, ADMIN_REMAP],
    );

    await client.query(
      `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
       values ($1,$2,'Conta de remap','relist-remap-conta',992,'CONNECTED',now())
       on conflict do nothing`,
      [CONTA_REMAP, ORG_SB],
    );

    const skus = await client.query<{ id: string; sku_key: string }>(
      `insert into public.skus (organization_id, sku, kind)
       values ($1,'RELISTREMAP-A','PRODUTO'), ($1,'RELISTREMAP-B','PRODUTO')
       on conflict on constraint skus_org_key_unique do update set sku = excluded.sku
       returning id, sku_key`,
      [ORG_SB],
    );

    skuAId = skus.rows.find((row) => row.sku_key === "RELISTREMAP-A")?.id ?? "";
    const skuBId = skus.rows.find((row) => row.sku_key === "RELISTREMAP-B")?.id ?? "";

    // Pai 1: vínculo de ANÚNCIO INTEIRO. Pai 2: dois vínculos de VARIAÇÃO.
    await client.query(
      `insert into public.sku_listing_links (organization_id, ml_account_id, sku_id, ref_kind, item_id)
       values ($1,$2,$3,'ITEM',$4)
       on conflict do nothing`,
      [ORG_SB, CONTA_REMAP, skuAId, PAI_ITEM],
    );
    await client.query(
      `insert into public.sku_listing_links (organization_id, ml_account_id, sku_id, ref_kind, item_id, variation_id)
       values ($1,$2,$3,'ITEM',$4,'111'), ($1,$2,$3,'ITEM',$4,'222')
       on conflict do nothing`,
      [ORG_SB, CONTA_REMAP, skuBId, PAI_VAR],
    );

    const ops = await client.query<{ id: string; parent_item_id: string }>(
      `insert into public.listing_relists
         (organization_id, ml_account_id, parent_item_id, child_item_id, status, parent_snapshot, requested_by)
       values ($1,$2,$3,$4,'RELISTED','{}',$5), ($1,$2,$6,$7,'RELISTED','{}',$5)
       returning id, parent_item_id`,
      [ORG_SB, CONTA_REMAP, PAI_ITEM, FILHO_ITEM, ADMIN_REMAP, PAI_VAR, FILHO_VAR],
    );

    opItemId = ops.rows.find((row) => row.parent_item_id === PAI_ITEM)?.id ?? "";
    opVarId = ops.rows.find((row) => row.parent_item_id === PAI_VAR)?.id ?? "";
  });

  it("vínculo de ITEM inteiro: MESMO link_id passa a apontar ao filho, com REFERENCE_REMAPPED preservando o pai", async () => {
    const result = await client.query<{
      item_links_remapped: number;
      variation_links_retired: number;
      variation_candidates_created: number;
    }>(remapSql(opItemId, FILHO_ITEM, "[]"));

    expect(result.rows[0]).toMatchObject({
      item_links_remapped: 1,
      variation_links_retired: 0,
      variation_candidates_created: 0,
    });

    const link = await client.query<{ item_id: string; sku_id: string }>(
      `select item_id, sku_id from public.sku_listing_links
       where ml_account_id = $1 and ref_kind = 'ITEM' and item_id = $2`,
      [CONTA_REMAP, FILHO_ITEM],
    );
    expect(link.rows).toEqual([{ item_id: FILHO_ITEM, sku_id: skuAId }]);

    const event = await client.query<{ previous_item_id: string; reason: string }>(
      `select previous_item_id, reason from public.sku_listing_link_events
       where ml_account_id = $1 and event_type = 'REFERENCE_REMAPPED'`,
      [CONTA_REMAP],
    );
    expect(event.rows).toEqual([{ previous_item_id: PAI_ITEM, reason: "RELIST_ITEM_REMAPPED" }]);

    // A projeção do filho nasce já com o sku_id remapeado.
    const listing = await client.query<{ sku_id: string; status: string }>(
      `select sku_id, status from public.listings where ml_account_id = $1 and item_id = $2`,
      [CONTA_REMAP, FILHO_ITEM],
    );
    expect(listing.rows).toEqual([{ sku_id: skuAId, status: "active" }]);

    const op = await client.query<{ status: string }>(
      `select status from public.listing_relists where id = $1`,
      [opItemId],
    );
    expect(op.rows[0]?.status).toBe("REMAPPED");
  });

  it("idempotência: chamar de novo sobre REMAPPED devolve zeros sem erro e sem evento novo", async () => {
    const before = await client.query<{ n: string }>(
      `select count(*) as n from public.listing_relist_events where relist_id = $1`,
      [opItemId],
    );

    const again = await client.query<{ item_links_remapped: number }>(remapSql(opItemId, FILHO_ITEM, "[]"));

    expect(again.rows[0]?.item_links_remapped).toBe(0);

    const after = await client.query<{ n: string }>(
      `select count(*) as n from public.listing_relist_events where relist_id = $1`,
      [opItemId],
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("variações renovadas: vínculos antigos saem com REMOVED de supressão e cada id novo vira candidato RELIST", async () => {
    const result = await client.query<{
      item_links_remapped: number;
      variation_links_retired: number;
      variation_candidates_created: number;
    }>(remapSql(opVarId, FILHO_VAR, '[{"id":"901","channel_sku":"RELISTREMAP-B"},{"id":"902","channel_sku":null}]'));

    expect(result.rows[0]).toMatchObject({
      item_links_remapped: 0,
      variation_links_retired: 2,
      variation_candidates_created: 2,
    });

    const oldLinks = await client.query(
      `select 1 from public.sku_listing_links where ml_account_id = $1 and item_id = $2`,
      [CONTA_REMAP, PAI_VAR],
    );
    expect(oldLinks.rows).toHaveLength(0);

    const removed = await client.query<{ reason: string }>(
      `select reason from public.sku_listing_link_events
       where ml_account_id = $1 and item_id = $2 and event_type = 'REMOVED'`,
      [CONTA_REMAP, PAI_VAR],
    );
    expect(removed.rows).toEqual([
      { reason: "RELIST_VARIATION_RENEWED" },
      { reason: "RELIST_VARIATION_RENEWED" },
    ]);

    const candidates = await client.query<{ variation_id: string; sku_key: string; channel_sku: string | null }>(
      `select variation_id, sku_key, channel_sku from public.link_candidates
       where source = 'RELIST' and source_relist_id = $1 order by variation_id`,
      [opVarId],
    );
    expect(candidates.rows).toEqual([
      { variation_id: "901", sku_key: "RELISTREMAP-B", channel_sku: "RELISTREMAP-B" },
      { variation_id: "902", sku_key: "VARIACAO-902", channel_sku: null },
    ]);

    const op = await client.query<{ status: string }>(
      `select status from public.listing_relists where id = $1`,
      [opVarId],
    );
    expect(op.rows[0]?.status).toBe("REMAPPED");

    const transitionEvent = await client.query<{ reason: string }>(
      `select reason from public.listing_relist_events where relist_id = $1 and to_status = 'REMAPPED'`,
      [opVarId],
    );
    expect(transitionEvent.rows[0]?.reason).toBe("VARIATIONS_QUEUED:2");
  });

  it("authenticated não executa a transação — ela é do worker/service_role", async () => {
    await expect(asUser(ADMIN_REMAP, remapSql(opItemId, FILHO_ITEM, "[]"))).rejects.toThrow(
      /permission denied/i,
    );
  });

  it("coerência do candidato: RELIST com source_row_id (ou ERP_IMPORT sem) viola a constraint", async () => {
    await expect(
      client.query(
        `insert into public.link_candidates
           (organization_id, ml_account_id, source, source_row_id, source_relist_id, sku_key, ref_kind, item_id, variation_id)
         values ($1,$2,'RELIST',123,$3,'X','ITEM','${FILHO_VAR}','999')`,
        [ORG_SB, CONTA_REMAP, opVarId],
      ),
    ).rejects.toThrow(/source_coherent/);
  });
});

describe("movimentações — get_stock_movements (D-167)", () => {
  // Fixture permanente (movimentos são append-only; SKU referenciado por
  // RESTRICT) — nomes fora dos padrões de limpeza global, sem afterAll.
  const ATOR_MOV = "ffff7777-0000-4000-8000-000000000051";

  let skuMovId = "";

  beforeAll(async () => {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                              email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'ator@movtest.internal','x',now(),'{"full_name":"Ator de movimentos"}',now(),now())
       on conflict (id) do nothing`,
      [ATOR_MOV],
    );
    await client.query(
      `insert into public.organization_members (organization_id, user_id, role)
       values ($1,$2,'ADMIN') on conflict do nothing`,
      [ORG_SB, ATOR_MOV],
    );

    const sku = await client.query<{ id: string }>(
      `insert into public.skus (organization_id, sku, kind) values ($1,'MOVLIST-A','PRODUTO')
       on conflict on constraint skus_org_key_unique do update set sku = excluded.sku
       returning id`,
      [ORG_SB],
    );
    skuMovId = sku.rows[0]?.id ?? "";

    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type,
          source_type, source_id, idempotency_key, occurred_at, reason, created_by)
       values
         ($1,$2,'LOCAL',-2,'VENDA_ML','ORDER','9911001','movtest:venda:1','2026-08-15 12:00:00+00',null,null),
         ($1,$2,'LOCAL',5,'AJUSTE_MANUAL',null,null,'movtest:ajuste:1','2026-08-16 12:00:00+00','Contagem física',$3),
         ($1,$2,'LOCAL',1,'AJUSTE_RECONCILIACAO','RECONCILIATION','2026-08-17','movtest:reconc:1','2026-08-17 12:00:00+00',null,null)
       on conflict (idempotency_key) do nothing`,
      [ORG_SB, skuMovId, ATOR_MOV],
    );
  });

  it("extrato ordenado do mais recente, com contexto humano e contagem do conjunto filtrado", async () => {
    const rows = await asUser<{
      movement_type: string;
      qty_delta: string;
      sku: string;
      source_type: string | null;
      source_id: string | null;
      reason: string | null;
      created_by_name: string | null;
      total_count: string;
    }>(
      ATOR_MOV,
      `select movement_type, qty_delta, sku, source_type, source_id, reason, created_by_name, total_count
       from public.get_stock_movements('${ORG_SB}', 50, 0, 'MOVLIST-A')`,
    );

    expect(rows.map((r) => r.movement_type)).toEqual(["AJUSTE_RECONCILIACAO", "AJUSTE_MANUAL", "VENDA_ML"]);
    expect(rows.every((r) => r.total_count === "3")).toBe(true);
    // O ajuste manual carrega motivo E ator; a venda carrega a origem.
    const ajuste = rows.find((r) => r.movement_type === "AJUSTE_MANUAL");
    expect(ajuste).toMatchObject({ reason: "Contagem física", created_by_name: "Ator de movimentos" });
    const venda = rows.find((r) => r.movement_type === "VENDA_ML");
    expect(venda).toMatchObject({ source_type: "ORDER", source_id: "9911001", qty_delta: "-2.000" });
  });

  it("filtros por tipo e por período reduzem o conjunto E a contagem juntos", async () => {
    const porTipo = await asUser<{ movement_type: string; total_count: string }>(
      ATOR_MOV,
      `select movement_type, total_count
       from public.get_stock_movements('${ORG_SB}', 50, 0, 'MOVLIST-A', 'AJUSTE_MANUAL')`,
    );
    expect(porTipo).toHaveLength(1);
    expect(porTipo[0]).toMatchObject({ movement_type: "AJUSTE_MANUAL", total_count: "1" });

    const porPeriodo = await asUser<{ movement_type: string; total_count: string }>(
      ATOR_MOV,
      `select movement_type, total_count
       from public.get_stock_movements('${ORG_SB}', 50, 0, 'MOVLIST-A', null, null, null, '2026-08-15', '2026-08-16')`,
    );
    expect(porPeriodo.map((r) => r.movement_type).sort()).toEqual(["AJUSTE_MANUAL", "VENDA_ML"]);
    expect(porPeriodo[0]?.total_count).toBe("2");
  });

  it("paginação com contagem estável — a página muda, o total não", async () => {
    const pagina2 = await asUser<{ movement_type: string; total_count: string }>(
      ATOR_MOV,
      `select movement_type, total_count
       from public.get_stock_movements('${ORG_SB}', 1, 1, 'MOVLIST-A')`,
    );

    expect(pagina2).toHaveLength(1);
    expect(pagina2[0]).toMatchObject({ movement_type: "AJUSTE_MANUAL", total_count: "3" });
  });

  it("usuário de outra organização não vê os movimentos; anon é recusado", async () => {
    const outra = await asUser(
      DE_OUTRA_ORG,
      `select id from public.get_stock_movements('${ORG_SB}', 50, 0, 'MOVLIST-A')`,
    );
    expect(outra).toHaveLength(0);

    await expect(
      asAnon(`select * from public.get_stock_movements('${ORG_SB}')`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("guarda de GRANTs (D-066/D-098/D-130)", () => {
  // D-066 apertou 23 tabelas e o padrão foi REINTRODUZIDO nos dois dias
  // seguintes por migrations que não revogaram na criação (corrigido em
  // D-098). Uma auditoria pontual apanha o estoque de um dia; este teste
  // apanha toda tabela futura: privilégio de ESCRITA para `authenticated`
  // sem policy correspondente é superfície morta — a RLS nega de qualquer
  // jeito, então ou a policy deveria existir, ou o GRANT não deveria.
  //
  // A causa está medida em D-130 e é de catálogo, não de opinião:
  // `pg_default_acl` do schema `public` concede `arwdDxtm` a `authenticated`
  // em toda tabela criada pelo papel `postgres`. Um `grant select` explícito
  // NÃO desfaz isso — GRANTs são aditivos. Isso encerra a divergência com o
  // comentário da migration 20260825170000 ("Supabase 2026 não expõe tabela
  // nova por default"): não expõe é falso, e o default é o contrário.
  //
  // As consultas passam o OID da tabela para `has_table_privilege`, e não o
  // nome montado com `format('public.%I', ...)`. Isso não é estilo: com o
  // nome, o Postgres pode avaliar o predicado ANTES do filtro de schema
  // (a ordem de quals não é garantida) e o teste MORRE com
  // `relation "public.pg_statistic" does not exist` em vez de falhar
  // limpo — foi o que aconteceu ao rodar esta mesma consulta em D-130.
  it("nenhuma tabela de public da escrita a authenticated sem policy correspondente", async () => {
    const result = await client.query(
      `select c.relname as tablename, v.cmd
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       cross join (values ('INSERT'), ('UPDATE'), ('DELETE')) as v(cmd)
       where n.nspname = 'public'
         and c.relkind = 'r'
         and has_table_privilege('authenticated', c.oid, v.cmd)
         and not exists (
           select 1
           from pg_policies p
           where p.schemaname = 'public'
             and p.tablename = c.relname
             and (p.cmd = v.cmd or p.cmd = 'ALL')
             and (p.roles @> array['authenticated'::name] or p.roles @> array['public'::name])
         )
       order by c.relname, v.cmd`,
    );

    // Vazio = nenhum grant de escrita órfão. Cada linha que aparecer aqui
    // é uma combinação (tabela, comando) a revogar — ou uma policy que
    // deveria ter sido criada junto com o grant.
    expect(result.rows).toEqual([]);
  });

  // TRUNCATE é a exceção que derruba o consolo das rodadas anteriores.
  // D-066 e D-098 aceitaram o grant excessivo argumentando "a RLS nega de
  // qualquer jeito". Para TRUNCATE isso é FALSO: TRUNCATE não consulta
  // policy nenhuma, não respeita `using`, e nem os triggers append-only de
  // `domain_events`/`stock_movements` disparam nele. É o único privilégio de
  // escrita sem NENHUM backstop — por isso o invariante aqui é absoluto
  // (nunca, em tabela nenhuma) e não condicionado a policy.
  //
  // Medido em D-130 antes do revoke: 33 das 54 tabelas de `public` davam
  // TRUNCATE a `authenticated`, incluindo `orders`, `order_items`, `skus` e
  // `listings`.
  it("authenticated nao tem TRUNCATE em tabela nenhuma de public (D-130)", async () => {
    const result = await client.query(
      `select c.relname as tablename
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and has_table_privilege('authenticated', c.oid, 'TRUNCATE')
       order by c.relname`,
    );

    expect(result.rows).toEqual([]);
  });
});

describe("curadoria de catalogo (D-133)", () => {
  // As duas colunas que so uma PESSOA preenche escrevem por RPC `security
  // definer`: `skus` nao tem policy de escrita e `authenticated` so tem
  // SELECT. Se algum dia tiver, estes testes continuam sendo o contrato.
  const SKU_A = "dddddddd-0000-4000-8000-00000000d001";
  const SKU_B = "dddddddd-0000-4000-8000-00000000d002";
  const SKU_OUTRA_ORG = "dddddddd-0000-4000-8000-00000000d003";

  beforeAll(async () => {
    await client.query(
      `insert into public.skus (id, organization_id, sku, kind)
       values ($1,$2,'RLSTEST-CUR-A','PRODUTO'), ($3,$2,'RLSTEST-CUR-B','PRODUTO')
       on conflict (id) do nothing`,
      [SKU_A, ORG_SB, SKU_B],
    );

    await client.query(
      `insert into public.skus (id, organization_id, sku, kind)
       values ($1,$2,'RLSTEST-CUR-OUTRA','PRODUTO')
       on conflict (id) do nothing`,
      [SKU_OUTRA_ORG, ORG_OUTRA],
    );
  });

  it("anon nao executa nenhuma das cinco — o GRANT e a primeira barreira", async () => {
    for (const chamada of [
      `select * from public.get_sku_curation('${ORG_SB}')`,
      `select * from public.get_sku_curation_summary('${ORG_SB}')`,
      `select * from public.set_skus_stock_virtual('${ORG_SB}', array['${SKU_A}']::uuid[], 'VIRTUAL')`,
      `select * from public.set_skus_supplier_brand('${ORG_SB}', array['${SKU_A}']::uuid[], 'X')`,
    ]) {
      await expect(asAnon(chamada)).rejects.toThrow(/permission denied/i);
    }
  });

  it("ANALISTA e recusado nas quatro — leitura tambem, porque a tela projeta erp_stock_snapshots", async () => {
    // `security invoker` faria a tela aparecer VAZIA em vez de NEGAR, e tela
    // vazia mente. Por isso ate a LEITURA exige ADMIN/GESTOR aqui.
    for (const chamada of [
      `select * from public.get_sku_curation('${ORG_SB}')`,
      `select * from public.get_sku_curation_summary('${ORG_SB}')`,
      `select * from public.set_skus_stock_virtual('${ORG_SB}', array['${SKU_A}']::uuid[], 'VIRTUAL')`,
      `select * from public.set_skus_supplier_brand('${ORG_SB}', array['${SKU_A}']::uuid[], 'X')`,
    ]) {
      await expect(asUser(ANALISTA_SB, chamada)).rejects.toThrow(/sem permissao/i);
    }
  });

  it("ADMIN de OUTRA organizacao e recusado", async () => {
    await expect(
      asUser(DE_OUTRA_ORG, `select * from public.get_sku_curation('${ORG_SB}')`),
    ).rejects.toThrow(/sem permissao/i);
  });

  it("classificar grava e SOBREVIVE ao commit, com data e ator", async () => {
    const linhas = await asUserPersist<{ sku_id: string; status: string }>(
      ADMIN_SB,
      `select * from public.set_skus_stock_virtual('${ORG_SB}', array['${SKU_A}']::uuid[], 'VIRTUAL')`,
    );

    expect(linhas).toEqual([{ sku_id: SKU_A, status: "APLICADO" }]);

    const depois = await client.query<{ v: boolean; at: Date | null; by: string | null }>(
      `select stock_is_virtual as v, stock_is_virtual_set_at as at, stock_is_virtual_set_by as by
         from public.skus where id = $1`,
      [SKU_A],
    );

    expect(depois.rows[0]?.v).toBe(true);
    expect(depois.rows[0]?.at).not.toBeNull();
    expect(depois.rows[0]?.by).toBe(ADMIN_SB);
  });

  it("segunda chamada identica devolve JA_DECIDIDO — o no-op fica VISIVEL", async () => {
    // Sem o retorno por linha, "412 marcados" poderia significar 8.
    const linhas = await asUserPersist<{ sku_id: string; status: string }>(
      ADMIN_SB,
      `select * from public.set_skus_stock_virtual('${ORG_SB}', array['${SKU_A}']::uuid[], 'VIRTUAL')`,
    );

    expect(linhas).toEqual([{ sku_id: SKU_A, status: "JA_DECIDIDO" }]);
  });

  it("reafirmar FISICO sobre um SKU NUNCA DECIDIDO e decisao nova, nao no-op", async () => {
    // `stock_is_virtual` ja e `false` por default. O que muda e a DATA: e o
    // clique que tira o SKU da fila de pendentes.
    const linhas = await asUserPersist<{ sku_id: string; status: string }>(
      ADMIN_SB,
      `select * from public.set_skus_stock_virtual('${ORG_SB}', array['${SKU_B}']::uuid[], 'FISICO')`,
    );

    expect(linhas).toEqual([{ sku_id: SKU_B, status: "APLICADO" }]);
  });

  it("INDEFINIDO devolve a linha ao estado 'ninguem olhou'", async () => {
    await asUserPersist(
      ADMIN_SB,
      `select * from public.set_skus_stock_virtual('${ORG_SB}', array['${SKU_B}']::uuid[], 'INDEFINIDO')`,
    );

    const depois = await client.query<{ v: boolean; at: Date | null; by: string | null }>(
      `select stock_is_virtual as v, stock_is_virtual_set_at as at, stock_is_virtual_set_by as by
         from public.skus where id = $1`,
      [SKU_B],
    );

    expect(depois.rows[0]).toMatchObject({ v: false, at: null, by: null });
  });

  it("id de OUTRA organizacao volta NAO_ENCONTRADO sem derrubar o lote", async () => {
    // Desvio declarado dos precedentes de linha unica: abortar faria o
    // operador perder as outras 499 decisoes por causa de uma linha que ele
    // nem sabia que estava ali.
    const linhas = await asUserPersist<{ sku_id: string; status: string }>(
      ADMIN_SB,
      `select * from public.set_skus_stock_virtual(
         '${ORG_SB}', array['${SKU_A}','${SKU_OUTRA_ORG}']::uuid[], 'FISICO')
       order by sku_id`,
    );

    const porId = new Map(linhas.map((l) => [l.sku_id, l.status]));

    expect(porId.get(SKU_A)).toBe("APLICADO");
    expect(porId.get(SKU_OUTRA_ORG)).toBe("NAO_ENCONTRADO");

    const intacto = await client.query<{ at: Date | null }>(
      `select stock_is_virtual_set_at as at from public.skus where id = $1`,
      [SKU_OUTRA_ORG],
    );

    expect(intacto.rows[0]?.at).toBeNull();
  });

  it("marca grava MANUAL, normalizada, com data", async () => {
    const linhas = await asUserPersist<{ status: string }>(
      ADMIN_SB,
      `select status from public.set_skus_supplier_brand('${ORG_SB}', array['${SKU_A}']::uuid[], '  off racer ')`,
    );

    expect(linhas).toEqual([{ status: "APLICADO" }]);

    const depois = await client.query<{ b: string; s: string; at: Date | null }>(
      `select supplier_brand as b, supplier_brand_source as s, supplier_brand_set_at as at
         from public.skus where id = $1`,
      [SKU_A],
    );

    expect(depois.rows[0]).toMatchObject({ b: "OFF RACER", s: "MANUAL" });
    expect(depois.rows[0]?.at).not.toBeNull();
  });

  it("limpar marca zera as QUATRO colunas juntas — anular so o texto violaria o CHECK", async () => {
    // `skus_supplier_brand_source_coherent` exige os dois nulos ou os dois
    // preenchidos. Zerar so `supplier_brand` estouraria 23514 e derrubaria o
    // lote inteiro.
    await asUserPersist(
      ADMIN_SB,
      `select * from public.set_skus_supplier_brand('${ORG_SB}', array['${SKU_A}']::uuid[], '')`,
    );

    const depois = await client.query<{ b: string | null; s: string | null; at: Date | null; by: string | null }>(
      `select supplier_brand as b, supplier_brand_source as s,
              supplier_brand_set_at as at, supplier_brand_set_by as by
         from public.skus where id = $1`,
      [SKU_A],
    );

    expect(depois.rows[0]).toEqual({ b: null, s: null, at: null, by: null });
  });

  it("lote vazio e lote acima de 500 sao recusados na entrada", async () => {
    await expect(
      asUser(ADMIN_SB, `select * from public.set_skus_stock_virtual('${ORG_SB}', array[]::uuid[], 'VIRTUAL')`),
    ).rejects.toThrow(/selecao vazia/i);

    await expect(
      asUser(
        ADMIN_SB,
        `select * from public.set_skus_stock_virtual(
           '${ORG_SB}',
           (select array_agg(gen_random_uuid()) from generate_series(1, 501)),
           'VIRTUAL')`,
      ),
    ).rejects.toThrow(/selecao grande demais/i);
  });

  it("decisao fora da lista fechada e recusada", async () => {
    await expect(
      asUser(ADMIN_SB, `select * from public.set_skus_stock_virtual('${ORG_SB}', array['${SKU_A}']::uuid[], 'SIM')`),
    ).rejects.toThrow(/decisao invalida/i);
  });

  it("a fila devolve total_count do FILTRO, nao da pagina", async () => {
    const linhas = await asUser<{ total_count: string }>(
      ADMIN_SB,
      `select total_count from public.get_sku_curation('${ORG_SB}', null, false, null, null, null, 1, 0)`,
    );

    expect(linhas).toHaveLength(1);
    expect(Number(linhas[0]?.total_count ?? 0)).toBeGreaterThan(1);
  });

  it("o resumo separa a linha TOTAL da linha 'sem marca' — sao coisas diferentes", async () => {
    const linhas = await asUser<{ is_total: boolean; supplier_brand: string | null }>(
      ADMIN_SB,
      `select is_total, supplier_brand from public.get_sku_curation_summary('${ORG_SB}')`,
    );

    const totais = linhas.filter((l) => l.is_total);

    expect(totais).toHaveLength(1);
    expect(totais[0]?.supplier_brand).toBeNull();

    // E existe TAMBEM uma linha de marca nula que NAO e o total.
    expect(linhas.some((l) => !l.is_total && l.supplier_brand === null)).toBe(true);
  });
});

describe("ator de tabela append-only: on delete restrict (D-094/D-099)", () => {
  // E-mail FORA do padrão '%@rls.test' de propósito: o afterAll global
  // apaga esses usuários, e este ator fica referenciado por uma linha
  // append-only com `restrict` — apagá-lo é exatamente o que deve falhar.
  // Mesma técnica do ator dedicado de D-094 (e de D-065 antes dele).
  const ATOR_D099 = "dddddddd-0000-4000-8000-0000000d0990";

  let purchaseOrderId = "";

  beforeAll(async () => {
    await client.query(
      `insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                               email_confirmed_at, raw_user_meta_data, created_at, updated_at)
       values ($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',
               'ator-d099@restrict.teste','x',now(),'{"full_name":"Ator D-099"}',now(),now())
       on conflict (id) do nothing`,
      [ATOR_D099],
    );

    // `created_by` também é o ATOR dedicado, nunca ADMIN_SB:
    // `purchase_orders.created_by` é `on delete restrict` e o pedido fica
    // permanente (o DELETE cascatearia para `purchase_order_events`, que o
    // trigger append-only recusa) — com ADMIN_SB aqui, o `delete from
    // auth.users where email like '%@rls.test'` do afterAll GLOBAL passaria
    // a falhar. Foi exatamente o que a primeira rodada da CI pegou.
    const order = await client.query<{ id: string }>(
      `insert into public.purchase_orders (organization_id, created_by, notes)
       values ($1, $2, 'RLSTEST-D099 fixture')
       returning id`,
      [ORG_SB, ATOR_D099],
    );
    purchaseOrderId = order.rows[0]?.id ?? "";

    await client.query(
      `insert into public.purchase_order_events
         (organization_id, purchase_order_id, event_type, actor_user_id)
       values ($1, $2, 'CREATED', $3)`,
      [ORG_SB, purchaseOrderId, ATOR_D099],
    );
  });

  // Sem afterAll: a linha de evento é append-only e referencia o ator com
  // restrict — é justamente a irremovibilidade que o teste prova.

  it("deletar usuário com histórico falha com erro de FK, não com o erro enganoso de append-only", async () => {
    // Antes de D-099, o `on delete set null` disparava um UPDATE que o
    // trigger append-only recusava — o erro falava "Insira um novo evento"
    // sem mencionar que a causa era o usuário estar referenciado (defeito
    // registrado em D-094). Com `restrict`, o bloqueio continua (linha de
    // auditoria não sobrevive sem o ator), mas o diagnóstico é o correto.
    let raised: Error | null = null;

    try {
      await client.query("delete from public.profiles where id = $1", [ATOR_D099]);
    } catch (error) {
      raised = error as Error;
    }

    expect(raised).not.toBeNull();
    expect(raised?.message).toMatch(/foreign key/i);
    expect(raised?.message).not.toMatch(/append-only/i);
  });

  it("as duas FKs de ator em tabela append-only são restrict no catálogo", async () => {
    // Cobre também `support_case_events` sem montar um `support_case`
    // completo: o comportamento do RESTRICT é o mesmo do teste acima, o
    // que interessa aqui é provar que a migration trocou a ação das DUAS.
    const result = await client.query<{ conname: string; confdeltype: string }>(
      `select conname, confdeltype
       from pg_constraint
       where conname in ('support_case_events_actor_user_id_fkey',
                         'purchase_order_events_actor_user_id_fkey')
       order by conname`,
    );

    expect(result.rows).toEqual([
      { conname: "purchase_order_events_actor_user_id_fkey", confdeltype: "r" },
      { conname: "support_case_events_actor_user_id_fkey", confdeltype: "r" },
    ]);
  });
});

describe("replenishment_settings (Configuração de reposição, D-144)", () => {
  // Linhas próprias desta suíte, sem afterAll — mesma convenção do arquivo.
  // `organization_id` tem cascade de organizations e `sku_id` de skus, então
  // o teardown global não é bloqueado por estas linhas (diferente dos
  // ledgers — foi a lição de D-142).
  let settingId = "";

  beforeAll(async () => {
    const inserted = await client.query<{ id: string }>(
      `insert into public.replenishment_settings
         (organization_id, supplier_brand, lead_time_days, target_coverage_days, safety_stock_days)
       values ($1, 'NAVETEC', 60, 90, 15)
       returning id`,
      [ORG_SB],
    );

    settingId = inserted.rows[0]?.id ?? "";
  });

  it("qualquer membro da organização lê a configuração", async () => {
    const rows = await asUser<{ id: string }>(
      ANALISTA_SB,
      `select id from public.replenishment_settings where id = '${settingId}'`,
    );

    expect(rows).toHaveLength(1);
  });

  it("membro de OUTRA organização não vê", async () => {
    const rows = await asUser<{ id: string }>(
      DE_OUTRA_ORG,
      `select id from public.replenishment_settings where id = '${settingId}'`,
    );

    expect(rows).toHaveLength(0);
  });

  it("ADMIN cria o padrão da organização", async () => {
    const rows = await asUserPersist<{ id: string }>(
      ADMIN_SB,
      `insert into public.replenishment_settings
         (organization_id, lead_time_days, target_coverage_days)
       values ('${ORG_SB}', 15, 30)
       returning id`,
    );

    expect(rows).toHaveLength(1);
  });

  it("segundo padrão da organização é recusado — o índice parcial garante UM", async () => {
    await expect(
      asUser(
        ADMIN_SB,
        `insert into public.replenishment_settings
           (organization_id, lead_time_days, target_coverage_days)
         values ('${ORG_SB}', 10, 20)`,
      ),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("ANALISTA não cria — a policy exige ADMIN/GESTOR", async () => {
    await expect(
      asUser(
        ANALISTA_SB,
        `insert into public.replenishment_settings
           (organization_id, supplier_brand, lead_time_days, target_coverage_days)
         values ('${ORG_SB}', 'RT', 15, 30)`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("ANALISTA não edita: RLS filtra e o UPDATE alcança zero linhas", async () => {
    const rows = await asUser<{ id: string }>(
      ANALISTA_SB,
      `update public.replenishment_settings set lead_time_days = 1 where id = '${settingId}' returning id`,
    );

    expect(rows).toHaveLength(0);
  });

  it("marca com escopo E sku ao mesmo tempo é recusada — os escopos são exclusivos", async () => {
    await expect(
      client.query(
        `insert into public.replenishment_settings
           (organization_id, supplier_brand, sku_id, lead_time_days, target_coverage_days)
         values ($1, 'NAVETEC', (select id from public.skus limit 1), 15, 30)`,
        [ORG_SB],
      ),
    ).rejects.toThrow(/one_scope/i);
  });

  it("marca fora de caixa alta é recusada pelo CHECK — a normalização é obrigação de quem grava", async () => {
    await expect(
      client.query(
        `insert into public.replenishment_settings
           (organization_id, supplier_brand, lead_time_days, target_coverage_days)
         values ($1, 'navetec', 15, 30)`,
        [ORG_SB],
      ),
    ).rejects.toThrow(/check/i);
  });

  /**
   * O teto de excesso (D-148) abaixo da própria janela tornaria o estado
   * ADEQUADA impossível — toda cobertura na janela já contaria como excesso.
   * A contradição é recusada na ORIGEM, pelo CHECK, não descoberta na tela.
   */
  it("teto de excesso abaixo da janela (prazo+cobertura+segurança) é recusado pelo CHECK", async () => {
    await expect(
      client.query(
        `insert into public.replenishment_settings
           (organization_id, supplier_brand, lead_time_days, target_coverage_days, safety_stock_days, max_coverage_days)
         values ($1, 'RLSTETO', 15, 90, 15, 119)`,
        [ORG_SB],
      ),
    ).rejects.toThrow(/max_covers_window/i);
  });

  it("teto igual à janela é aceito, e nulo continua legítimo (excesso nunca afirmado)", async () => {
    const inserted = await client.query<{ id: string; max_coverage_days: number | null }>(
      `insert into public.replenishment_settings
         (organization_id, supplier_brand, lead_time_days, target_coverage_days, safety_stock_days, max_coverage_days)
       values ($1, 'RLSTETO', 15, 90, 15, 120)
       returning id, max_coverage_days`,
      [ORG_SB],
    );

    expect(inserted.rows[0]?.max_coverage_days).toBe(120);

    // Limpar o teto é edição legítima: volta a "não afirmar excesso".
    const cleared = await client.query<{ max_coverage_days: number | null }>(
      `update public.replenishment_settings set max_coverage_days = null
       where id = $1 returning max_coverage_days`,
      [inserted.rows[0]?.id],
    );

    expect(cleared.rows[0]?.max_coverage_days).toBeNull();

    await client.query(`delete from public.replenishment_settings where id = $1`, [inserted.rows[0]?.id]);
  });
});
