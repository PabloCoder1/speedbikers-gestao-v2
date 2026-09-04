import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { summarizePagedWindow } from "../../lib/filters";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { MarkAllButton } from "./mark-all-button";
import { NotificationRow, type NotificationRowData } from "./notification-row";

export const metadata = { title: "Central de Notificações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * A tela lista as 100 mais recentes. O número TOTAL e o de não lidas vêm de
 * contagens próprias, não do tamanho desta lista — ver D-183.
 */
const PAGE_SIZE = 100;

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

  // As três em paralelo: a lista e as DUAS contagens. Contar custa 2,7 ms e
  // 1,0 ms contra as 28.386 linhas do Dev (medido em D-183) — o round trip a
  // mais é mais barato do que o número errado que ele evita.
  const [{ data, error }, totalResult, unreadResult] = await Promise.all([
    supabase
      .from("notifications")
      .select(
        "id, created_at, notification_recipients!inner(read_at), domain_events(event_type, entity_type, entity_id, severity, occurred_at, before, after, ml_accounts(label))",
      )
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE),
    supabase.from("notification_recipients").select("notification_id", { count: "exact", head: true }),
    supabase
      .from("notification_recipients")
      .select("notification_id", { count: "exact", head: true })
      .is("read_at", null),
  ]);

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

  // D-183 — o defeito que esta fatia corrige.
  //
  // `unreadCount` era `rows.filter(...).length`: contava as não lidas ENTRE AS
  // 100 CARREGADAS. Medido no Dev: 28.386 notificações, 2.543 não lidas. A
  // tela dizia "100 no histórico" e no máximo 100 não lidas.
  //
  // O pior não era o número: era o botão. "Marcar todas como lidas" só
  // aparece com `unreadCount > 0`, então bastava ler as 100 mais recentes
  // para ele SUMIR — deixando milhares de não lidas sem nenhuma forma de
  // limpar pela interface, enquanto a Server Action por trás dele sempre
  // marcou todas. Mesma classe de D-138/D-140, que criaram o
  // `summarizePagedWindow` justamente para isto.
  //
  // `count` nulo é recusa, não zero (D-131): quando a contagem não vem, a
  // tela diz que não sabe em vez de inventar o tamanho da página.
  const totalCount = totalResult.count;
  const unreadCount = unreadResult.count;
  const window =
    totalCount === null
      ? null
      : summarizePagedWindow({
          page: 1,
          totalCount,
          rowsOnPage: rows.length,
          pageSize: PAGE_SIZE,
          noun: { singular: "notificação", plural: "notificações" },
          emptyLabel: "Nenhuma notificação ainda.",
          trailing: ", as mais recentes",
        });

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
            {/* O helper devolve a frase já pontuada, porque as outras telas a
                exibem sozinha. Aqui ela é o primeiro de dois fatos, então o
                ponto final sai para o "·" não vir depois de um ponto. */}
            {window === null
              ? `${formatCount(rows.length)} carregadas — total indisponível.`
              : window.label.replace(/\.$/, "")}
            {unreadCount !== null && ` · ${formatCount(unreadCount)} não lida(s).`}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-3)" }}>
          <Link href="/notificacoes/preferencias" style={{ fontSize: "0.8125rem", color: "var(--sb-primary)" }}>
            Preferências
          </Link>

          {unreadCount !== null && unreadCount > 0 && <MarkAllButton />}
        </div>
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
