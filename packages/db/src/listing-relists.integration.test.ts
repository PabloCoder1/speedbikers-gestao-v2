import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readLastRelistFailureReason } from "./listing-relists.js";
import type { Database } from "./types.js";

/**
 * A retomada da republicação recusada (D-364) contra Postgres + PostgREST
 * reais, pelo MESMO cliente que a `api` e o worker usam. Os testes unitários
 * provam a regra com fakes; o que só o banco prova é:
 *
 * - o CAS por versão: o `updated_at` que o PostgREST devolve, usado de volta
 *   num `.eq("updated_at", ...)`, casa com a linha — se não casasse, a
 *   retomada terminaria sem POST e o botão nunca funcionaria —, e o trigger
 *   `listing_relists_set_updated_at` muda a versão a cada UPDATE, então a
 *   leitura velha perde a vez (o A→B→A da revisão da D-364);
 * - `readLastRelistFailureReason`: a ordem e os filtros no select real;
 * - `parent_snapshot->variations`, a projeção que a página lê para listar as
 *   variações que ficam fora do anúncio novo.
 *
 * Exige o Supabase local no ar (`pnpm exec supabase start`). As linhas ficam:
 * `listing_relist_events` é append-only e `listing_relists` prende a conta
 * com `on delete restrict` (mesma convenção de `rls.integration.test.ts`).
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ORGANIZATION_ID = randomUUID();
const ACCOUNT_ID = randomUUID();
const SUFIXO = ORGANIZATION_ID.slice(0, 8);

const db = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY ?? "sem-chave", {
  auth: { persistSession: false, autoRefreshToken: false },
});

let userId = "";

async function criarOperacao(parentItemId: string, status: string, parentSnapshot: unknown = { title: "pai" }) {
  const inserted = await db
    .from("listing_relists")
    .insert({
      organization_id: ORGANIZATION_ID,
      ml_account_id: ACCOUNT_ID,
      parent_item_id: parentItemId,
      status,
      parent_snapshot: parentSnapshot as never,
      requested_by: userId,
    })
    .select("id, updated_at")
    .single();

  if (inserted.error !== null) {
    throw inserted.error;
  }

  return inserted.data;
}

async function gravarEvento(relistId: string, from: string | null, to: string, reason: string, occurredAt: string) {
  const event = await db.from("listing_relist_events").insert({
    organization_id: ORGANIZATION_ID,
    ml_account_id: ACCOUNT_ID,
    relist_id: relistId,
    from_status: from,
    to_status: to,
    reason,
    occurred_at: occurredAt,
  });

  if (event.error !== null) {
    throw event.error;
  }
}

beforeAll(async () => {
  if (SERVICE_ROLE_KEY === undefined) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY não definida — exporte com `eval \"$(pnpm exec supabase status -o env)\"`.",
    );
  }

  const user = await db.auth.admin.createUser({
    email: `d364-${SUFIXO}@teste.local`,
    password: randomUUID(),
    email_confirm: true,
  });

  if (user.error !== null) {
    throw user.error;
  }

  userId = user.data.user.id;

  const organization = await db
    .from("organizations")
    .insert({ id: ORGANIZATION_ID, name: "D-364 retomada", slug: `d364-${SUFIXO}` });

  if (organization.error !== null) {
    throw organization.error;
  }

  const account = await db.from("ml_accounts").insert({
    id: ACCOUNT_ID,
    organization_id: ORGANIZATION_ID,
    label: "D-364",
    slug: `d364-conta-${SUFIXO}`,
  });

  if (account.error !== null) {
    throw account.error;
  }
});

afterAll(async () => {
  if (userId !== "") {
    // O profile fica preso por `requested_by` (restrict); o usuário de auth, não.
    await db.auth.admin.deleteUser(userId).catch(() => undefined);
  }
});

describe("retomada da republicação recusada contra o banco real (D-364)", () => {
  it("o CAS por versão casa com o updated_at lido pelo PostgREST e perde a vez depois de outra transição", async () => {
    const operacao = await criarOperacao("MLB936400001", "RELIST_FAILED");
    const lida = await db.from("listing_relists").select("status, updated_at").eq("id", operacao.id).single();

    expect(lida.error).toBeNull();
    expect(lida.data?.updated_at).toBe(operacao.updated_at);

    const versaoLida = lida.data?.updated_at ?? "";

    // Outra retomada sai de RELIST_FAILED e volta a ele (A → B → A) entre a
    // leitura e o CAS desta: o status é o mesmo, a versão não.
    const outra = await db
      .from("listing_relists")
      .update({ status: "RELISTING" })
      .eq("id", operacao.id)
      .eq("status", "RELIST_FAILED")
      .eq("updated_at", versaoLida)
      .select("id, updated_at");

    expect(outra.error).toBeNull();
    expect(outra.data).toHaveLength(1);
    expect(outra.data?.[0]?.updated_at).not.toBe(versaoLida);

    const volta = await db
      .from("listing_relists")
      .update({ status: "RELIST_FAILED" })
      .eq("id", operacao.id)
      .eq("status", "RELISTING")
      .select("id, updated_at");

    expect(volta.error).toBeNull();
    expect(volta.data).toHaveLength(1);

    const velha = await db
      .from("listing_relists")
      .update({ status: "RELISTING" })
      .eq("id", operacao.id)
      .eq("status", "RELIST_FAILED")
      .eq("updated_at", versaoLida)
      .select("id");

    expect(velha.error).toBeNull();
    expect(velha.data).toHaveLength(0);

    // Sem a versão, o mesmo UPDATE passaria: é exatamente o ABA que o CAS fecha.
    const semVersao = await db
      .from("listing_relists")
      .select("id")
      .eq("id", operacao.id)
      .eq("status", "RELIST_FAILED");

    expect(semVersao.data).toHaveLength(1);
  });

  it("readLastRelistFailureReason lê a falha MAIS NOVA desta operação, ignorando outra operação e outras transições", async () => {
    const operacao = await criarOperacao("MLB936400002", "RELIST_FAILED");
    const outraOperacao = await criarOperacao("MLB936400003", "RELIST_FAILED");

    await gravarEvento(operacao.id, "RELISTING", "RELIST_FAILED", "POST_RECUSADO", "2026-09-16T18:41:46.000Z");
    await gravarEvento(operacao.id, "RELIST_FAILED", "RELISTING", "RETOMADA_APOS_RECUSA", "2026-09-17T10:00:00.000Z");
    await gravarEvento(operacao.id, "RELISTING", "RELIST_FAILED", "POST_FALHOU", "2026-09-17T10:00:05.000Z");
    // Depois de tudo, mas de OUTRA operação — e uma transição que não é falha.
    await gravarEvento(outraOperacao.id, "RELISTING", "RELIST_FAILED", "POST_RECUSADO", "2026-09-17T11:00:00.000Z");
    await gravarEvento(operacao.id, "RELIST_FAILED", "RELISTING", "RETOMADA_APOS_RECUSA", "2026-09-17T12:00:00.000Z");

    const ultima = await readLastRelistFailureReason(db, operacao.id);

    expect(ultima).toEqual({ ok: true, reason: "POST_FALHOU" });
    expect(await readLastRelistFailureReason(db, outraOperacao.id)).toEqual({ ok: true, reason: "POST_RECUSADO" });
    expect(await readLastRelistFailureReason(db, randomUUID())).toEqual({ ok: true, reason: null });
  });

  it("a projeção parent_snapshot->variations devolve o array do snapshot com ids numéricos", async () => {
    const operacao = await criarOperacao("MLB936400004", "REQUESTED", {
      title: "pai com variações",
      variations: [
        { id: 52844432013, price: 114.9, available_quantity: 698 },
        { id: 181664696721, price: 114.9, available_quantity: 0 },
      ],
    });

    const lida = await db
      .from("listing_relists")
      .select("variations:parent_snapshot->variations")
      .eq("id", operacao.id)
      .maybeSingle();

    expect(lida.error).toBeNull();
    expect(lida.data?.variations).toEqual([
      { id: 52844432013, price: 114.9, available_quantity: 698 },
      { id: 181664696721, price: 114.9, available_quantity: 0 },
    ]);
  });
});
