import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  computeCancellationMovements,
  computeReturnReversal,
  computeSaleDeductions,
  estornadoKeyOf,
  estornoKeyOf,
  resolveStockExportInstant,
} from "@sb/domain";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "./types.js";

/**
 * D-351 — a guarda contra baixa de venda anterior ao snapshot do UpSeller, provada
 * contra o Postgres real.
 *
 * O que so o banco prova: os grants e o corte de `get_erp_stock_cutoffs`, que o corte
 * dela e o de `compute_erp_target_balances` sao o MESMO (senao a primeira reconciliacao
 * desfaz a guarda), que a venda gravada antes de a planilha chegar nao e estornada numa
 * segunda planilha, que a chave neutra absorve o segundo estorno do mesmo movimento sem
 * derrubar a pagina, o fan-out pulando `backfill`, as duas migrations de dados (o corte
 * da exportacao nos snapshots antigos e as notificacoes do backfill) e a compensacao F3,
 * que mora em `packages/db/scripts/` e nao e migration.
 *
 * Organizacoes, usuario e conta proprios (uuid aleatorio): este arquivo roda ao lado de
 * `rls.integration.test.ts`. As duas migrations de dados e a F3 rodam dentro de uma
 * transacao revertida, e as assercoes olham so as linhas deste arquivo.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`), banco recriado e
 * `SUPABASE_SERVICE_ROLE_KEY` exportada (o teste da chave neutra grava pelo PostgREST).
 */

const DB_URL = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RAIZ = new URL("../../../", import.meta.url);

const ORG_CORTE = randomUUID();
// Propria: os snapshots do teste da migration sao gravados de verdade, e mudariam o
// corte da organizacao que o teste da RPC confere.
const ORG_MIGRACAO = randomUUID();
const ORG_SEM_SNAPSHOT = randomUUID();
const ORG_F3 = randomUUID();
const ORG_RECONCILIADA = randomUUID();
const ORG_DUAS_PLANILHAS = randomUUID();
const ORG_CHAVE = randomUUID();
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

