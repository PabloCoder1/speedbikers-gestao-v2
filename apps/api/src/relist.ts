import type { AdminClient } from "@sb/db";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import type { Caller } from "./auth.js";
import type { Enqueuer } from "./enqueue.js";

/**
 * Pedido de republicação de um anúncio (Fase 9, D-161) — o primeiro elo do
 * fio. **A `api` autoriza e enfileira; o `worker` captura o snapshot e roda
 * o preflight.** Mesmo desenho de todo comando privilegiado (D-096): a
 * captura é uma chamada ao Mercado Livre, e `docs/ARCHITECTURE.md` secao 5
 * proíbe chamada remota inline aqui.
 *
 * NADA destrutivo acontece nesta fatia: a operação nasce REQUESTED (ou
 * PREFLIGHT_FAILED, se o preflight reprovar no worker) e PARA aí — o
 * fechamento do pai e o POST /relist são a fatia seguinte, com confirmação
 * própria. Este endpoint é o ATO HUMANO que o PRD exige: `requested_by` fica
 * na operação e no evento de criação.
 *
 * Permissão específica (PRD): papel ADMIN/GESTOR imposto na ROTA (republicar
 * é decisão de gestão — OPERADOR atende, não encerra anúncio) e escopo por
 * CONTA imposto aqui, no servidor (a lição de D-117: organização e papel não
 * bastam quando a entidade é escopada por conta).
 */

export interface RelistDeps {
  db: AdminClient;
  enqueuer: Enqueuer;
  logger: Logger;
  now?: () => Date;
}

export const relistRequestSchema = z.object({
  mlAccountId: z.uuid(),
  itemId: z.string().regex(/^MLB\d+$/, "itemId precisa ser um MLB válido"),
});

export type RelistRequest = z.infer<typeof relistRequestSchema>;

export type RelistRequestOutcome =
  | { status: "queued"; deduplicated: boolean }
  | { status: "not_found" }
  | { status: "error"; reason: string };

export type RelistExecuteOutcome =
  | { status: "queued"; deduplicated: boolean }
  | { status: "invalid"; reason: string }
  | { status: "not_found" }
  | { status: "error"; reason: string };

/**
 * A CONFIRMAÇÃO humana da execução (D-162) — segundo ato, separado do pedido
 * de propósito: é aqui que o irreversível é autorizado. Só operação
 * REQUESTED (preflight aprovado na criação) é executável; o worker re-roda o
 * preflight NA HORA de qualquer forma (padrão D-096).
 */
export async function requestListingRelistExecution(
  deps: RelistDeps,
  caller: Caller,
  relistId: string,
): Promise<RelistExecuteOutcome> {
  const now = deps.now?.() ?? new Date();

  const operation = await deps.db
    .from("listing_relists")
    .select("id, organization_id, ml_account_id, status, parent_item_id, ml_accounts(slug)")
    .eq("id", relistId)
    .maybeSingle();

  if (operation.error !== null) {
    return { status: "error", reason: operation.error.message };
  }

  const row = operation.data as {
    id: string;
    organization_id: string;
    ml_account_id: string;
    status: string;
    parent_item_id: string;
    ml_accounts: { slug: string } | null;
  } | null;

  // Fronteira de organização em código (AdminClient bypassa RLS); "não
  // encontrado" nunca vira "sem permissão" — padrão D-096.
  if (row?.organization_id !== caller.organizationId) {
    return { status: "not_found" };
  }

  if (caller.role !== "ADMIN") {
    const permission = await deps.db
      .from("user_account_permissions")
      .select("user_id")
      .eq("user_id", caller.userId)
      .eq("ml_account_id", row.ml_account_id)
      .maybeSingle();

    if (permission.error !== null) {
      return { status: "error", reason: permission.error.message };
    }

    if (permission.data === null) {
      return { status: "not_found" };
    }
  }

  if (row.status !== "REQUESTED") {
    return {
      status: "invalid",
      reason:
        row.status === "PREFLIGHT_FAILED"
          ? "a operação foi reprovada no preflight — corrija a causa e crie um novo pedido"
          : `a operação está em ${row.status} e não aguarda execução`,
    };
  }

  const slug = row.ml_accounts?.slug;

  if (slug === undefined) {
    return { status: "error", reason: "conta sem slug para resolver a fila" };
  }

  const minuteWindow = now.toISOString().slice(0, 16);

  const enqueued = await deps.enqueuer.enqueue({
    jobType: "relist.execute",
    organizationId: caller.organizationId,
    dedupeKey: `relist-execute:${relistId}:${minuteWindow}`,
    queue: `ml-sync-${slug}`,
    payload: { relistId },
  });

  deps.logger.info("relist_execute_queued", {
    relist_id: relistId,
    parent_item_id: row.parent_item_id,
    confirmed_by: caller.userId,
    deduplicated: enqueued.deduplicated,
  });

  return { status: "queued", deduplicated: enqueued.deduplicated };
}

