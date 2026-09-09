import { EVENT_SEVERITY } from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
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
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / NOTIFICAÇÕES"
        title="Preferências de Notificação"
        subtitle={<Link href="/notificacoes">← Voltar à Central de Notificações</Link>}
        compacto
      />

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)", maxWidth: "42rem" }}>
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
          <Panel
            title="Regras de alerta"
            subtitle="A regra mais específica vence; sem nenhuma, todo evento vira toast."
          >
            {rows.length === 0 && (
              <p className="sb-empty">Nenhuma preferência configurada — todo evento vira toast por padrão.</p>
            )}

            {rows.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table className="sb-table">
                  <thead>
                    <tr>
                      <th>Tipo de evento</th>
                      <th>Conta</th>
                      <th>Severidade mínima</th>
                      <th>Estado</th>
                      <th>Ações</th>
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
          </Panel>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <NewPreferenceForm eventTypes={eventTypes} accounts={accounts} />
          </div>
        </>
      )}
    </Shell>
  );
}
