import type { FreshnessLevel } from "@sb/domain";
import { classifySyncFreshness } from "@sb/domain";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount, formatDateTime } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Saúde da Sincronização — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Ver apps/web/app/importacoes/page.tsx para o mesmo raciocínio.
export const dynamic = "force-dynamic";

/**
 * Saúde da Sincronização (docs/ROADMAP.md, marco final da Fase 3).
 *
 * `docs/ARCHITECTURE.md` secao 20: "sync_runs/sync_errors/freshness por
 * conta vira a tela de Saúde da Sincronização, que é observabilidade PARA O
 * USUÁRIO" — e a mesma secao avisa para não repetir o erro da V2
 * ("instrumentação sem consumidor é custo puro"). `sync_runs`, `sync_errors`
 * e `domain_events` já existem e gravam desde a Fase 3; esta tela é o
 * primeiro consumidor.
 *
 * Só `resource = 'orders'` tem sincronização de verdade hoje — listings e
 * fulfillment ainda não foram construídos (`docs/ROADMAP.md`), então a tela
 * não finge frescor que não existe.
 */

const FRESHNESS_TONE: Record<FreshnessLevel, { color: string; label: string }> = {
  ok: { color: "var(--sb-secondary)", label: "Em dia" },
  atencao: { color: "var(--sb-accent-ink)", label: "Sincronização atrasando" },
  critico: { color: "var(--sb-danger)", label: "Sincronização atrasada" },
  nunca_sincronizado: { color: "var(--sb-muted-ink)", label: "Nunca sincronizado" },
};

const ACCOUNT_STATUS_TONE: Record<string, { color: string; label: string }> = {
  PENDING: { color: "var(--sb-muted-ink)", label: "Aguardando conexão" },
  CONNECTED: { color: "var(--sb-secondary)", label: "Conectada" },
  REVOKED: { color: "var(--sb-danger)", label: "Acesso revogado" },
  ERROR: { color: "var(--sb-danger)", label: "Erro de conexão" },
};

const SEVERITY_TONE: Record<string, { color: string; label: string }> = {
  informativo: { color: "var(--sb-muted-ink)", label: "Informativo" },
  importante: { color: "var(--sb-accent-ink)", label: "Importante" },
  critico: { color: "var(--sb-danger)", label: "Crítico" },
};

/**
 * Rótulo legível por `event_type`. Fallback para o próprio tipo bruto: um
 * evento novo (quando o motor de diff ganhar mais detectores) não deve ficar
 * invisível só porque a tela ainda não tem um texto pronto para ele.
 */
const EVENT_LABEL: Record<string, string> = {
  "order.cancelled": "Pedido cancelado",
};

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

interface AccountRow {
  id: string;
  label: string;
  slug: string;
  status: string;
  last_error: string | null;
}

interface AccountHealth extends AccountRow {
  freshness: FreshnessLevel | null;
  latestRecordAt: string | null;
  errorCount24h: number;
}

async function loadAccountHealth(
  supabase: SupabaseServerClient,
  account: AccountRow,
  now: Date,
): Promise<AccountHealth> {
  if (account.status !== "CONNECTED") {
    // Conta que nunca chegou a sincronizar não tem frescor a medir — mostrar
    // "0h de atraso" seria fingir um dado que não existe.
    return { ...account, freshness: null, latestRecordAt: null, errorCount24h: 0 };
  }

  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();

  const [lastRun, errorCount] = await Promise.all([
    supabase
      .from("sync_runs")
      .select("latest_record_at")
      .eq("ml_account_id", account.id)
      .eq("resource", "orders")
      .in("status", ["done", "partial"])
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from("sync_errors")
      .select("id", { count: "exact", head: true })
      .eq("ml_account_id", account.id)
      .gte("occurred_at", since),
  ]);

  const latestRecordAt = lastRun.data?.latest_record_at ?? null;

  return {
    ...account,
    freshness: classifySyncFreshness(latestRecordAt === null ? null : new Date(latestRecordAt), now),
    latestRecordAt,
    errorCount24h: errorCount.count ?? 0,
  };
}