export async function requestListingRelist(
  deps: RelistDeps,
  caller: Caller,
  request: RelistRequest,
): Promise<RelistRequestOutcome> {
  const now = deps.now?.() ?? new Date();

  const account = await deps.db
    .from("ml_accounts")
    .select("id, organization_id, slug")
    .eq("id", request.mlAccountId)
    .maybeSingle();

  if (account.error !== null) {
    return { status: "error", reason: account.error.message };
  }

  // O `AdminClient` bypassa RLS: a fronteira de organização é conferida em
  // código. Conta de outra organização é "não encontrado", nunca "sem
  // permissão" — a segunda resposta revelaria que ela existe (padrão D-096).
  if (account.data?.organization_id !== caller.organizationId) {
    return { status: "not_found" };
  }

  // Escopo por CONTA para quem não é ADMIN (lição de D-117) — espelha
  // `private.has_account_access`, que não é chamável sob service_role.
  if (caller.role !== "ADMIN") {
    const permission = await deps.db
      .from("user_account_permissions")
      .select("user_id")
      .eq("user_id", caller.userId)
      .eq("ml_account_id", request.mlAccountId)
      .maybeSingle();

    if (permission.error !== null) {
      return { status: "error", reason: permission.error.message };
    }

    if (permission.data === null) {
      return { status: "not_found" };
    }
  }

  // O anúncio precisa EXISTIR no catálogo sincronizado da conta — pedir
  // relist de um item que a V3 não conhece falharia só no worker, tarde e
  // sem resposta para quem pediu.
  const listing = await deps.db
    .from("listings")
    .select("item_id")
    .eq("ml_account_id", request.mlAccountId)
    .eq("item_id", request.itemId)
    .maybeSingle();

  if (listing.error !== null) {
    return { status: "error", reason: listing.error.message };
  }

  if (listing.data === null) {
    return { status: "not_found" };
  }

  // Janela de minuto no nome da task (classe D-051): o Cloud Tasks retém o
  // nome por até 24h — sem a janela, um pedido legítimo HORAS depois de uma
  // operação reaberta (PREFLIGHT_FAILED corrigido, por exemplo) seria
  // descartado em silêncio. Dois cliques no MESMO minuto colapsam em um; a
  // proteção durável contra operação dupla é o índice único parcial do banco
  // (D-159), não este nome.
  const minuteWindow = now.toISOString().slice(0, 16);

  const enqueued = await deps.enqueuer.enqueue({
    jobType: "relist.prepare",
    organizationId: caller.organizationId,
    dedupeKey: `relist-prepare:${request.itemId}:${minuteWindow}`,
    // Fila da conta: a captura do snapshot fala com o Mercado Livre e disputa
    // o rate limit daquela conta (D-036).
    queue: `ml-sync-${account.data.slug}`,
    payload: {
      mlAccountId: request.mlAccountId,
      itemId: request.itemId,
      requestedBy: caller.userId,
    },
  });

  deps.logger.info("relist_prepare_queued", {
    ml_account_id: request.mlAccountId,
    item_id: request.itemId,
    requested_by: caller.userId,
    deduplicated: enqueued.deduplicated,
  });

  return { status: "queued", deduplicated: enqueued.deduplicated };
}
