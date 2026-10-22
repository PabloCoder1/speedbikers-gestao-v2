import { EVENT_SEVERITY } from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../../../components/page-title";
import { Panel } from "../../../../components/panel";
import { createClient } from "../../../../lib/supabase/server";
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
  shopee_shop_id: string | null;
  min_severity: string;
  enabled: boolean;
  ml_accounts: { label: string } | null;
}

// "A regra mais específica vence" (o texto da tela) só é fácil de conferir de
// olho se a ordem da tabela bater com a regra: as duas cunhas (tipo de
// evento, conta) primeiro, a severidade mais alta como desempate. Sem isso a
// tabela ficava em ordem de criação — quem chegou primeiro, sem relação com
// quem realmente vence.
const SEVERITY_RANK: Record<string, number> = { informativo: 0, importante: 1, critico: 2 };

function specificity(row: PreferenceRowData): number {
  return (row.eventType === null ? 0 : 1) + (row.accountLabel === null ? 0 : 1);
}

function byPrecedence(a: PreferenceRowData, b: PreferenceRowData): number {
  return (
    specificity(b) - specificity(a) ||
    (SEVERITY_RANK[b.minSeverity] ?? 0) - (SEVERITY_RANK[a.minSeverity] ?? 0)
  );
}

export default async function PreferenciasPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const [preferencesResult, accountsResult, lojasResult] = await Promise.all([
    supabase
      .from("notification_preferences")
      .select("id, event_type, ml_account_id, shopee_shop_id, min_severity, enabled, ml_accounts(label)")
      .order("created_at", { ascending: true }),
    supabase.from("ml_accounts").select("id, label").order("label", { ascending: true }),
    // D-642 (C-82): as lojas que a pessoa alcança (a RLS de D-433) — as únicas que ela pode escolher.
    supabase.from("shopee_shops").select("id, shop_name, environment").order("connected_at", { ascending: true }),
  ]);

  const error = preferencesResult.error ?? accountsResult.error ?? lojasResult.error;
  const accounts = accountsResult.data ?? [];
  const lojas = (lojasResult.data ?? []).map((loja) => ({
    id: loja.id,
    label: `${loja.shop_name ?? "Loja sem nome lido"}${loja.environment === "live" ? "" : " (teste)"}`,
  }));
  const nomeDaLoja = new Map(lojas.map((loja) => [loja.id, loja.label]));

  const rows: PreferenceRowData[] = ((preferencesResult.data ?? []) as PreferenceQueryRow[])
    .map((row) => ({
      id: row.id,
      eventType: row.event_type,
      // D-642: a origem é a conta do ML ou a loja da Shopee (nunca as duas).
      accountLabel:
        row.ml_accounts?.label ??
        (row.shopee_shop_id === null ? null : `Shopee · ${nomeDaLoja.get(row.shopee_shop_id) ?? "loja sem acesso"}`),
      minSeverity: row.min_severity,
      enabled: row.enabled,
    }))
    .sort(byPrecedence);

  const eventTypes = Object.keys(EVENT_SEVERITY);

  return (
    <>
      <PageTitle
        eyebrow="ADMINISTRAÇÃO / NOTIFICAÇÕES"
        title="Preferências de Notificação"
        subtitle={<Link href="/notificacoes">← Voltar à Central de Notificações</Link>}
        compacto
      />

      <div className="sb-note" style={{ marginBottom: "var(--sb-space-3)", maxWidth: "42rem" }}>
        <span>SÓ CONTROLA O TOAST</span>
        <p>
          Estas regras filtram apenas o alerta em tempo real. O histórico completo continua sempre na Central de
          Notificações, mesmo para o que estiver desativado ou abaixo da severidade mínima aqui. Sem nenhuma regra,
          todo evento vira toast por padrão.
        </p>
      </div>

      {error !== null && (
        <p role="alert" className="sb-note sb-note-perigo">
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <>
          <Panel
            title="Regras de alerta"
            subtitle="Da mais específica para a mais geral — é nessa ordem que uma regra vence a outra."
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
                      <th>Conta ou loja</th>
                      <th>Severidade mínima</th>
                      <th>Estado</th>
                      <th>
                        <span className="sb-sr-only">Ações</span>
                      </th>
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
            <Panel
              title="Nova regra"
              subtitle="Deixe tipo de evento ou conta e loja em aberto para uma regra mais abrangente."
            >
              <NewPreferenceForm eventTypes={eventTypes} eventSeverity={EVENT_SEVERITY} accounts={accounts} lojas={lojas} />
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
