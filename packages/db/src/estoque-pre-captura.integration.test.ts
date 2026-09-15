import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { computeSaleDeductions, estornoKeyOf, resolveStockExportInstant } from "@sb/domain";
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
  // Quando cada linha entrou. O import grava os snapshots em lotes, cada lote com o seu
  // `created_at` (quatro, entre 18:44:18.7 e 18:44:19.2, em producao).
  const I_VELHO = "2026-08-21T15:42:10.000Z";
  const I_NOVO_PRIMEIRO = "2026-09-14T18:44:18.714Z";
  const I_NOVO_MEIO = "2026-09-14T18:44:18.900Z";
  const I_NOVO_ULTIMO = "2026-09-14T18:44:19.198Z";

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
    // (o alvo nao muda): o corte chegou com o primeiro lote, nao com o ultimo.
    await snapshot(ORG_CORTE, novo, "DOIS-IMPORTS", doisImports, "DEPOSITO", 7, T_NOVO, I_NOVO_ULTIMO);
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

  it("service_role: o maximo entre imports e armazens, o corte proprio mais velho, e o da organizacao para quem nao tem snapshot — cada um com o PRIMEIRO created_at das linhas do corte", async () => {
    const rows = await comoPapel<{ sku_id: string; captured_at: Date | null; imported_at: Date | null }>(
      "service_role",
      `select sku_id, captured_at, imported_at from public.get_erp_stock_cutoffs(
         '${ORG_CORTE}',
         array['${doisImports}', '${soNoVelho}', '${semSnapshot}', '${doisImports}', null]::uuid[])`,
    );

    const porSku = new Map(
      rows.map((r) => [r.sku_id, [r.captured_at?.toISOString() ?? null, r.imported_at?.toISOString() ?? null]]),
    );

    // Uma linha por id DISTINTO e nao nulo.
    expect(rows).toHaveLength(3);
    expect(porSku.get(doisImports)).toEqual([T_NOVO, I_NOVO_PRIMEIRO]);
    expect(porSku.get(soNoVelho)).toEqual([T_VELHO, I_VELHO]);
    expect(porSku.get(semSnapshot)).toEqual([T_NOVO, I_NOVO_PRIMEIRO]);
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
    const [corte] = await comoPapel<{ captured_at: Date; imported_at: Date }>(
      "service_role",
      `select captured_at, imported_at from public.get_erp_stock_cutoffs('${ORG_DUAS_PLANILHAS}', array['${sku}']::uuid[])`,
    );

    if (corte === undefined) {
      throw new Error("get_erp_stock_cutoffs sem linha");
    }

    expect([corte.captured_at.toISOString(), corte.imported_at.toISOString()]).toEqual([C2, I2]);

    const cutoffFor = () => ({ capturedAt: corte.captured_at, importedAt: corte.imported_at });
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
      { cutoffFor, recordedSale: () => undefined },
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
        }),
        recordedSale: (key) =>
          key === venda
            ? { skuId: skuVendido, qtyDelta: -1, occurredAt: new Date(VENDA_EM), recordedAt: new Date(GRAVADA_EM) }
            : undefined,
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

  it("a migration de dados marca como lidas SO as notificacoes do backfill (evento anterior a conexao, order.cancelled, criada antes de 09-14 18:30), e e idempotente", async () => {
    const migration = await arquivo("supabase/migrations/20260914200300_notificacoes_do_backfill_lidas.sql");
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
});
