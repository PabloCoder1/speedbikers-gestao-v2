import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import type { ActionEvidence, ActionRowData } from "./action-row";
import { ActionRow } from "./action-row";

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

  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null || userId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Central de Ações</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const { data, error } = await supabase
    .from("actions")
    .select(
      "id, severity, confidence, estimated_impact_brl, evidence, recommendation, status, assignee_id, skus(sku, title)",
    )
    .in("status", ["novo", "em_andamento"])
    .order("estimated_impact_brl", { ascending: false, nullsFirst: false });

  const rows = ((data ?? []) as ActionQueryRow[]).map(
    (row): ActionRowData => ({
      id: row.id,
      sku: row.skus?.sku ?? null,
      title: row.skus?.title ?? null,
      severity: row.severity,
      confidence: row.confidence,
      estimated_impact_brl: row.estimated_impact_brl,
      evidence: row.evidence as ActionEvidence,
      recommendation: row.recommendation,
      status: row.status,
      assignee_id: row.assignee_id,
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
                <th style={th}>Direção</th>
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
