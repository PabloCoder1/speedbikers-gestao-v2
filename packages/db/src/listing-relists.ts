import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./types.js";

/**
 * A ÚLTIMA falha registrada de uma republicação (D-364) — a leitura que decide
 * se a operação em RELIST_FAILED pode ser retomada por uma pessoa.
 *
 * Três camadas aplicam a regra de elegibilidade (`isRelistRetryEligible`, em
 * `@sb/domain`): a tela, sob RLS, para oferecer o botão; a `api` e o worker,
 * com o `AdminClient`, para aceitar o pedido e emitir o POST. A consulta é
 * uma só, aqui, porque cada filtro dela é segurança:
 *
 * - `relist_id`: o `AdminClient` ignora a RLS, e sem o filtro o evento de
 *   OUTRA operação decidiria esta;
 * - `to_status = RELIST_FAILED`: só a entrada na falha diz o motivo dela;
 * - a ordem DESCENDENTE: a primeira falha pode ter sido recusa e a última, um
 *   5xx da retomada — ler a primeira ofereceria repetir o POST depois de um
 *   5xx, que pode ter criado o filho.
 *
 * `occurred_at` é `now()` de cada transação (o worker grava cada transição
 * numa chamada própria), então duas falhas da mesma operação nunca empatam.
 */

export type LastRelistFailure = { ok: true; reason: string | null } | { ok: false; message: string };

export async function readLastRelistFailureReason(
  client: SupabaseClient<Database>,
  relistId: string,
): Promise<LastRelistFailure> {
  const { data, error } = await client
    .from("listing_relist_events")
    .select("reason")
    .eq("relist_id", relistId)
    .eq("to_status", "RELIST_FAILED")
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error !== null) {
    return { ok: false, message: error.message };
  }

  return { ok: true, reason: data?.reason ?? null };
}
