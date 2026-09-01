import type { AdminClient, Json } from "@sb/db";
import type { DomainEventDraft } from "@sb/domain";
import type { Logger } from "@sb/observability";

/**
 * Grava os rascunhos de evento produzidos pelo motor de diff
 * (`@sb/domain/events`) em `domain_events`.
 *
 * Best-effort DE PROPÓSITO, mesmo padrão de `job_runs`
 * (`apps/worker/src/app.ts`): falhar aqui não pode derrubar uma
 * persistência de pedido que já deu certo — deixar a observabilidade
 * derrubar a operação faria o Cloud Tasks repetir um trabalho que já
 * funcionou. O conflito de `dedup_key` (23505) não é sequer logado como
 * erro: é a deduplicação funcionando.
 */

const UNIQUE_VIOLATION = "23505";

export interface RecordDomainEventsContext {
  organizationId: string;
  /** `null`/ausente para eventos organizacionais sem conta associada (D-054, ex.: `stock.balance.diverged`). */
  mlAccountId?: string | null;
}

export async function recordDomainEvents(
  db: AdminClient,
  context: RecordDomainEventsContext,
  drafts: readonly DomainEventDraft[],
  logger: Logger,
): Promise<void> {
  for (const draft of drafts) {
    // `ON CONFLICT DO NOTHING` em vez de INSERT com 23505 absorvido no
    // cliente (D-092): o conflito de `dedup_key` é esperado a cada
    // reprocessamento, e deixá-lo virar ERROR no log do Postgres só enterrava
    // erro de verdade. `ignoreDuplicates` nunca faz UPDATE — `domain_events` é
    // append-only (D-016).
    const result = await db.from("domain_events").upsert(
      {
        organization_id: context.organizationId,
        ml_account_id: context.mlAccountId ?? null,
        occurred_at: draft.occurredAt.toISOString(),
        event_type: draft.eventType,
        entity_type: draft.entityType,
        entity_id: draft.entityId,
        before: asJson(draft.before),
        after: asJson(draft.after),
        severity: draft.severity,
        source: draft.source,
        dedup_key: draft.dedupKey,
      },
      { onConflict: "dedup_key", ignoreDuplicates: true },
    );

    if (result.error !== null && result.error.code !== UNIQUE_VIOLATION) {
      logger.error("domain_event_not_recorded", {
        event_type: draft.eventType,
        entity_id: draft.entityId,
        reason: result.error.message,
      });
    }
  }
}

/**
 * `DomainEventDraft.before`/`after` são `unknown` em `@sb/domain` (pacote
 * puro, sem depender do tipo `Json` de `@sb/db`). Aqui na borda de I/O é
 * seguro converter: o motor de diff só produz objetos serializáveis
 * (`{ status: string | null }`), nunca `undefined`, `Date` ou classe.
 */
export function asJson(value: unknown): Json {
  return value as Json;
}
