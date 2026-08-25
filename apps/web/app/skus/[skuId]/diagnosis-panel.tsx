"use client";

import { useState, type ReactNode } from "react";

import { formatCurrency } from "../../../lib/format";
import { diagnoseSku, type SkuDiagnosisResult } from "./actions";

/**
 * Ação contextual "O que aconteceu?" (Fase 7, item 8, D-078) — botão +
 * card de resultado no Dashboard de SKU. Mesmo padrão de componente
 * cliente por ação de `apps/web/app/acoes/action-row.tsx`: estado local,
 * Server Action por clique, sem RPC direto do cliente.
 */

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

  async function handleClick(): Promise<void> {
    setBusy(true);

    const outcome = await diagnoseSku(skuId);

    setBusy(false);
    setResult(outcome);
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
        </div>
      )}
    </div>
  );
}
