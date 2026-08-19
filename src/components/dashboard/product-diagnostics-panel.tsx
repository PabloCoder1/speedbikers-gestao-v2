"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { Evidence } from "@/features/product-diagnostics/product-diagnostic-domain";
import type { ProductDiagnosticRunRecord } from "@/features/product-diagnostics/get-product-diagnostic-latest";
import type { ProductDiagnosticConfidence, ProductDiagnosticResult } from "@/features/product-diagnostics/product-diagnostic-schema";

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  dateStyle: "short",
  timeStyle: "short",
});

const CONFIDENCE_LABEL: Record<ProductDiagnosticConfidence, string> = {
  low: "Baixa",
  medium: "Media",
  high: "Alta",
};

const CONFIDENCE_VARIANT: Record<ProductDiagnosticConfidence, "neutral" | "warning" | "success"> = {
  low: "neutral",
  medium: "warning",
  high: "success",
};

const PRIORITY_VARIANT: Record<string, "danger" | "warning" | "neutral"> = {
  high: "danger",
  medium: "warning",
  low: "neutral",
};

type RunState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "anthropic_not_configured" }
  | { kind: "analysis_in_progress" }
  | { kind: "error"; message: string };

type DiagnosticView = {
  status: "succeeded" | "failed";
  model: string;
  evidenceHash: string;
  evidence: Evidence[];
  result: ProductDiagnosticResult | null;
  errorMessage: string | null;
  createdAt: string;
};

