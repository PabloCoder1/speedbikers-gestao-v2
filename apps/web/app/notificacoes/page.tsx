import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { MarkAllButton } from "./mark-all-button";
import { NotificationRow, type NotificationRowData } from "./notification-row";

export const metadata = { title: "Central de Notificações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Central de Notificações (Fase 7, item 4, `docs/HANDOFF.md` —
 * desbloqueada pelo schema de D-073). Histórico completo com estado
 * lido/não lido por usuário (`docs/NOTIFICATIONS.md` secao 7) — Realtime,
 * toast e agrupamento por janela (item 5) ficam de fora desta fatia.
 *
 * `notification_recipients!inner(read_at)` sem filtro de `user_id`: a
 * policy `notification_recipients_select_own` já restringe o embed à
 * própria linha do usuário — mesmo raciocínio de `apps/web/app/compras/page.tsx`
 * ("sem filtro por organização: a policy já restringe").
 */

interface NotificationQueryRow {
  id: string;
  created_at: string;
  notification_recipients: { read_at: string | null }[];
  domain_events: {
    event_type: string;
    entity_type: string;
    entity_id: string;
    severity: string;
    occurred_at: string;
    before: unknown;
    after: unknown;
    ml_accounts: { label: string } | null;
  } | null;
}

export default async function NotificacoesPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("notifications")
    .select(
      "id, created_at, notification_recipients!inner(read_at), domain_events(event_type, entity_type, entity_id, severity, occurred_at, before, after, ml_accounts(label))",
    )
    .order("created_at", { ascending: false })
    .limit(100);

  const rows: NotificationRowData[] = ((data ?? []) as NotificationQueryRow[]).map((row) => {
    const readAt = row.notification_recipients[0]?.read_at ?? null;
    const event = row.domain_events;

    return {
      id: row.id,
      createdAt: row.created_at,
      readAt,
      eventType: event?.event_type ?? "—",
      entityType: event?.entity_type ?? "—",
      entityId: event?.entity_id ?? "—",
      severity: event?.severity ?? "informativo",
      occurredAt: event?.occurred_at ?? row.created_at,
      before: (event?.before ?? null) as Record<string, unknown> | null,
      after: (event?.after ?? null) as Record<string, unknown> | null,
      accountLabel: event?.ml_accounts?.label ?? null,
    };
  });

  const unreadCount = rows.filter((row) => row.readAt === null).length;

  return (
    <Shell>
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "var(--sb-space-3)",
          marginBottom: "var(--sb-space-3)",
          flexWrap: "wrap",
        }}
      >
        <div>
          <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Central de Notificações</h1>

          <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            {formatCount(rows.length)} no histórico · {formatCount(unreadCount)} não lida(s).
          </p>
        </div>

        {unreadCount > 0 && <MarkAllButton />}
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && rows.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhuma notificação ainda.</p>
      )}

      {error === null && rows.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {rows.map((row) => (
            <NotificationRow key={row.id} notification={row} />
          ))}
        </ul>
      )}
    </Shell>
  );
}
