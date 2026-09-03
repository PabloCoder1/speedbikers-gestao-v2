import { describeActionEvidence } from "@sb/domain";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { actionShortcuts } from "../../lib/action-shortcuts";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import type { ActionRowData, DecisionData, OutcomeData } from "./action-row";
import { ActionRow } from "./action-row";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Central de Ações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Central de Ações (Fase 6, D-064, `docs/ARCHITECTURE.md` secao 16) —
 * problema e oportunidade unificados numa tabela só. Só os itens ABERTOS
 * (`novo`/`em_andamento`) por padrão: "cinco mil alertas não são cinco mil
 * problemas" — a tela some da lista assim que resolvida/descartada, não
 * porque o registro sumiu.
 *
 * Ordenado por impacto financeiro estimado, NUNCA por contagem ou data —
 * mesma regra documentada em ARCHITECTURE.md secao 16.
 */

interface ActionQueryRow {
  id: string;
  kind: string;
  sku_id: string | null;
  severity: string;
  confidence: string;
  estimated_impact_brl: number | null;
  evidence: unknown;
  recommendation: string;
  status: string;
  assignee_id: string | null;
  skus: { sku: string; title: string | null } | null;
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

export default async function AcoesPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // Três leituras independentes, juntas desde D-195 — eram três idas ao banco
  // em fila. `getUser()` revalida o token contra o servidor de Auth e custa
  // uma ida inteira: enfileirá-lo não protegia nada, porque quem barra a rota
  // é o `proxy.ts`, que já chamou `getUser()` nesta mesma requisição. E as
  // ações não ficam desprotegidas por saírem junto: a RLS decide o que volta,
  // e o `organizationId` abaixo só serve ao guarda de "sem organização".
  const [{ data: auth }, membership, actionsResult] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(supabase),
    supabase
      .from("actions")
      .select(
        "id, kind, sku_id, severity, confidence, estimated_impact_brl, evidence, recommendation, status, assignee_id, skus(sku, title)",
      )
      .in("status", ["novo", "em_andamento"])
      .order("estimated_impact_brl", { ascending: false, nullsFirst: false }),
  ]);

  const userId = auth.user?.id ?? null;
  const organizationId = membership.organizationId;

  if (organizationId === null || userId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Central de Ações</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const { data, error: actionsError } = actionsResult;

  const actionIds = (data ?? []).map((row) => row.id);

  // Memória de decisões (Fase 6, PROMPT_MASTER secao 29) — decisões e
  // resultados medidos das ações listadas acima. Ação sem decisão registrada
  // simplesmente não aparece nos dois mapas abaixo.
  const decisionsResult =
    actionIds.length > 0
      ? await supabase
          .from("action_decisions")
          .select("id, action_id, decision, baseline_snapshot, created_at")
          .in("action_id", actionIds)
          .order("created_at", { ascending: false })
      : { data: [] };

  const decisionRows = decisionsResult.data ?? [];
  const decisionIds = decisionRows.map((row) => row.id);

  const outcomesResult =
    decisionIds.length > 0
      ? await supabase
          .from("action_outcomes")
          .select("action_decision_id, window_days, outcome_snapshot, measured_at")
          .in("action_decision_id", decisionIds)
      : { data: [] };

  const outcomesByDecision = new Map<string, OutcomeData[]>();

  for (const row of outcomesResult.data ?? []) {
    const list = outcomesByDecision.get(row.action_decision_id) ?? [];
    list.push({
      windowDays: row.window_days,
      outcomeSnapshot: row.outcome_snapshot as Record<string, unknown>,
      measuredAt: row.measured_at,
    });
    outcomesByDecision.set(row.action_decision_id, list);
  }

  // Falha ao ler decisões/outcomes ficava invisível antes: a Central de
  // Ações mostraria cada ação sem nenhuma decisão registrada, indistinguível
  // de "ninguém registrou uma decisão ainda" (D-067).
  const error =
    actionsError ??
    ("error" in decisionsResult ? decisionsResult.error : null) ??
    ("error" in outcomesResult ? outcomesResult.error : null);

  const decisionsByAction = new Map<string, DecisionData[]>();

  for (const row of decisionRows) {
    const list = decisionsByAction.get(row.action_id) ?? [];
    list.push({
      id: row.id,
      decision: row.decision,
      baselineSnapshot: row.baseline_snapshot as Record<string, unknown>,
      createdAt: row.created_at,
      outcomes: (outcomesByDecision.get(row.id) ?? []).sort((a, b) => a.windowDays - b.windowDays),
    });
    decisionsByAction.set(row.action_id, list);
  }

  const rows = ((data ?? []) as ActionQueryRow[]).map(
    (row): ActionRowData => ({
      id: row.id,
      sku: row.skus?.sku ?? null,
      title: row.skus?.title ?? null,
      severity: row.severity,
      confidence: row.confidence,
      estimated_impact_brl: row.estimated_impact_brl,
      evidence: describeActionEvidence(row.kind, row.evidence),
      recommendation: row.recommendation,
      status: row.status,
      assignee_id: row.assignee_id,
      decisions: decisionsByAction.get(row.id) ?? [],
      // Atalhos operacionais (D-154): só para telas que existem, com o
      // filtro que elas realmente têm — calculados no servidor, a linha só
      // renderiza.
      shortcuts: actionShortcuts({ kind: row.kind, skuId: row.sku_id, sku: row.skus?.sku ?? null }),
    }),
  );

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Central de Ações</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Problemas e oportunidades detectados automaticamente, ordenados por impacto financeiro estimado — não por
        contagem. {formatCount(rows.length)} aberto(s).
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && rows.length === 0 && <p style={{ color: "var(--sb-text-soft)" }}>Nenhuma ação aberta.</p>}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "64rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Tipo</th>
                <th style={th}>Confiança</th>
                <th style={th}>Impacto (R$)</th>
                <th style={th}>Evidência</th>
                <th style={th}>Recomendação</th>
                <th style={th}>Status</th>
                <th style={th}>Ações</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <ActionRow key={row.id} action={row} userId={userId} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
