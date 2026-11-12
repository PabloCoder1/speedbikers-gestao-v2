import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { Database } from "./types.js";

const dbUrl = process.env.SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

const admin = new Client({ connectionString: dbUrl });
const primeiro = new Client({ connectionString: dbUrl });
const segundo = new Client({ connectionString: dbUrl });
const dona = randomUUID();
const outra = randomUUID();
const agora = "2026-11-11T18:00:00Z";
const vence = "2026-12-11T18:00:00Z";
const chaveOriginal = "a".repeat(64);
const chaveRejeitada = "b".repeat(64);
const chaveNova = "c".repeat(64);

function credenciais(organizationId: string, cifra: string) {
  return {
    p_organization_id: organizationId,
    p_created_by: null,
    p_connected_at: agora,
    p_access_token_ciphertext: cifra,
    p_refresh_token_ciphertext: cifra,
    p_access_token_expires_at: vence,
    p_refresh_token_expires_at: vence,
  };
}

type Admin = ReturnType<typeof createClient<Database>>;
let api: Admin;
let fixturesCriadas = false;
let concorrentePid: number;
beforeAll(async () => {
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!loopback.has(new URL(dbUrl).hostname) || !loopback.has(new URL(apiUrl).hostname) || !key) {
    throw new Error("Teste OAuth exige PostgreSQL e PostgREST locais com chave de serviço.");
  }

  api = createClient<Database>(apiUrl, key, { auth: { persistSession: false } });
  await Promise.all([admin.connect(), primeiro.connect(), segundo.connect()]);
  await admin.query(
    "insert into public.organizations (id, name, slug) select id, 'OAuth fixture', id::text from unnest($1::uuid[]) as t(id)",
    [[dona, outra]],
  );
  fixturesCriadas = true;
  await Promise.all([
    primeiro.query("set role service_role; set statement_timeout = '5s'"),
    segundo.query("set role service_role; set statement_timeout = '5s'"),
  ]);
  const pid = await segundo.query<{ pid: number }>("select pg_backend_pid() as pid");
  const linha = pid.rows[0];
  if (linha === undefined) throw new Error("Conexão concorrente sem PID");
  concorrentePid = linha.pid;
});

afterAll(async () => {
  await Promise.all([primeiro.end(), segundo.end()]);
  try {
    if (fixturesCriadas) {
      await admin.query("delete from public.organizations where id = any($1::uuid[])", [[dona, outra]]);
    }
  } finally {
    await admin.end();
  }
});

const canais = [
  {
    nome: "Shopee",
    nova: "821000001",
    alvo: "821000002",
    ocupada: "821000003",
    conectarPg: (db: Client, organizationId: string, id: string, cifra: string) => db.query(
      "select public.shopee_connect_shops($1, null, 'sandbox', $2, $3, $4, $4, $5, $5)",
      [organizationId, agora, JSON.stringify([{ shop_id: id, shop_name: cifra[0] }]), cifra, vence],
    ),
    conectar: (organizationId: string, ids: string[], cifra: string) => api.rpc("shopee_connect_shops", {
      ...credenciais(organizationId, cifra),
      p_environment: "sandbox",
      p_shops: ids.map((shop_id) => ({ shop_id, shop_name: cifra[0] ?? null })),
    }),
    select: `select l.id, l.organization_id, l.shop_name, c.access_token_ciphertext, c.refresh_token_ciphertext
               from public.shopee_shops l left join public.shopee_credentials c on c.shopee_shop_id = l.id
              where l.environment = 'sandbox' and l.shop_id = any($1::bigint[]) order by l.shop_id`,
  },
  {
    nome: "TikTok Shop",
    nova: "8210000010000000001",
    alvo: "8210000020000000001",
    ocupada: "8210000030000000001",
    conectarPg: (db: Client, organizationId: string, id: string, cifra: string) => db.query(
      "select public.tiktok_connect_shops($1, null, $2, $3, 'seller', null, null, $4, $4, $5, $5)",
      [organizationId, agora, JSON.stringify([{ shop_id: id, shop_name: cifra[0], shop_cipher: "fixture" }]), cifra, vence],
    ),
    conectar: (organizationId: string, ids: string[], cifra: string) => api.rpc("tiktok_connect_shops", {
      ...credenciais(organizationId, cifra),
      p_open_id: "seller",
      p_seller_name: null,
      p_granted_scopes: null,
      p_shops: ids.map((shop_id) => ({ shop_id, shop_name: cifra[0] ?? null, shop_cipher: "fixture" })),
    }),
    select: `select l.id, l.organization_id, l.shop_name, c.access_token_ciphertext, c.refresh_token_ciphertext
               from public.tiktok_shops l left join public.tiktok_credentials c on c.tiktok_shop_id = l.id
              where l.shop_id = any($1::text[]) order by l.shop_id`,
  },
];

