import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { NewSuggestionForm } from "./new-suggestion-form";
import { SuggestionRow, type SuggestionRowData } from "./suggestion-row";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Sugestões de Melhoria — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Central de Sugestões (Fase 7, item 9, D-079,
 * `docs/PRODUCT_REQUIREMENTS.md`) — captura de ideias em texto livre +
 * fluxo de triagem em sete estados. Qualquer membro envia; só ADMIN/GESTOR
 * muda o status (mesma granularidade de `purchase_orders`/`actions`).
 *
 * A versão ESTRUTURADA (título, problema, objetivo...) é gerada pela IA
 * "quando possível" (requisito original) — o Copiloto ainda não tem
 * modelo/orçamento decidido (`docs/COPILOT.md` secao 10), então esta tela
 * só mostra o texto original, preservado íntegro. Ver D-079 em
 * `docs/DECISIONS.md`.
 */

interface SuggestionQueryRow {
  id: string;
  original_text: string;
  status: string;
  created_at: string;
  title: string | null;
  problem: string | null;
  objective: string | null;
  impacted_users: string | null;
  suggested_flow: string | null;
  expected_benefit: string | null;
  acceptance_criteria: string | null;
  dependencies_risks: string | null;
  complexity: string | null;
  profiles: { full_name: string | null } | null;
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

export default async function SugestoesPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // As duas leituras são INDEPENDENTES: o papel decide o que a tela DEIXA
  // fazer, e a listagem é restringida pela RLS, não pelo papel. Em fila
  // custavam duas idas ao banco somadas; em paralelo, uma (D-195).
  //
  // O `as never` que morava aqui ficou obsoleto: `feature_suggestions`
  // entrou em `Database` quando os types foram regenerados (D-100).
  const [membership, suggestions] = await Promise.all([
    currentMembership(supabase),
    supabase
      .from("feature_suggestions")
      .select(
        "id, original_text, status, created_at, title, problem, objective, impacted_users, suggested_flow, expected_benefit, acceptance_criteria, dependencies_risks, complexity, profiles(full_name)",
      )
      .order("created_at", { ascending: false }),
  ]);

  const role = membership.role;
  const canManage = role === "ADMIN" || role === "GESTOR";
  const { data, error } = suggestions;

  const rows: SuggestionRowData[] = ((data ?? []) as unknown as SuggestionQueryRow[]).map((row) => ({
    id: row.id,
    originalText: row.original_text,
    status: row.status,
    createdAt: row.created_at,
    authorName: row.profiles?.full_name ?? null,
    structured: {
      title: row.title,
      problem: row.problem,
      objective: row.objective,
      impactedUsers: row.impacted_users,
      suggestedFlow: row.suggested_flow,
      expectedBenefit: row.expected_benefit,
      acceptanceCriteria: row.acceptance_criteria,
      dependenciesRisks: row.dependencies_risks,
      complexity: row.complexity,
    },
  }));

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Sugestões de Melhoria</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Envie ideias de melhoria em texto livre — o que você escreve fica preservado exatamente como foi escrito.{" "}
        {formatCount(rows.length)} sugestão(ões) registrada(s).
      </p>

      <NewSuggestionForm />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && rows.length === 0 && <p style={{ color: "var(--sb-text-soft)" }}>Nenhuma sugestão ainda.</p>}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "44rem" }}>
            <thead>
              <tr>
                <th style={th}>Sugestão</th>
                <th style={th}>Autor</th>
                <th style={th}>Data</th>
                <th style={th}>Status</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <SuggestionRow key={row.id} suggestion={row} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
