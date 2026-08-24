"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { StatusPill } from "../../components/status-pill";
import { formatCurrency, formatDateTime } from "../../lib/format";
import { eventTypeLabel, listingStatusLabel, severityLabel } from "../../lib/labels";
import { markNotificationRead } from "./actions";

/**
 * Uma notificação na Central (Fase 7, item 4) — mesmo padrão de
 * `apps/web/app/acoes/action-row.tsx`: componente cliente por linha (estado
 * local de lida/ocupado/erro), Server Action por clique, sem RPC.
 */

export interface NotificationRowData {
  id: string;
  createdAt: string;
  readAt: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  severity: string;
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  accountLabel: string | null;
}

/**
 * Diff legível só para os tipos de evento cujo formato de `before`/`after` já
 * está documentado (`packages/domain/src/events/listing-events.ts`). Os
 * demais tipos não têm diff aqui de propósito — mostrar chave/valor bruto de
 * um `before`/`after` cujo formato não foi conferido seria inventar leitura
 * (REGRA ABSOLUTA equivalente à de `docs/MERCADO_LIVRE.md`).
 */
/** `unknown` vira string só quando já é string/number — nunca `String(objeto)`, que gera "[object Object]" ilegível. */
function scalar(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);

  return "—";
}

function formatEventDiff(eventType: string, before: Record<string, unknown> | null, after: Record<string, unknown> | null): string | null {
  const b = before ?? {};
  const a = after ?? {};

  switch (eventType) {
    case "listing.price.changed": {
      const beforePrice = typeof b.price === "number" ? b.price : null;
      const afterPrice = typeof a.price === "number" ? a.price : null;

      return `${formatCurrency(beforePrice)} → ${formatCurrency(afterPrice)}`;
    }
    case "listing.title.changed":
      return `"${scalar(b.title)}" → "${scalar(a.title)}"`;
    case "listing.available_quantity.changed":
      return `${scalar(b.availableQuantity)} → ${scalar(a.availableQuantity)}`;
    case "listing.status.paused":
    case "listing.status.reactivated":
      return `${listingStatusLabel(scalar(b.status))} → ${listingStatusLabel(scalar(a.status))}`;
    default:
      return null;
  }
}

/**
 * Link pra entidade afetada (docs/NOTIFICATIONS.md secao 7) só quando a rota
 * existe de verdade: `/skus/[skuId]` usa o UUID de `skus.id` diretamente, o
 * mesmo valor que `entity_id` carrega pra `entity_type = "sku"`
 * (`packages/domain/src/events/fulfillment-events.ts`). Anúncio e pedido
 * ainda não têm tela própria — mostrar só o texto em vez de um link morto.
 */
function entityHref(entityType: string, entityId: string): string | null {
  if (entityType === "sku") return `/skus/${entityId}`;

  return null;
}

function entityLabel(entityType: string): string {
  if (entityType === "sku") return "SKU";
  if (entityType === "listing") return "Anúncio";
  if (entityType === "order") return "Pedido";

  return entityType;
}

export function NotificationRow({ notification }: { notification: NotificationRowData }): ReactNode {
  const [readAt, setReadAt] = useState(notification.readAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUnread = readAt === null;
  const diff = formatEventDiff(notification.eventType, notification.before, notification.after);
  const href = entityHref(notification.entityType, notification.entityId);

  async function handleMarkRead(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await markNotificationRead(notification.id);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setReadAt(new Date().toISOString());
  }

  return (
    <li
      style={{
        display: "flex",
        gap: "var(--sb-space-3)",
        padding: "var(--sb-space-3)",
        border: "1px solid var(--sb-border)",
        borderLeft: isUnread ? "3px solid var(--sb-primary)" : "3px solid transparent",
        borderRadius: "var(--sb-radius)",
        background: isUnread ? "var(--sb-surface)" : "transparent",
        marginBottom: "var(--sb-space-2)",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-2)", flexWrap: "wrap" }}>
          <StatusPill code={notification.severity} label={severityLabel(notification.severity)} />

          <span style={{ fontWeight: isUnread ? 700 : 500, fontSize: "0.875rem" }}>
            {eventTypeLabel(notification.eventType)}
          </span>

          {notification.accountLabel !== null && (
            <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>{notification.accountLabel}</span>
          )}
        </div>

        <div style={{ marginTop: "0.25rem", fontSize: "0.8125rem" }}>
          {href !== null ? (
            <Link href={href} style={{ color: "var(--sb-primary)" }}>
              {entityLabel(notification.entityType)} {notification.entityId}
            </Link>
          ) : (
            <span style={{ color: "var(--sb-text-soft)" }}>
              {entityLabel(notification.entityType)} {notification.entityId}
            </span>
          )}

          {diff !== null && <span style={{ marginLeft: "0.5rem" }}>{diff}</span>}
        </div>

        <div style={{ marginTop: "0.25rem", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
          {formatDateTime(notification.occurredAt)}
        </div>

        {error !== null && (
          <p role="alert" style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
            {error}
          </p>
        )}
      </div>

      {isUnread && (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void handleMarkRead();
          }}
          style={{
            alignSelf: "flex-start",
            padding: "0.25rem 0.625rem",
            borderRadius: "var(--sb-radius)",
            border: "1px solid var(--sb-border)",
            background: "transparent",
            fontSize: "0.75rem",
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          Marcar como lida
        </button>
      )}
    </li>
  );
}
