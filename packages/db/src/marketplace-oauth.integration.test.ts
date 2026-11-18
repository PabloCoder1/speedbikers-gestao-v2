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

async function aguardarBloqueio(): Promise<void> {
  await vi.waitFor(async () => {
    const bloqueio = await admin.query<{ bloqueada: boolean }>(
      "select cardinality(pg_blocking_pids($1)) > 0 as bloqueada",
      [concorrentePid],
    );
    expect(bloqueio.rows[0]?.bloqueada).toBe(true);
  }, { timeout: 2_000, interval: 20 });
}

describe.each(canais)("$nome OAuth", (canal) => {
  it("serializa callbacks concorrentes e permite reconexão do mesmo dono", async () => {
    await primeiro.query("begin");

    let tentativa: Promise<unknown>;
    try {
      await canal.conectarPg(primeiro, dona, canal.alvo, chaveOriginal);
      tentativa = canal.conectarPg(segundo, outra, canal.alvo, chaveRejeitada)
        .then(() => null, (error: unknown) => error);
      await aguardarBloqueio();
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

describe("Shopee OAuth e renovação concorrente", () => {
  const shopId = 821000004;
  const lockAntigo = randomUUID();
  const lockAtual = randomUUID();
  const mesmaExpiracao = "2026-11-11T18:01:00Z";

  it("descarta sucesso e recusa antigos mesmo com o mesmo prazo na nova trava", async () => {
    const conectar = (cifra: string) => api.rpc("shopee_connect_shops", {
      ...credenciais(dona, cifra),
      p_environment: "sandbox",
      p_shops: [{ shop_id: shopId }],
    });
    expect((await conectar(chaveOriginal)).error).toBeNull();
    const loja = await api.from("shopee_shops").select("id").eq("environment", "sandbox").eq("shop_id", shopId).single();
    if (loja.data === null) throw new Error("Loja de teste não gravada");
    const id = loja.data.id;
    const credencial = () => api.from("shopee_credentials")
      .select("access_token_ciphertext,refresh_token_ciphertext,refresh_locked_until,refresh_lock_id")
      .eq("shopee_shop_id", id).single();
    const travar = (lockId: string) => api.from("shopee_credentials")
      .update({ refresh_locked_until: mesmaExpiracao, refresh_lock_id: lockId }).eq("shopee_shop_id", id);
    const estado = () => api.from("shopee_shops").select("status,last_error").eq("id", id).single();
    const recusar = (lockId: string) => api.rpc("shopee_reject_token_refresh", {
      p_shopee_shop_id: id, p_lock_id: lockId, p_error: "Recusa de teste",
    });

    expect((await travar(lockAntigo)).error).toBeNull();
    expect((await conectar(chaveNova)).error).toBeNull();
    expect((await credencial()).data).toMatchObject({ refresh_locked_until: null, refresh_lock_id: null });
    expect((await travar(lockAtual)).error).toBeNull();

    const sucessoAntigo = await api.from("shopee_credentials")
      .update({ access_token_ciphertext: chaveRejeitada, refresh_token_ciphertext: chaveRejeitada,
        refresh_locked_until: null, refresh_lock_id: null })
      .eq("shopee_shop_id", id).eq("refresh_lock_id", lockAntigo).select("shopee_shop_id");
    expect(sucessoAntigo).toMatchObject({ error: null, data: [] });
    expect(await recusar(lockAntigo)).toMatchObject({ error: null, data: false });
    const recusaLegada = await api.rpc("shopee_reject_token_refresh", {
      p_shopee_shop_id: id, p_locked_until: mesmaExpiracao, p_error: "Recusa legada",
    });
    expect(recusaLegada.error?.code).toBe("23514");
    expect((await credencial()).data).toMatchObject({
      access_token_ciphertext: chaveNova,
      refresh_token_ciphertext: chaveNova,
      refresh_locked_until: "2026-11-11T18:01:00+00:00",
      refresh_lock_id: lockAtual,
    });
    expect((await estado()).data).toEqual({ status: "CONNECTED", last_error: null });

    expect(await recusar(lockAtual)).toMatchObject({ error: null, data: true });
    expect((await credencial()).data).toMatchObject({
      refresh_token_ciphertext: chaveNova, refresh_locked_until: null, refresh_lock_id: null,
    });
    expect((await estado()).data).toEqual({ status: "ERROR", last_error: "Recusa de teste" });

    expect((await conectar(chaveNova)).error).toBeNull();
    const travaLegada = await api.from("shopee_credentials")
      .update({ refresh_locked_until: mesmaExpiracao }).eq("shopee_shop_id", id);
    expect(travaLegada.error).toBeNull();
    expect(await api.rpc("shopee_reject_token_refresh", {
      p_shopee_shop_id: id, p_locked_until: mesmaExpiracao, p_error: "Recusa legada vigente",
    })).toMatchObject({ error: null, data: true });
    expect((await estado()).data).toEqual({ status: "ERROR", last_error: "Recusa legada vigente" });
  });

  it("reserva o registro da recusa ao service_role", async () => {
    const result = await admin.query<{ anon: boolean; authenticated: boolean; service_role: boolean }>(`
      select has_function_privilege('anon', fn, 'EXECUTE') as anon,
             has_function_privilege('authenticated', fn, 'EXECUTE') as authenticated,
             has_function_privilege('service_role', fn, 'EXECUTE') as service_role
        from unnest(array[
          'public.shopee_reject_token_refresh(uuid,timestamptz,text)'::regprocedure,
          'public.shopee_reject_token_refresh(uuid,uuid,text)'::regprocedure
        ]) as alvo(fn)
    `);
    expect(result.rows).toEqual([
      { anon: false, authenticated: false, service_role: true },
      { anon: false, authenticated: false, service_role: true },
    ]);
  });
});

describe("Mercado Livre OAuth e renovação concorrente", () => {
  // A recusa vigente produz evento append-only. Os fixtures deste bloco
  // ficam na organização própria até o próximo reset do banco de testes.
  const orgMl = randomUUID();
  const conta = randomUUID();
  const contaSemCredencial = randomUUID();
  const seller = 821000005;
  const lockAntigo = randomUUID();
  const lockAtual = randomUUID();
  const mesmaExpiracao = "2026-11-11T18:01:00Z";

  function conectar(accountId: string, organizationId: string, sellerId: number, cifra: string) {
    return api.rpc("ml_connect_account", {
      p_organization_id: organizationId, p_ml_account_id: accountId, p_seller_id: sellerId, p_connected_at: agora,
      p_access_token_ciphertext: cifra, p_refresh_token_ciphertext: cifra,
      p_access_token_expires_at: vence, p_scopes: ["read"],
    });
  }

  beforeAll(async () => {
    await admin.query(
      "insert into public.organizations (id, name, slug) values ($1, 'OAuth ML fixture', $1::uuid::text)",
      [orgMl],
    );
    await admin.query(
      `insert into public.ml_accounts (id, organization_id, label, slug)
       select id, $1, 'OAuth fixture', id::text from unnest($2::uuid[]) as t(id)`,
      [orgMl, [conta, contaSemCredencial]],
    );
  });

  it("serializa a recusa antiga com a reconexão e preserva a nova credencial", async () => {
    expect((await conectar(conta, orgMl, seller, chaveOriginal)).data).toBe(conta);
    const credencial = () => api.from("ml_credentials")
      .select("access_token_ciphertext,refresh_token_ciphertext,refresh_lock_id,refresh_locked_until")
      .eq("ml_account_id", conta).single();
    const travar = (id: string) => api.from("ml_credentials")
      .update({ refresh_lock_id: id, refresh_locked_until: mesmaExpiracao }).eq("ml_account_id", conta);
    const estado = () => api.from("ml_accounts").select("status,last_error,seller_id").eq("id", conta).single();
    expect((await travar(lockAntigo)).error).toBeNull();

    await primeiro.query("begin");
    let recusa: Promise<unknown>;
    try {
      await primeiro.query(
        "select public.ml_connect_account($1, $2, $3, $4, $5, $5, $6, array['read'])",
        [orgMl, conta, seller, agora, chaveNova, vence],
      );
      recusa = segundo.query<{ gravada: boolean }>(
        "select public.ml_reject_token_refresh($1, $2, $3) as gravada", [conta, lockAntigo, "Recusa atrasada"],
      ).then((resultado) => resultado.rows[0], (error: unknown) => error);
      await aguardarBloqueio();
    } finally {
      await primeiro.query("commit");
    }
    expect(await recusa).toEqual({ gravada: false });
    expect((await credencial()).data).toEqual({
      access_token_ciphertext: chaveNova,
      refresh_token_ciphertext: chaveNova,
      refresh_lock_id: null,
      refresh_locked_until: null,
    });

    // O UUID distingue duas aquisições com o mesmo horário de expiração.
    expect((await travar(lockAtual)).error).toBeNull();
    const sucessoAntigo = await api.from("ml_credentials")
      .update({ access_token_ciphertext: chaveRejeitada, refresh_token_ciphertext: chaveRejeitada,
        refresh_lock_id: null, refresh_locked_until: null })
      .eq("ml_account_id", conta).eq("refresh_lock_id", lockAntigo).select("ml_account_id");
    expect(sucessoAntigo).toMatchObject({ error: null, data: [] });
    expect((await credencial()).data).toMatchObject({
      access_token_ciphertext: chaveNova,
      refresh_token_ciphertext: chaveNova,
      refresh_lock_id: lockAtual,
    });
    expect((await estado()).data).toEqual({ status: "CONNECTED", last_error: null, seller_id: seller });

    const recusaAtual = await api.rpc("ml_reject_token_refresh", {
      p_ml_account_id: conta, p_lock_id: lockAtual, p_error: "Recusa vigente",
    });
    expect(recusaAtual).toMatchObject({ error: null, data: true });
    expect((await estado()).data).toEqual({ status: "ERROR", last_error: "Recusa vigente", seller_id: seller });
    expect((await credencial()).data).toMatchObject({ refresh_lock_id: null, refresh_locked_until: null });
    expect((await conectar(conta, orgMl, seller, chaveNova)).error).toBeNull();
    expect((await estado()).data).toEqual({ status: "CONNECTED", last_error: null, seller_id: seller });
  });

  it("confere organização, protege o vendedor e reverte a conta se a credencial falhar", async () => {
    expect(await conectar(contaSemCredencial, outra, seller + 1, chaveOriginal)).toMatchObject({ error: null, data: null });
    const falha = await conectar(contaSemCredencial, orgMl, seller + 1, "APP_USR-fixture-invalido");
    expect(falha.error?.code).toBe("23514");
    const estado = await api.from("ml_accounts").select("status,seller_id,connected_at").eq("id", contaSemCredencial).single();
    expect(estado.data).toEqual({ status: "PENDING", seller_id: null, connected_at: null });

    expect((await conectar(contaSemCredencial, orgMl, seller + 1, chaveOriginal)).error).toBeNull();
    expect((await conectar(contaSemCredencial, orgMl, seller + 2, chaveRejeitada)).error?.code).toBe("PT409");
    const par = await api.from("ml_credentials").select("access_token_ciphertext").eq("ml_account_id", contaSemCredencial).single();
    expect(par.data).toEqual({ access_token_ciphertext: chaveOriginal });
  });

  it("reserva as duas RPCs de escrita ao service_role", async () => {
    const result = await admin.query<{ anon: boolean; authenticated: boolean; service_role: boolean }>(`
      select has_function_privilege('anon', fn, 'EXECUTE') as anon,
             has_function_privilege('authenticated', fn, 'EXECUTE') as authenticated,
             has_function_privilege('service_role', fn, 'EXECUTE') as service_role
        from unnest(array[
          'public.ml_connect_account(uuid,uuid,bigint,timestamptz,text,text,timestamptz,text[])'::regprocedure,
          'public.ml_reject_token_refresh(uuid,uuid,text)'::regprocedure
        ]) as alvo(fn)
    `);
    expect(result.rows).toEqual([
      { anon: false, authenticated: false, service_role: true },
      { anon: false, authenticated: false, service_role: true },
    ]);
  });
});
