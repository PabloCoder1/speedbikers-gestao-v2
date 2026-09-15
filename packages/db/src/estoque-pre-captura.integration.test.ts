import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { resolveStockExportInstant } from "@sb/domain";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * D-351 — a guarda contra baixa de venda anterior ao snapshot do UpSeller, provada
 * contra o Postgres real.
 *
 * O que so o banco prova: os grants e o corte de `get_erp_stock_cutoffs`, que o corte
 * dela e o de `compute_erp_target_balances` sao o MESMO (senao a primeira reconciliacao
 * desfaz a guarda), o fan-out pulando `backfill`, as duas migrations de dados (o corte
 * da exportacao nos snapshots antigos e as notificacoes do backfill) e a compensacao F3,
 * que mora em `packages/db/scripts/` e nao e migration.
 *
 * Organizacoes, usuario e conta proprios (uuid aleatorio): este arquivo roda ao lado de
 * `rls.integration.test.ts`. As duas migrations de dados e a F3 rodam dentro de uma
 * transacao revertida, e as assercoes olham so as linhas deste arquivo.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`) e banco recriado.
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const RAIZ = new URL("../../../", import.meta.url);

const ORG_CORTE = randomUUID();
// Propria: os snapshots do teste da migration sao gravados de verdade, e mudariam o
// corte da organizacao que o teste da RPC confere.
const ORG_MIGRACAO = randomUUID();
const ORG_SEM_SNAPSHOT = randomUUID();
const ORG_F3 = randomUUID();
const ORG_RECONCILIADA = randomUUID();
const ADMIN = randomUUID();
const PREFIXO = `d351-${ORG_CORTE.slice(0, 8)}`;

let client: Client;

async function arquivo(caminho: string): Promise<string> {
  return readFile(new URL(caminho, RAIZ), "utf8");
}

async function comoPapel<T>(papel: "anon" | "authenticated" | "service_role", sql: string): Promise<T[]> {
  await client.query("begin");

  try {
    await client.query(`set local role ${papel}`);

    if (papel === "authenticated") {
      await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: ADMIN })]);
    }

    const result = await client.query(sql);

    return result.rows as T[];
  } finally {
    await client.query("rollback");
  }
}

async function umId(sql: string, params: unknown[]): Promise<string> {
  const result = await client.query<{ id: string }>(sql, params);
  const id = result.rows[0]?.id;

  if (id === undefined) {
    throw new Error(`fixture sem id: ${sql}`);
  }

  return id;
}

async function novaOrganizacao(id: string, nome: string): Promise<void> {
  await client.query(`insert into public.organizations (id, name, slug) values ($1, $2, $3)`, [
    id,
    `${PREFIXO} ${nome}`,
    `${PREFIXO}-${nome}`,
  ]);
  await client.query(`insert into public.organization_members (organization_id, user_id, role) values ($1, $2, 'ADMIN')`, [
    id,
    ADMIN,
  ]);
}

async function novoSku(organizationId: string, nome: string): Promise<string> {
  return umId(`insert into public.skus (organization_id, sku, kind) values ($1, $2, 'PRODUTO') returning id`, [
    organizationId,
    `${PREFIXO}-${nome}`,
  ]);
}

async function novoLote(organizationId: string, nome: string, parsedAt: string | null = null): Promise<string> {
  return umId(
    `insert into public.erp_import_batches (organization_id, kind, storage_path, content_hash, file_name, parsed_at)
     values ($1, 'STOCK', $2, md5($2) || md5($2), $3, $4) returning id`,
    [organizationId, `erp-imports/${PREFIXO}/${nome}`, nome, parsedAt],
  );
}

async function snapshot(
  organizationId: string,
  batchId: string,
  skuKey: string,
  skuId: string | null,
  warehouse: string,
  available: number,
  capturedAt: string,
): Promise<void> {
  await client.query(
    `insert into public.erp_stock_snapshots
       (organization_id, batch_id, sku_key, sku_id, warehouse, on_hand, available, reserved, captured_at)
     values ($1, $2, $3, $4, $5, $6, $6, 0, $7)`,
    [organizationId, batchId, skuKey, skuId, warehouse, available, capturedAt],
  );
}

async function movimento(
  organizationId: string,
  skuId: string,
  tipo: string,
  delta: number,
  chave: string,
  occurredAt: string,
  sourceId: string | null = null,
): Promise<void> {
  await client.query(
    `insert into public.stock_movements
       (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
     values ($1, $2, 'LOCAL', $3, $4, $5, $6, $7, $8)`,
    [organizationId, skuId, delta, tipo, sourceId === null ? null : "ORDER", sourceId, chave, occurredAt],
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: DB_URL });
  await client.connect();

  // Tokens como '' e nao NULL: usuario criado por SQL com token nulo envenena a
  // listagem do GoTrue inteira (docs/TESTING.md).
  await client.query(
    `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
                             raw_user_meta_data, created_at, updated_at,
                             confirmation_token, recovery_token, email_change, email_change_token_new,
                             email_change_token_current, phone_change, phone_change_token, reauthentication_token)
     values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, 'x', now(),
             '{"full_name":"Admin D-351"}', now(), now(), '', '', '', '', '', '', '', '')`,
    [ADMIN, `${PREFIXO}@d351.test`],
  );

  await novaOrganizacao(ORG_CORTE, "corte");
  await novaOrganizacao(ORG_MIGRACAO, "migracao");
  await novaOrganizacao(ORG_SEM_SNAPSHOT, "sem-snapshot");
  await novaOrganizacao(ORG_F3, "f3");
  await novaOrganizacao(ORG_RECONCILIADA, "reconciliada");
});

afterAll(async () => {
  // Sem limpeza: `stock_movements` e `domain_events` sao append-only, e as organizacoes
  // ficam como ficam as das outras suites ("o ambiente local acumula ate o proximo
  // `supabase db reset`").
  await client.end();
});

describe("corte da exportacao: private.erp_stock_export_instant e gemea de resolveStockExportInstant", () => {
  const CASOS: [string | null, string][] = [
    ["Lista_de_Estoque_0914184200.xlsx", "2026-09-14T18:44:13.254Z"],
    ["Lista_de_Estoque_0820160923.xlsx", "2026-08-21T15:42:02.459Z"],
    ["Lista_de_Estoque_0914184200 (1).xlsx", "2026-09-14T18:44:13.254Z"],
    ["estoque.xlsx", "2026-09-14T18:44:13.254Z"],
    [null, "2026-09-14T18:44:13.254Z"],
    ["export_kit_202609141541-20260914184106906001.xlsx", "2026-09-14T18:44:13.254Z"],
    ["Lista_de_Estoque_09141842001.xlsx", "2026-09-14T18:44:13.254Z"],
    ["Lista_de_Estoque_1314184200.xlsx", "2026-03-01T12:00:00.000Z"],
    ["Lista_de_Estoque_0230100000.xlsx", "2026-03-01T12:00:00.000Z"],
    ["Lista_de_Estoque_0301240000.xlsx", "2026-03-01T12:00:00.000Z"],
    ["Lista_de_Estoque_0912100000.xlsx", "2026-09-14T18:44:13.254Z"],
    ["Lista_de_Estoque_0914184700.xlsx", "2026-09-14T18:44:13.254Z"],
    ["Lista_de_Estoque_1231235900.xlsx", "2027-01-01T00:05:00.000Z"],
    ["Lista_de_Estoque_0229100000.xlsx", "2028-02-29T12:00:00.000Z"],
    ["Lista_de_Estoque_0229100000.xlsx", "2027-03-01T12:00:00.000Z"],
  ];

  it.each(CASOS)("%s com parse em %s: SQL e dominio dao o mesmo instante", async (nome, parse) => {
    const esperado = resolveStockExportInstant(nome, new Date(parse)).toISOString();
    const result = await client.query<{ v: Date }>(
      `select private.erp_stock_export_instant($1, $2::timestamptz) as v`,
      [nome, parse],
    );

    expect(result.rows[0]?.v.toISOString()).toBe(esperado);
  });

  it("o arquivo de producao: 18:44:13.254 vira 18:42:00", async () => {
    const result = await client.query<{ v: Date }>(
      `select private.erp_stock_export_instant('Lista_de_Estoque_0914184200.xlsx', '2026-09-14T18:44:13.254Z') as v`,
    );

    expect(result.rows[0]?.v.toISOString()).toBe("2026-09-14T18:42:00.000Z");
  });

  it("a migration corrige so o snapshot que ainda carrega o parse, e a segunda execucao nao muda nada", async () => {
    const migration = await arquivo("supabase/migrations/20260914200000_erp_corte_da_exportacao.sql");
    const update = /update public\.erp_stock_snapshots s[\s\S]*?;/.exec(migration)?.[0];

    expect(update).toBeDefined();

    const sku = await novoSku(ORG_MIGRACAO, "migration-corte");
    const loteVelho = await novoLote(ORG_MIGRACAO, "Lista_de_Estoque_0914184200.xlsx", "2026-09-14T18:44:13.254Z");
    const loteJaCorrigido = await novoLote(ORG_MIGRACAO, "Lista_de_Estoque_0914184201.xlsx", "2026-09-14T18:44:13.254Z");

    await snapshot(ORG_MIGRACAO, loteVelho, "MIGRATION-A", sku, "ESTOQUE LOJA", 5, "2026-09-14T18:44:13.254Z");
    // captured_at que NAO e o parse (gravado por outro caminho): a migration nao o toca,
    // mesmo que o nome do arquivo apontasse outro instante (18:42:01).
    await snapshot(ORG_MIGRACAO, loteJaCorrigido, "MIGRATION-B", sku, "ESTOQUE LOJA", 5, "2026-09-14T18:43:00.000Z");

    await client.query("begin");

    try {
      const primeira = await client.query(update ?? "");
      const segunda = await client.query(update ?? "");
      const linhas = await client.query<{ sku_key: string; captured_at: Date }>(
        `select sku_key, captured_at from public.erp_stock_snapshots
         where batch_id in ($1, $2) order by sku_key`,
        [loteVelho, loteJaCorrigido],
      );

      expect(primeira.rowCount).toBeGreaterThanOrEqual(1);
      expect(segunda.rowCount).toBe(0);
      expect(linhas.rows.map((r) => [r.sku_key, r.captured_at.toISOString()])).toEqual([
        ["MIGRATION-A", "2026-09-14T18:42:00.000Z"],
        ["MIGRATION-B", "2026-09-14T18:43:00.000Z"],
      ]);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("get_erp_stock_cutoffs", () => {
  let doisImports = "";
  let soNoVelho = "";
  let semSnapshot = "";

  const T_VELHO = "2026-08-20T16:09:23.000Z";
  const T_MEIO = "2026-08-30T10:00:00.000Z";
  const T_NOVO = "2026-09-14T18:42:00.000Z";

  beforeAll(async () => {
    doisImports = await novoSku(ORG_CORTE, "dois-imports");
    soNoVelho = await novoSku(ORG_CORTE, "so-no-velho");
    semSnapshot = await novoSku(ORG_CORTE, "sem-snapshot");

    const velho = await novoLote(ORG_CORTE, `${PREFIXO}-velho.xlsx`);
    const novo = await novoLote(ORG_CORTE, `${PREFIXO}-novo.xlsx`);

    await snapshot(ORG_CORTE, velho, "DOIS-IMPORTS", doisImports, "ESTOQUE LOJA", 100, T_VELHO);
    await snapshot(ORG_CORTE, velho, "DOIS-IMPORTS", doisImports, "DEPOSITO", 7, T_MEIO);
    await snapshot(ORG_CORTE, velho, "SO-NO-VELHO", soNoVelho, "ESTOQUE LOJA", 3, T_VELHO);
    await snapshot(ORG_CORTE, novo, "DOIS-IMPORTS", doisImports, "ESTOQUE LOJA", 50, T_NOVO);
    // Linha sem SKU na V3: continua sendo o retrato da organizacao.
    await snapshot(ORG_CORTE, novo, "DESCONHECIDO", null, "ESTOQUE LOJA", 1, T_NOVO);
  });

  it("anon nao executa", async () => {
    await expect(
      comoPapel("anon", `select * from public.get_erp_stock_cutoffs('${ORG_CORTE}', array['${doisImports}']::uuid[])`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("authenticated nao executa — so service_role, mesmo sendo ADMIN da organizacao", async () => {
    await expect(
      comoPapel(
        "authenticated",
        `select * from public.get_erp_stock_cutoffs('${ORG_CORTE}', array['${doisImports}']::uuid[])`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("e SECURITY INVOKER com search_path travado", async () => {
    const result = await client.query<{ definer: boolean; config: string | null }>(
      `select p.prosecdef as definer, array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'get_erp_stock_cutoffs'`,
    );

    expect(result.rows).toEqual([{ definer: false, config: 'search_path=""' }]);
  });

  it("service_role: o maximo entre imports e armazens, o corte proprio mais velho, e o da organizacao para quem nao tem snapshot", async () => {
    const rows = await comoPapel<{ sku_id: string; captured_at: Date | null }>(
      "service_role",
      `select sku_id, captured_at from public.get_erp_stock_cutoffs(
         '${ORG_CORTE}',
         array['${doisImports}', '${soNoVelho}', '${semSnapshot}', '${doisImports}', null]::uuid[])`,
    );

    const porSku = new Map(rows.map((r) => [r.sku_id, r.captured_at?.toISOString() ?? null]));

    // Uma linha por id DISTINTO e nao nulo.
    expect(rows).toHaveLength(3);
    expect(porSku.get(doisImports)).toBe(T_NOVO);
    expect(porSku.get(soNoVelho)).toBe(T_VELHO);
    expect(porSku.get(semSnapshot)).toBe(T_NOVO);
  });

  it("organizacao sem snapshot: uma linha por id, com corte nulo", async () => {
    const rows = await comoPapel<{ sku_id: string; captured_at: Date | null }>(
      "service_role",
      `select sku_id, captured_at from public.get_erp_stock_cutoffs('${ORG_SEM_SNAPSHOT}', array['${semSnapshot}']::uuid[])`,
    );

    expect(rows).toEqual([{ sku_id: semSnapshot, captured_at: null }]);
  });

  it("o corte da RPC e o de compute_erp_target_balances: par estornado dos dois lados soma zero, e o alvo = snapshot + legitimos", async () => {
    // Snapshot mais recente por (sku, armazem): 50 (LOJA, T_NOVO) + 7 (DEPOSITO, T_MEIO) = 57.
    const venda = (minutos: number) => new Date(new Date(T_NOVO).getTime() + minutos * 60_000).toISOString();

    // Legitimo: venda depois do corte.
    await movimento(ORG_CORTE, doisImports, "VENDA_ML", -2, `${PREFIXO}:legitima`, venda(1));
    // Par antes do corte (a planilha ja tinha a venda).
    await movimento(ORG_CORTE, doisImports, "VENDA_ML", -1, `${PREFIXO}:antes`, venda(-60));
    await movimento(ORG_CORTE, doisImports, "ESTORNO_PRE_CAPTURA", 1, `estorno-pre-captura:${PREFIXO}:antes`, venda(-60));
    // Par EXATAMENTE no corte: a fronteira do gate (<=) e a do alvo (>) sao a mesma.
    await movimento(ORG_CORTE, doisImports, "VENDA_ML", -1, `${PREFIXO}:no-corte`, T_NOVO);
    await movimento(ORG_CORTE, doisImports, "ESTORNO_PRE_CAPTURA", 1, `estorno-pre-captura:${PREFIXO}:no-corte`, T_NOVO);
    // Par espelhado de venda gravada pelo worker antigo com a data da atualizacao.
    await movimento(ORG_CORTE, doisImports, "VENDA_ML", -3, `${PREFIXO}:worker-antigo`, venda(10));
    await movimento(
      ORG_CORTE,
      doisImports,
      "ESTORNO_PRE_CAPTURA",
      3,
      `estorno-pre-captura:${PREFIXO}:worker-antigo`,
      venda(10),
    );

    const alvo = await client.query<{ quantity: string }>(
      `select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL'`,
      [ORG_CORTE, doisImports],
    );
    const saldo = await client.query<{ quantity: string }>(
      `select quantity from public.inventory_balances where sku_id = $1 and location_kind = 'LOCAL'`,
      [doisImports],
    );

    expect(Number(alvo.rows[0]?.quantity)).toBe(57 - 2);
    // O saldo local (sem reconciliacao) e so o legitimo: os pares somam zero.
    expect(Number(saldo.rows[0]?.quantity)).toBe(-2);
  });
});