function AccountCard({ account }: { account: AccountHealth }): ReactNode {
  const statusTone = ACCOUNT_STATUS_TONE[account.status] ?? { color: "var(--sb-muted-ink)", label: account.status };
  const freshnessTone = account.freshness === null ? null : FRESHNESS_TONE[account.freshness];
  const borderColor = freshnessTone?.color ?? statusTone.color;

  return (
    <li
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        gap: "var(--sb-space-3)",
        padding: "var(--sb-space-3)",
        border: "1px solid var(--sb-border)",
        borderRadius: "var(--sb-radius)",
        borderLeft: `3px solid ${borderColor}`,
      }}
    >
      <span style={{ fontWeight: 600, minWidth: "10rem" }}>{account.label}</span>

      <span style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", fontFamily: "ui-monospace, monospace" }}>
        {account.slug}
      </span>

      <span style={{ fontSize: "0.8125rem", fontWeight: 700, color: statusTone.color }}>{statusTone.label}</span>

      {account.status === "ERROR" && account.last_error !== null && (
        <span style={{ color: "var(--sb-danger)", fontSize: "0.8125rem" }}>{account.last_error}</span>
      )}

      {freshnessTone !== null && (
        <>
          <span style={{ fontSize: "0.8125rem", fontWeight: 700, color: freshnessTone.color }}>
            {freshnessTone.label}
          </span>
          <span style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
            atualizado até {formatDateTime(account.latestRecordAt)}
          </span>
          <span style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", marginLeft: "auto" }}>
            {formatCount(account.errorCount24h)} erro(s) nas últimas 24h
          </span>
        </>
      )}
    </li>
  );
}

interface EventRow {
  id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  severity: string;
  occurred_at: string;
  ml_accounts: { label: string };
}

function EventLine({ event }: { event: EventRow }): ReactNode {
  const tone = SEVERITY_TONE[event.severity] ?? { color: "var(--sb-muted-ink)", label: event.severity };
  const label = EVENT_LABEL[event.event_type] ?? event.event_type;

  return (
    <li
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "baseline",
        gap: "var(--sb-space-2)",
        padding: "var(--sb-space-2) 0",
        borderBottom: "1px solid var(--sb-border)",
        fontSize: "0.875rem",
      }}
    >
      <span
        style={{
          fontSize: "0.6875rem",
          fontWeight: 700,
          letterSpacing: "0.04em",
          color: tone.color,
          minWidth: "5.5rem",
        }}
      >
        {tone.label.toUpperCase()}
      </span>
      <span style={{ fontWeight: 600 }}>{label}</span>
      <span style={{ color: "var(--sb-text-soft)", fontFamily: "ui-monospace, monospace", fontSize: "0.8125rem" }}>
        {event.entity_type} {event.entity_id}
      </span>
      <span style={{ color: "var(--sb-text-soft)" }}>{event.ml_accounts.label}</span>
      <span style={{ color: "var(--sb-text-soft)", marginLeft: "auto", whiteSpace: "nowrap" }}>
        {formatDateTime(event.occurred_at)}
      </span>
    </li>
  );
}

export default async function SincronizacaoPage(): Promise<ReactNode> {
  const supabase = await createClient();
  const now = new Date();

  const accountsResult = await supabase
    .from("ml_accounts")
    .select("id, label, slug, status, last_error")
    .order("label", { ascending: true });

  const accounts = accountsResult.data ?? [];

  const [health, eventsResult] = await Promise.all([
    Promise.all(accounts.map((account) => loadAccountHealth(supabase, account, now))),
    supabase
      .from("domain_events")
      .select("id, event_type, entity_type, entity_id, severity, occurred_at, ml_accounts(label)")
      .order("occurred_at", { ascending: false })
      .limit(30),
  ]);

  const events = eventsResult.data ?? [];

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1.375rem" }}>Saúde da Sincronização</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Frescor de pedidos por conta e os últimos eventos detectados. Só pedidos têm sincronização
        hoje — anúncios e estoque Full ainda não foram construídos.
      </p>

      {accountsResult.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar as contas: {accountsResult.error.message}
        </p>
      )}

      {accountsResult.error === null && accounts.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhuma conta Mercado Livre cadastrada ainda.</p>
      )}

      {accounts.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 var(--sb-space-5)", display: "grid", gap: "var(--sb-space-2)" }}>
          {health.map((account) => (
            <AccountCard key={account.id} account={account} />
          ))}
        </ul>
      )}

      <h2 style={{ fontSize: "1.0625rem", margin: "0 0 var(--sb-space-2)" }}>Eventos recentes</h2>

      {eventsResult.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os eventos: {eventsResult.error.message}
        </p>
      )}

      {eventsResult.error === null && events.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum evento registrado ainda.</p>
      )}

      {events.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {events.map((event) => (
            <EventLine key={event.id} event={event} />
          ))}
        </ul>
      )}
    </Shell>
  );
}
