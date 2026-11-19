import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Retenção de `job_runs` (D-768) e o índice único do Full (D-767), pela porta
 * do DONO da tabela, que atravessa GRANT e RLS: o que está sob teste são o
 * gatilho e a função no Postgres.
 *
 * Tudo roda dentro de `begin … rollback`: `private.expurgar_job_runs()` olha a
 * tabela inteira, e o banco local é compartilhado com o seed do e2e.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

const DB_URL =
  process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

const client = new Client({ connectionString: DB_URL });

beforeAll(async () => {
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!loopback.has(new URL(DB_URL).hostname)) {
    throw new Error("Teste de retenção exige Postgres local.");
  }
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

async function emTransacao(corpo: () => Promise<void>): Promise<void> {
  await client.query("begin");

  try {
    await corpo();
  } finally {
    await client.query("rollback");
  }
}

/** Uma execução com `finished_at` há `diasAtras` dias. */
async function execucao(
  organizationId: string,
  jobType: string,
  status: "done" | "failed",
  diasAtras: number,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.job_runs
       (organization_id, job_id, job_type, dedupe_key, attempt, status, retryable, reason,
        started_at, finished_at)
     values ($1, gen_random_uuid(), $2, $3, 1, $4,
             case when $4 = 'failed' then false end,
             case when $4 = 'failed' then 'teste' end,
             now() - make_interval(days => $5) - interval '1 second',
             now() - make_interval(days => $5))
     returning id`,
    [organizationId, jobType, `retencao-${randomUUID()}`, status, diasAtras],
  );

  return rows[0]!.id;
}

async function existentes(ids: string[]): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    "select id from public.job_runs where id = any($1::uuid[])",
    [ids],
  );

  return rows.map((row) => row.id);
}

async function cadastrarSku(): Promise<{ org: string; sku: string }> {
  const org = randomUUID();
  const sku = randomUUID();
  await client.query("insert into public.organizations (id, name, slug) values ($1, 'Retenção teste', $1::uuid::text)", [org]);
  await client.query("insert into public.skus (id, organization_id, sku, kind) values ($1, $2, 'RETENCAO', 'PRODUTO')", [sku, org]);
  return { org, sku };
}

describe("retenção de job_runs (D-768)", () => {
  it("preserva a última conciliação bem-sucedida quando só houve falhas recentes", async () => {
    await emTransacao(async () => {
      const { org, sku } = await cadastrarSku();
      const batch = randomUUID();
      await client.query(
        `insert into public.erp_import_batches (id, organization_id, kind, storage_path, content_hash)
         values ($1, $2, 'STOCK', 'fixture.xlsx', repeat('a', 64))`,
        [batch, org],
      );
      await client.query(
        `insert into public.erp_stock_snapshots
           (organization_id, batch_id, sku_id, sku_key, warehouse, on_hand, available, captured_at)
         values ($1, $2, $3, 'RETENCAO', 'LOJA', 1, 1, now() - interval '45 days')`,
        [org, batch, sku],
      );
      const tipo = "maintenance.reconcile-balances";
      const anterior = await execucao(org, tipo, "done", 70);
      const ultimaConciliacao = await execucao(org, tipo, "done", 40);
      const falhaRecente = await execucao(org, tipo, "failed", 2);

      async function corte() {
        const { rows } = await client.query<{ reconciled_at: Date | null }>(
          "select reconciled_at from public.get_erp_stock_cutoffs($1, array[$2]::uuid[])",
          [org, sku],
        );
        return rows[0]?.reconciled_at;
      }
      const antes = await corte();
      expect(antes).toBeInstanceOf(Date);

      await client.query("select private.expurgar_job_runs(1, 200)");

      expect(await corte()).toEqual(antes);
      expect((await existentes([anterior, ultimaConciliacao, falhaRecente])).sort())
        .toEqual([ultimaConciliacao, falhaRecente].sort());
    });
  });

  it("o expurgo tira só a concluída vencida e guarda a última de cada tipo", async () => {
    await emTransacao(async () => {
      const org = randomUUID();
      const tipo = `retencao.${randomUUID()}`;
      const tipoParado = `retencao.parado.${randomUUID()}`;

      const vencidaAntiga = await execucao(org, tipo, "done", 60);
      const vencida = await execucao(org, tipo, "done", 45);
      const recente = await execucao(org, tipo, "done", 2);
      const falhaAntiga = await execucao(org, tipo, "failed", 80);
      // Um tipo que parou de rodar: só tem linhas vencidas. A mais nova é a
      // "última execução" da Saúde do Sistema e tem de ficar.
      const paradoVelho = await execucao(org, tipoParado, "done", 70);
      const paradoUltima = await execucao(org, tipoParado, "done", 40);

      // Lote de 1 obriga o laço a dar várias voltas.
      const { rows } = await client.query<{ apagadas: number }>(
        "select private.expurgar_job_runs(1, 200) as apagadas",
      );

      expect(rows[0]!.apagadas).toBeGreaterThanOrEqual(3);

      const ficaram = await existentes([
        vencidaAntiga,
        vencida,
        recente,
        falhaAntiga,
        paradoVelho,
        paradoUltima,
      ]);

      expect(ficaram.sort()).toEqual([recente, falhaAntiga, paradoUltima].sort());

      // O interruptor não sobra ligado na transação de quem chamou.
      const { rows: interruptor } = await client.query<{ valor: string | null }>(
        "select current_setting('sb.expurgo_job_runs', true) as valor",
      );
      expect(interruptor[0]!.valor).not.toBe("on");
    });
  });

  it("DELETE solto continua recusado até para o dono, mesmo na linha vencida", async () => {
    await emTransacao(async () => {
      const id = await execucao(randomUUID(), `retencao.${randomUUID()}`, "done", 90);

      await expect(client.query("delete from public.job_runs where id = $1", [id])).rejects.toThrow(
        /append-only/i,
      );
    });
  });

  it("com o interruptor ligado, falha e linha recente continuam recusadas", async () => {
    await emTransacao(async () => {
      const org = randomUUID();
      const falha = await execucao(org, `retencao.${randomUUID()}`, "failed", 90);

      await client.query("select set_config('sb.expurgo_job_runs', 'on', true)");
      await expect(
        client.query("delete from public.job_runs where id = $1", [falha]),
      ).rejects.toThrow(/append-only/i);
    });

    await emTransacao(async () => {
      const recente = await execucao(randomUUID(), `retencao.${randomUUID()}`, "done", 29);

      await client.query("select set_config('sb.expurgo_job_runs', 'on', true)");
      await expect(
        client.query("delete from public.job_runs where id = $1", [recente]),
      ).rejects.toThrow(/append-only/i);
    });
  });

  it("UPDATE segue recusado com o interruptor ligado", async () => {
    await emTransacao(async () => {
      const id = await execucao(randomUUID(), `retencao.${randomUUID()}`, "done", 90);

      await client.query("select set_config('sb.expurgo_job_runs', 'on', true)");
      await expect(
        client.query("update public.job_runs set processed = 1 where id = $1", [id]),
      ).rejects.toThrow(/append-only/i);
    });
  });

  it("nem authenticated nem service_role executam o expurgo", async () => {
    for (const papel of ["authenticated", "service_role"]) {
      await emTransacao(async () => {
        await client.query(`set local role ${papel}`);
        await expect(client.query("select private.expurgar_job_runs()")).rejects.toThrow(
          /permission denied/i,
        );
      });
    }
  });
});

describe("unicidade do Full na ordem do distinct on (D-767)", () => {
  it("um índice só em (conta, inventário, instante), unique e DESC no instante", async () => {
    const { rows } = await client.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes
        where schemaname = 'public' and tablename = 'fulfillment_stock_snapshots'
          and indexdef like '%(ml_account_id, inventory_id, captured_at%'`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexname).toBe("fulfillment_stock_snapshots_unique");
    expect(rows[0]!.indexdef).toMatch(/UNIQUE INDEX .*\(ml_account_id, inventory_id, captured_at DESC\)/);
  });

  it("a mesma captura duas vezes ainda é 23505", async () => {
    await emTransacao(async () => {
      const { org, sku } = await cadastrarSku();
      const conta = randomUUID();
      await client.query(
        `insert into public.ml_accounts (id, organization_id, label, slug, seller_id, status, connected_at)
         values ($1, $2, 'Conta teste', $1::uuid::text, 331331, 'CONNECTED', now())`,
        [conta, org],
      );
      const linha = [org, conta, "INV-RETENCAO", "MLB1", sku];
      const inserir = `insert into public.fulfillment_stock_snapshots
          (organization_id, ml_account_id, inventory_id, item_id, sku_id, quantity, captured_at)
        values ($1, $2, $3, $4, $5, 1, timestamptz '2026-11-17 12:00:00+00')`;

      await client.query(inserir, linha);
      await expect(client.query(inserir, linha)).rejects.toMatchObject({ code: "23505" });
    });
  });
});