describe("stock_movements aceita ESTORNO_PRE_CAPTURA, e so ele", () => {
  it("linha de sistema: sem created_by e sem reason", async () => {
    const sku = await novoSku(ORG_SEM_SNAPSHOT, "tipo-novo");

    await movimento(ORG_SEM_SNAPSHOT, sku, "VENDA_ML", -1, `${PREFIXO}:tipo:venda`, "2026-09-14T10:00:00Z");
    await movimento(ORG_SEM_SNAPSHOT, sku, "ESTORNO_PRE_CAPTURA", 1, `${PREFIXO}:tipo:estorno`, "2026-09-14T10:00:00Z");

    const result = await client.query<{ created_by: string | null; reason: string | null }>(
      `select created_by, reason from public.stock_movements where idempotency_key = $1`,
      [`${PREFIXO}:tipo:estorno`],
    );

    expect(result.rows).toEqual([{ created_by: null, reason: null }]);
  });

  it("tipo fora do vocabulario continua recusado", async () => {
    const sku = await novoSku(ORG_SEM_SNAPSHOT, "tipo-inventado");

    await expect(
      movimento(ORG_SEM_SNAPSHOT, sku, "ESTORNO_INVENTADO", 1, `${PREFIXO}:tipo:inventado`, "2026-09-14T10:00:00Z"),
    ).rejects.toThrow(/stock_movements_movement_type_check/);
  });
});