async function novoSku(organizationId: string, nome: string, tipo: "PRODUTO" | "KIT" = "PRODUTO"): Promise<string> {
  return umId(`insert into public.skus (organization_id, sku, kind) values ($1, $2, $3) returning id`, [
    organizationId,
    `${PREFIXO}-${nome}`,
    tipo,
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
  // Explicito quando o teste depende de QUANDO o corte chegou (`imported_at`).
  createdAt: string | null = null,
): Promise<void> {
  await client.query(
    `insert into public.erp_stock_snapshots
       (organization_id, batch_id, sku_key, sku_id, warehouse, on_hand, available, reserved, captured_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $6, 0, $7, coalesce($8::timestamptz, now()))`,
    [organizationId, batchId, skuKey, skuId, warehouse, available, capturedAt, createdAt],
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
  // Explicito quando o teste depende de QUANDO a venda entrou no saldo.
  createdAt: string | null = null,
): Promise<void> {
  await client.query(
    `insert into public.stock_movements
       (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at, created_at)
     values ($1, $2, 'LOCAL', $3, $4, $5, $6, $7, $8, coalesce($9::timestamptz, now()))`,
    [organizationId, skuId, delta, tipo, sourceId === null ? null : "ORDER", sourceId, chave, occurredAt, createdAt],
  );
}

/** Alvo menos saldo LOCAL de um SKU: o que a reconciliacao gravaria como AJUSTE_RECONCILIACAO. */
async function ajusteDaReconciliacao(organizationId: string, skuId: string): Promise<number> {
  const result = await client.query<{ alvo: string | null; saldo: string | null }>(
    `select (select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL') as alvo,
            (select quantity from public.inventory_balances where sku_id = $2 and location_kind = 'LOCAL') as saldo`,
    [organizationId, skuId],
  );

  return Number(result.rows[0]?.alvo ?? 0) - Number(result.rows[0]?.saldo ?? 0);
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
  await novaOrganizacao(ORG_DUAS_PLANILHAS, "duas-planilhas");
  await novaOrganizacao(ORG_CHAVE, "chave-neutra");
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
    const migration = await arquivo("supabase/migrations/20260916180000_erp_corte_da_exportacao.sql");
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
  // Quando cada linha entrou. O import grava os snapshots em lotes, cada lote com o seu
  // `created_at` (quatro, entre 18:44:18.7 e 18:44:19.2, em producao).
  const I_VELHO = "2026-08-21T15:42:10.000Z";
  const I_NOVO_PRIMEIRO = "2026-09-14T18:44:18.714Z";
  const I_NOVO_MEIO = "2026-09-14T18:44:18.900Z";
  const I_NOVO_ULTIMO = "2026-09-14T18:44:19.198Z";
  // `erp_import_batches.applied_at` do import novo em producao.
  const APLICADO_NOVO = "2026-09-14T18:44:19.581Z";

  beforeAll(async () => {
    doisImports = await novoSku(ORG_CORTE, "dois-imports");
    soNoVelho = await novoSku(ORG_CORTE, "so-no-velho");
    semSnapshot = await novoSku(ORG_CORTE, "sem-snapshot");

    const velho = await novoLote(ORG_CORTE, `${PREFIXO}-velho.xlsx`);
    const novo = await novoLote(ORG_CORTE, `${PREFIXO}-novo.xlsx`);

    await snapshot(ORG_CORTE, velho, "DOIS-IMPORTS", doisImports, "ESTOQUE LOJA", 100, T_VELHO, I_VELHO);
    await snapshot(ORG_CORTE, velho, "DOIS-IMPORTS", doisImports, "DEPOSITO", 7, T_MEIO, I_VELHO);
    await snapshot(ORG_CORTE, velho, "SO-NO-VELHO", soNoVelho, "ESTOQUE LOJA", 3, T_VELHO, I_VELHO);
    await snapshot(ORG_CORTE, novo, "DOIS-IMPORTS", doisImports, "ESTOQUE LOJA", 50, T_NOVO, I_NOVO_PRIMEIRO);
    // Linha sem SKU na V3: continua sendo o retrato da organizacao.
    await snapshot(ORG_CORTE, novo, "DESCONHECIDO", null, "ESTOQUE LOJA", 1, T_NOVO, I_NOVO_MEIO);
    // O mesmo SKU num lote POSTERIOR do mesmo import, com o saldo que o DEPOSITO ja tinha
    // (o alvo nao muda).
    await snapshot(ORG_CORTE, novo, "DOIS-IMPORTS", doisImports, "DEPOSITO", 7, T_NOVO, I_NOVO_ULTIMO);
    // O import novo terminou (`applied_at`, gravado depois de todos os upserts); o velho
    // fica sem `applied_at`, e vale o `created_at` do snapshot vencedor.
    await client.query(`update public.erp_import_batches set applied_at = $1 where id = $2`, [APLICADO_NOVO, novo]);
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

  it("service_role: o maximo entre imports e armazens, o corte proprio mais velho, e o da organizacao para quem nao tem snapshot — cada um com o applied_at do lote do snapshot vencedor (ou o created_at dele, com o lote aberto)", async () => {
    const rows = await comoPapel<{
      sku_id: string;
      captured_at: Date | null;
      imported_at: Date | null;
      reconciled_at: Date | null;
      exported_at: Date | null;
    }>(
      "service_role",
      `select sku_id, captured_at, imported_at, reconciled_at, exported_at from public.get_erp_stock_cutoffs(
         '${ORG_CORTE}',
         array['${doisImports}', '${soNoVelho}', '${semSnapshot}', '${doisImports}', null]::uuid[])`,
    );

    const porSku = new Map(
      rows.map((r) => [
        r.sku_id,
        [r.captured_at?.toISOString() ?? null, r.imported_at?.toISOString() ?? null, r.reconciled_at, r.exported_at?.toISOString() ?? null],
      ]),
    );

    // Uma linha por id DISTINTO e nao nulo. `imported_at` e o fim do import, e nao o
    // primeiro lote (verificacao de e6fda07, BAIXA-1): a venda decidida com o corte antigo
    // e gravada entre o primeiro lote e o fim nao parece "gravada depois de o corte chegar".
    expect(rows).toHaveLength(3);
    // `exported_at` = `captured_at`: nenhum destes snapshots carrega o parse de uma planilha com o
    // nome carimbado (reverificacao de c48fb70, MEDIA-1).
    expect(porSku.get(doisImports)).toEqual([T_NOVO, APLICADO_NOVO, null, T_NOVO]);
    expect(porSku.get(soNoVelho)).toEqual([T_VELHO, I_VELHO, null, T_VELHO]);
    expect(porSku.get(semSnapshot)).toEqual([T_NOVO, APLICADO_NOVO, null, T_NOVO]);
  });

  it("organizacao sem snapshot: uma linha por id, com corte e imported_at nulos", async () => {
    const rows = await comoPapel<{ sku_id: string; captured_at: Date | null; imported_at: Date | null }>(
      "service_role",
      `select sku_id, captured_at, imported_at from public.get_erp_stock_cutoffs('${ORG_SEM_SNAPSHOT}', array['${semSnapshot}']::uuid[])`,
    );

    expect(rows).toEqual([{ sku_id: semSnapshot, captured_at: null, imported_at: null }]);
  });

  it("o corte da RPC e o de compute_erp_target_balances: par estornado dos dois lados soma zero, e o alvo = snapshot + legitimos", async () => {
    // Snapshot mais recente por (sku, armazem): 50 (LOJA, T_NOVO) + 7 (DEPOSITO, T_NOVO) = 57.
    const venda = (minutos: number) => new Date(new Date(T_NOVO).getTime() + minutos * 60_000).toISOString();

    // Legitimo: venda depois do corte.
    await movimento(ORG_CORTE, doisImports, "VENDA_ML", -2, `${PREFIXO}:legitima`, venda(1));
    // Par antes do corte (a planilha ja tinha a venda).
    await movimento(ORG_CORTE, doisImports, "VENDA_ML", -1, `${PREFIXO}:antes`, venda(-60));
    await movimento(ORG_CORTE, doisImports, "ESTORNO_PRE_CAPTURA", 1, `estorno:${PREFIXO}:antes`, venda(-60));
    // Par EXATAMENTE no corte: a fronteira do gate (<=) e a do alvo (>) sao a mesma.
    await movimento(ORG_CORTE, doisImports, "VENDA_ML", -1, `${PREFIXO}:no-corte`, T_NOVO);
    await movimento(ORG_CORTE, doisImports, "ESTORNO_PRE_CAPTURA", 1, `estorno:${PREFIXO}:no-corte`, T_NOVO);
    // Par espelhado de venda gravada pelo worker antigo com a data da atualizacao.
    await movimento(ORG_CORTE, doisImports, "VENDA_ML", -3, `${PREFIXO}:worker-antigo`, venda(10));
    await movimento(ORG_CORTE, doisImports, "ESTORNO_PRE_CAPTURA", 3, `estorno:${PREFIXO}:worker-antigo`, venda(10));

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

describe("segunda planilha: venda gravada antes de o corte chegar nao e estornada (revisao de D-351, ALTA-1)", () => {
  it("duas planilhas e uma reconciliacao entre elas: o saldo so fecha com o alvo se a venda ja absorvida NAO for estornada, e a venda antiga vista depois do import for", async () => {
    const sku = await novoSku(ORG_DUAS_PLANILHAS, "duas-planilhas");
    const base = 935_200_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const pedidoLegitimo = base + 1;
    const pedidoAntigo = base + 2;
    const itens = [{ position: 0, quantity: 1, skuId: sku, skuKind: "PRODUTO" as const, components: [] }];

    const C1 = "2026-09-14T18:42:00.000Z";
    const I1 = "2026-09-14T18:44:18.714Z";
    const VENDA_LEGITIMA = "2026-09-15T12:00:00.000Z";
    const C2 = "2026-09-16T18:00:00.000Z";
    const I2 = "2026-09-16T18:02:00.000Z";

    // Planilha 1: Disponivel 10.
    await snapshot(ORG_DUAS_PLANILHAS, await novoLote(ORG_DUAS_PLANILHAS, `${PREFIXO}-planilha-1.xlsx`), "DUAS", sku, "ESTOQUE LOJA", 10, C1, I1);

    // Venda legitima (depois do corte 1), gravada na hora pelo worker novo.
    await movimento(
      ORG_DUAS_PLANILHAS,
      sku,
      "VENDA_ML",
      -1,
      `venda:${String(pedidoLegitimo)}:0`,
      VENDA_LEGITIMA,
      String(pedidoLegitimo),
      "2026-09-15T12:00:05.000Z",
    );

    // R1: a reconciliacao diaria alinha o saldo ao alvo.
    await movimento(ORG_DUAS_PLANILHAS, sku, "AJUSTE_RECONCILIACAO", await ajusteDaReconciliacao(ORG_DUAS_PLANILHAS, sku), `${PREFIXO}:r1`, new Date().toISOString());

    // Planilha 2, ja com a venda descontada: Disponivel 9. R2 nao tem o que ajustar.
    await snapshot(ORG_DUAS_PLANILHAS, await novoLote(ORG_DUAS_PLANILHAS, `${PREFIXO}-planilha-2.xlsx`), "DUAS", sku, "ESTOQUE LOJA", 9, C2, I2);

    expect(await ajusteDaReconciliacao(ORG_DUAS_PLANILHAS, sku)).toBe(0);

    // O corte que o worker le.
    const [corte] = await comoPapel<{ captured_at: Date; imported_at: Date; reconciled_at: Date | null; exported_at: Date }>(
      "service_role",
      `select captured_at, imported_at, reconciled_at, exported_at from public.get_erp_stock_cutoffs('${ORG_DUAS_PLANILHAS}', array['${sku}']::uuid[])`,
    );

    if (corte === undefined) {
      throw new Error("get_erp_stock_cutoffs sem linha");
    }

    expect([corte.captured_at.toISOString(), corte.imported_at.toISOString()]).toEqual([C2, I2]);

    const cutoffFor = () => ({
      capturedAt: corte.captured_at,
      importedAt: corte.imported_at,
      reconciledAt: corte.reconciled_at,
      exportedAt: corte.exported_at,
    });
    const gravada = await client.query<{ sku_id: string; qty_delta: string; occurred_at: Date; created_at: Date }>(
      `select sku_id, qty_delta, occurred_at, created_at from public.stock_movements where idempotency_key = $1`,
      [`venda:${String(pedidoLegitimo)}:0`],
    );
    const linha = gravada.rows[0];

    if (linha === undefined) {
      throw new Error("venda legitima nao gravada");
    }

    // 1. O pedido da venda legitima e atualizado (envio) em 09-17: o dominio NAO estorna.
    const legitima = computeSaleDeductions(
      { id: pedidoLegitimo, status: "paid", dateCreated: new Date(VENDA_LEGITIMA), dateClosed: new Date(VENDA_LEGITIMA), items: itens },
      {
        cutoffFor,
        recordedSale: (key) =>
          key === `venda:${String(pedidoLegitimo)}:0`
            ? { skuId: linha.sku_id, qtyDelta: Number(linha.qty_delta), occurredAt: linha.occurred_at, recordedAt: linha.created_at }
            : undefined,
        recordedReversals: [],
      },
    );

    expect(legitima.preCaptureReversals).toEqual([]);

    // Contraprova: o estorno que a regra de b170509 dava deixaria o saldo 1 acima, e R3
    // ajustaria -1 (com notificacao `stock.balance.adjusted`).
    await client.query("begin");

    try {
      await movimento(
        ORG_DUAS_PLANILHAS,
        sku,
        "ESTORNO_PRE_CAPTURA",
        1,
        estornoKeyOf(`venda:${String(pedidoLegitimo)}:0`),
        VENDA_LEGITIMA,
        String(pedidoLegitimo),
      );

      expect(await ajusteDaReconciliacao(ORG_DUAS_PLANILHAS, sku)).toBe(-1);
    } finally {
      await client.query("rollback");
    }

    // 2. Pedido antigo (venda de 09-16 10:00, antes do corte 2) visto pela V3 so depois do
    // import 2: o dominio grava E estorna, e o saldo continua igual ao alvo.
    const antigo = computeSaleDeductions(
      {
        id: pedidoAntigo,
        status: "paid",
        dateCreated: new Date("2026-09-16T09:59:00.000Z"),
        dateClosed: new Date("2026-09-16T10:00:00.000Z"),
        items: itens,
      },
      { cutoffFor, recordedSale: () => undefined, recordedReversals: [] },
    );

    expect(antigo.preCaptureReversals).toHaveLength(1);

    for (const [tipo, draft] of [
      ...antigo.deductions.map((d) => ["VENDA_ML", d] as const),
      ...antigo.preCaptureReversals.map((d) => ["ESTORNO_PRE_CAPTURA", d] as const),
    ]) {
      await movimento(ORG_DUAS_PLANILHAS, draft.skuId, tipo, draft.qtyDelta, draft.idempotencyKey, draft.occurredAt.toISOString(), String(pedidoAntigo));
    }

    expect(await ajusteDaReconciliacao(ORG_DUAS_PLANILHAS, sku)).toBe(0);
  });
});

describe("chave neutra do estorno: o segundo estorno do MESMO movimento nao entra e nao derruba a pagina", () => {
  const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY ?? "sem-chave", {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  it("estorno ja gravado com estorno:<chave> por outro produtor: o upsert da pagina (ON CONFLICT DO NOTHING, pelo PostgREST) grava o resto e nao duplica o estorno", async () => {
    if (SERVICE_ROLE_KEY === undefined) {
      throw new Error(
        "SUPABASE_SERVICE_ROLE_KEY nao definida — exporte com `eval \"$(pnpm exec supabase status -o env)\"`.",
      );
    }

    const skuVendido = await novoSku(ORG_CHAVE, "chave-vendido");
    const skuOutro = await novoSku(ORG_CHAVE, "chave-outro");
    const pedido = 935_300_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const outroPedido = pedido + 1;
    const venda = `venda:${String(pedido)}:0`;
    const VENDA_EM = "2026-09-10T12:00:00.000Z";
    const GRAVADA_EM = "2026-09-14T19:00:00.000Z";

    await movimento(ORG_CHAVE, skuVendido, "VENDA_ML", -1, venda, VENDA_EM, String(pedido), GRAVADA_EM);
    // O PRIMEIRO estorno do movimento, gravado por outro produtor (a F3 grava
    // `'estorno:' || chave`; a fatia do Full vai gravar `ESTORNO_FULL` com a mesma chave).
    await movimento(ORG_CHAVE, skuVendido, "ESTORNO_PRE_CAPTURA", 1, `estorno:${venda}`, VENDA_EM, String(pedido));

    // O worker reprocessa o pedido: o dominio devolve a venda e o estorno do MESMO movimento.
    const { deductions, preCaptureReversals } = computeSaleDeductions(
      {
        id: pedido,
        status: "paid",
        dateCreated: new Date(VENDA_EM),
        dateClosed: new Date(VENDA_EM),
        items: [{ position: 0, quantity: 1, skuId: skuVendido, skuKind: "PRODUTO", components: [] }],
      },
      {
        cutoffFor: () => ({
          capturedAt: new Date("2026-09-14T18:42:00.000Z"),
          importedAt: new Date("2026-09-14T18:44:18.714Z"),
          reconciledAt: null,
          exportedAt: new Date("2026-09-14T18:42:00.000Z"),
        }),
        recordedSale: (key) =>
          key === venda
            ? { skuId: skuVendido, qtyDelta: -1, occurredAt: new Date(VENDA_EM), recordedAt: new Date(GRAVADA_EM) }
            : undefined,
        recordedReversals: [],
      },
    );

    // A pagina: os dois do pedido reprocessado e um movimento NOVO de outro pedido, no
    // MESMO upsert e na forma de `flushPageWrites` (ordenado por SKU, DO NOTHING).
    const linha = (skuId: string, tipo: string, delta: number, chave: string, occurredAt: string, sourceId: string) => ({
      organization_id: ORG_CHAVE,
      sku_id: skuId,
      location_kind: "LOCAL",
      qty_delta: delta,
      movement_type: tipo,
      source_type: "ORDER",
      source_id: sourceId,
      idempotency_key: chave,
      occurred_at: occurredAt,
    });
    const pagina = [
      ...deductions.map((d) => linha(d.skuId, "VENDA_ML", d.qtyDelta, d.idempotencyKey, d.occurredAt.toISOString(), String(pedido))),
      ...preCaptureReversals.map((d) =>
        linha(d.skuId, "ESTORNO_PRE_CAPTURA", d.qtyDelta, d.idempotencyKey, d.occurredAt.toISOString(), String(pedido)),
      ),
      linha(skuOutro, "VENDA_ML", -2, `venda:${String(outroPedido)}:0`, "2026-09-14T19:10:00.000Z", String(outroPedido)),
    ].sort((a, b) => (a.sku_id < b.sku_id ? -1 : a.sku_id > b.sku_id ? 1 : 0));

    const resultado = await db
      .from("stock_movements")
      .upsert(pagina, { onConflict: "idempotency_key", ignoreDuplicates: true });

    // A pagina NAO abortou: nenhum erro, e o movimento do outro pedido entrou.
    expect(resultado.error).toBeNull();

    const gravados = await client.query<{ sku_id: string; movement_type: string; linhas: string; soma: string }>(
      `select sku_id, movement_type, count(*) as linhas, sum(qty_delta) as soma
       from public.stock_movements where organization_id = $1
       group by sku_id, movement_type`,
      [ORG_CHAVE],
    );
    const porTipo = new Map(gravados.rows.map((r) => [`${r.sku_id}:${r.movement_type}`, [Number(r.linhas), Number(r.soma)]]));

    // UM estorno do movimento vendido — o segundo foi absorvido pelo UNIQUE de idempotency_key.
    expect(porTipo.get(`${skuVendido}:ESTORNO_PRE_CAPTURA`)).toEqual([1, 1]);
    expect(porTipo.get(`${skuVendido}:VENDA_ML`)).toEqual([1, -1]);
    expect(porTipo.get(`${skuOutro}:VENDA_ML`)).toEqual([1, -2]);

    const saldos = await client.query<{ sku_id: string; quantity: string }>(
      `select sku_id, quantity from public.inventory_balances where sku_id = any($1::uuid[]) and location_kind = 'LOCAL'`,
      [[skuVendido, skuOutro]],
    );

    expect(new Map(saldos.rows.map((r) => [r.sku_id, Number(r.quantity)]))).toEqual(
      new Map([
        [skuVendido, 0],
        [skuOutro, -2],
      ]),
    );
    // E a chave que o worker gera e a mesma, byte a byte, da que o outro produtor gravou.
    expect(preCaptureReversals.map((e) => e.idempotencyKey)).toEqual([`estorno:${venda}`]);
  });
});

describe("stock_movements aceita ESTORNO_PRE_CAPTURA e ESTORNO_REVERSAO_EXCEDENTE, e so eles", () => {
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

  it("a anulacao da reversao a mais (D-351 §12): linha de sistema, sem created_by e sem reason", async () => {
    const sku = await novoSku(ORG_SEM_SNAPSHOT, "tipo-anulacao");

    await movimento(ORG_SEM_SNAPSHOT, sku, "ESTORNO_REVERSAO_EXCEDENTE", -1, `${PREFIXO}:tipo:anulacao`, "2026-09-14T10:00:00Z");

    const result = await client.query<{ created_by: string | null; reason: string | null }>(
      `select created_by, reason from public.stock_movements where idempotency_key = $1`,
      [`${PREFIXO}:tipo:anulacao`],
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

  it("a migration de dados marca como lidas SO as notificacoes do backfill (evento anterior a conexao, order.cancelled, criada antes de 09-14 18:30), e e idempotente", async () => {
    const migration = await arquivo("supabase/migrations/20260916180300_notificacoes_do_backfill_lidas.sql");
    const conta = await umId(
      `insert into public.ml_accounts (organization_id, label, slug, seller_id, status, connected_at)
       values ($1, 'Conta D-351', $2, 351351, 'CONNECTED', now() - interval '1 hour') returning id`,
      [ORG_SEM_SNAPSHOT, `${PREFIXO}-notif`],
    );

    const eventoDaConta = (sufixo: string, occurredAt: string, tipo = "order.cancelled") =>
      umId(
        `insert into public.domain_events
           (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, severity, source, dedup_key)
         values ($1, $2, ${occurredAt}, $5, 'order', $3, 'importante', 'sync', $4)
         returning id`,
        [ORG_SEM_SNAPSHOT, conta, `${PREFIXO}-${sufixo}`, `${PREFIXO}:migration:${sufixo}`, tipo],
      );

    const historia = await eventoDaConta("historia", "now() - interval '30 days'");
    const noticia = await eventoDaConta("noticia", "now()");
    const jaLida = await eventoDaConta("ja-lida", "now() - interval '2 days'");
    // Anterior a conexao, mas nao e cancelamento: uma devolucao real depois de a conta
    // reconectar (connected_at reescrito) nao pode sair como lida.
    const outroTipo = await eventoDaConta("outro-tipo", "now() - interval '30 days'", "order.returned");
    // Anterior a conexao e cancelamento, mas notificado DEPOIS da carga (18:30 em ponto,
    // a fronteira): tambem e noticia de uma conta que reconectou.
    const depoisDaCarga = await eventoDaConta("depois-da-carga", "now() - interval '2 hours'");

    // As notificacoes do backfill de producao nasceram entre 17:31 e 18:25 de 2026-09-14.
    await client.query(
      `update public.notifications set created_at = '2026-09-14T18:00:00Z' where domain_event_id = any($1::uuid[])`,
      [[historia, jaLida, outroTipo]],
    );
    await client.query(`update public.notifications set created_at = '2026-09-14T18:30:00Z' where domain_event_id = $1`, [
      depoisDaCarga,
    ]);
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
         where n.domain_event_id = any($1::uuid[])`,
        [[historia, noticia, jaLida, outroTipo, depoisDaCarga]],
      );
      const porEvento = new Map(lidas.rows.map((r) => [r.domain_event_id, r.read_at]));

      expect(porEvento.get(historia)).not.toBeNull();
      expect(porEvento.get(noticia)).toBeNull();
      expect(porEvento.get(outroTipo)).toBeNull();
      expect(porEvento.get(depoisDaCarga)).toBeNull();
      // Ja lida antes: `read_at` preservado, nao reescrito.
      expect(porEvento.get(jaLida)?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
      expect(segunda.rowCount).toBe(0);
      // Nada apagado: as cinco notificacoes continuam existindo.
      expect(lidas.rows).toHaveLength(5);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("compensacao F3 (packages/db/scripts, fora das migrations)", () => {
  const PEDIDO = 935_100_000_000 + Math.floor(Math.random() * 1_000_000) * 100;
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

  async function itemVinculado(conta: string, id: number, skuId: string) {
    await client.query(
      `insert into public.order_items (order_id, organization_id, ml_account_id, position, item_id, title,
                                       quantity, unit_price, currency_id, sku_id)
       values ($1, $2, $3, 0, 'MLB351351', 'Item D-351', 1, 10, 'BRL', $4)`,
      [id, ORG_F3, conta, skuId],
    );
  }

  /** O `order.cancelled` que o worker grava quando VE a transicao (`before` = status anterior). */
  async function cancelamentoVisto(conta: string, id: number, antes: string | null, occurredAt: string) {
    await client.query(
      `insert into public.domain_events
         (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, before, after,
          severity, source, dedup_key)
       values ($1, $2, $3, 'order.cancelled', 'order', $4, $5::jsonb, '{"status":"cancelled"}', 'importante', 'sync', $6)`,
      [ORG_F3, conta, occurredAt, String(id), JSON.stringify({ status: antes }), `${PREFIXO}:f3:${String(id)}`],
    );
  }

  beforeAll(async () => {
    skuF3 = await novoSku(ORG_F3, "f3");
    skuReconciliada = await novoSku(ORG_RECONCILIADA, "f3");
    const kitF3 = await novoSku(ORG_F3, "f3-kit", "KIT");

    await client.query(`insert into public.sku_components (kit_sku_id, component_sku_id, quantity) values ($1, $2, 2)`, [
      kitF3,
      skuF3,
    ]);

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

    // PARTE 1 -- VENDA_ML gravado sem par.
    // 1: venda antes do corte, gravada pelo worker antigo depois dele -> compensa, espelhando a data.
    await pedido(ORG_F3, contaF3, PEDIDO + 1, "paid", em(-2 * 24 * 60));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 1)}:0`, em(5), String(PEDIDO + 1));
    // 2: venda depois do corte -> legitima, nao toca.
    await pedido(ORG_F3, contaF3, PEDIDO + 2, "paid", em(1));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 2)}:0`, em(1), String(PEDIDO + 2));
    // 3: ja estornada pelo worker novo -> nao duplica.
    await pedido(ORG_F3, contaF3, PEDIDO + 3, "paid", em(-24 * 60));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 3)}:0`, em(6), String(PEDIDO + 3));
    await movimento(ORG_F3, skuF3, "ESTORNO_PRE_CAPTURA", 1, `estorno:venda:${String(PEDIDO + 3)}:0`, em(6), String(PEDIDO + 3));
    // 4: venda e cancelamento ANTES do corte -> o par ja soma zero, nao toca.
    await pedido(ORG_F3, contaF3, PEDIDO + 4, "cancelled", em(-3 * 24 * 60));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 4)}:0`, em(-2 * 24 * 60), String(PEDIDO + 4));
    await movimento(ORG_F3, skuF3, "CANCELAMENTO_ML", 1, `cancelamento:venda:${String(PEDIDO + 4)}:0`, em(-60), String(PEDIDO + 4));
    // 5: venda antes do corte, cancelada DEPOIS -> compensa a venda; o cancelamento fica (+1 real).
    await pedido(ORG_F3, contaF3, PEDIDO + 5, "cancelled", em(-24 * 60));
    await movimento(ORG_F3, skuF3, "VENDA_ML", -1, `venda:${String(PEDIDO + 5)}:0`, em(7), String(PEDIDO + 5));
    await movimento(ORG_F3, skuF3, "CANCELAMENTO_ML", 1, `cancelamento:venda:${String(PEDIDO + 5)}:0`, em(20), String(PEDIDO + 5));

    // PARTE 2 -- a venda que o worker antigo nunca gravou.
    // 7: paga antes do corte, cancelada DEPOIS, transicao vista (before paid) -> trio.
    await pedido(ORG_F3, contaF3, PEDIDO + 7, "cancelled", em(-2 * 24 * 60));
    await itemVinculado(contaF3, PEDIDO + 7, skuF3);
    await cancelamentoVisto(contaF3, PEDIDO + 7, "paid", em(30));
    // 8: o backfill trouxe ja cancelado (before nulo) -> nao mexe.
    await pedido(ORG_F3, contaF3, PEDIDO + 8, "cancelled", em(-2 * 24 * 60));
    await itemVinculado(contaF3, PEDIDO + 8, skuF3);
    await cancelamentoVisto(contaF3, PEDIDO + 8, null, em(30));
    // 9: transicao vista, mas cancelada ANTES do corte -> a planilha tem as duas, nao mexe.
    await pedido(ORG_F3, contaF3, PEDIDO + 9, "cancelled", em(-2 * 24 * 60));
    await itemVinculado(contaF3, PEDIDO + 9, skuF3);
    await cancelamentoVisto(contaF3, PEDIDO + 9, "paid", em(-30));
    // 10: KIT de 2 unidades do componente, cancelado depois -> trio do componente.
    await pedido(ORG_F3, contaF3, PEDIDO + 10, "cancelled", em(-2 * 24 * 60));
    await itemVinculado(contaF3, PEDIDO + 10, kitF3);
    await cancelamentoVisto(contaF3, PEDIDO + 10, "paid", em(40));
    // 11: venda DEPOIS do corte, nunca gravada e cancelada -> soma zero, nao mexe.
    await pedido(ORG_F3, contaF3, PEDIDO + 11, "cancelled", em(1));
    await itemVinculado(contaF3, PEDIDO + 11, skuF3);
    await cancelamentoVisto(contaF3, PEDIDO + 11, "paid", em(30));

    // Organizacao reconciliada: mesma venda antiga, mas com AJUSTE_RECONCILIACAO.
    await pedido(ORG_RECONCILIADA, contaReconciliada, PEDIDO + 6, "paid", em(-2 * 24 * 60));
    await movimento(ORG_RECONCILIADA, skuReconciliada, "VENDA_ML", -1, `venda:${String(PEDIDO + 6)}:0`, em(5), String(PEDIDO + 6));
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

  const porChave = (a: unknown[], b: unknown[]) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);

  it("compensa so a venda anterior ao corte sem par (e nao a cancelada ate o corte), repoe a venda nunca gravada cancelada depois dele, espelha as datas, fecha o alvo e a segunda execucao grava 0", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarF3(ORG_F3, avisos);

      const gravados = await client.query<{
        movement_type: string;
        idempotency_key: string;
        qty_delta: string;
        occurred_at: Date;
        created_by: string | null;
      }>(
        `select movement_type, idempotency_key, qty_delta, occurred_at, created_by from public.stock_movements
         where organization_id = $1 and movement_type in ('ESTORNO_PRE_CAPTURA', 'VENDA_ML', 'CANCELAMENTO_ML')
           and source_id = any($2::text[])`,
        [ORG_F3, [PEDIDO + 1, PEDIDO + 3, PEDIDO + 5, PEDIDO + 7, PEDIDO + 8, PEDIDO + 9, PEDIDO + 10, PEDIDO + 11].map(String)],
      );
      const linhas = (tipo: string) =>
        gravados.rows
          .filter((r) => r.movement_type === tipo)
          .map((r) => [r.idempotency_key, Number(r.qty_delta), r.occurred_at.toISOString(), r.created_by])
          .sort(porChave);

      const KIT = `venda:${String(PEDIDO + 10)}:0:${skuF3}`;

      expect(linhas("ESTORNO_PRE_CAPTURA")).toEqual(
        [
          // parte 1: espelha a occurred_at do VENDA_ML gravado
          [`estorno:venda:${String(PEDIDO + 1)}:0`, 1, em(5), null],
          [`estorno:venda:${String(PEDIDO + 3)}:0`, 1, em(6), null],
          [`estorno:venda:${String(PEDIDO + 5)}:0`, 1, em(7), null],
          // parte 2: a venda em
          [`estorno:venda:${String(PEDIDO + 7)}:0`, 1, em(-2 * 24 * 60), null],
          [`estorno:${KIT}`, 2, em(-2 * 24 * 60), null],
        ].sort(porChave),
      );
      expect(linhas("VENDA_ML").filter(([chave]) => [`venda:${String(PEDIDO + 7)}:0`, KIT].includes(String(chave)))).toEqual(
        [
          [`venda:${String(PEDIDO + 7)}:0`, -1, em(-2 * 24 * 60), null],
          [KIT, -2, em(-2 * 24 * 60), null],
        ].sort(porChave),
      );
      // Nenhuma venda para os pedidos 8, 9 e 11.
      expect(linhas("VENDA_ML").map(([chave]) => chave)).not.toContain(`venda:${String(PEDIDO + 8)}:0`);
      expect(linhas("VENDA_ML").map(([chave]) => chave)).not.toContain(`venda:${String(PEDIDO + 9)}:0`);
      expect(linhas("VENDA_ML").map(([chave]) => chave)).not.toContain(`venda:${String(PEDIDO + 11)}:0`);
      // O cancelamento da reposicao tem a data do evento que viu a transicao.
      expect(linhas("CANCELAMENTO_ML").filter(([chave]) => String(chave).includes(String(PEDIDO + 7)) || String(chave).includes(KIT))).toEqual(
        [
          [`cancelamento:venda:${String(PEDIDO + 7)}:0`, 1, em(30), null],
          [`cancelamento:${KIT}`, 2, em(40), null],
        ].sort(porChave),
      );
      expect(avisos).toContain("compensacao_d351: 2 estornos gravados");
      expect(avisos).toContain("compensacao_d351: 2 vendas repostas (venda + estorno + cancelamento)");

      // Alvo: 20 + venda legitima (-1) + cancelamentos depois do corte (+1 do 5, +1 do 7,
      // +2 do KIT). Os pares somam 0.
      const alvo = await client.query<{ quantity: string }>(
        `select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL'`,
        [ORG_F3, skuF3],
      );
      const saldo = await client.query<{ quantity: string }>(
        `select quantity from public.inventory_balances where sku_id = $1 and location_kind = 'LOCAL'`,
        [skuF3],
      );

      expect(Number(alvo.rows[0]?.quantity)).toBe(23);
      expect(Number(saldo.rows[0]?.quantity)).toBe(3);

      const segunda: string[] = [];

      await rodarF3(ORG_F3, segunda);

      expect(segunda).toContain("compensacao_d351: 0 estornos gravados");
      expect(segunda).toContain("compensacao_d351: 0 vendas repostas (venda + estorno + cancelamento)");
    } finally {
      await client.query("rollback");
    }
  });

  it("organizacao com AJUSTE_RECONCILIACAO nao e compensada — e avisa, em vez de sumir em silencio; e o corte do parse dela, que a migration deixa de proposito, nao aborta a F3", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];
      // O Dev: planilha carimbada com o corte do PARSE, que o UPDATE de 20260916180000 nao
      // toca numa organizacao reconciliada (verificacao de e6fda07, MEDIA-1).
      const loteDoParse = await novoLote(ORG_RECONCILIADA, "Lista_de_Estoque_0820160923.xlsx", "2026-08-21T15:42:02.459Z");

      await snapshot(ORG_RECONCILIADA, loteDoParse, "F3-DEV-PARSE", skuReconciliada, "DEPOSITO", 1, "2026-08-21T15:42:02.459Z");

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

  it("aborta se o corte ainda for o do PARSE numa planilha com o nome carimbado — antes da migration, estornaria venda legitima da janela entre exportacao e parse", async () => {
    await client.query("begin");

    try {
      const lote = await novoLote(ORG_F3, "Lista_de_Estoque_0914184200.xlsx", "2026-09-14T18:44:13.254Z");

      await snapshot(ORG_F3, lote, "F3-PARSE", skuF3, "DEPOSITO", 1, "2026-09-14T18:44:13.254Z");

      await expect(rodarF3(ORG_F3, [])).rejects.toThrow(/corte do PARSE/);
    } finally {
      await client.query("rollback");
    }
  });

  it("planilha importada pelo worker antigo antes da F3: a organizacao fica inelegivel, e a F3 ABORTA com o corte do parse em vez de pular em silencio; com o UPDATE refeito, vira no-op com NOTICE (reverificacao de 60c7a6a, BAIXA-1)", async () => {
    const migration = await arquivo("supabase/migrations/20260916180000_erp_corte_da_exportacao.sql");
    const update = /update public\.erp_stock_snapshots s[\s\S]*?;/.exec(migration)?.[0];
    const organizacao = randomUUID();
    const id = PEDIDO + 90;
    // P2, pelo worker antigo: exportada ha 12 min e parseada 2 min depois, com o corte do parse.
    const exportacao = new Date(Math.floor((Date.now() - 12 * 60_000) / 1000) * 1000);
    const parse = new Date(exportacao.getTime() + 2 * 60_000);
    const dd = (n: number): string => String(n).padStart(2, "0");
    const nome = `Lista_de_Estoque_${dd(exportacao.getUTCMonth() + 1)}${dd(exportacao.getUTCDate())}${dd(exportacao.getUTCHours())}${dd(exportacao.getUTCMinutes())}${dd(exportacao.getUTCSeconds())}.xlsx`;

    expect(update).toBeDefined();

    await client.query("begin");

    try {
      await novaOrganizacao(organizacao, "f3-planilha-antes-da-f3");

      const sku = await novoSku(organizacao, "f3-planilha-antes-da-f3");
      const conta = await umId(
        `insert into public.ml_accounts (organization_id, label, slug, seller_id, status, connected_at)
         values ($1, 'F3 antes', $2, $3, 'CONNECTED', now()) returning id`,
        [organizacao, `${PREFIXO}-f3-antes`, 3_800_000 + Math.floor(Math.random() * 100_000)],
      );

      // A forma de producao: P1 ja com o corte da exportacao, e o ledger nascido depois dela.
      await snapshot(
        organizacao,
        await novoLote(organizacao, "Lista_de_Estoque_0914184200.xlsx", "2026-09-14T18:44:13.254Z"),
        "F3-ANTES",
        sku,
        "ESTOQUE LOJA",
        20,
        "2026-09-14T18:42:00.000Z",
      );
      await pedido(organizacao, conta, id, "paid", "2026-09-13T10:00:00.000Z");
      await movimento(organizacao, sku, "VENDA_ML", -1, `venda:${String(id)}:0`, "2026-09-14T18:43:59.000Z", String(id), "2026-09-14T18:43:59.000Z");
      // P2 entra pelo worker antigo, com o corte do parse.
      await snapshot(organizacao, await novoLote(organizacao, nome, parse.toISOString()), "F3-ANTES", sku, "ESTOQUE LOJA", 19, parse.toISOString());

      await client.query("savepoint antes_da_f3");
      await expect(rodarF3(organizacao, [])).rejects.toThrow(/corte do PARSE/);
      await client.query("rollback to savepoint antes_da_f3");

      // O UPDATE refeito tira o aborto, mas nao devolve a elegibilidade: a F3 vira no-op.
      await client.query(update ?? "");

      const corte = await client.query<{ captured_at: Date }>(
        `select max(captured_at) as captured_at from public.erp_stock_snapshots where organization_id = $1`,
        [organizacao],
      );

      expect(corte.rows[0]?.captured_at.toISOString()).toBe(exportacao.toISOString());

      const avisos: string[] = [];

      await rodarF3(organizacao, avisos);

      const estornos = await client.query(
        `select 1 from public.stock_movements where organization_id = $1 and movement_type = 'ESTORNO_PRE_CAPTURA'`,
        [organizacao],
      );

      expect(estornos.rowCount).toBe(0);
      expect(avisos).toContain("compensacao_d351: 0 estornos gravados");
      expect(avisos.join("\n")).toContain(`organizacao ${organizacao} fora do criterio (tem AJUSTE_RECONCILIACAO ou ledger anterior ao corte) com 1 VENDA_ML afetados`);
    } finally {
      await client.query("rollback");
    }
  });
});

// ============================================================================================
// Verificacao independente de e6fda07 (D-351 §9). Organizacoes proprias, criadas no beforeAll
// de cada bloco: nenhum destes fixtures muda o que os blocos de cima conferem.
// ============================================================================================

/** Uma rodada de `maintenance.reconcile-balances` como o roteador a registra (`app.ts`). */
async function rodadaDaReconciliacao(
  organizationId: string,
  finishedAt: string,
  status: "done" | "failed" = "done",
  jobType = "maintenance.reconcile-balances",
): Promise<void> {
  await client.query(
    `insert into public.job_runs
       (organization_id, job_id, job_type, dedupe_key, attempt, status, retryable, reason, processed, started_at, finished_at)
     values ($1, gen_random_uuid(), $2, $3, 1, $4, $5, $6, $7, $8::timestamptz - interval '5 seconds', $8::timestamptz)`,
    [
      organizationId,
      jobType,
      `${PREFIXO}:${jobType}:${finishedAt}:${status}:${randomUUID()}`,
      status,
      status === "failed" ? true : null,
      status === "failed" ? "boom" : null,
      status === "done" ? 0 : null,
      finishedAt,
    ],
  );
}

/** Uma devolucao como `processClaimReturn` a grava: origem CLAIM, pedido dentro da chave. */
async function devolucao(
  organizationId: string,
  skuId: string,
  claimId: string,
  chaveDaVenda: string,
  occurredAt: string,
  delta = 1,
): Promise<void> {
  await client.query(
    `insert into public.stock_movements
       (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
     values ($1, $2, 'LOCAL', $3, 'DEVOLUCAO_ML', 'CLAIM', $4, $5, $6)`,
    [organizationId, skuId, delta, claimId, `devolucao:${claimId}:${chaveDaVenda}`, occurredAt],
  );
}

interface CorteLido {
  captured_at: Date;
  imported_at: Date;
  reconciled_at: Date | null;
  exported_at: Date;
}

/** O corte como o worker o le, pela RPC -- como postgres, para caber numa transacao aberta. */
async function corteDaRpc(organizationId: string, skuId: string): Promise<CorteLido> {
  const result = await client.query<CorteLido>(
    `select captured_at, imported_at, reconciled_at, exported_at from public.get_erp_stock_cutoffs($1, array[$2]::uuid[])`,
    [organizationId, skuId],
  );
  const linha = result.rows[0];

  if (linha === undefined) {
    throw new Error("get_erp_stock_cutoffs sem linha");
  }

  return linha;
}

/** A venda gravada de uma chave, na forma de `RecordedSale`. */
async function vendaGravada(
  chave: string,
): Promise<{ skuId: string; qtyDelta: number; occurredAt: Date; recordedAt: Date } | undefined> {
  const result = await client.query<{ sku_id: string; qty_delta: string; occurred_at: Date; created_at: Date }>(
    `select sku_id, qty_delta, occurred_at, created_at from public.stock_movements
     where idempotency_key = $1 and movement_type = 'VENDA_ML'`,
    [chave],
  );
  const linha = result.rows[0];

  return linha === undefined
    ? undefined
    : { skuId: linha.sku_id, qtyDelta: Number(linha.qty_delta), occurredAt: linha.occurred_at, recordedAt: linha.created_at };
}

describe("get_erp_stock_cutoffs: a ultima reconciliacao (verificacao de e6fda07, MEDIA-1)", () => {
  const ORG_JOB = randomUUID();
  const ORG_SO_AJUSTE = randomUUID();
  const ORG_OUTRA = randomUUID();
  let proprio = "";
  let semSnapshot = "";
  let soAjuste = "";

  const CORTE = "2026-09-14T18:42:00.000Z";
  const AJUSTE_EM = "2026-09-15T09:00:00.000Z";
  const RODADA_EM = "2026-09-16T09:00:05.000Z";

  beforeAll(async () => {
    await novaOrganizacao(ORG_JOB, "reconciliacao-job");
    await novaOrganizacao(ORG_SO_AJUSTE, "reconciliacao-ajuste");
    await novaOrganizacao(ORG_OUTRA, "reconciliacao-outra");

    proprio = await novoSku(ORG_JOB, "reconciliado-proprio");
    semSnapshot = await novoSku(ORG_JOB, "reconciliado-sem-snapshot");
    soAjuste = await novoSku(ORG_SO_AJUSTE, "so-ajuste");

    await snapshot(ORG_JOB, await novoLote(ORG_JOB, `${PREFIXO}-rec-job.xlsx`), "PROPRIO", proprio, "ESTOQUE LOJA", 5, CORTE);
    await snapshot(ORG_SO_AJUSTE, await novoLote(ORG_SO_AJUSTE, `${PREFIXO}-rec-ajuste.xlsx`), "SO-AJUSTE", soAjuste, "ESTOQUE LOJA", 5, CORTE);

    // ORG_JOB: um ajuste, depois uma rodada concluida SEM ajuste (a mais recente que conta),
    // e tres rodadas que nao contam: uma que falhou, uma de outro job e uma de outra organizacao.
    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at, created_at)
       values ($1, $2, 'LOCAL', 5, 'AJUSTE_RECONCILIACAO', $3, $4, $4), ($5, $6, 'LOCAL', 5, 'AJUSTE_RECONCILIACAO', $7, $4, $4),
              -- Um ajuste mais ANTIGO em ORG_SO_AJUSTE: vale o ultimo (reverificacao de c48fb70, MUT-X4).
              ($5, $6, 'LOCAL', 1, 'AJUSTE_RECONCILIACAO', $8, $9, $9)`,
      [ORG_JOB, proprio, `${PREFIXO}:rec-job`, AJUSTE_EM, ORG_SO_AJUSTE, soAjuste, `${PREFIXO}:rec-ajuste`, `${PREFIXO}:rec-ajuste-antigo`, "2026-09-14T09:00:00.000Z"],
    );
    // Uma rodada concluida mais ANTIGA, depois do ajuste: vale a mais recente (reverificacao de
    // c48fb70, MUT-X3).
    await rodadaDaReconciliacao(ORG_JOB, "2026-09-15T20:00:05.000Z");
    await rodadaDaReconciliacao(ORG_JOB, RODADA_EM);
    await rodadaDaReconciliacao(ORG_JOB, "2026-09-17T09:00:05.000Z", "failed");
    await rodadaDaReconciliacao(ORG_JOB, "2026-09-18T09:00:05.000Z", "done", "sync.orders.window");
    await rodadaDaReconciliacao(ORG_OUTRA, "2026-09-19T09:00:05.000Z");
  });

  it("a rodada concluida mais recente da organizacao, mesmo sem ajuste; nula para o SKU sem snapshot proprio, que a reconciliacao nunca visita", async () => {
    const rows = await comoPapel<{ sku_id: string; reconciled_at: Date | null }>(
      "service_role",
      `select sku_id, reconciled_at from public.get_erp_stock_cutoffs('${ORG_JOB}', array['${proprio}', '${semSnapshot}']::uuid[])`,
    );
    const porSku = new Map(rows.map((r) => [r.sku_id, r.reconciled_at?.toISOString() ?? null]));

    expect(porSku.get(proprio)).toBe(RODADA_EM);
    expect(porSku.get(semSnapshot)).toBeNull();
  });

  it("sem job_runs registrado (a gravacao do roteador e best-effort): vale o ultimo AJUSTE_RECONCILIACAO", async () => {
    const [linha] = await comoPapel<{ reconciled_at: Date | null }>(
      "service_role",
      `select reconciled_at from public.get_erp_stock_cutoffs('${ORG_SO_AJUSTE}', array['${soAjuste}']::uuid[])`,
    );

    expect(linha?.reconciled_at?.toISOString()).toBe(AJUSTE_EM);
  });
});

describe("o ultimo alinhamento do saldo decide a venda ja gravada (verificacao de e6fda07, MEDIA-1)", () => {
  const ORG_ALINHAMENTO = randomUUID();
  const ORG_PRODUCAO = randomUUID();

  beforeAll(async () => {
    await novaOrganizacao(ORG_ALINHAMENTO, "alinhamento");
    await novaOrganizacao(ORG_PRODUCAO, "caminho-producao");
  });

  it("venda gravada depois do import, reconciliacao, atualizacao do pedido: nenhum estorno (e a contraprova dava -1); a gravada depois da reconciliacao e estornada e fecha em 0", async () => {
    const sku = await novoSku(ORG_ALINHAMENTO, "alinhamento");
    const base = 935_300_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const absorvida = base + 1;
    const depois = base + 2;
    const itens = [{ position: 0, quantity: 1, skuId: sku, skuKind: "PRODUTO" as const, components: [] }];
    const C = "2026-09-14T18:42:00.000Z";
    const lote = await novoLote(ORG_ALINHAMENTO, `${PREFIXO}-alinhamento.xlsx`);

    await snapshot(ORG_ALINHAMENTO, lote, "ALINHAMENTO", sku, "ESTOQUE LOJA", 10, C, "2026-09-14T18:44:18.714Z");
    await client.query(`update public.erp_import_batches set applied_at = '2026-09-14T18:44:19.581Z' where id = $1`, [lote]);

    // Venda ate o corte gravada DEPOIS do import, sem estorno (o estorno falhou antes do retry).
    await movimento(ORG_ALINHAMENTO, sku, "VENDA_ML", -1, `venda:${String(absorvida)}:0`, "2026-09-14T10:00:00.000Z", String(absorvida), "2026-09-14T19:00:00.000Z");

    // A reconciliacao diaria: ajuste e a rodada registrada.
    expect(await ajusteDaReconciliacao(ORG_ALINHAMENTO, sku)).toBe(11);
    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at, created_at)
       values ($1, $2, 'LOCAL', 11, 'AJUSTE_RECONCILIACAO', $3, '2026-09-15T09:00:01Z', '2026-09-15T09:00:01Z')`,
      [ORG_ALINHAMENTO, sku, `${PREFIXO}:alinhamento:r1`],
    );
    await rodadaDaReconciliacao(ORG_ALINHAMENTO, "2026-09-15T09:00:05.000Z");

    expect(await ajusteDaReconciliacao(ORG_ALINHAMENTO, sku)).toBe(0);

    const corte = await corteDaRpc(ORG_ALINHAMENTO, sku);

    expect(corte.reconciled_at?.toISOString()).toBe("2026-09-15T09:00:05.000Z");

    const cutoffFor = () => ({
      capturedAt: corte.captured_at,
      importedAt: corte.imported_at,
      reconciledAt: corte.reconciled_at,
      exportedAt: corte.exported_at,
    });
    const gravadaAbsorvida = await vendaGravada(`venda:${String(absorvida)}:0`);

    // 1. O pedido e atualizado (envio): a reconciliacao ja absorveu a venda -- nenhum estorno.
    const atualizacao = computeSaleDeductions(
      {
        id: absorvida,
        status: "paid",
        dateCreated: new Date("2026-09-14T09:59:00.000Z"),
        dateClosed: new Date("2026-09-14T10:00:00.000Z"),
        items: itens,
      },
      { cutoffFor, recordedSale: () => gravadaAbsorvida, recordedReversals: [] },
    );

    expect(atualizacao.preCaptureReversals).toEqual([]);

    // Contraprova: com o estorno (a regra de e6fda07, ancorada so no import), a rodada seguinte ajustaria -1.
    await client.query("begin");

    try {
      await movimento(ORG_ALINHAMENTO, sku, "ESTORNO_PRE_CAPTURA", 1, estornoKeyOf(`venda:${String(absorvida)}:0`), "2026-09-14T10:00:00.000Z", String(absorvida));

      expect(await ajusteDaReconciliacao(ORG_ALINHAMENTO, sku)).toBe(-1);
    } finally {
      await client.query("rollback");
    }

    // 2. Outra venda ate o corte, gravada DEPOIS da reconciliacao: estorna, e fecha em 0.
    await movimento(ORG_ALINHAMENTO, sku, "VENDA_ML", -1, `venda:${String(depois)}:0`, "2026-09-14T11:00:00.000Z", String(depois), "2026-09-15T10:00:00.000Z");

    expect(await ajusteDaReconciliacao(ORG_ALINHAMENTO, sku)).toBe(1);

    const gravadaDepois = await vendaGravada(`venda:${String(depois)}:0`);
    const posterior = computeSaleDeductions(
      {
        id: depois,
        status: "paid",
        dateCreated: new Date("2026-09-14T10:59:00.000Z"),
        dateClosed: new Date("2026-09-14T11:00:00.000Z"),
        items: itens,
      },
      { cutoffFor, recordedSale: () => gravadaDepois, recordedReversals: [] },
    );

    expect(posterior.preCaptureReversals).toHaveLength(1);

    for (const estorno of posterior.preCaptureReversals) {
      await movimento(ORG_ALINHAMENTO, estorno.skuId, "ESTORNO_PRE_CAPTURA", estorno.qtyDelta, estorno.idempotencyKey, estorno.occurredAt.toISOString(), String(depois));
    }

    expect(await ajusteDaReconciliacao(ORG_ALINHAMENTO, sku)).toBe(0);
  });

  it("o caminho documentado de producao continua fechando: worker novo, F3, reconciliacao despausada, e as atualizacoes seguintes nao geram ajuste", async () => {
    const sku = await novoSku(ORG_PRODUCAO, "caminho-producao");
    const base = 935_400_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    const pedidoA = base + 1;
    const pedidoB = base + 2;
    const pedidoC = base + 3;
    const itens = [{ position: 0, quantity: 1, skuId: sku, skuKind: "PRODUTO" as const, components: [] }];
    const CORTE = new Date(Date.now() - 10 * 60_000);
    const em = (minutos: number) => new Date(CORTE.getTime() + minutos * 60_000).toISOString();

    const conta = await umId(
      `insert into public.ml_accounts (organization_id, label, slug, seller_id, status, connected_at)
       values ($1, 'Producao', $2, $3, 'CONNECTED', now()) returning id`,
      [ORG_PRODUCAO, `${PREFIXO}-producao`, 3_600_000 + Math.floor(Math.random() * 100_000)],
    );

    for (const [id, fechado] of [
      [pedidoA, em(-2 * 24 * 60)],
      [pedidoB, em(-24 * 60)],
      [pedidoC, em(-3 * 24 * 60)],
    ] as const) {
      await client.query(
        `insert into public.orders (id, organization_id, ml_account_id, status, date_created, date_closed, date_last_updated, total_amount, currency_id)
         values ($1, $2, $3, 'paid', $4::timestamptz - interval '1 minute', $4, now(), 10, 'BRL')`,
        [id, ORG_PRODUCAO, conta, fechado],
      );
    }

    const lote = await novoLote(ORG_PRODUCAO, `${PREFIXO}-producao.xlsx`);

    await snapshot(ORG_PRODUCAO, lote, "PRODUCAO", sku, "ESTOQUE LOJA", 20, CORTE.toISOString(), em(1));
    await client.query(`update public.erp_import_batches set applied_at = $1 where id = $2`, [em(2), lote]);

    // O worker ANTIGO, depois do import: A com a data da atualizacao (depois do corte); B com
    // uma atualizacao anterior ao corte, gravada depois dele.
    await movimento(ORG_PRODUCAO, sku, "VENDA_ML", -1, `venda:${String(pedidoA)}:0`, em(5), String(pedidoA), em(5));
    await movimento(ORG_PRODUCAO, sku, "VENDA_ML", -1, `venda:${String(pedidoB)}:0`, em(-30), String(pedidoB), em(6));

    await client.query("begin");

    try {
      const estornosDoWorker = async (id: number, fechado: string): Promise<number> => {
        const corte = await corteDaRpc(ORG_PRODUCAO, sku);
        const gravada = await vendaGravada(`venda:${String(id)}:0`);
        const resultado = computeSaleDeductions(
          { id, status: "paid", dateCreated: new Date(fechado), dateClosed: new Date(fechado), items: itens },
          {
            cutoffFor: () => ({
              capturedAt: corte.captured_at,
              importedAt: corte.imported_at,
              reconciledAt: corte.reconciled_at,
              exportedAt: corte.exported_at,
            }),
            recordedSale: () => gravada,
            recordedReversals: [],
          },
        );

        for (const [tipo, draft] of [
          ...resultado.deductions.map((d) => ["VENDA_ML", d] as const),
          ...resultado.preCaptureReversals.map((d) => ["ESTORNO_PRE_CAPTURA", d] as const),
        ]) {
          await client.query(
            `insert into public.stock_movements
               (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
             values ($1, $2, 'LOCAL', $3, $4, 'ORDER', $5, $6, $7)
             on conflict (idempotency_key) do nothing`,
            [ORG_PRODUCAO, draft.skuId, draft.qtyDelta, tipo, String(id), draft.idempotencyKey, draft.occurredAt.toISOString()],
          );
        }

        return resultado.preCaptureReversals.length;
      };

      // 1. Deploy: o worker novo atualiza A e o estorna, espelhado (nunca reconciliou).
      expect(await estornosDoWorker(pedidoA, em(-2 * 24 * 60))).toBe(1);

      // 2. A F3 estorna o que sobrou (B).
      const avisos: string[] = [];
      const escuta = (aviso: { message?: string | undefined }): void => {
        avisos.push(aviso.message ?? "");
      };

      client.on("notice", escuta);

      try {
        await client.query(`set local sb.compensacao_organizacao = '${ORG_PRODUCAO}'`);
        await client.query(await arquivo("packages/db/scripts/compensacao-estorno-pre-captura-d351.sql"));
      } finally {
        client.off("notice", escuta);
      }

      expect(avisos).toContain("compensacao_d351: 1 estornos gravados");

      // 3. O dono despausa a reconciliacao: a primeira rodada semeia o saldo.
      const RODADA = new Date(Date.now() + 60_000).toISOString();
      const semente = await ajusteDaReconciliacao(ORG_PRODUCAO, sku);

      await client.query(
        `insert into public.stock_movements
           (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at, created_at)
         values ($1, $2, 'LOCAL', $3, 'AJUSTE_RECONCILIACAO', $4, $5, $5)`,
        [ORG_PRODUCAO, sku, semente, `${PREFIXO}:producao:semente`, RODADA],
      );
      await rodadaDaReconciliacao(ORG_PRODUCAO, RODADA);

      expect(await ajusteDaReconciliacao(ORG_PRODUCAO, sku)).toBe(0);
      expect((await corteDaRpc(ORG_PRODUCAO, sku)).reconciled_at?.toISOString()).toBe(RODADA);

      // 4. Depois da reconciliacao: A e B voltam a ser atualizados, e C (venda antiga nunca
      // gravada) aparece. Nada disso gera ajuste.
      await estornosDoWorker(pedidoA, em(-2 * 24 * 60));
      expect(await estornosDoWorker(pedidoB, em(-24 * 60))).toBe(0);
      expect(await estornosDoWorker(pedidoC, em(-3 * 24 * 60))).toBe(1);

      expect(await ajusteDaReconciliacao(ORG_PRODUCAO, sku)).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("desempate da planilha reimportada com o mesmo nome (verificacao de e6fda07, BAIXA-2)", () => {
  const ORG_REIMPORT = randomUUID();
  const ORG_REIMPORT_ORGANIZACAO = randomUUID();

  beforeAll(async () => {
    await novaOrganizacao(ORG_REIMPORT, "reimport");
    await novaOrganizacao(ORG_REIMPORT_ORGANIZACAO, "reimport-organizacao");
  });

  /**
   * O corte pela RPC SEM indice (reverificacao de 60c7a6a, MEDIA-1). Em banco pequeno o plano
   * desce `erp_stock_snapshots_sku_cutoff_idx` e `erp_stock_snapshots_org_cutoff_idx`, que ja
   * estao na ordem do desempate: a RPC sem o `created_at desc, id desc` passava no teste. Com a
   * varredura sequencial e o sort, so o desempate escrito na consulta escolhe o lote novo.
   */
  async function corteDaRpcSemIndice(organizationId: string, skuId: string): Promise<CorteLido> {
    await client.query("begin");

    try {
      await client.query("set local enable_indexscan = off");
      await client.query("set local enable_indexonlyscan = off");
      await client.query("set local enable_bitmapscan = off");

      return await corteDaRpc(organizationId, skuId);
    } finally {
      await client.query("rollback");
    }
  }

  it("o mesmo empate no corte da ORGANIZACAO (SKU sem snapshot proprio): o corte fica com o lote gravado por ultimo, com e sem indice (reverificacao de 60c7a6a, MEDIA-1)", async () => {
    const comSnapshot = await novoSku(ORG_REIMPORT_ORGANIZACAO, "reimport-org");
    const semSnapshot = await novoSku(ORG_REIMPORT_ORGANIZACAO, "reimport-org-sem-snapshot");
    const C = "2026-09-16T18:00:00.000Z";
    const primeiro = await novoLote(ORG_REIMPORT_ORGANIZACAO, `${PREFIXO}-reimport-org-1.xlsx`);
    const segundo = await novoLote(ORG_REIMPORT_ORGANIZACAO, `${PREFIXO}-reimport-org-2.xlsx`);

    // O lote VELHO entra fisicamente primeiro: na varredura sequencial, e ele que vem antes no sort.
    await snapshot(ORG_REIMPORT_ORGANIZACAO, primeiro, "REIMPORT-ORG", comSnapshot, "ESTOQUE LOJA", 7, C, "2026-09-16T18:02:00.000Z");
    await snapshot(ORG_REIMPORT_ORGANIZACAO, segundo, "REIMPORT-ORG", comSnapshot, "ESTOQUE LOJA", 6, C, "2026-09-16T19:02:00.000Z");
    await client.query(`update public.erp_import_batches set applied_at = '2026-09-16T18:02:01Z' where id = $1`, [primeiro]);
    await client.query(`update public.erp_import_batches set applied_at = '2026-09-16T19:02:01Z' where id = $1`, [segundo]);

    for (const corte of [await corteDaRpc(ORG_REIMPORT_ORGANIZACAO, semSnapshot), await corteDaRpcSemIndice(ORG_REIMPORT_ORGANIZACAO, semSnapshot)]) {
      expect([corte.captured_at.toISOString(), corte.imported_at.toISOString(), corte.reconciled_at]).toEqual([
        C,
        "2026-09-16T19:02:01.000Z",
        null,
      ]);
    }
  });

  it("dois lotes com o MESMO captured_at: o alvo e o corte ficam com o lote gravado por ultimo", async () => {
    const sku = await novoSku(ORG_REIMPORT, "reimport");
    const C = "2026-09-16T18:00:00.000Z";
    const primeiro = await novoLote(ORG_REIMPORT, `${PREFIXO}-reimport-1.xlsx`);
    const segundo = await novoLote(ORG_REIMPORT, `${PREFIXO}-reimport-2.xlsx`);

    // O lote VELHO entra fisicamente primeiro: sem o desempate, e ele que o `distinct on` escolhia.
    await snapshot(ORG_REIMPORT, primeiro, "REIMPORT", sku, "ESTOQUE LOJA", 7, C, "2026-09-16T18:02:00.000Z");
    await snapshot(ORG_REIMPORT, segundo, "REIMPORT", sku, "ESTOQUE LOJA", 6, C, "2026-09-16T19:02:00.000Z");
    await client.query(`update public.erp_import_batches set applied_at = '2026-09-16T18:02:01Z' where id = $1`, [primeiro]);
    await client.query(`update public.erp_import_batches set applied_at = '2026-09-16T19:02:01Z' where id = $1`, [segundo]);

    const alvo = await client.query<{ quantity: string }>(
      `select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL'`,
      [ORG_REIMPORT, sku],
    );
    const corte = await corteDaRpc(ORG_REIMPORT, sku);
    // Sem indice (reverificacao de 60c7a6a, MEDIA-1): so o desempate da consulta escolhe o lote novo.
    const semIndice = await corteDaRpcSemIndice(ORG_REIMPORT, sku);

    expect(Number(alvo.rows[0]?.quantity)).toBe(6);
    expect([corte.captured_at.toISOString(), corte.imported_at.toISOString()]).toEqual([C, "2026-09-16T19:02:01.000Z"]);
    expect([semIndice.captured_at.toISOString(), semIndice.imported_at.toISOString()]).toEqual([C, "2026-09-16T19:02:01.000Z"]);
  });

  it("compute_erp_target_balances continua SECURITY INVOKER, com search_path travado, e so service_role executa", async () => {
    const result = await client.query<{ definer: boolean; config: string | null; acl: string }>(
      `select p.prosecdef as definer, array_to_string(p.proconfig, ',') as config, p.proacl::text as acl
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'compute_erp_target_balances'`,
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.definer).toBe(false);
    expect(result.rows[0]?.config).toBe('search_path=""');
    expect(result.rows[0]?.acl).not.toMatch(/(^|[{,])(anon|authenticated)?=X/);
    expect(result.rows[0]?.acl).toMatch(/service_role=X/);
  });
});

describe("migration 20260916180000: o UPDATE nao recua o corte de organizacao ja reconciliada (verificacao de e6fda07, MEDIA-1)", () => {
  const ORG_NUNCA = randomUUID();
  const ORG_RECONCILIADA_MIGRACAO = randomUUID();

  beforeAll(async () => {
    await novaOrganizacao(ORG_NUNCA, "migracao-nunca-reconciliou");
    await novaOrganizacao(ORG_RECONCILIADA_MIGRACAO, "migracao-reconciliada");
  });

  it("a organizacao que nunca reconciliou ganha o corte da exportacao; a reconciliada fica com o do parse, e o alvo dela nao muda", async () => {
    const migration = await arquivo("supabase/migrations/20260916180000_erp_corte_da_exportacao.sql");
    const update = /update public\.erp_stock_snapshots s[\s\S]*?;/.exec(migration)?.[0];
    const PARSE = "2026-08-21T15:42:02.459Z";

    expect(update).toBeDefined();

    const skuNunca = await novoSku(ORG_NUNCA, "migracao-nunca");
    const skuReconciliada = await novoSku(ORG_RECONCILIADA_MIGRACAO, "migracao-reconciliada");

    await snapshot(ORG_NUNCA, await novoLote(ORG_NUNCA, "Lista_de_Estoque_0820160923.xlsx", PARSE), "NUNCA", skuNunca, "ESTOQUE LOJA", 10, PARSE);
    await snapshot(
      ORG_RECONCILIADA_MIGRACAO,
      await novoLote(ORG_RECONCILIADA_MIGRACAO, "Lista_de_Estoque_0820160923.xlsx", PARSE),
      "RECONCILIADA",
      skuReconciliada,
      "ESTOQUE LOJA",
      10,
      PARSE,
    );

    // O Dev: venda fechada ANTES da exportacao, gravada pelo worker antigo com a data da
    // atualizacao (entre a exportacao e o parse), ja absorvida pela reconciliacao.
    await movimento(ORG_RECONCILIADA_MIGRACAO, skuReconciliada, "VENDA_ML", -1, `${PREFIXO}:dev-antiga`, "2026-08-21T10:00:00.000Z");
    await movimento(ORG_RECONCILIADA_MIGRACAO, skuReconciliada, "AJUSTE_RECONCILIACAO", 11, `${PREFIXO}:dev-ajuste`, "2026-08-25T13:29:30.000Z");

    const alvoAntes = await ajusteDaReconciliacao(ORG_RECONCILIADA_MIGRACAO, skuReconciliada);

    expect(alvoAntes).toBe(0);

    await client.query("begin");

    try {
      await client.query(update ?? "");

      const cortes = await client.query<{ organization_id: string; captured_at: Date }>(
        `select organization_id, captured_at from public.erp_stock_snapshots where organization_id = any($1::uuid[])`,
        [[ORG_NUNCA, ORG_RECONCILIADA_MIGRACAO]],
      );
      const porOrganizacao = new Map(cortes.rows.map((r) => [r.organization_id, r.captured_at.toISOString()]));

      expect(porOrganizacao.get(ORG_NUNCA)).toBe("2026-08-20T16:09:23.000Z");
      expect(porOrganizacao.get(ORG_RECONCILIADA_MIGRACAO)).toBe(PARSE);
      // Com o corte recuado, a venda antiga entraria no alvo e a proxima rodada gravaria -1.
      expect(await ajusteDaReconciliacao(ORG_RECONCILIADA_MIGRACAO, skuReconciliada)).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });
});

describe("get_order_return_movements (verificacao de e6fda07, ALTA-1)", () => {
  const ORG_DEVOLUCOES = randomUUID();
  const ORG_OUTRA_DEVOLUCAO = randomUUID();
  const P1 = String(935_500_000_000 + Math.floor(Math.random() * 1_000_000) * 10);
  const P2 = String(Number(P1) + 1);
  let sku = "";
  let outro = "";

  beforeAll(async () => {
    await novaOrganizacao(ORG_DEVOLUCOES, "devolucoes");
    await novaOrganizacao(ORG_OUTRA_DEVOLUCAO, "devolucoes-outra");

    sku = await novoSku(ORG_DEVOLUCOES, "devolucoes");
    outro = await novoSku(ORG_OUTRA_DEVOLUCAO, "devolucoes-outra");

    await movimento(ORG_DEVOLUCOES, sku, "VENDA_ML", -2, `venda:${P1}:0`, "2026-09-15T10:00:00.000Z", P1);
    await movimento(ORG_DEVOLUCOES, sku, "CANCELAMENTO_ML", 1, `cancelamento:venda:${P1}:0`, "2026-09-15T11:00:00.000Z", P1);
    await devolucao(ORG_DEVOLUCOES, sku, "5570000001", `venda:${P1}:0`, "2026-09-15T12:00:00.000Z");
    await devolucao(ORG_DEVOLUCOES, sku, "5570000002", `venda:${P1}:0:${sku}`, "2026-09-15T12:00:00.000Z");
    await devolucao(ORG_DEVOLUCOES, sku, "5570000003", `venda:${P2}:0`, "2026-09-15T12:00:00.000Z");
    // A mesma chave de pedido em OUTRA organizacao nao vaza.
    await devolucao(ORG_OUTRA_DEVOLUCAO, outro, "5570000004", `venda:${P1}:0`, "2026-09-15T12:00:00.000Z");
  });

  it("anon e authenticated nao executam; e SECURITY INVOKER com search_path travado", async () => {
    const sql = `select * from public.get_order_return_movements('${ORG_DEVOLUCOES}', array['${P1}'])`;

    await expect(comoPapel("anon", sql)).rejects.toThrow(/permission denied/i);
    await expect(comoPapel("authenticated", sql)).rejects.toThrow(/permission denied/i);

    const result = await client.query<{ definer: boolean; config: string | null }>(
      `select p.prosecdef as definer, array_to_string(p.proconfig, ',') as config
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'get_order_return_movements'`,
    );

    expect(result.rows).toEqual([{ definer: false, config: 'search_path=""' }]);
  });

  it("service_role: so as DEVOLUCAO_ML dos pedidos pedidos, pelo pedido de dentro da chave, e so da organizacao -- com o occurred_at (D-351 §12)", async () => {
    const rows = await comoPapel<{ order_id: string; sku_id: string; qty_delta: string; idempotency_key: string; occurred_at: Date }>(
      "service_role",
      `select order_id, sku_id, qty_delta, idempotency_key, occurred_at from public.get_order_return_movements('${ORG_DEVOLUCOES}', array['${P1}', '999'])`,
    );

    expect(rows.map((r) => [r.order_id, Number(r.qty_delta), r.idempotency_key, r.occurred_at.toISOString()]).sort()).toEqual(
      [
        [P1, 1, `devolucao:5570000001:venda:${P1}:0`, "2026-09-15T12:00:00.000Z"],
        [P1, 1, `devolucao:5570000002:venda:${P1}:0:${sku}`, "2026-09-15T12:00:00.000Z"],
      ].sort(),
    );
  });

  it("service_role: movimento de OUTRO tipo com a chave no formato da devolucao nao entra -- e o tipo, e nao a chave, que separa a devolucao (reverificacao de 60c7a6a)", async () => {
    const P3 = String(Number(P1) + 2);

    // Um estorno (ou qualquer outro tipo) cuja chave tenha o pedido no quarto campo: somado como
    // devolucao, faria a venda parecer ja devolvida, e o cancelamento seguinte nao reporia a unidade.
    await movimento(ORG_DEVOLUCOES, sku, "ESTORNO_PRE_CAPTURA", 1, `devolucao:5570000005:venda:${P3}:0`, "2026-09-15T12:00:00.000Z", P3);
    await devolucao(ORG_DEVOLUCOES, sku, "5570000006", `venda:${P3}:1`, "2026-09-15T12:00:00.000Z");

    const rows = await comoPapel<{ order_id: string; qty_delta: string; idempotency_key: string }>(
      "service_role",
      `select order_id, qty_delta, idempotency_key from public.get_order_return_movements('${ORG_DEVOLUCOES}', array['${P3}'])`,
    );

    expect(rows.map((r) => [r.order_id, Number(r.qty_delta), r.idempotency_key])).toEqual([[P3, 1, `devolucao:5570000006:venda:${P3}:1`]]);
  });
});

describe("compensacao F3 e o limite das reversoes (verificacao de e6fda07, ALTA-1 e MEDIA-1)", () => {
  const ORG_F3_REVERSAO = randomUUID();
  const PEDIDO = 935_600_000_000 + Math.floor(Math.random() * 1_000_000) * 100;
  const CORTE = new Date(Date.now() - 10 * 60_000);
  const em = (minutos: number) => new Date(CORTE.getTime() + minutos * 60_000).toISOString();

  // P1 = a forma de 2000018212899604; P2 = venda com devolucao so; P3 = um dos 6 do trio com
  // `order.returned` movementsReversed 0; P4 = venda gravada com a chave de um KIT e o item
  // hoje vinculado como PRODUTO.
  const P1 = PEDIDO + 1;
  const P2 = PEDIDO + 2;
  const P3 = PEDIDO + 3;
  const P4 = PEDIDO + 4;
  // P5 = KIT A1+A2 com a devolucao entregue dos DOIS componentes (reverificacao de c48fb70, MUT-X1).
  const P5 = PEDIDO + 5;
  let sku = "";
  let conta = "";
  let a1 = "";
  let a2 = "";

  async function pedido(id: number, status: string, dateClosed: string): Promise<void> {
    await client.query(
      `insert into public.orders (id, organization_id, ml_account_id, status, date_created, date_closed, date_last_updated, total_amount, currency_id)
       values ($1, $2, $3, $4, $5::timestamptz - interval '1 minute', $5, now(), 10, 'BRL')`,
      [id, ORG_F3_REVERSAO, conta, status, dateClosed],
    );
  }

  /** O item do pedido vinculado hoje ao SKU, como PRODUTO. Depois do pedido: `order_items` tem FK. */
  async function itemVinculado(id: number, itemId: string): Promise<void> {
    await client.query(
      `insert into public.order_items (order_id, organization_id, ml_account_id, position, item_id, title, quantity, unit_price, currency_id, sku_id)
       values ($1, $2, $3, 0, $4, 'Item D-351', 1, 10, 'BRL', $5)`,
      [id, ORG_F3_REVERSAO, conta, itemId, sku],
    );
  }

  async function evento(id: number, tipo: string, antes: string | null, occurredAt: string, depois: unknown): Promise<void> {
    await client.query(
      `insert into public.domain_events
         (organization_id, ml_account_id, occurred_at, event_type, entity_type, entity_id, before, after, severity, source, dedup_key)
       values ($1, $2, $3, $4, 'order', $5, $6::jsonb, $7::jsonb, 'importante', 'sync', $8)`,
      [
        ORG_F3_REVERSAO,
        conta,
        occurredAt,
        tipo,
        String(id),
        antes === null ? null : JSON.stringify({ status: antes }),
        JSON.stringify(depois),
        `${PREFIXO}:f3-reversao:${tipo}:${String(id)}`,
      ],
    );
  }

  /** Soma do pedido no ledger (origem ORDER e devolucoes pela chave) e a parte dele no alvo. */
  async function liquidoDoPedido(id: number): Promise<{ saldo: number; alvo: number }> {
    const result = await client.query<{ saldo: string | null; alvo: string | null }>(
      `select sum(m.qty_delta) as saldo,
              sum(m.qty_delta) filter (where m.occurred_at > $3 and m.movement_type <> 'AJUSTE_RECONCILIACAO') as alvo
       from public.stock_movements m
       where m.organization_id = $1
         and ((m.source_type = 'ORDER' and m.source_id = $2) or (m.movement_type = 'DEVOLUCAO_ML' and split_part(m.idempotency_key, ':', 4) = $2))`,
      [ORG_F3_REVERSAO, String(id), CORTE.toISOString()],
    );

    return { saldo: Number(result.rows[0]?.saldo ?? 0), alvo: Number(result.rows[0]?.alvo ?? 0) };
  }

  beforeAll(async () => {
    await novaOrganizacao(ORG_F3_REVERSAO, "f3-reversao");
    sku = await novoSku(ORG_F3_REVERSAO, "f3-reversao");
    conta = await umId(
      `insert into public.ml_accounts (organization_id, label, slug, seller_id, status, connected_at)
       values ($1, 'F3 reversao', $2, $3, 'CONNECTED', now()) returning id`,
      [ORG_F3_REVERSAO, `${PREFIXO}-f3-reversao`, 3_700_000 + Math.floor(Math.random() * 100_000)],
    );

    await snapshot(ORG_F3_REVERSAO, await novoLote(ORG_F3_REVERSAO, `${PREFIXO}-f3-reversao.xlsx`), "F3-REVERSAO", sku, "ESTOQUE LOJA", 20, CORTE.toISOString());

    // P1: VENDA do worker antigo (depois do corte), DEVOLUCAO e CANCELAMENTO -- o legado +1.
    await pedido(P1, "cancelled", em(-15 * 24 * 60));
    await movimento(ORG_F3_REVERSAO, sku, "VENDA_ML", -1, `venda:${String(P1)}:0`, em(9), String(P1));
    await devolucao(ORG_F3_REVERSAO, sku, "5570995770", `venda:${String(P1)}:0`, em(20));
    await movimento(ORG_F3_REVERSAO, sku, "CANCELAMENTO_ML", 1, `cancelamento:venda:${String(P1)}:0`, em(21), String(P1));

    // P2: VENDA do worker antigo e DEVOLUCAO, sem cancelamento -- estorna inteiro.
    await pedido(P2, "paid", em(-10 * 24 * 60));
    await movimento(ORG_F3_REVERSAO, sku, "VENDA_ML", -1, `venda:${String(P2)}:0`, em(9), String(P2));
    await devolucao(ORG_F3_REVERSAO, sku, "5570995771", `venda:${String(P2)}:0`, em(20));

    // P3: nunca gravado; a devolucao foi processada sem venda (movementsReversed 0) e o
    // pedido cancelou depois do corte, com a transicao vista -- o trio.
    await pedido(P3, "cancelled", em(-12 * 24 * 60));
    await itemVinculado(P3, "MLB351352");
    await evento(P3, "order.returned", null, em(24), { fullReversal: false, movementsReversed: 0, needsManualReview: true });
    await evento(P3, "order.cancelled", "paid", em(25), { status: "cancelled" });

    // P4: a venda foi gravada com a chave de um KIT (componente = o mesmo SKU), e o item hoje
    // esta vinculado como PRODUTO. Cancelou depois do corte, com a transicao vista.
    await pedido(P4, "cancelled", em(-11 * 24 * 60));
    await itemVinculado(P4, "MLB351353");
    await movimento(ORG_F3_REVERSAO, sku, "VENDA_ML", -1, `venda:${String(P4)}:0:${sku}`, em(9), String(P4));
    await evento(P4, "order.cancelled", "paid", em(26), { status: "cancelled" });

    // P5: KIT A1+A2 vendido antes do corte, VENDA do worker antigo em cada componente e a devolucao
    // entregue dos DOIS (uma DEVOLUCAO_ML por componente, o mesmo claim), sem cancelamento. Cada venda
    // casa so com a devolucao da propria chave: somar as duas do pedido daria excesso 1 e nenhum estorno.
    a1 = await novoSku(ORG_F3_REVERSAO, "f3-reversao-a1");
    a2 = await novoSku(ORG_F3_REVERSAO, "f3-reversao-a2");
    const loteKit = await novoLote(ORG_F3_REVERSAO, `${PREFIXO}-f3-reversao-kit.xlsx`);

    await pedido(P5, "paid", em(-9 * 24 * 60));

    for (const [componente, chaveDoSnapshot] of [
      [a1, "F3-REVERSAO-A1"],
      [a2, "F3-REVERSAO-A2"],
    ] as const) {
      await snapshot(ORG_F3_REVERSAO, loteKit, chaveDoSnapshot, componente, "ESTOQUE LOJA", 20, CORTE.toISOString());
      await movimento(ORG_F3_REVERSAO, componente, "VENDA_ML", -1, `venda:${String(P5)}:0:${componente}`, em(9), String(P5));
      await devolucao(ORG_F3_REVERSAO, componente, "5570995775", `venda:${String(P5)}:0:${componente}`, em(20));
    }
  });

  async function rodarF3(avisos: string[]): Promise<void> {
    const escuta = (aviso: { message?: string | undefined }): void => {
      avisos.push(aviso.message ?? "");
    };

    client.on("notice", escuta);

    try {
      await client.query(`set local sb.compensacao_organizacao = '${ORG_F3_REVERSAO}'`);
      await client.query(await arquivo("packages/db/scripts/compensacao-estorno-pre-captura-d351.sql"));
    } finally {
      client.off("notice", escuta);
    }
  }

  it("VENDA + DEVOLUCAO + CANCELAMENTO fica em +1 com o estorno inteiro e a anulacao do cancelamento (D-351 §12); so a devolucao estorna inteiro; o KIT com a devolucao dos dois componentes estorna cada um; o trio nao volta a devolver; e pedido com VENDA_ML de outra chave nao e reposto", async () => {
    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarF3(avisos);

      expect(avisos).toContain("compensacao_d351: 5 estornos gravados");
      expect(avisos).toContain("compensacao_d351: 1 anulacoes de reversao a mais gravadas");
      expect(avisos).toContain("compensacao_d351: 1 vendas repostas (venda + estorno + cancelamento)");

      const estornos = await client.query<{ idempotency_key: string; qty_delta: string }>(
        `select idempotency_key, qty_delta from public.stock_movements
         where organization_id = $1 and movement_type = 'ESTORNO_PRE_CAPTURA' order by idempotency_key`,
        [ORG_F3_REVERSAO],
      );

      expect(estornos.rows.map((r) => [r.idempotency_key, Number(r.qty_delta)]).sort()).toEqual(
        [
          // P1: a venda inteira -- ate cc90baa, 1 - excesso = 0 e nenhuma linha.
          [`estorno:venda:${String(P1)}:0`, 1],
          [`estorno:venda:${String(P2)}:0`, 1],
          [`estorno:venda:${String(P3)}:0`, 1],
          [`estorno:venda:${String(P4)}:0:${sku}`, 1],
          [`estorno:venda:${String(P5)}:0:${a1}`, 1],
          [`estorno:venda:${String(P5)}:0:${a2}`, 1],
        ].sort(),
      );

      // P1: a reversao a mais e o cancelamento (em(21), depois da devolucao em(20)), anulado com o instante dele.
      const anulacoes = await client.query<{ idempotency_key: string; qty_delta: string; occurred_at: Date; source_id: string }>(
        `select idempotency_key, qty_delta, occurred_at, source_id from public.stock_movements
         where organization_id = $1 and movement_type = 'ESTORNO_REVERSAO_EXCEDENTE'`,
        [ORG_F3_REVERSAO],
      );

      expect(anulacoes.rows.map((r) => [r.idempotency_key, Number(r.qty_delta), r.occurred_at.toISOString(), r.source_id])).toEqual([
        [`estorno:cancelamento:venda:${String(P1)}:0`, -1, em(21), String(P1)],
      ]);

      // P5: cada componente fica em +1 no saldo e no alvo -- snapshot 20 e a unidade que voltou uma vez.
      for (const componente of [a1, a2]) {
        const doComponente = await client.query<{ alvo: string | null; saldo: string | null }>(
          `select (select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL') as alvo,
                  (select quantity from public.inventory_balances where sku_id = $2 and location_kind = 'LOCAL') as saldo`,
          [ORG_F3_REVERSAO, componente],
        );

        expect([Number(doComponente.rows[0]?.alvo), Number(doComponente.rows[0]?.saldo)]).toEqual([21, 1]);
      }

      // P4: nenhuma venda com a chave de hoje.
      const repostaP4 = await client.query(`select 1 from public.stock_movements where idempotency_key = $1`, [
        `venda:${String(P4)}:0`,
      ]);

      expect(repostaP4.rowCount).toBe(0);

      // O estado final de cada pedido: saldo e parte no alvo. Real: a planilha tem a venda, e
      // a unidade voltou uma vez (P1, P2, P3); P4 ainda espera o CANCELAMENTO_ML do worker.
      expect(await liquidoDoPedido(P1)).toEqual({ saldo: 1, alvo: 1 });
      expect(await liquidoDoPedido(P2)).toEqual({ saldo: 1, alvo: 1 });
      expect(await liquidoDoPedido(P3)).toEqual({ saldo: 1, alvo: 1 });
      expect(await liquidoDoPedido(P4)).toEqual({ saldo: 0, alvo: 0 });

      // A nova execucao do claim de P3 (notificacao de encerramento, ou o retry de D-344):
      // com a venda do trio gravada, a devolucao le o cancelamento e nao devolve de novo.
      const doPedido = await client.query<{ sku_id: string; qty_delta: string; idempotency_key: string; movement_type: string }>(
        `select sku_id, qty_delta, idempotency_key, movement_type from public.stock_movements
         where organization_id = $1 and source_type = 'ORDER' and source_id = $2 and movement_type in ('VENDA_ML', 'CANCELAMENTO_ML')`,
        [ORG_F3_REVERSAO, String(P3)],
      );
      const devolucoesDeP3 = await client.query<{ qty_delta: string; idempotency_key: string }>(
        `select qty_delta, idempotency_key from public.get_order_return_movements($1, array[$2])`,
        [ORG_F3_REVERSAO, String(P3)],
      );
      const reversao = computeReturnReversal(
        { id: P3 },
        { position: 0, totalQuantity: 1, returnQuantity: 1 },
        doPedido.rows
          .filter((r) => r.movement_type === "VENDA_ML")
          .map((r) => ({ skuId: r.sku_id, qtyDelta: Number(r.qty_delta), idempotencyKey: r.idempotency_key })),
        [
          ...doPedido.rows
            .filter((r) => r.movement_type === "CANCELAMENTO_ML")
            .map((r) => ({ idempotencyKey: r.idempotency_key, quantity: Number(r.qty_delta) })),
          ...devolucoesDeP3.rows.map((r) => ({ idempotencyKey: r.idempotency_key, quantity: Number(r.qty_delta) })),
        ],
        "5572189795",
        new Date(),
      );

      expect(reversao.movements).toEqual([]);
      expect(reversao.alreadyReversed).toEqual([`venda:${String(P3)}:0`]);

      // Alvo = 20 + P1 (+1) + P2 (+1) + P3 (+1); saldo so dos movimentos (sem reconciliacao).
      const alvo = await client.query<{ quantity: string }>(
        `select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL'`,
        [ORG_F3_REVERSAO, sku],
      );

      expect(Number(alvo.rows[0]?.quantity)).toBe(23);

      const segunda: string[] = [];

      await rodarF3(segunda);

      expect(segunda).toContain("compensacao_d351: 0 estornos gravados");
      expect(segunda).toContain("compensacao_d351: 0 anulacoes de reversao a mais gravadas");
      expect(segunda).toContain("compensacao_d351: 0 vendas repostas (venda + estorno + cancelamento)");
    } finally {
      await client.query("rollback");
    }
  });
});

describe("compensacao F3: a reversao a mais do legado anulada com o instante dela (reverificacao de cc90baa, D-351 §12)", () => {
  const ORG_EXCESSO = randomUUID();
  const PEDIDO = 935_700_000_000 + Math.floor(Math.random() * 1_000_000) * 100;
  const CORTE = new Date(Date.now() - 10 * 60_000);
  const em = (minutos: number) => new Date(CORTE.getTime() + minutos * 60_000).toISOString();

  // K = a forma de 2000017792822486: KIT de 3 componentes, VENDA do worker antigo com occurred_at
  // ATE o corte (18:11:20 para o corte de 18:42:00) e gravada depois dele; DEVOLUCAO e depois
  // CANCELAMENTO, os dois depois do corte.
  const K = PEDIDO + 1;
  // C = a contraprova, 2000018206306064: VENDA do worker antigo DENTRO do alvo.
  const C = PEDIDO + 2;
  // E = devolucao e cancelamento no MESMO instante: a F3 e o dominio escolhem a mesma reversao.
  const E = PEDIDO + 3;
  // W = o worker novo gravou o estorno e falhou antes da anulacao: a F3 grava so a anulacao.
  const W = PEDIDO + 4;
  // D = E >= 2: VENDA ate o corte, CANCELAMENTO e depois DUAS DEVOLUCOES (claims diferentes), todos
  // depois do corte. V = 1, R = 3, E = 2, e a reversao mais recente (1) e menor que o excesso: so o
  // teto `least(quantidade_reversao, ...)` da parte 1B impede a anulacao de 2 na ultima devolucao.
  const D = PEDIDO + 5;
  let componentes: string[] = [];
  let skuC = "";
  let skuE = "";
  let skuW = "";
  let skuD = "";

  const chaveK = (componente: string) => `venda:${String(K)}:0:${componente}`;
  const porChave = (a: unknown[], b: unknown[]) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0);

  beforeAll(async () => {
    await novaOrganizacao(ORG_EXCESSO, "f3-excesso");

    componentes = [await novoSku(ORG_EXCESSO, "f3-excesso-a"), await novoSku(ORG_EXCESSO, "f3-excesso-b"), await novoSku(ORG_EXCESSO, "f3-excesso-c")];
    skuC = await novoSku(ORG_EXCESSO, "f3-excesso-contraprova");
    skuE = await novoSku(ORG_EXCESSO, "f3-excesso-empate");
    skuW = await novoSku(ORG_EXCESSO, "f3-excesso-worker");
    skuD = await novoSku(ORG_EXCESSO, "f3-excesso-duas-devolucoes");

    const conta = await umId(
      `insert into public.ml_accounts (organization_id, label, slug, seller_id, status, connected_at)
       values ($1, 'F3 excesso', $2, $3, 'CONNECTED', now()) returning id`,
      [ORG_EXCESSO, `${PREFIXO}-f3-excesso`, 3_800_000 + Math.floor(Math.random() * 100_000)],
    );
    // O snapshot ANTES dos movimentos: a venda do worker antigo entrou no saldo depois do import.
    const lote = await novoLote(ORG_EXCESSO, `${PREFIXO}-f3-excesso.xlsx`);

    for (const [indice, sku] of [...componentes, skuC, skuE, skuW, skuD].entries()) {
      await snapshot(ORG_EXCESSO, lote, `F3-EXCESSO-${String(indice)}`, sku, "ESTOQUE LOJA", 20, CORTE.toISOString());
    }

    for (const [id, fechado] of [
      [K, em(-41 * 24 * 60)],
      [C, em(-15 * 24 * 60)],
      [E, em(-12 * 24 * 60)],
      [W, em(-11 * 24 * 60)],
      [D, em(-10 * 24 * 60)],
    ] as const) {
      await client.query(
        `insert into public.orders (id, organization_id, ml_account_id, status, date_created, date_closed, date_last_updated, total_amount, currency_id)
         values ($1, $2, $3, 'cancelled', $4::timestamptz - interval '5 minutes', $4, now(), 10, 'BRL')`,
        [id, ORG_EXCESSO, conta, fechado],
      );
    }

    for (const componente of componentes) {
      await movimento(ORG_EXCESSO, componente, "VENDA_ML", -1, chaveK(componente), em(-31), String(K));
      await devolucao(ORG_EXCESSO, componente, "5571421181", chaveK(componente), em(3));
      await movimento(ORG_EXCESSO, componente, "CANCELAMENTO_ML", 1, `cancelamento:${chaveK(componente)}`, em(8), String(K));
    }

    await movimento(ORG_EXCESSO, skuC, "VENDA_ML", -1, `venda:${String(C)}:0`, em(5), String(C));
    await devolucao(ORG_EXCESSO, skuC, "5570000002", `venda:${String(C)}:0`, em(6));
    await movimento(ORG_EXCESSO, skuC, "CANCELAMENTO_ML", 1, `cancelamento:venda:${String(C)}:0`, em(7), String(C));

    await movimento(ORG_EXCESSO, skuE, "VENDA_ML", -1, `venda:${String(E)}:0`, em(-20), String(E));
    await devolucao(ORG_EXCESSO, skuE, "5570000003", `venda:${String(E)}:0`, em(4));
    await movimento(ORG_EXCESSO, skuE, "CANCELAMENTO_ML", 1, `cancelamento:venda:${String(E)}:0`, em(4), String(E));

    await movimento(ORG_EXCESSO, skuW, "VENDA_ML", -1, `venda:${String(W)}:0`, em(-25), String(W));
    await movimento(ORG_EXCESSO, skuW, "ESTORNO_PRE_CAPTURA", 1, `estorno:venda:${String(W)}:0`, em(-25), String(W));
    await devolucao(ORG_EXCESSO, skuW, "5570000004", `venda:${String(W)}:0`, em(2));
    await movimento(ORG_EXCESSO, skuW, "CANCELAMENTO_ML", 1, `cancelamento:venda:${String(W)}:0`, em(9), String(W));

    await movimento(ORG_EXCESSO, skuD, "VENDA_ML", -1, `venda:${String(D)}:0`, em(-18), String(D));
    await movimento(ORG_EXCESSO, skuD, "CANCELAMENTO_ML", 1, `cancelamento:venda:${String(D)}:0`, em(1), String(D));
    await devolucao(ORG_EXCESSO, skuD, "5570000051", `venda:${String(D)}:0`, em(5));
    await devolucao(ORG_EXCESSO, skuD, "5570000052", `venda:${String(D)}:0`, em(6));
  });

  async function rodarF3(avisos: string[]): Promise<void> {
    const escuta = (aviso: { message?: string | undefined }): void => {
      avisos.push(aviso.message ?? "");
    };

    client.on("notice", escuta);

    try {
      await client.query(`set local sb.compensacao_organizacao = '${ORG_EXCESSO}'`);
      await client.query(await arquivo("packages/db/scripts/compensacao-estorno-pre-captura-d351.sql"));
    } finally {
      client.off("notice", escuta);
    }
  }

  async function alvoESaldo(sku: string): Promise<[number, number]> {
    const result = await client.query<{ alvo: string | null; saldo: string | null }>(
      `select (select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL') as alvo,
              (select quantity from public.inventory_balances where sku_id = $2 and location_kind = 'LOCAL') as saldo`,
      [ORG_EXCESSO, sku],
    );

    return [Number(result.rows[0]?.alvo), Number(result.rows[0]?.saldo)];
  }

  /** O que o worker novo calcula para o pedido cancelado, lendo o ledger como ele le. */
  async function doWorker(id: number) {
    const doPedido = await client.query<{
      sku_id: string;
      qty_delta: string;
      idempotency_key: string;
      movement_type: string;
      occurred_at: Date;
      created_at: Date;
    }>(
      `select sku_id, qty_delta, idempotency_key, movement_type, occurred_at, created_at from public.stock_movements
       where organization_id = $1 and source_type = 'ORDER' and source_id = $2
         and movement_type in ('VENDA_ML', 'ESTORNO_PRE_CAPTURA', 'CANCELAMENTO_ML')`,
      [ORG_EXCESSO, String(id)],
    );
    const devolucoes = await client.query<{ qty_delta: string; idempotency_key: string; occurred_at: Date }>(
      `select qty_delta, idempotency_key, occurred_at from public.get_order_return_movements($1, array[$2])`,
      [ORG_EXCESSO, String(id)],
    );
    const vendas = doPedido.rows.filter((r) => r.movement_type === "VENDA_ML");
    const cortes = new Map<string, CorteLido>();

    for (const venda of vendas) {
      cortes.set(venda.sku_id, await corteDaRpc(ORG_EXCESSO, venda.sku_id));
    }

    return computeCancellationMovements({
      order: { id, status: "cancelled", dateCreated: new Date(em(-60 * 24 * 60)), dateClosed: new Date(em(-60 * 24 * 60)), items: [] },
      occurredAt: new Date(),
      occurredAtKnown: true,
      transition: null,
      recordedSales: vendas.map((r) => ({
        skuId: r.sku_id,
        qtyDelta: Number(r.qty_delta),
        idempotencyKey: r.idempotency_key,
        occurredAt: r.occurred_at,
        recordedAt: r.created_at,
      })),
      estornadas: new Set(
        doPedido.rows.filter((r) => r.movement_type === "ESTORNO_PRE_CAPTURA").map((r) => estornadoKeyOf(r.idempotency_key)),
      ),
      reversals: [
        ...doPedido.rows
          .filter((r) => r.movement_type === "CANCELAMENTO_ML")
          .map((r) => ({ idempotencyKey: r.idempotency_key, quantity: Number(r.qty_delta), occurredAt: r.occurred_at })),
        ...devolucoes.rows.map((r) => ({ idempotencyKey: r.idempotency_key, quantity: Number(r.qty_delta), occurredAt: r.occurred_at })),
      ],
      cutoffFor: (skuId) => {
        const corte = cortes.get(skuId);

        if (corte === undefined) {
          throw new Error(`corte nao lido para ${skuId}`);
        }

        return { capturedAt: corte.captured_at, importedAt: corte.imported_at, reconciledAt: corte.reconciled_at, exportedAt: corte.exported_at };
      },
    });
  }

  it("KIT com a venda ATE o corte: estorno inteiro e anulacao do cancelamento em cada componente, alvo 21 e saldo 1 (a regra de cc90baa deixava o alvo em 22); a contraprova dentro do alvo e o empate fecham igual; o estorno do worker ganha so a anulacao; E = 2 com a reversao mais recente menor que o excesso anula 1 de cada devolucao; o worker novo calcula as mesmas linhas; a segunda execucao grava 0", async () => {
    // Antes da F3: a devolucao e o cancelamento do KIT estao dentro do alvo, e a venda nao.
    for (const componente of componentes) {
      expect(await alvoESaldo(componente)).toEqual([22, 1]);
    }

    // D: 20 + as tres reversoes depois do corte no alvo; -1 + 3 no saldo.
    expect(await alvoESaldo(skuD)).toEqual([23, 2]);

    await client.query("begin");

    try {
      const avisos: string[] = [];

      await rodarF3(avisos);

      // Estornos: 3 do KIT, C, E e D (o de W ja existia). Anulacoes: 3 do KIT, C, E, W e as 2 de D.
      expect(avisos).toContain("compensacao_d351: 6 estornos gravados");
      expect(avisos).toContain("compensacao_d351: 8 anulacoes de reversao a mais gravadas");
      expect(avisos).toContain("compensacao_d351: 0 vendas repostas (venda + estorno + cancelamento)");

      const gravados = await client.query<{
        movement_type: string;
        idempotency_key: string;
        qty_delta: string;
        occurred_at: Date;
        source_type: string | null;
        source_id: string | null;
        created_by: string | null;
      }>(
        `select movement_type, idempotency_key, qty_delta, occurred_at, source_type, source_id, created_by from public.stock_movements
         where organization_id = $1 and movement_type in ('ESTORNO_PRE_CAPTURA', 'ESTORNO_REVERSAO_EXCEDENTE')`,
        [ORG_EXCESSO],
      );
      const linhas = (tipo: string) =>
        gravados.rows
          .filter((r) => r.movement_type === tipo)
          .map((r) => [r.idempotency_key, Number(r.qty_delta), r.occurred_at.toISOString(), r.source_type, r.source_id, r.created_by])
          .sort(porChave);

      expect(linhas("ESTORNO_PRE_CAPTURA")).toEqual(
        [
          ...componentes.map((componente) => [`estorno:${chaveK(componente)}`, 1, em(-31), "ORDER", String(K), null]),
          [`estorno:venda:${String(C)}:0`, 1, em(5), "ORDER", String(C), null],
          [`estorno:venda:${String(E)}:0`, 1, em(-20), "ORDER", String(E), null],
          // O do worker, gravado antes da F3.
          [`estorno:venda:${String(W)}:0`, 1, em(-25), "ORDER", String(W), null],
          [`estorno:venda:${String(D)}:0`, 1, em(-18), "ORDER", String(D), null],
        ].sort(porChave),
      );
      expect(linhas("ESTORNO_REVERSAO_EXCEDENTE")).toEqual(
        [
          // A reversao mais recente de cada venda, com o instante dela e a origem da venda.
          ...componentes.map((componente) => [`estorno:cancelamento:${chaveK(componente)}`, -1, em(8), "ORDER", String(K), null]),
          [`estorno:cancelamento:venda:${String(C)}:0`, -1, em(7), "ORDER", String(C), null],
          // Empate: a chave maior em ordem de codigo ("devolucao" > "cancelamento").
          [`estorno:devolucao:5570000003:venda:${String(E)}:0`, -1, em(4), "ORDER", String(E), null],
          [`estorno:cancelamento:venda:${String(W)}:0`, -1, em(9), "ORDER", String(W), null],
          // E = 2 nas duas devolucoes, as mais recentes, cada uma limitada a propria quantidade (1), com
          // o instante dela; o cancelamento, o mais antigo, fica sem anulacao. Sem o teto, a ultima
          // devolucao levaria -2, a anterior -1, e D fecharia com alvo 20 e saldo 0.
          [`estorno:devolucao:5570000052:venda:${String(D)}:0`, -1, em(6), "ORDER", String(D), null],
          [`estorno:devolucao:5570000051:venda:${String(D)}:0`, -1, em(5), "ORDER", String(D), null],
        ].sort(porChave),
      );

      // Real de cada SKU: 20 da planilha, que tem a venda, e a unidade que voltou UMA vez.
      for (const sku of [...componentes, skuC, skuE, skuW, skuD]) {
        expect(await alvoESaldo(sku)).toEqual([21, 1]);
      }

      // O worker novo reprocessando os pedidos calcula exatamente as linhas que a F3 gravou: o
      // UNIQUE as absorve, e nada entra em dobro.
      for (const id of [K, C, E, W, D]) {
        const resultado = await doWorker(id);
        const daF3 = gravados.rows
          .filter((r) => r.movement_type === "ESTORNO_REVERSAO_EXCEDENTE" && r.source_id === String(id))
          .map((r) => [r.idempotency_key, Number(r.qty_delta), r.occurred_at.toISOString()])
          .sort(porChave);

        expect(resultado.estornos).toEqual([]);
        expect(resultado.reversals).toEqual([]);
        expect(resultado.excessReversalEstornos.map((m) => [m.idempotencyKey, m.qtyDelta, m.occurredAt.toISOString()]).sort(porChave)).toEqual(daF3);
      }

      const segunda: string[] = [];

      await rodarF3(segunda);

      expect(segunda).toContain("compensacao_d351: 0 estornos gravados");
      expect(segunda).toContain("compensacao_d351: 0 anulacoes de reversao a mais gravadas");
      expect(segunda).toContain("compensacao_d351: 0 vendas repostas (venda + estorno + cancelamento)");
    } finally {
      await client.query("rollback");
    }
  });
});

// ============================================================================================
// Reverificacao de c48fb70 (D-351 §10). Organizacoes proprias.
// ============================================================================================

describe("o snapshot que ainda carrega o parse retrata a exportacao do nome do arquivo (reverificacao de c48fb70, MEDIA-1)", () => {
  const ORG_DEV = randomUUID();
  const ORG_ENTRE_MIGRATION_E_DEPLOY = randomUUID();

  beforeAll(async () => {
    await novaOrganizacao(ORG_DEV, "parse-reconciliada");
    await novaOrganizacao(ORG_ENTRE_MIGRATION_E_DEPLOY, "parse-nunca-reconciliou");
  });

  /** O que o dominio decidiu para um pedido pago, gravado como o flush da pagina (DO NOTHING). */
  async function gravaDecisao(organizationId: string, pedido: number, resultado: ReturnType<typeof computeSaleDeductions>): Promise<void> {
    for (const [tipo, draft] of [
      ...resultado.deductions.map((d) => ["VENDA_ML", d] as const),
      ...resultado.preCaptureReversals.map((d) => ["ESTORNO_PRE_CAPTURA", d] as const),
    ]) {
      await client.query(
        `insert into public.stock_movements
           (organization_id, sku_id, location_kind, qty_delta, movement_type, source_type, source_id, idempotency_key, occurred_at)
         values ($1, $2, 'LOCAL', $3, $4, 'ORDER', $5, $6, $7)
         on conflict (idempotency_key) do nothing`,
        [organizationId, draft.skuId, draft.qtyDelta, tipo, String(pedido), draft.idempotencyKey, draft.occurredAt.toISOString()],
      );
    }
  }

  async function alvo(organizationId: string, skuId: string): Promise<number> {
    const result = await client.query<{ quantity: string }>(
      `select quantity from public.compute_erp_target_balances($1) where sku_id = $2 and location_kind = 'LOCAL'`,
      [organizationId, skuId],
    );

    return Number(result.rows[0]?.quantity);
  }

  function doCorte(corte: CorteLido) {
    return () => ({
      capturedAt: corte.captured_at,
      importedAt: corte.imported_at,
      reconciledAt: corte.reconciled_at,
      exportedAt: corte.exported_at,
    });
  }

  it("Dev: organizacao reconciliada com o corte do parse -- a venda entre a exportacao e o parse nao e estornada e o alvo nao muda; a anterior a exportacao e; e service_role le a exportacao, tambem para o SKU sem snapshot proprio", async () => {
    const sku = await novoSku(ORG_DEV, "parse-reconciliada");
    const semSnapshot = await novoSku(ORG_DEV, "parse-reconciliada-sem-snapshot");
    const base = 935_700_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    // A forma de 2000018048056108 (fechado em 08-21 12:37:59, VENDA_ML do worker antigo em 09-06).
    const naJanela = base + 1;
    const antesDaExportacao = base + 2;
    // Um dos 4 pedidos pagos da janela, no Dev, sem VENDA_ML.
    const novaNaJanela = base + 3;
    const PARSE = "2026-08-21T15:42:02.459Z";
    const EXPORTACAO = "2026-08-20T16:09:23.000Z";
    const itens = [{ position: 0, quantity: 1, skuId: sku, skuKind: "PRODUTO" as const, components: [] }];

    const lote = await novoLote(ORG_DEV, "Lista_de_Estoque_0820160923.xlsx", PARSE);

    await client.query(`update public.erp_import_batches set applied_at = '2026-08-21T17:12:44.481Z' where id = $1`, [lote]);
    // O corte que a migration 20260916180000 deixa na organizacao reconciliada: o parse.
    await snapshot(ORG_DEV, lote, "PARSE-RECONCILIADA", sku, "ESTOQUE LOJA", 10, PARSE, "2026-08-21T17:12:43.810Z");

    // O worker antigo gravou as duas vendas com a data da atualizacao, depois do corte.
    await movimento(ORG_DEV, sku, "VENDA_ML", -1, `venda:${String(naJanela)}:0`, "2026-09-06T12:33:31.000Z", String(naJanela), "2026-09-06T12:33:33.116Z");
    await movimento(ORG_DEV, sku, "VENDA_ML", -1, `venda:${String(antesDaExportacao)}:0`, "2026-09-06T12:40:00.000Z", String(antesDaExportacao), "2026-09-06T12:40:02.000Z");

    // A reconciliacao alinhou o saldo ao alvo e continua rodando.
    await client.query(
      `insert into public.stock_movements
         (organization_id, sku_id, location_kind, qty_delta, movement_type, idempotency_key, occurred_at, created_at)
       values ($1, $2, 'LOCAL', $3, 'AJUSTE_RECONCILIACAO', $4, '2026-09-07T09:00:05Z', '2026-09-07T09:00:05Z')`,
      [ORG_DEV, sku, await ajusteDaReconciliacao(ORG_DEV, sku), `${PREFIXO}:parse-reconciliada:r1`],
    );
    await rodadaDaReconciliacao(ORG_DEV, "2026-09-14T09:00:09.295Z");

    expect(await ajusteDaReconciliacao(ORG_DEV, sku)).toBe(0);
    // 10 - a venda da janela (certo) - a anterior a exportacao (que a planilha ja tinha: contada de novo).
    expect(await alvo(ORG_DEV, sku)).toBe(8);

    // O corte como o worker o le, como service_role: a RPC e security invoker e le a exportacao do
    // nome pela funcao privada.
    const lidos = await comoPapel<{ sku_id: string; captured_at: Date; exported_at: Date }>(
      "service_role",
      `select sku_id, captured_at, exported_at from public.get_erp_stock_cutoffs('${ORG_DEV}', array['${sku}', '${semSnapshot}']::uuid[])`,
    );
    const porSku = new Map(lidos.map((r) => [r.sku_id, [r.captured_at.toISOString(), r.exported_at.toISOString()]]));

    expect(porSku.get(sku)).toEqual([PARSE, EXPORTACAO]);
    expect(porSku.get(semSnapshot)).toEqual([PARSE, EXPORTACAO]);

    const corte = await corteDaRpc(ORG_DEV, sku);
    const cutoffFor = doCorte(corte);
    const decide = async (id: number, fechado: string, corteUsado = cutoffFor) => {
      const gravada = await vendaGravada(`venda:${String(id)}:0`);

      return computeSaleDeductions(
        { id, status: "paid", dateCreated: new Date(fechado), dateClosed: new Date(fechado), items: itens },
        { cutoffFor: corteUsado, recordedSale: () => gravada, recordedReversals: [] },
      );
    };

    await client.query("begin");

    try {
      // 1. A venda da janela e atualizada: a planilha nao a tem, e o -1 que o alvo conta e o certo.
      const janela = await decide(naJanela, "2026-08-21T12:37:59.000Z");

      expect(janela.preCaptureReversals).toEqual([]);

      await gravaDecisao(ORG_DEV, naJanela, janela);

      expect(await alvo(ORG_DEV, sku)).toBe(8);
      expect(await ajusteDaReconciliacao(ORG_DEV, sku)).toBe(0);

      // Contraprova: com a regra de c48fb70 (a planilha decidida pelo corte do alvo), o mesmo pedido
      // ganha um estorno, e alvo e saldo sobem juntos -- a reconciliacao nao ve diferenca nenhuma.
      const deC48 = await decide(naJanela, "2026-08-21T12:37:59.000Z", () => ({ ...cutoffFor(), exportedAt: corte.captured_at }));

      expect(deC48.preCaptureReversals).toHaveLength(1);

      await client.query("savepoint contraprova");
      await gravaDecisao(ORG_DEV, naJanela, deC48);

      expect(await alvo(ORG_DEV, sku)).toBe(9);
      expect(await ajusteDaReconciliacao(ORG_DEV, sku)).toBe(0);

      await client.query("rollback to savepoint contraprova");

      // 2. A venda anterior a exportacao: a planilha a tem, e o estorno espelhado tira a segunda contagem.
      const anterior = await decide(antesDaExportacao, "2026-08-20T10:00:00.000Z");

      expect(anterior.preCaptureReversals).toHaveLength(1);

      await gravaDecisao(ORG_DEV, antesDaExportacao, anterior);

      expect(await alvo(ORG_DEV, sku)).toBe(9);
      expect(await ajusteDaReconciliacao(ORG_DEV, sku)).toBe(0);

      // 3. Pedido pago da janela, nunca gravado: a venda, sem estorno. RESIDUO (D-351 §6): a linha tem
      // `occurred_at` ate o corte do parse e fica fora do alvo; a reconciliacao seguinte grava +1.
      const nova = await decide(novaNaJanela, "2026-08-21T13:00:00.000Z");

      expect(nova.deductions).toHaveLength(1);
      expect(nova.preCaptureReversals).toEqual([]);

      await gravaDecisao(ORG_DEV, novaNaJanela, nova);

      expect(await ajusteDaReconciliacao(ORG_DEV, sku)).toBe(1);
    } finally {
      await client.query("rollback");
    }
  });

  it("planilha importada pelo worker antigo entre a migration e o deploy (organizacao nunca reconciliada, corte do parse): o worker novo nao estorna a venda da janela, e o UPDATE refeito depois fecha o alvo com o real", async () => {
    const migration = await arquivo("supabase/migrations/20260916180000_erp_corte_da_exportacao.sql");
    const update = /update public\.erp_stock_snapshots s[\s\S]*?;/.exec(migration)?.[0];
    const base = 935_800_000_000 + Math.floor(Math.random() * 1_000_000) * 10;
    // A forma de 2000018457209778, fechado as 18:43:57 -- entre a exportacao e o parse.
    const naJanela = base + 1;
    const antesDaExportacao = base + 2;
    const PARSE = "2026-09-14T18:44:13.254Z";
    const EXPORTACAO = "2026-09-14T18:42:00.000Z";

    expect(update).toBeDefined();

    // Tudo numa transacao: um snapshot com o corte do parse numa organizacao elegivel nao pode
    // sobrar no banco para os outros blocos.
    await client.query("begin");

    try {
      const sku = await novoSku(ORG_ENTRE_MIGRATION_E_DEPLOY, "parse-nunca-reconciliou");
      const itens = [{ position: 0, quantity: 1, skuId: sku, skuKind: "PRODUTO" as const, components: [] }];
      const lote = await novoLote(ORG_ENTRE_MIGRATION_E_DEPLOY, "Lista_de_Estoque_0914184200.xlsx", PARSE);

      await client.query(`update public.erp_import_batches set applied_at = '2026-09-14T18:44:19.581Z' where id = $1`, [lote]);
      await snapshot(ORG_ENTRE_MIGRATION_E_DEPLOY, lote, "PARSE-NUNCA", sku, "ESTOQUE LOJA", 10, PARSE, "2026-09-14T18:44:18.714Z");

      // O worker antigo gravou as duas vendas com a data da atualizacao, depois do parse.
      await movimento(ORG_ENTRE_MIGRATION_E_DEPLOY, sku, "VENDA_ML", -1, `venda:${String(naJanela)}:0`, "2026-09-14T19:03:00.000Z", String(naJanela), "2026-09-14T19:03:05.000Z");
      await movimento(ORG_ENTRE_MIGRATION_E_DEPLOY, sku, "VENDA_ML", -1, `venda:${String(antesDaExportacao)}:0`, "2026-09-14T19:04:00.000Z", String(antesDaExportacao), "2026-09-14T19:04:05.000Z");

      const corte = await corteDaRpc(ORG_ENTRE_MIGRATION_E_DEPLOY, sku);

      expect([corte.captured_at.toISOString(), corte.exported_at.toISOString()]).toEqual([PARSE, EXPORTACAO]);

      // O worker novo, com o corte do parse, estorna so a venda anterior a exportacao. Com a regra de
      // c48fb70 a da janela tambem ganharia estorno, e o alvo ficaria em 10 depois do UPDATE.
      for (const [id, fechado, estornos] of [
        [naJanela, "2026-09-14T18:43:57.000Z", 0],
        [antesDaExportacao, "2026-09-14T10:00:00.000Z", 1],
      ] as const) {
        const gravada = await vendaGravada(`venda:${String(id)}:0`);
        const resultado = computeSaleDeductions(
          { id, status: "paid", dateCreated: new Date(fechado), dateClosed: new Date(fechado), items: itens },
          { cutoffFor: doCorte(corte), recordedSale: () => gravada, recordedReversals: [] },
        );

        expect(resultado.preCaptureReversals).toHaveLength(estornos);

        await gravaDecisao(ORG_ENTRE_MIGRATION_E_DEPLOY, id, resultado);
      }

      // O UPDATE refeito depois do deploy: o corte vira a exportacao, e o alvo fecha com o real -- a
      // planilha tem a venda anterior e nao tem a da janela.
      await client.query(update ?? "");

      expect((await corteDaRpc(ORG_ENTRE_MIGRATION_E_DEPLOY, sku)).captured_at.toISOString()).toBe(EXPORTACAO);
      expect(await alvo(ORG_ENTRE_MIGRATION_E_DEPLOY, sku)).toBe(9);
    } finally {
      await client.query("rollback");
    }
  });
});
