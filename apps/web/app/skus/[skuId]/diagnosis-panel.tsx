"use client";

import type { SalesAnomalyDiagnosis } from "@sb/domain";
import { useState, type ReactNode } from "react";

import { formatCurrency } from "../../../lib/format";
import { createClient } from "../../../lib/supabase/browser";
import { diagnoseSku, type SkuDiagnosisResult } from "./actions";

/**
 * Ação contextual "O que aconteceu?" (Fase 7, item 8, D-078) — botão +
 * card de resultado no Dashboard de SKU. Mesmo padrão de componente
 * cliente por ação de `apps/web/app/acoes/action-row.tsx`: estado local,
 * Server Action por clique, sem RPC direto do cliente.
 *
 * **Narração por IA (D-082)**: opcional, só aparece quando há anomalia.
 * Diferente do diagnóstico em si (Server Action, lê sob RLS local), a
 * narração precisa da chave da Anthropic — que só existe em `apps/api`
 * (Secret Manager, nunca na Vercel). Por isso é um fetch client-side
 * direto para a `api`, mesmo padrão já usado por
 * `apps/web/app/notas-fiscais/[id]/confirm-apply-form.tsx`: sessão do
 * navegador, `access_token` da sessão Supabase repassado no header
 * `Authorization`. O diagnóstico já calculado (D-078) é o que vai no
 * corpo do pedido — a `api` revalida que o usuário alcança o SKU antes
 * de narrar, mas não recalcula o diagnóstico (evita duplicar a agregação
 * pesada de `get_sku_sales_baseline`/`domain_events`).
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

const buttonStyle: React.CSSProperties = {
  padding: "0.375rem 0.875rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  background: "transparent",
  fontSize: "0.8125rem",
  cursor: "pointer",
};

const cardStyle: React.CSSProperties = {
  marginTop: "var(--sb-space-2)",
  padding: "var(--sb-space-3)",
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  fontSize: "0.875rem",
  display: "grid",
  gap: "0.375rem",
  maxWidth: "36rem",
};

export function DiagnosisPanel({ skuId }: { skuId: string }): ReactNode {
  const [result, setResult] = useState<SkuDiagnosisResult | null>(null);
  const [busy, setBusy] = useState(false);

  const [narrativa, setNarrativa] = useState<string | null>(null);
  const [narrating, setNarrating] = useState(false);
  const [narrationError, setNarrationError] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    setBusy(true);
    setNarrativa(null);
    setNarrationError(null);

    const outcome = await diagnoseSku(skuId);

    setBusy(false);
    setResult(outcome);
  }

  async function handleNarrate(diagnosis: SalesAnomalyDiagnosis, impactBrl: number | null): Promise<void> {
    setNarrating(true);
    setNarrationError(null);

    const supabase = createClient();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;

    if (token === undefined) {
      setNarrationError("Sua sessão expirou. Entre de novo.");
      setNarrating(false);

      return;
    }

    let response: Response;

    try {
      response = await fetch(`${API_URL}/v1/copilot/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          tool: "narrate_sku_diagnosis",
          input: { diagnosis, impactBrl },
        }),
      });
    } catch {
      setNarrationError("Não foi possível falar com o servidor. Tente de novo.");
      setNarrating(false);

      return;
    }

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      const message =
        typeof payload === "object" && payload !== null && "error" in payload
          ? (payload as { error?: { message?: string } }).error?.message
          : undefined;

      setNarrationError(message ?? "Não foi possível narrar o diagnóstico.");
      setNarrating(false);

      return;
    }

    const payload = (await response.json()) as { data: { narrativa: string } };

    setNarrativa(payload.data.narrativa);
    setNarrating(false);
  }

  return (
    <div style={{ marginBottom: "var(--sb-space-4)" }}>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void handleClick();
        }}
        style={buttonStyle}
      >
        {busy ? "Analisando…" : "O que aconteceu?"}
      </button>

      {result !== null && !result.ok && (
        <p role="alert" style={{ marginTop: "var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-danger)" }}>
          {result.message}
        </p>
      )}

      {result !== null && result.ok && result.status === "insufficient_sample" && (
        <p style={{ marginTop: "var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          Histórico insuficiente para comparar — menos de 4 ocorrências do mesmo dia da semana com venda calculada.
        </p>
      )}

      {result !== null && result.ok && result.status === "no_anomaly" && (
        <p style={{ marginTop: "var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          Venda de ontem dentro do padrão esperado para o mesmo dia da semana — nenhuma anomalia detectada.
        </p>
      )}

      {result !== null && result.ok && result.status === "anomaly" && result.diagnosis !== null && (
        <div style={{ ...cardStyle, background: result.diagnosis.direcao === "queda" ? "#fdeaea" : "#e6f4ea" }}>
          <div style={{ fontWeight: 700 }}>
            {result.diagnosis.direcao === "queda" ? "Queda" : "Alta"} de venda — confiança{" "}
            {result.diagnosis.confianca === "alta" ? "alta" : "média"}
          </div>

          {result.diagnosis.evidencias.map((evidence, index) => (
            <div key={`${evidence.tipo}-${String(index)}`}>{evidence.descricao}</div>
          ))}

          {result.impactBrl !== null && <div>Impacto estimado: {formatCurrency(result.impactBrl)}</div>}

          <div>
            <strong>Causa candidata:</strong>{" "}
            {result.diagnosis.causasCandidatas.length === 0
              ? "nenhum evento correlato encontrado"
              : result.diagnosis.causasCandidatas.map((cause) => cause.descricao).join(" ")}
          </div>

          <div>
            <strong>Próximos passos:</strong> {result.diagnosis.proximosPassos.join(" ")}
          </div>

          <div style={{ marginTop: "var(--sb-space-2)" }}>
            <button
              type="button"
              disabled={narrating}
              onClick={() => {
                if (result.diagnosis !== null) {
                  void handleNarrate(result.diagnosis, result.impactBrl);
                }
              }}
              style={buttonStyle}
            >
              {narrating ? "Narrando…" : "Narrar com IA"}
            </button>

            {narrationError !== null && (
              <p role="alert" style={{ marginTop: "var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-danger)" }}>
                {narrationError}
              </p>
            )}

            {narrativa !== null && (
              <p style={{ marginTop: "var(--sb-space-2)", fontSize: "0.875rem", fontStyle: "italic" }}>{narrativa}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