describe("notificacoes: o fan-out pula backfill", () => {
  async function evento(fonte: string, sufixo: string): Promise<string> {
    return umId(
      `insert into public.domain_events
         (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
       values ($1, null, now(), 'order.cancelled', 'order', $2, 'importante', $3, $4)
       returning id`,
      [ORG_SEM_SNAPSHOT, `${PREFIXO}-${sufixo}`, fonte, `${PREFIXO}:fanout:${sufixo}`],
    );
  }

  async function notificacoesDe(eventId: string): Promise<{ notificacoes: number; destinatarios: string[] }> {
    const result = await client.query<{ id: string; user_id: string | null }>(
      `select n.id, r.user_id
       from public.notifications n
       left join public.notification_recipients r on r.notification_id = n.id
       where n.domain_event_id = $1`,
      [eventId],
    );

    return {
      notificacoes: new Set(result.rows.map((r) => r.id)).size,
      destinatarios: result.rows.flatMap((r) => (r.user_id === null ? [] : [r.user_id])),
    };
  }

  it("evento backfill e gravado e NAO vira notificacao", async () => {
    const id = await evento("backfill", "backfill");

    expect(await notificacoesDe(id)).toEqual({ notificacoes: 0, destinatarios: [] });
  });

  it("evento sync continua virando notificacao para o ADMIN", async () => {
    const id = await evento("sync", "sync");

    expect(await notificacoesDe(id)).toEqual({ notificacoes: 1, destinatarios: [ADMIN] });
  });

  it("fonte fora do vocabulario continua recusada", async () => {
    await expect(evento("carga", "carga")).rejects.toThrow(/domain_events_source_check/);
  });

  it("a migration de dados marca como lidas SO as notificacoes de evento anterior a conexao da conta, e e idempotente", async () => {
    const migration = await arquivo("supabase/migrations/20260914200300_notificacoes_do_backfill_lidas.sql");
    const conta = await umId(
      `insert into public.ml_accounts (organization_id, label, slug, seller_id, status, connected_at)
       values ($1, 'Conta D-351', $2, 351351, 'CONNECTED', now() - interval '1 hour') returning id`,
      [ORG_SEM_SNAPSHOT, `${PREFIXO}-notif`],
    );

    const eventoDaConta = (sufixo: string, occurredAt: string) =>
      umId(
        `insert into public.domain_events
           (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
         values ($1, $2, ${occurredAt}, 'order.cancelled', 'order', $3, 'importante', 'sync', $4)
         returning id`,
        [ORG_SEM_SNAPSHOT, conta, `${PREFIXO}-${sufixo}`, `${PREFIXO}:migration:${sufixo}`],
      );

    const historia = await eventoDaConta("historia", "now() - interval '30 days'");
    const noticia = await eventoDaConta("noticia", "now()");
    const jaLida = await eventoDaConta("ja-lida", "now() - interval '2 days'");

    await client.query(
      `update public.notification_recipients set read_at = '2026-09-01T00:00:00Z'
       where notification_id = (select id from public.notifications where domain_event_id = $1)`,
      [jaLida],
    );

    await client.query("begin");

    try {
      await client.query(migration);
      const segunda = await client.query(migration);

      const lidas = await client.query<{ domain_event_id: string; read_at: Date | null }>(
        `select n.domain_event_id, r.read_at
         from public.notifications n join public.notification_recipients r on r.notification_id = n.id
         where n.domain_event_id in ($1, $2, $3)`,
        [historia, noticia, jaLida],
      );
      const porEvento = new Map(lidas.rows.map((r) => [r.domain_event_id, r.read_at]));

      expect(porEvento.get(historia)).not.toBeNull();
      expect(porEvento.get(noticia)).toBeNull();
      // Ja lida antes: `read_at` preservado, nao reescrito.
      expect(porEvento.get(jaLida)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
      expect(segunda.rowCount).toBe(0);
      // Nada apagado: as tres notificacoes continuam existindo.
      expect(lidas.rows).toHaveLength(3);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("compensacao F3 (packages/db/scripts, fora das migrations)", () => {
  const PEDIDO = 935_100_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
  // Corte recente: a organizacao "nasceu no import" (primeiro movimento depois de corte - 1 h).
  const CORTE = new Date(Date.now() - 10 * 60_000);
  const em = (minutos: number) => new Date(CORTE.getTime() + minutos * 60_000).toISOString();

  let skuF3 = "";
  let skuReconciliada = "";

  async function pedido(organizationId: string, conta: string, id: number, status: string, dateClosed: string) {
    await client.query(
      `insert into public.orders (id, organization_id, ml_account_id, status, date_created, date_closed,
                                  date_last_updated, total_amount, currency_id)
       values ($1, $2, $3, $4, $5::timestamptz - interval '1 minute', $5, now(), 10, 'BRL')`,
      [id, organizationId, conta, status, dateClosed],
    );
  }

  beforeAll(async () => {
    skuF3 = await novoSku(ORG_F3, "f3");
    skuReconciliada = await novoSku(ORG_RECONCILIADA, "f3");

    const loteF3 = await novoLote(ORG_F3, `${PREFIXO}-f3.xlsx`);
    const loteReconciliada = await novoLote(ORG_RECONCILIADA, `${PREFIXO}-f3-reconciliada.xlsx`);

    await snapshot(ORG_F3, loteF3, "F3", skuF3, "ESTOQUE LOJA", 20, CORTE.toISOString());
    await snapshot(ORG_RECONCILIADA, loteReconciliada, "F3", skuReconciliada, "ESTOQUE LOJA", 20, CORTE.toISOString());

    const contaF3 = await umId(
      `insert into public.ml_accounts (organization_id, label, slug, seller_id, status, connected_at)
       values ($1, 'F3', $2, 3513, 'CONNECTED', now()) returning id`,
      [ORG_F3, `${PREFIXO}-f3`],
    );
    const contaReconciliada = await umId(
      `insert into public.ml_accounts (organization_id, label, slug, seller_id, status, connected_at)
       values ($1, 'F3 reconciliada', $2, 3514, 'CONNECTED', now()) returning id`,
      [ORG_RECONCILIADA, `${PREFIXO}-f3-rec`],
    );

    // 1: venda antes do corte, gravada pelo worker antigo depois dele -> compensa, espelhando a data.
    await pedido(ORG_F3, contaF3, PEDIDO + 1, "paid", em(-2 * 24 * 60));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 1)}:0`, em(5), String(PEDIDO + 1));
    // 2: venda depois do corte -> legitima, nao toca.
    await pedido(ORG_F3, contaF3, PEDIDO + 2, "paid", em(1));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 2)}:0`, em(1), String(PEDIDO + 2));
    // 3: ja estornada pelo worker novo -> nao duplica.
    await pedido(ORG_F3, contaF3, PEDIDO + 3, "paid", em(-24 * 60));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 3)}:0`, em(6), String(PEDIDO + 3));
    await movimento(
      ORG_F3,
      skuF3,
      "ESTORNO_PRE_CAPTURA",
      1,
      `estorno-pre-captura:venda:${String(PEDIDO + 3)}:0`,
      em(6),
      String(PEDIDO + 3),
    );
    // 4: venda e cancelamento ANTES do corte -> o par ja soma zero, nao toca.
    await pedido(ORG_F3, contaF3, PEDIDO + 4, "cancelled", em(-3 * 24 * 60));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 4)}:0`, em(-2 * 24 * 60), String(PEDIDO + 4));
    await movimento(
      ORG_F3,
      skuF3,
      "CANCELAMENTO_ML",
      1,
      `cancelamento:venda:${String(PEDIDO + 4)}:0`,
      em(-60),
      String(PEDIDO + 4),
    );
    // 5: venda antes do corte, cancelada DEPOIS -> compensa a venda; o cancelamento fica (+1 real).
    await pedido(ORG_F3, contaF3, PEDIDO + 5, "cancelled", em(-24 * 60));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 5)}:0`, em(7), String(PEDIDO + 5));
    await movimento(
      ORG_F3,
      skuF3,
      "CANCELAMENTO_ML",
      1,
      `cancelamento:venda:${String(PEDIDO + 5)}:0`,
      em(20),
      String(PEDIDO + 5),
    );

    // Organizacao reconciliada: mesma venda antiga, mas com AJUSTE_RECONCILIACAO.
    await pedido(ORG_RECONCILIADA, contaReconciliada, PEDIDO + 6, "paid", em(-2 * 24 * 60));
    await movimento(
      ORG_RECONCILIADA,
      skuReconciliada,
      "VENDA_ML",
      -1,
      `venda:${String(PEDIDO + 6)}:0`,
      em(5),
      String(PEDIDO + 6),
    );
    await movimento(ORG_RECONCILIADA, skuReconciliada, "AJUSTE_RECONCILIACAO", 21, `${PREFIXO}:reconciliacao`, em(8));
  });

  async function rodarF3(organizationId: string, avisos: string[]): Promise<void> {
    const script = await arquivo("packages/db/scripts/compensacao-estorno-pre-captura-d351.sql");
    const escuta = (aviso: { message?: string | undefined }): void => {
      avisos.push(aviso.message ?? "");
    };

    client.on("notice", escuta);

    try {
      await client.query(`set local sb.compensacao_organizacao = '${organizationId}'`);
      await client.query(script);
    } finally {
      client.off("notice", escuta);
    }
  }

  it("compensa so a venda anterior ao corte sem par (e nao a cancelada ate o corte), espelha a data, fecha o alvo e a segunda execucao grava 0", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarF3(ORG_F3, avisos);

      const estornos = await client.query<{ idempotency_key: string; qty_delta: string; occurred_at: Date; created_by: string | null }>(
        `select idempotency_key, qty_delta, occurred_at, created_by from public.stock_movements
         where organization_id = $1 and movement_type = 'ESTORNO_PRE_CAPTURA'
         order by idempotency_key`,
        [ORG_F3],
      );

      expect(estornos.rows.map((r) => [r.idempotency_key, Number(r.qty_delta), r.occurred_at.toISOString(), r.created_by])).toEqual([
        [`estorno-pre-captura:venda:${String(PEDIDO + 1)}:0`, 1, em(5), null],
        [`estorno-pre-captura:venda:${String(PEDIDO + 3)}:0`, 1, em(6), null],
        [`estorno-pre-captura:venda:${String(PEDIDO + 5)}:0`, 1, em(7), null],
      ]);
      expect(avisos).toContain("compensacao_d351: 2 estornos gravados");

      // Alvo: 20 + venda legitima (-1) + cancelamento depois do corte (+1). Os pares somam 0.
      const alvo = await client.query<{ quantity: string }>(
        `select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL'`,
        [ORG_F3, skuF3],
      );
      const saldo = await client.query<{ quantity: string }>(
        `select quantity from public.inventory_balances where sku_id = $1 and location_kind = 'LOCAL'`,
        [skuF3],
      );

      expect(Number(alvo.rows[0]?.quantity)).toBe(20);
      expect(Number(saldo.rows[0]?.quantity)).toBe(0);

      const segunda: string[] = [];

      await rodarF3(ORG_F3, segunda);

      expect(segunda).toContain("compensacao_d351: 0 estornos gravados");
    } finally {
      await client.query("rollback");
    }
  });

  it("organizacao com AJUSTE_RECONCILIACAO nao e compensada — e avisa, em vez de sumir em silencio", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarF3(ORG_RECONCILIADA, avisos);

      const estornos = await client.query(
        `select 1 from public.stock_movements where organization_id = $1 and movement_type = 'ESTORNO_PRE_CAPTURA'`,
        [ORG_RECONCILIADA],
      );

      expect(estornos.rowCount).toBe(0);
      expect(avisos).toContain("compensacao_d351: 0 estornos gravados");
      expect(avisos.join("\n")).toContain(`organizacao ${ORG_RECONCILIADA} fora do criterio`);
    } finally {
      await client.query("rollback");
    }
  });
});
