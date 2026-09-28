import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "./types.js";

/**
 * `support_messages` nao regrava a linha quando o upsert nao muda nada
 * (migration `20260928170000`, auditoria de 2026-09-28).
 *
 * Pelo MESMO cliente e pela mesma forma de upsert que o worker usa: o que esta
 * sob teste e o gatilho no Postgres, e mock nao o exercitaria. O sinal e o
 * `updated_at`, que `set_updated_at` avanca em toda atualizacao que acontece.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`).
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ORGANIZATION_ID = randomUUID();
const ACCOUNT_ID = randomUUID();
const CASE_ID = randomUUID();
const EXTERNAL_ID = String(9_000_000_000 + Math.floor(Math.random() * 1_000_000));
const MESSAGE_KEY = `auditoria-2809:${randomUUID()}`;

const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY ?? "sem-chave", {
  auth: { persistSession: false, autoRefreshToken: false },
});

function mensagem(body: string, observedAt: string) {
  return {
    organization_id: ORGANIZATION_ID,
    ml_account_id: ACCOUNT_ID,
    support_case_id: CASE_ID,
    external_message_key: MESSAGE_KEY,
    direction: "INBOUND",
    sender_kind: "CUSTOMER",
    body,
    body_state: "AVAILABLE",
    occurred_at: "2026-09-28T10:00:00.000Z",
    observed_at: observedAt,
  };
}

async function gravar(body: string, observedAt: string): Promise<void> {
  const resultado = await db
    .from("support_messages")
    .upsert(mensagem(body, observedAt), { onConflict: "support_case_id,external_message_key" });

  if (resultado.error !== null) {
    throw resultado.error;
  }
}

async function lerLinha(): Promise<{ body: string | null; updated_at: string; observed_at: string }> {
  const lida = await db
    .from("support_messages")
    .select("body, updated_at, observed_at")
    .eq("support_case_id", CASE_ID)
    .eq("external_message_key", MESSAGE_KEY)
    .single();

  if (lida.error !== null) {
    throw lida.error;
  }

  return lida.data;
}

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  if (SERVICE_ROLE_KEY === undefined) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY não definida — exporte com `eval \"$(pnpm exec supabase status -o env)\"`.",
    );
  }

  const organizacao = await db
    .from("organizations")
    .insert({ id: ORGANIZATION_ID, name: "Auditoria 28/09", slug: `aud2809-${ORGANIZATION_ID.slice(0, 8)}` });

  if (organizacao.error !== null) {
    throw organizacao.error;
  }

  const conta = await db
    .from("ml_accounts")
    .insert({ id: ACCOUNT_ID, organization_id: ORGANIZATION_ID, label: "Auditoria", slug: `aud2809-${ACCOUNT_ID.slice(0, 8)}` });

  if (conta.error !== null) {
    throw conta.error;
  }

  const caso = await db.from("support_cases").insert({
    id: CASE_ID,
    organization_id: ORGANIZATION_ID,
    ml_account_id: ACCOUNT_ID,
    channel: "QUESTION",
    external_case_id: EXTERNAL_ID,
    external_case_key: `question:${EXTERNAL_ID}`,
    last_activity_at: "2026-09-28T10:00:00.000Z",
  });

  if (caso.error !== null) {
    throw caso.error;
  }
});

afterAll(async () => {
  await db.from("support_cases").delete().eq("id", CASE_ID);
  await db.from("ml_accounts").delete().eq("id", ACCOUNT_ID);
  await db.from("organizations").delete().eq("id", ORGANIZATION_ID);
});

describe("support_messages sem regravar o que não mudou (auditoria de 28/09)", () => {
  it("o mesmo conteúdo com só `observed_at` novo não regrava a linha", async () => {
    await gravar("Tem no tamanho 42?", "2026-09-28T10:00:01.000Z");
    const antes = await lerLinha();

    await esperar(20);
    await gravar("Tem no tamanho 42?", "2026-09-28T11:00:00.000Z");
    const depois = await lerLinha();

    expect(depois.updated_at).toBe(antes.updated_at);
    expect(depois.observed_at).toBe(antes.observed_at);
  });

  it("conteúdo mudado continua sendo gravado", async () => {
    const antes = await lerLinha();

    await esperar(20);
    await gravar("Tem no tamanho 43?", "2026-09-28T12:00:00.000Z");
    const depois = await lerLinha();

    expect(depois.body).toBe("Tem no tamanho 43?");
    expect(depois.updated_at).not.toBe(antes.updated_at);
  });
});