function toView(record: ProductDiagnosticRunRecord): DiagnosticView {
  return {
    status: record.status,
    model: record.model,
    evidenceHash: record.evidenceHash,
    evidence: record.evidence,
    result: record.result,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
  };
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Fatos observados</p>
      <ul className="mt-2 space-y-1.5">
        {evidence.map((item) => (
          <li key={item.id} className="text-xs leading-5 text-gray-700">
            {item.displayText}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultSections({ result }: { result: ProductDiagnosticResult }) {
  return (
    <div className="mt-5 space-y-5 border-t border-gray-100 pt-5">
      {result.correlations.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Correlacoes</p>
          <ul className="mt-2 space-y-2">
            {result.correlations.map((correlation, index) => (
              <li key={index} className="text-sm text-gray-800">
                {correlation.statement}
                {correlation.evidenceRefs.length > 0 ? (
                  <span className="ml-2 text-[11px] text-gray-400">[{correlation.evidenceRefs.join(", ")}]</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.hypotheses.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Hipoteses / causa provavel</p>
          <ul className="mt-2 space-y-3">
            {result.hypotheses.map((hypothesis, index) => (
              <li key={index} className="rounded-xl border border-gray-100 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold text-gray-950">{hypothesis.title}</p>
                  <Badge variant={CONFIDENCE_VARIANT[hypothesis.confidence]}>Confianca: {CONFIDENCE_LABEL[hypothesis.confidence]}</Badge>
                </div>
                <p className="mt-1.5 text-sm text-gray-700">{hypothesis.explanation}</p>
                {hypothesis.evidenceRefs.length > 0 ? (
                  <p className="mt-1.5 text-[11px] text-gray-500">Evidencias: {hypothesis.evidenceRefs.join(", ")}</p>
                ) : null}
                {hypothesis.counterEvidenceRefs.length > 0 ? (
                  <p className="mt-1 text-[11px] text-gray-500">Evidencias contrarias: {hypothesis.counterEvidenceRefs.join(", ")}</p>
                ) : null}
                {hypothesis.missingEvidence.length > 0 ? (
                  <p className="mt-1 text-[11px] text-amber-700">Faltaria confirmar: {hypothesis.missingEvidence.join(", ")}</p>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.recommendedActions.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Acoes recomendadas</p>
          <ul className="mt-2 space-y-2">
            {result.recommendedActions.map((action, index) => (
              <li key={index} className="flex items-start gap-2">
                <Badge variant={PRIORITY_VARIANT[action.priority] ?? "neutral"}>{action.priority}</Badge>
                <div>
                  <p className="text-sm font-medium text-gray-950">{action.title}</p>
                  <p className="text-xs text-gray-600">{action.reason}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {result.limitations.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Limitacoes</p>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            {result.limitations.map((limitation, index) => (
              <li key={index} className="text-xs text-gray-600">
                {limitation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function ProductDiagnosticsPanel({
  productId,
  canGenerate,
  initialDiagnostic,
  isStale,
}: {
  productId: string;
  canGenerate: boolean;
  initialDiagnostic: ProductDiagnosticRunRecord | null;
  isStale: boolean;
}) {
  const [diagnostic, setDiagnostic] = useState<DiagnosticView | null>(initialDiagnostic ? toView(initialDiagnostic) : null);
  const [stale, setStale] = useState(isStale);
  const [state, setState] = useState<RunState>({ kind: "idle" });

  async function runDiagnostic(force: boolean) {
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/product-diagnostics/${productId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const body = await response.json();

      if (response.status === 409 || body?.status === "analysis_in_progress") {
        setState({ kind: "analysis_in_progress" });
        return;
      }
      if (body?.status === "anthropic_not_configured") {
        setState({ kind: "anthropic_not_configured" });
        return;
      }
      if (!response.ok) {
        setState({ kind: "error", message: "Nao foi possivel gerar o diagnostico agora." });
        return;
      }
      if (body?.run) {
        setDiagnostic(toView(body.run));
        setStale(false);
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "error", message: "Resposta inesperada do servidor." });
    } catch {
      setState({ kind: "error", message: "Nao foi possivel gerar o diagnostico agora." });
    }
  }

  const isLoading = state.kind === "loading";
  const primaryLabel = !diagnostic ? "Analisar com Claude" : stale ? "Reanalisar" : "Reanalisar mesmo assim";

  return (
    <section className="mt-8">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-950">Diagnostico inteligente</h2>
          <p className="mt-1 text-xs text-gray-500">
            Use os dados atuais de vendas, preco, promocoes, estoque e Full para investigar o desempenho deste produto.
          </p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            disabled={!canGenerate || isLoading}
            onClick={() => runDiagnostic(!stale && Boolean(diagnostic))}
            className="rounded-xl bg-gray-950 px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {isLoading ? "Analisando..." : primaryLabel}
          </button>
          {!canGenerate ? (
            <p className="text-[11px] text-gray-400">Apenas Admin, Gestor ou Analista podem gerar diagnosticos.</p>
          ) : null}
        </div>
      </div>

      <Card>
        {diagnostic ? (
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-500">
              Analisado em {dateTimeFormatter.format(new Date(diagnostic.createdAt))} · modelo {diagnostic.model}
            </p>
            {diagnostic.status === "succeeded" ? (
              stale ? (
                <Badge variant="warning">Os dados mudaram desde esta analise</Badge>
              ) : (
                <Badge variant="success">Analise atual</Badge>
              )
            ) : (
              <Badge variant="danger">Falha na ultima analise</Badge>
            )}
          </CardHeader>
        ) : null}

        <CardContent>
          {state.kind === "anthropic_not_configured" ? (
            <p className="text-sm text-amber-700">
              Diagnostico inteligente ainda nao esta configurado.
              {canGenerate ? " Configure a integracao Anthropic no ambiente do servidor." : ""}
            </p>
          ) : state.kind === "analysis_in_progress" ? (
            <p className="text-sm text-amber-700">Uma analise ja esta em andamento para este produto. Atualize a pagina em instantes.</p>
          ) : state.kind === "error" ? (
            <p className="text-sm text-red-700">{state.message}</p>
          ) : null}

          {!diagnostic && state.kind !== "anthropic_not_configured" && state.kind !== "analysis_in_progress" && state.kind !== "error" ? (
            <p className="text-sm text-gray-500">Nenhuma analise gerada ainda.</p>
          ) : null}

          {diagnostic?.status === "failed" ? (
            <p className="text-sm text-red-700">Nao foi possivel gerar o diagnostico agora.</p>
          ) : null}

          {diagnostic?.result ? (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={CONFIDENCE_VARIANT[diagnostic.result.confidence]}>Confianca: {CONFIDENCE_LABEL[diagnostic.result.confidence]}</Badge>
                <Badge variant="neutral">{diagnostic.result.verdict}</Badge>
              </div>
              <p className="mt-2 text-sm text-gray-800">{diagnostic.result.executiveSummary}</p>
              <ResultSections result={diagnostic.result} />
            </div>
          ) : null}

          {diagnostic ? (
            <div className="mt-5 border-t border-gray-100 pt-5">
              <EvidenceList evidence={diagnostic.evidence} />
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
