"use client";

import type { ActionEvidenceView } from "@sb/domain";
import { useState, type ReactNode } from "react";

import Link from "next/link";

import { StatusPill } from "../../components/status-pill";
import type { ActionShortcut } from "../../lib/action-shortcuts";
import { formatCurrency } from "../../lib/format";
import { formatDecisionSnapshot, outcomeWindowLabel } from "../../lib/decision-format";
import { actionSeverityLabel, actionStatusLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/browser";
import { claimAction, dismissAction, registerDecision, resolveAction } from "./actions";

/**
 * Um cartão da Central de Ações, pelo frame `IntelligenceScreen type="actions"`
 * (D23, D-263). Era `action-row.tsx`, uma `<tr>` de oito colunas — o frame não
 * desenha tabela aqui, e o nome do arquivo acompanhou.
 *
 * Continua sendo componente cliente por item (estado local de "ocupado"/erro) e
 * Server Action por clique, como `vinculacoes/candidate-row.tsx`. **Nada de
 * funcionalidade saiu na migração**: as cinco escritas, a explicação sob
 * demanda e o histórico de decisões estão todos aqui. O Design Contract manda
 * remover conteúdo incompatível com o frame, não funcionalidade que o frame
 * simplesmente não desenhou.
 *
 * O cartão NÃO conhece o formato bruto de `actions.evidence`: recebe a visão já
 * normalizada por `describeActionEvidence`, total para qualquer `kind`.
 */

export interface OutcomeData {
  windowDays: number;
  outcomeSnapshot: Record<string, unknown>;
  measuredAt: string;
}

export interface DecisionData {
  id: string;
  decision: string;
  baselineSnapshot: Record<string, unknown>;
  createdAt: string;
  outcomes: OutcomeData[];
}

export interface ActionCardData {
  id: string;
  sku: string | null;
  title: string | null;
  mlbId: string | null;
  accountLabel: string | null;
  severity: string;
  confidence: string;
  estimated_impact_brl: number | null;
  evidence: ActionEvidenceView;
  recommendation: string;
  status: string;
  assignee_id: string | null;
  /** Já formatado no servidor: "há 12 min", ou a data absoluta se for velha. */
  age: string;
  decisions: DecisionData[];
  /** Atalhos operacionais (D-154), calculados no servidor — só telas que existem. */
  shortcuts: ActionShortcut[];
}

const buttonStyle: React.CSSProperties = {
  padding: "0.25rem 0.625rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  background: "transparent",
  fontSize: "0.75rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}

/**
 * A chave da Anthropic só existe em `apps/api` (Secret Manager, nunca na
 * Vercel) — por isso a explicação é um fetch client-side direto para a `api`,
 * mesmo padrão de `diagnosis-panel.tsx` (D-082): sessão do navegador,
 * `access_token` no header `Authorization`. Só o `actionId` viaja; a `api`
 * relê a ação sob a RLS do usuário e narra o que está no banco (D-155).
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

export function ActionCard({ action, userId }: { action: ActionCardData; userId: string }): ReactNode {
  const [status, setStatus] = useState(action.status);
  const [assigneeId, setAssigneeId] = useState(action.assignee_id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [explanation, setExplanation] = useState<string | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);

  async function handleExplain(): Promise<void> {
    setExplaining(true);
    setExplainError(null);

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setExplainError("Sua sessão expirou. Entre de novo.");
      setExplaining(false);

      return;
    }

    let response: Response;

    try {
      response = await fetch(`${API_URL}/v1/copilot/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ tool: "narrate_action", input: { actionId: action.id } }),
      });
    } catch {
      setExplainError("Não foi possível falar com o servidor. Tente de novo.");
      setExplaining(false);

      return;
    }

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? (payload as { error?: { message?: string } }).error?.message
          : undefined;

      setExplainError(message ?? "Não foi possível explicar a ação.");
      setExplaining(false);

      return;
    }

    const payload = (await response.json()) as { data: { narrativa: string } };

    setExplanation(payload.data.narrativa);
    setExplaining(false);
  }

  async function run(
    fn: () => Promise<{ ok: boolean; message: string | null }>,
    next: string,
    nextAssigneeId?: string,
  ): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await fn();

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    setStatus(next);
    if (nextAssigneeId !== undefined) setAssigneeId(nextAssigneeId);
    setBusy(false);
  }

  async function handleRegisterDecision(): Promise<void> {
    const decision = window.prompt("Qual foi a decisão para esta ação?");

    if (decision === null || decision.trim() === "") return;

    setBusy(true);
    setError(null);

    const result = await registerDecision(action.id, decision.trim());

    setBusy(false);

    if (!result.ok) {
      setError(result.message);
    }
  }

  // O identificador do frame é um chip só. A ação tem SKU **ou** MLB (no Dev,
  // 100% das abertas têm SKU e nenhuma tem MLB), então o chip mostra o que
  // existe e "—" quando nenhum dos dois existe — nunca um dos dois inventado.
  const referencia = action.sku ?? action.mlbId;

  const aberta = status === "novo" || status === "em_andamento";

  return (
    <article className="sb-action-card" data-tone={action.evidence.tone}>
      <StatusPill code={`severidade_${action.severity}`} label={actionSeverityLabel(action.severity)} />

      <div>
        <div className="sb-action-head">
          <h3>
            {action.evidence.kindLabel}
            {action.evidence.direcaoLabel !== null && ` · ${action.evidence.direcaoLabel}`}
          </h3>
          <span>{action.age}</span>
        </div>

        <div className="sb-action-meta">
          <span className="sb-action-ref">{referencia ?? "—"}</span>

          {action.title !== null && <span>{action.title}</span>}

          {/*
            "Impacto: R$ X" do frame. Só aparece QUANDO EXISTE: 63 das abertas
            do Dev têm `estimated_impact_brl` nulo, e impacto desconhecido não é
            impacto zero (D-067). O frame também esconde a célula quando o valor
            é "-", então aqui frame e regra concordam.
          */}
          {action.estimated_impact_brl !== null && (
            <span className="sb-divide">
              Impacto: <strong>{formatCurrency(action.estimated_impact_brl)}</strong>
            </span>
          )}

          <span className="sb-divide">
            Confiança {action.confidence === "alta" ? "alta" : "média"}
          </span>

          {/*
            O chip de conta do frame ("Speed Bikers"). `ml_account_id` é nulo em
            100% das abertas do Dev — a detecção de venda anômala trabalha por
            SKU, que atravessa contas —, então na prática ele quase nunca
            nasce. Fica porque a coluna existe e o seed prova o caminho.
          */}
          {action.accountLabel !== null && <span className="sb-divide">{action.accountLabel}</span>}

          {!aberta && <span className="sb-divide">{actionStatusLabel(status)}</span>}

          {assigneeId !== null && aberta && (
            <span className="sb-divide">{assigneeId === userId ? "Atribuída a você" : "Atribuída"}</span>
          )}
        </div>

        <p>{action.recommendation}</p>

        {action.evidence.evidencias.length > 0 && (
          <p className="sb-action-evidence">
            {action.evidence.evidencias.map((item) => item.descricao).join(" ")}
            {action.evidence.causas.length > 0 &&
              ` ${action.evidence.causas.map((cause) => cause.descricao).join(" ")}`}
          </p>
        )}

        {/*
          Atalhos operacionais (D-154): a recomendação deixou de mandar o
          operador procurar telas — os caminhos que EXISTEM estão a um clique.
        */}
        {action.shortcuts.length > 0 && (
          <div className="sb-action-links">
            {action.shortcuts.map((shortcut) => (
              <Link key={shortcut.href} href={shortcut.href}>
                {shortcut.label} →
              </Link>
            ))}
          </div>
        )}

        {aberta && (
          <div className="sb-action-buttons">
            {status === "novo" && (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void run(() => claimAction(action.id, userId), "em_andamento", userId);
                }}
                style={buttonStyle}
              >
                Assumir
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void run(() => resolveAction(action.id), "resolvido");
              }}
              style={buttonStyle}
            >
              Resolver
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void run(() => dismissAction(action.id), "descartado");
              }}
              style={buttonStyle}
            >
              Descartar
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void handleRegisterDecision();
              }}
              style={buttonStyle}
            >
              Registrar decisão
            </button>
            {/*
              IA explicando a AÇÃO (D-155) — nunca no carregamento da página
              (docs/COPILOT.md secao 9), só em clique.
            */}
            <button
              type="button"
              disabled={explaining}
              onClick={() => {
                void handleExplain();
              }}
              style={buttonStyle}
            >
              {explaining ? "Explicando…" : "Explicar com IA"}
            </button>
          </div>
        )}

        {explainError !== null && (
          <p role="alert" style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
            {explainError}
          </p>
        )}

        {error !== null && (
          <p role="alert" style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "var(--sb-danger)" }}>
            {error}
          </p>
        )}

        {explanation !== null && (
          <div
            style={{
              marginTop: "0.5rem",
              padding: "0.625rem",
              borderRadius: "var(--sb-radius-md)",
              background: "var(--sb-bg-soft)",
              fontSize: "0.6875rem",
            }}
          >
            <strong>Explicação (IA):</strong>
            {/* As cinco seções chegam separadas por quebra de linha — pre-line as preserva. */}
            <div style={{ whiteSpace: "pre-line", marginTop: "0.25rem", fontStyle: "italic" }}>
              {explanation}
            </div>
          </div>
        )}

        {action.decisions.length > 0 && (
          <div
            style={{
              marginTop: "0.5rem",
              padding: "0.625rem",
              borderRadius: "var(--sb-radius-md)",
              background: "var(--sb-bg-soft)",
              fontSize: "0.6875rem",
            }}
          >
            {action.decisions.map((decision) => (
              <div key={decision.id} style={{ marginBottom: "0.5rem" }}>
                <div>
                  <strong>Decisão ({formatDate(decision.createdAt)}):</strong> {decision.decision}
                </div>
                <div style={{ color: "var(--sb-text-soft)", marginTop: "0.125rem" }}>
                  No momento da decisão — {formatDecisionSnapshot(decision.baselineSnapshot)}
                </div>
                {decision.outcomes.map((outcome) => (
                  <div key={outcome.windowDays} style={{ color: "var(--sb-text-soft)", marginTop: "0.125rem" }}>
                    {outcomeWindowLabel(outcome.windowDays)} ({formatDate(outcome.measuredAt)}) —{" "}
                    {formatDecisionSnapshot(outcome.outcomeSnapshot)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
