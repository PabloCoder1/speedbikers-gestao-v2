"use client";

import type { ActionEvidenceView } from "@sb/domain";
import { useState, type ReactNode } from "react";

import Link from "next/link";

import type { ActionShortcut } from "../../lib/action-shortcuts";
import { formatCurrency } from "../../lib/format";
import { formatDecisionSnapshot, outcomeWindowLabel } from "../../lib/decision-format";
import { actionStatusLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/browser";
import { claimAction, dismissAction, registerDecision, resolveAction } from "./actions";

/**
 * Uma linha da Central de Ações (Fase 6, D-064) — mesmo padrão de
 * `apps/web/app/vinculacoes/candidate-row.tsx`: componente cliente por linha
 * (estado local de "ocupado"/erro), Server Action por clique.
 *
 * A linha NÃO conhece o formato bruto de `actions.evidence`: ela recebe a
 * visão já normalizada por `describeActionEvidence`, que é total para
 * qualquer `kind`. Antes daqui a tela lia a forma de `venda_anomala` como se
 * fosse a única existente.
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

export interface ActionRowData {
  id: string;
  sku: string | null;
  title: string | null;
  severity: string;
  confidence: string;
  estimated_impact_brl: number | null;
  evidence: ActionEvidenceView;
  recommendation: string;
  status: string;
  assignee_id: string | null;
  decisions: DecisionData[];
  /** Atalhos operacionais (D-154), calculados no servidor — só telas que existem. */
  shortcuts: ActionShortcut[];
}

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.25rem 0.625rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  background: "transparent",
  fontSize: "0.75rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/**
 * Fundo por tom, não por direção: uma ação sem direção (padrão de
 * reclamações, D-116) caía no `else` e ficava VERDE, lendo como oportunidade.
 */
const TONE_BACKGROUND: Readonly<Record<string, string | undefined>> = {
  problema: "var(--sb-danger-soft)",
  oportunidade: "var(--sb-success-soft)",
  neutro: undefined,
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

export function ActionRow({ action, userId }: { action: ActionRowData; userId: string }): ReactNode {
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

  return (
    <>
    <tr style={{ background: TONE_BACKGROUND[action.evidence.tone] }}>
      <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
        {action.sku ?? "—"}
        {action.title !== null && (
          <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
            {action.title}
          </div>
        )}
      </td>
      <td style={td}>
        {action.evidence.kindLabel}
        {action.evidence.direcaoLabel !== null && (
          <div style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>{action.evidence.direcaoLabel}</div>
        )}
      </td>
      <td style={td}>{action.confidence === "alta" ? "Alta" : "Média"}</td>
      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {formatCurrency(action.estimated_impact_brl)}
      </td>
      <td style={td}>
        {action.evidence.evidencias.map((item) => item.descricao).join(" ")}
        {action.evidence.causas.length > 0 && (
          <div style={{ marginTop: "0.25rem", color: "var(--sb-text-soft)" }}>
            {action.evidence.causas.map((cause) => cause.descricao).join(" ")}
          </div>
        )}
      </td>
      <td style={td}>
        {action.recommendation}
        {/*
          Atalhos operacionais (D-154): a recomendação deixou de mandar o
          operador procurar telas — os caminhos que EXISTEM estão a um
          clique, embaixo dela.
        */}
        {action.shortcuts.length > 0 && (
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.375rem" }}>
            {action.shortcuts.map((shortcut) => (
              <Link key={shortcut.href} href={shortcut.href} style={{ fontSize: "0.75rem", whiteSpace: "nowrap" }}>
                {shortcut.label} →
              </Link>
            ))}
          </div>
        )}
      </td>
      <td style={td}>
        {actionStatusLabel(status)}
        {assigneeId !== null && (
          <div style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
            {assigneeId === userId ? "Atribuído a você" : "Atribuído"}
          </div>
        )}
      </td>
      <td style={td}>
        {(status === "novo" || status === "em_andamento") && (
          <div style={{ display: "flex", gap: "0.375rem", flexWrap: "wrap" }}>
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
              IA explicando a AÇÃO (D-155, último item da Fase 6B) — nunca no
              carregamento da página (docs/COPILOT.md secao 9), só em clique.
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
      </td>
    </tr>

    {explanation !== null && (
      <tr style={{ background: "var(--sb-bg-soft)" }}>
        <td colSpan={8} style={{ ...td, fontSize: "0.8125rem" }}>
          <strong>Explicação (IA):</strong>
          {/* As cinco seções chegam separadas por quebra de linha — pre-line as preserva. */}
          <div style={{ whiteSpace: "pre-line", marginTop: "0.25rem", fontStyle: "italic" }}>{explanation}</div>
        </td>
      </tr>
    )}

    {action.decisions.length > 0 && (
      <tr style={{ background: "var(--sb-bg-soft)" }}>
        <td colSpan={8} style={{ ...td, fontSize: "0.8125rem" }}>
          {action.decisions.map((decision) => (
            <div key={decision.id} style={{ marginBottom: "0.5rem" }}>
              <div>
                <strong>Decisão ({formatDate(decision.createdAt)}):</strong> {decision.decision}
              </div>
              <div style={{ color: "var(--sb-text-soft)", marginTop: "0.125rem" }}>
                No momento da decisão — {formatDecisionSnapshot(decision.baselineSnapshot)}
              </div>
              {decision.outcomes.map((outcome) => (
                <div
                  key={outcome.windowDays}
                  style={{ color: "var(--sb-text-soft)", marginTop: "0.125rem" }}
                >
                  {outcomeWindowLabel(outcome.windowDays)} ({formatDate(outcome.measuredAt)}) —{" "}
                  {formatDecisionSnapshot(outcome.outcomeSnapshot)}
                </div>
              ))}
            </div>
          ))}
        </td>
      </tr>
    )}
    </>
  );
}
