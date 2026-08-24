import { EVENT_SEVERITY } from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { createClient } from "../../../lib/supabase/server";
import { NewPreferenceForm } from "./new-preference-form";
import { PreferenceRow, type PreferenceRowData } from "./preference-row";

export const metadata = { title: "Preferências de Notificação — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Preferências de notificação (Fase 7, item 6, D-076) — schema e regra de
 * aplicação prontos desde D-073, faltava só esta UI. Cada usuário gerencia
 * a própria preferência direto sob RLS (`notification_preferences_all_own`),
 * sem RPC.
 *
 * Só controla o TOAST em tempo real — a Central de Notificações mostra
 * tudo sempre, independente destas regras (correção D-076, ver
 * `docs/DECISIONS.md`): a cópia da tela é explícita sobre isso pra não
 * repetir o mal-entendido que o bug original causaria.
 *
 * Lista de `event_type` vem do catálogo real (`@sb/domain`), não uma
 * cópia — o mesmo catálogo que `packages/domain/src/events/catalog.ts`
 * usa pra atribuir severidade.
 */

interface PreferenceQueryRow {
  id: string;
  event_type: string | null;
  ml_account_id: string | null;
  min_severity: string;
  enabled: boolean;
  ml_accounts: { label: string } | null;
}

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

export default async function PreferenciasPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const [preferencesResult, accountsResult] = await Promise.all([
    supabase
      .from("notification_preferences")
      .select("id, event_type, ml_account_id, min_severity, enabled, ml_accounts(label)")
      .order("created_at", { ascending: true }),
    supabase.from("ml_accounts").select("id, label").order("label", { ascending: true }),
  ]);

  const error = preferencesResult.error ?? accountsResult.error;
  const accounts = accountsResult.data ?? [];

  const rows: PreferenceRowData[] = ((preferencesResult.data ?? []) as PreferenceQueryRow[]).map((row) => ({
    id: row.id,
    eventType: row.event_type,
    accountLabel: row.ml_accounts?.label ?? null,
    minSeverity: row.min_severity,
    enabled: row.enabled,
  }));

  const eventTypes = Object.keys(EVENT_SEVERITY);

  return (
    <Shell>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sb-space-3)",
          marginBottom: "var(--sb-space-2)",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>Preferências de Notificação</h1>

        <Link href="/notificacoes" style={{ marginLeft: "auto", fontSize: "0.8125rem", color: "var(--sb-primary)" }}>
          ← Central de Notificações
        </Link>
      </div>

      <p style={{ margin: "0 0 var(--sb-space-4)", fontSize: "0.8125rem", color: "var(--sb-text-soft)", maxWidth: "42rem" }}>
        Controla só o alerta em tempo real (o toast) — o histórico completo continua sempre na Central de
        Notificações, mesmo pro que estiver desativado ou abaixo da severidade mínima aqui. Sem nenhuma regra, todo
        evento vira toast por padrão.
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <>
          {rows.length === 0 && (
            <p style={{ color: "var(--sb-text-soft)", marginBottom: "var(--sb-space-3)" }}>
              Nenhuma preferência configurada — todo evento vira toast por padrão.
            </p>
          )}

          {rows.length > 0 && (
            <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
              <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "40rem" }}>
                <thead>
                  <tr>
                    <th style={th}>Tipo de evento</th>
                    <th style={th}>Conta</th>
                    <th style={th}>Severidade mínima</th>
                    <th style={th}>Estado</th>
                    <th style={th}>Ações</th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => (
                    <PreferenceRow key={row.id} preference={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <NewPreferenceForm eventTypes={eventTypes} accounts={accounts} />
        </>
      )}
    </Shell>
  );
}
