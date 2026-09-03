"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { StatusPill } from "../../components/status-pill";
import { formatDateTime } from "../../lib/format";
import { featureSuggestionStatusLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/browser";
import { updateSuggestionStatus } from "./actions";
import { SUGGESTION_STATUS_VALUES, type SuggestionStatus } from "./constants";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export interface StructuredFields {
  title: string | null;
  problem: string | null;
  objective: string | null;
  impactedUsers: string | null;
  suggestedFlow: string | null;
  expectedBenefit: string | null;
  acceptanceCriteria: string | null;
  dependenciesRisks: string | null;
  complexity: string | null;
}

const STRUCTURED_LABELS: readonly [keyof StructuredFields, string][] = [
  ["title", "Título"],
  ["problem", "Problema"],
  ["objective", "Objetivo"],
  ["impactedUsers", "Usuários impactados"],
  ["suggestedFlow", "Fluxo sugerido"],
  ["expectedBenefit", "Benefício esperado"],
  ["acceptanceCriteria", "Critérios de aceite"],
  ["dependenciesRisks", "Dependências/riscos"],
  ["complexity", "Complexidade"],
];

/**
 * Uma sugestão na Central (Fase 7, item 9, D-079) — mesmo padrão de
 * `apps/web/app/acoes/action-row.tsx`: componente cliente por linha
 * (estado local de ocupado/erro), Server Action por clique, sem RPC.
 */

export interface SuggestionRowData {
  id: string;
  originalText: string;
  status: string;
  createdAt: string;
  authorName: string | null;
  structured: StructuredFields;
}

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

export function SuggestionRow({
  suggestion,
  canManage,
}: {
  suggestion: SuggestionRowData;
  canManage: boolean;
}): ReactNode {
  const router = useRouter();
  const [status, setStatus] = useState(suggestion.status);
  const [busy, setBusy] = useState(false);
  const [structuring, setStructuring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasStructured = STRUCTURED_LABELS.some(([key]) => suggestion.structured[key] !== null);

  /**
   * Estruturação por IA (D-112): chama a `api` diretamente, como o
   * reply-form e o diagnosis-panel — é ela quem tem a chave da Anthropic e
   * grava `ai_runs`. A persistência dos campos acontece lá, sob a RLS do
   * chamador; aqui só se recarrega a lista.
   */
  function structure(): void {
    setStructuring(true);
    setError(null);

    void (async () => {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (token === undefined) {
        setError("Sessão expirada — atualize a página.");
        setStructuring(false);

        return;
      }

      try {
        const response = await fetch(`${API_URL}/v1/copilot/query`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({
            tool: "structure_feature_suggestion",
            input: { suggestionId: suggestion.id },
          }),
        });

        const body = (await response.json()) as { error?: { message?: string } };

        if (!response.ok) {
          setError(body.error?.message ?? "Não foi possível estruturar a sugestão.");

          return;
        }

        router.refresh();
      } catch {
        setError("Falha de conexão ao estruturar.");
      } finally {
        setStructuring(false);
      }
    })();
  }

  async function handleStatusChange(next: SuggestionStatus): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await updateSuggestionStatus(suggestion.id, next);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setStatus(next);
  }

  return (
    <tr>
      <td style={{ ...td, whiteSpace: "pre-wrap", maxWidth: "28rem" }}>
        {suggestion.originalText}

        {hasStructured && (
          // O texto original fica SEMPRE visível acima (requisito: preservado
          // íntegro); a versão estruturada é complemento, atrás de um
          // <details> para a tabela não explodir.
          <details style={{ marginTop: "0.5rem" }}>
            <summary style={{ cursor: "pointer", fontSize: "0.8125rem", color: "var(--sb-secondary)" }}>
              Versão estruturada pela IA
            </summary>
            <dl style={{ margin: "0.5rem 0 0", fontSize: "0.8125rem", display: "grid", gap: "0.375rem" }}>
              {STRUCTURED_LABELS.map(([key, label]) => {
                const value = suggestion.structured[key];

                if (value === null) {
                  return null;
                }

                return (
                  <div key={key}>
                    <dt style={{ fontWeight: 600, display: "inline" }}>{label}: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>{value}</dd>
                  </div>
                );
              })}
            </dl>
          </details>
        )}

        {canManage && (
          <div style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              disabled={structuring}
              onClick={structure}
              style={{
                border: "1px solid var(--sb-border)",
                borderRadius: "var(--sb-radius)",
                background: "var(--sb-surface)",
                padding: "0.25rem 0.625rem",
                fontSize: "0.75rem",
                cursor: structuring ? "default" : "pointer",
              }}
            >
              {structuring ? "Estruturando…" : hasStructured ? "Estruturar de novo" : "Estruturar com IA"}
            </button>
          </div>
        )}
      </td>
      <td style={td}>{suggestion.authorName ?? "—"}</td>
      <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(suggestion.createdAt)}</td>
      <td style={td}>
        {canManage ? (
          <select
            value={status}
            disabled={busy}
            onChange={(event) => {
              void handleStatusChange(event.target.value as SuggestionStatus);
            }}
            style={{
              padding: "0.25rem 0.5rem",
              borderRadius: "var(--sb-radius)",
              border: "1px solid var(--sb-border)",
              background: "transparent",
              color: "inherit",
              fontSize: "0.8125rem",
            }}
          >
            {SUGGESTION_STATUS_VALUES.map((option) => (
              <option key={option} value={option}>
                {featureSuggestionStatusLabel(option)}
              </option>
            ))}
          </select>
        ) : (
          <StatusPill code={status} label={featureSuggestionStatusLabel(status)} />
        )}

        {error !== null && (
          <p role="alert" style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
            {error}
          </p>
        )}
      </td>
    </tr>
  );
}
