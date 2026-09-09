"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { StatusPill } from "../../components/status-pill";
import { formatDateTime } from "../../lib/format";
import { eventTypeLabel, severityLabel } from "../../lib/labels";
import { entityHref, entityLabel, formatEventDiff } from "../../lib/event-format";
import { markNotificationRead } from "./actions";

/**
 * Uma notificação na Central (Fase 7, item 4) — mesmo padrão de
 * `apps/web/app/acoes/action-card.tsx`: componente cliente por linha (estado
 * local de lida/ocupado/erro), Server Action por clique, sem RPC.
 *
 * Leitura de `before`/`after`/entidade compartilhada com os toasts em tempo
 * real (`lib/event-format.ts`, item 5) — mesmo evento, mesma leitura.
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
        /*
          NÃO LIDA é o cartão branco; LIDA recua para o chão (D-285).

          A linha era `--sb-surface` contra `transparent`, e o passo cinza
          deveria ligá-la sozinho — foi o que o item 8 da lista de
          pré-requisitos prometeu. **Não ligou, e o motivo é a árvore:** a lista
          mora DENTRO de um `.sb-panel` branco, então o `transparent` da lida
          mostrava o painel, não o chão. Com `--sb-ground` explícito o recuo
          existe, e o realce que estava escrito no código desde sempre aparece
          na tela pela primeira vez.
        */
        background: isUnread ? "var(--sb-surface)" : "var(--sb-ground)",
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
          className="sb-button"
          type="button"
          disabled={busy}
          onClick={() => {
            void handleMarkRead();
          }} style={{ alignSelf: "flex-start" }}
        >
          Marcar como lida
        </button>
      )}
    </li>
  );
}
