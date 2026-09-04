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
 *
 * ## Composição (auditoria de fidelidade, P0)
 *
 * Era um `<button>` com estilo próprio solto sobre o corpo cinza do cartão de
 * entidade, e o resultado um cartão desenhado à mão — a aplicação antiga
 * intacta dentro da moldura nova. O frame do SKU não desenha esta aba
 * ("Conteúdo da aba em construção"), então vale o design system: um painel
 * com título e ressalva no cabeçalho, a ação como `.sb-button` no canto do
 * painel, e o resultado como `.sb-stat`s + lista dentro do corpo. O painel é
 * markup, não componente: `Panel` é Server Component e este arquivo é
 * cliente — as classes são as mesmas, então a forma é uma só.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

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

  const anomalia = result !== null && result.ok && result.status === "anomaly" ? result.diagnosis : null;

  return (
    <section className="sb-panel" aria-label="Diagnóstico de venda">
      <div className="sb-panel-head">
        <div style={{ minWidth: 0 }}>
          <h2>Diagnóstico de venda</h2>
          <p>
            Compara a venda de ontem com o mesmo dia da semana nas últimas semanas (D-078). Nada é calculado até
            você pedir.
          </p>
        </div>
        <button
          type="button"
          className="sb-button sb-button-primary"
          disabled={busy}
          onClick={() => {
            void handleClick();
          }}
        >
          {busy ? "Analisando…" : "O que aconteceu?"}
        </button>
      </div>

      {result === null && (
        <p className="sb-empty">Clique em “O que aconteceu?” para comparar a venda de ontem com o padrão do dia.</p>
      )}

      {result !== null && !result.ok && (
        <p role="alert" className="sb-panel-body" style={{ color: "var(--sb-danger)" }}>
          {result.message}
        </p>
      )}

      {result !== null && result.ok && result.status === "insufficient_sample" && (
        <p className="sb-empty">
          Histórico insuficiente para comparar — menos de 4 ocorrências do mesmo dia da semana com venda calculada.
        </p>
      )}

      {result !== null && result.ok && result.status === "no_anomaly" && (
        <p className="sb-empty">
          Venda de ontem dentro do padrão esperado para o mesmo dia da semana — nenhuma anomalia detectada.
        </p>
      )}

      {result !== null && result.ok && anomalia !== null && (
        <div className="sb-panel-body" style={{ display: "grid", gap: "var(--sb-space-3)" }}>
          {/*
            Os dois números do diagnóstico como cartões de indicador, com o tom
            do veredito na borda — o mesmo gesto do cartão Cobertura da Visão
            geral. Queda é perigo; alta é ok.
          */}
          <div className="sb-stat-grid">
            <div
              className="sb-stat"
              style={{
                ["--sb-tone" as string]: anomalia.direcao === "queda" ? "var(--sb-danger)" : "var(--sb-success)",
                ["--sb-tone-ink" as string]: anomalia.direcao === "queda" ? "var(--sb-danger-ink)" : "var(--sb-success)",
              }}
            >
              <span className="sb-stat-label">Veredito</span>
              <b className="sb-stat-value">{anomalia.direcao === "queda" ? "Queda" : "Alta"} de venda</b>
              <span className="sb-stat-note">confiança {anomalia.confianca === "alta" ? "alta" : "média"}</span>
            </div>

            <div className="sb-stat">
              <span className="sb-stat-label">Impacto estimado</span>
              <b className="sb-stat-value">{result.impactBrl === null ? "—" : formatCurrency(result.impactBrl)}</b>
              <span className="sb-stat-note">
                {result.impactBrl === null ? "sem preço médio para estimar" : "diferença × preço médio praticado"}
              </span>
            </div>
          </div>

          <div>
            <div className="sb-section-label" style={{ marginTop: 0 }}>
              <span>Evidências</span>
            </div>
            <ul style={{ margin: 0, paddingLeft: "1.125rem", fontSize: "0.6875rem", display: "grid", gap: "0.25rem" }}>
              {anomalia.evidencias.map((evidence, index) => (
                <li key={`${evidence.tipo}-${String(index)}`}>{evidence.descricao}</li>
              ))}
            </ul>
          </div>

          <div style={{ fontSize: "0.6875rem", display: "grid", gap: "0.375rem" }}>
            <p style={{ margin: 0 }}>
              <strong>Causa candidata:</strong>{" "}
              {anomalia.causasCandidatas.length === 0
                ? "nenhum evento correlato encontrado"
                : anomalia.causasCandidatas.map((cause) => cause.descricao).join(" ")}
            </p>
            <p style={{ margin: 0 }}>
              <strong>Próximos passos:</strong> {anomalia.proximosPassos.join(" ")}
            </p>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "var(--sb-space-2)", flexWrap: "wrap" }}>
            <button
              type="button"
              className="sb-button"
              disabled={narrating}
              onClick={() => {
                void handleNarrate(anomalia, result.impactBrl);
              }}
            >
              {narrating ? "Narrando…" : "Narrar com IA"}
            </button>

            {narrationError !== null && (
              <span role="alert" style={{ fontSize: "0.6875rem", color: "var(--sb-danger)" }}>
                {narrationError}
              </span>
            )}
          </div>

          {narrativa !== null && (
            <p style={{ margin: 0, fontSize: "0.75rem", fontStyle: "italic", color: "var(--sb-text)" }}>{narrativa}</p>
          )}
        </div>
      )}
    </section>
  );
}
