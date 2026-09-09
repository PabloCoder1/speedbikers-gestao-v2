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

export interface SuggestionData {
  id: string;
  originalText: string;
  status: string;
  createdAt: string;
  authorName: string | null;
  structured: StructuredFields;
}

/**
 * Os NOVE campos, contra os cinco que o frame desenha.
 *
 * Ele mostra Problema, Objetivo, Benefício, Critério de aceite e Dependências.
 * A tabela tem esses cinco **mais** título, usuários impactados, fluxo sugerido
 * e complexidade — e esconder quatro campos preenchidos por não estarem no
 * desenho seria jogar fora trabalho que a IA já fez.
 */
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
 * O detalhe de uma sugestão (D30, D-270) — o painel direito do frame
 * `CentralScreen` na variação de ideias.
 *
 * **Aqui o mestre-detalhe se justifica, e em `/notificacoes` não se justificava
 * (D-269).** Lá o painel repetia os três campos da linha; aqui há NOVE campos
 * estruturados que não cabem numa célula — a versão anterior os escondia num
 * `<details>` dentro da tabela, com um comentário que se desculpava ("para a
 * tabela não explodir").
 *
 * As duas escritas moram aqui porque são do objeto selecionado: mudar o status
 * (ADMIN/GESTOR) e estruturar com IA (D-112).
 */
export function SuggestionDetail({
  suggestion,
  canManage,
}: {
  suggestion: SuggestionData;
  canManage: boolean;
}): ReactNode {
  const router = useRouter();
  const [status, setStatus] = useState(suggestion.status);
  const [busy, setBusy] = useState(false);
  const [structuring, setStructuring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preenchidos = STRUCTURED_LABELS.filter(([key]) => suggestion.structured[key] !== null);

  /**
   * Estruturação por IA (D-112): chama a `api` diretamente, como o reply-form e
   * o diagnosis-panel — é ela quem tem a chave da Anthropic e grava `ai_runs`.
   * A persistência acontece lá, sob a RLS do chamador; aqui só se recarrega.
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
    <section className="sb-panel" aria-label="Detalhe da sugestão">
      <div className="sb-panel-head">
        <div style={{ minWidth: 0 }}>
          {/* O eyebrow do frame. Ele acerta o nome: os campos abaixo são
              estruturados pela IA a partir do texto livre (D-112). */}
          <span className="sb-eyebrow">SUGESTÃO ESTRUTURADA PELA IA</span>
          <h2>{suggestion.structured.title ?? "Sem título estruturado"}</h2>
          <p>
            {suggestion.authorName ?? "Autor desconhecido"} · {formatDateTime(suggestion.createdAt)}
          </p>
        </div>

        <div className="sb-panel-aside">
          {canManage ? (
            <select
              className="sb-input"
              value={status}
              disabled={busy}
              aria-label="Status da sugestão"
              onChange={(event) => {
                void handleStatusChange(event.target.value as SuggestionStatus);
              }}
              style={{
                padding: "0.25rem 0.5rem",
                borderRadius: "var(--sb-radius)",
                border: "1px solid var(--sb-border)",
                background: "transparent",
                color: "inherit",
                fontSize: "0.75rem",
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
        </div>
      </div>

      {/*
        O TEXTO ORIGINAL, que o frame não desenha e a tela não pode perder.
        A promessa desta página é que "o que você escreve fica preservado
        exatamente como foi escrito" — mostrar só a versão estruturada pela IA
        substituiria a palavra da pessoa pela da máquina.
      */}
      <div style={{ padding: "var(--sb-space-3) 1.25rem 0" }}>
        <span className="sb-eyebrow">COMO FOI ESCRITO</span>
        <p style={{ margin: "0.25rem 0 0", fontSize: "0.6875rem", whiteSpace: "pre-wrap" }}>
          {suggestion.originalText}
        </p>
      </div>

      {preenchidos.length === 0 ? (
        <p className="sb-empty">
          Ainda não estruturada. O texto acima é o que a pessoa escreveu; os nove campos aparecem depois de
          um ADMIN ou GESTOR pedir a estruturação.
        </p>
      ) : (
        <dl className="sb-fields">
          {preenchidos.map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{suggestion.structured[key]}</dd>
            </div>
          ))}
        </dl>
      )}

      {canManage && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", padding: "0 1.25rem var(--sb-space-3)" }}>
          <button className="sb-button" type="button" disabled={structuring} onClick={structure}>
            {structuring ? "Estruturando…" : preenchidos.length > 0 ? "Estruturar de novo" : "Estruturar com IA"}
          </button>
        </div>
      )}

      {error !== null && (
        <p role="alert" style={{ margin: "0 1.25rem var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}
    </section>
  );
}