interface Loja {
  id: string;
  organization_id: string;
  shop_name: string;
  access_token_ciphertext: string | null;
  refresh_token_ciphertext: string | null;
}

describe.each(canais)("$nome OAuth", (canal) => {
  it("serializa callbacks concorrentes e permite reconexão do mesmo dono", async () => {
    await primeiro.query("begin");

    let tentativa: Promise<unknown>;
    try {
      await canal.conectarPg(primeiro, dona, canal.alvo, chaveOriginal);
      tentativa = canal.conectarPg(segundo, outra, canal.alvo, chaveRejeitada)
        .then(() => null, (error: unknown) => error);
      await vi.waitFor(async () => {
        const bloqueio = await admin.query<{ bloqueada: boolean }>(
          "select cardinality(pg_blocking_pids($1)) > 0 as bloqueada",
          [concorrentePid],
        );
        expect(bloqueio.rows[0]?.bloqueada).toBe(true);
      }, { timeout: 2_000, interval: 20 });
    } finally {
      await primeiro.query("commit");
    }

    expect(await tentativa).toMatchObject({ code: "PT409" });
    const antes = await admin.query<Loja>(canal.select, [[canal.alvo]]);
    expect(antes.rows).toMatchObject([{
      organization_id: dona,
      shop_name: "a",
      access_token_ciphertext: chaveOriginal,
      refresh_token_ciphertext: chaveOriginal,
    }]);

    const reconectada = await canal.conectar(dona, [canal.alvo], chaveNova);
    expect(reconectada.error).toBeNull();
    const depois = await admin.query<Loja>(canal.select, [[canal.alvo]]);
    expect(depois.rows).toMatchObject([{
      id: antes.rows[0]?.id,
      organization_id: dona,
      shop_name: "c",
      access_token_ciphertext: chaveNova,
      refresh_token_ciphertext: chaveNova,
    }]);
  });

  it("reverte todo o lote quando uma loja é de outra organização", async () => {
    const original = await canal.conectar(dona, [canal.ocupada], chaveOriginal);
    expect(original.error).toBeNull();

    const resposta = await canal.conectar(outra, [canal.nova, canal.ocupada], chaveRejeitada);
    expect(resposta.status).toBe(409);
    expect(resposta.error?.code).toBe("PT409");

    const gravadas = await admin.query<Loja>(canal.select, [[canal.nova, canal.ocupada]]);
    expect(gravadas.rows).toMatchObject([{ organization_id: dona, access_token_ciphertext: chaveOriginal }]);
  });

  it("reverte a loja se a escrita das credenciais viola uma constraint", async () => {
    const resposta = await canal.conectar(dona, [canal.nova], "curta");
    expect(resposta.error?.code).toBe("23514");

    const gravadas = await admin.query<Loja>(canal.select, [[canal.nova]]);
    expect(gravadas.rows).toHaveLength(0);
  });

  it("impede a execução por anon e authenticated", async () => {
    for (const papel of ["anon", "authenticated"]) {
      await admin.query(`set role ${papel}`);
      try {
        await expect(canal.conectarPg(admin, outra, canal.alvo, chaveRejeitada)).rejects.toMatchObject({ code: "42501" });
      } finally {
        await admin.query("reset role");
      }
    }
  });
});
