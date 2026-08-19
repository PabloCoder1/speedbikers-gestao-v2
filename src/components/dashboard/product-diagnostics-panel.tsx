"use client";

import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { Evidence } from "@/features/product-diagnostics/product-diagnostic-domain";
import type { ProductDiagnosticRunRecord } from "@/features/product-diagnostics/get-product-diagnostic-latest";
import type { ProductDiagnosticResult } from "@/features/product-diagnostics/product-diagnostic-schema";
import type { ProductDiagnosticResultV2 } from "@/features/product-diagnostics/product-diagnostic-schema-v2";
import { PRODUCT_DIAGNOSTIC_PROMPT_VERSION_V2 } from "@/features/product-diagnostics/product-diagnostic-prompt-v2";

const dateTimeFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" });

const CONFIDENCE_LABEL: Record<string, string> = { low: "Baixa", medium: "Media", high: "Alta" };
const CONFIDENCE_VARIANT: Record<string, "neutral" | "warning" | "success"> = { low: "neutral", medium: "warning", high: "success" };
const PRIORITY_VARIANT: Record<string, "danger" | "warning" | "neutral"> = { high: "danger", medium: "warning", low: "neutral" };
const MARKET_STATUS_LABEL: Record<string, string> = {
  winning: "Ganhando",
  sharing_first_place: "Empatado em 1º lugar",
  competing: "Perdendo",
  listed: "Listado, sem disputa clara",
  unknown: "Indeterminado",
  not_applicable: "Nao aplicavel",
};

const PHASE_LABEL: Record<string, string> = {
  evidence: "Analisando dados internos...",
  market_official: "Comparando com o mercado...",
  market_external: "Pesquisando o mercado externo...",
  vision: "Analisando o anuncio...",
  claude: "Consolidando diagnostico...",
  persist: "Consolidando diagnostico...",
};

type PollState =
  | { kind: "idle" }
  | { kind: "queued_or_running"; phase: string }
  | { kind: "anthropic_not_configured" }
  | { kind: "analysis_in_progress" }
  | { kind: "error"; message: string };

type DiagnosticView = {
  status: "succeeded" | "failed";
  model: string;
  promptVersion: string;
  evidenceHash: string;
  evidence: Evidence[];
  result: ProductDiagnosticResult | ProductDiagnosticResultV2 | null;
  errorMessage: string | null;
  createdAt: string;
};

function toView(record: ProductDiagnosticRunRecord): DiagnosticView {
  return {
    status: record.status,
    model: record.model,
    promptVersion: record.promptVersion,
    evidenceHash: record.evidenceHash,
    evidence: record.evidence,
    result: record.result,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
  };
}

function isV2Result(result: DiagnosticView["result"], promptVersion: string): result is ProductDiagnosticResultV2 {
  return result !== null && promptVersion === PRODUCT_DIAGNOSTIC_PROMPT_VERSION_V2;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="rounded-lg border border-gray-200 px-2.5 py-1 text-[11px] font-semibold text-gray-600 hover:bg-gray-50"
    >
      {copied ? "Copiado" : "Copiar sugestao"}
    </button>
  );
}

function scopeLabel(scope: ProductDiagnosticResultV2["actions"][number]["scope"]) {
  return scope.type === "listing" ? `${scope.accountCode.toUpperCase()} — ${scope.itemId}` : "Produto (todas as contas)";
}

function EvidenceList({ evidence }: { evidence: Evidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1.5">
      {evidence.map((item) => (
        <li key={item.id} className="text-xs leading-5 text-gray-700">
          {item.displayText}
        </li>
      ))}
    </ul>
  );
}

function ResultViewV2({ result, evidence }: { result: ProductDiagnosticResultV2; evidence: Evidence[] }) {
  const marketEvidence = evidence.filter((item) => item.id.startsWith("market."));

  return (
    <div className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Situacao</p>
        <p className="mt-1 text-sm text-gray-900">{result.context}</p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Causa principal</p>
          {result.primaryCause ? <Badge variant={CONFIDENCE_VARIANT[result.primaryCause.confidence]}>Confianca: {CONFIDENCE_LABEL[result.primaryCause.confidence]}</Badge> : null}
        </div>
        {result.primaryCause ? (
          <>
            <p className="mt-2 text-sm font-semibold text-gray-950">{result.primaryCause.title}</p>
            <p className="mt-1 text-sm text-gray-700">{result.primaryCause.explanation}</p>
          </>
        ) : (
          <p className="mt-2 text-sm text-gray-600">Os dados disponiveis ainda nao mostram uma causa principal confiavel.</p>
        )}
      </div>

      {result.marketAssessment.status !== "not_applicable" ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Competitividade</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant={result.marketAssessment.status === "winning" || result.marketAssessment.status === "sharing_first_place" ? "success" : "warning"}>
              {MARKET_STATUS_LABEL[result.marketAssessment.status] ?? result.marketAssessment.status}
            </Badge>
          </div>
          <p className="mt-2 text-sm text-gray-700">{result.marketAssessment.summary}</p>
          {marketEvidence.length > 0 ? <EvidenceList evidence={marketEvidence} /> : null}
        </div>
      ) : null}

      {result.actions.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">O que fazer agora</p>
          <ol className="mt-2 space-y-3">
            {result.actions.map((action, index) => (
              <li key={index} className="rounded-xl border border-gray-100 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={PRIORITY_VARIANT[action.priority] ?? "neutral"}>{index + 1}</Badge>
                  <p className="text-sm font-semibold text-gray-950">{action.title}</p>
                  <span className="text-[11px] text-gray-400">{scopeLabel(action.scope)}</span>
                </div>
                <p className="mt-1.5 text-sm text-gray-700">{action.instruction}</p>
                {action.suggestedValue ? (
                  <div className="mt-2 flex items-center gap-2">
                    <span className="rounded-lg bg-gray-100 px-2 py-1 text-xs font-medium text-gray-800">{action.suggestedValue}</span>
                    <CopyButton text={action.suggestedValue} />
                  </div>
                ) : null}
                <p className="mt-1.5 text-xs text-gray-500">{action.reason}</p>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {result.secondaryHypotheses.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Hipoteses secundarias</p>
          <ul className="mt-2 space-y-2">
            {result.secondaryHypotheses.map((hypothesis, index) => (
              <li key={index} className="text-sm text-gray-800">
                <span className="font-semibold">{hypothesis.title}.</span> {hypothesis.explanation}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ResultViewV1({ result }: { result: ProductDiagnosticResult }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={CONFIDENCE_VARIANT[result.confidence]}>Confianca: {CONFIDENCE_LABEL[result.confidence]}</Badge>
        <Badge variant="neutral">{result.verdict}</Badge>
      </div>
      <p className="mt-2 text-sm text-gray-800">{result.executiveSummary}</p>
      {result.recommendedActions.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {result.recommendedActions.map((action, index) => (
            <li key={index} className="text-sm text-gray-800">
              <span className="font-semibold">{action.title}.</span> {action.reason}
            </li>
          ))}
        </ul>
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
  const [state, setState] = useState<PollState>({ kind: "idle" });
  const [showEvidence, setShowEvidence] = useState(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (pollTimer.current) clearTimeout(pollTimer.current); }, []);

  function pollJob(jobId: string) {
    fetch(`/api/product-diagnostics/${productId}?jobId=${jobId}`)
      .then((response) => response.json())
      .then((body) => {
        if (body?.status === "queued" || body?.status === "running") {
          setState({ kind: "queued_or_running", phase: body.phase ?? "evidence" });
          pollTimer.current = setTimeout(() => pollJob(jobId), 3000);
          return;
        }
        if (body?.status === "failed") {
          setState({ kind: "error", message: "Nao foi possivel gerar o diagnostico agora." });
          return;
        }
        if (body?.status === "done" && body?.run) {
          setDiagnostic(toView(body.run));
          setStale(false);
          setState({ kind: "idle" });
          return;
        }
        setState({ kind: "error", message: "Resposta inesperada do servidor." });
      })
      .catch(() => {
        setState({ kind: "error", message: "Nao foi possivel acompanhar a analise." });
      });
  }

  async function runDiagnostic(force: boolean) {
    setState({ kind: "queued_or_running", phase: "evidence" });
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
      if (!response.ok || !body?.jobId) {
        setState({ kind: "error", message: "Nao foi possivel gerar o diagnostico agora." });
        return;
      }
      pollJob(body.jobId);
    } catch {
      setState({ kind: "error", message: "Nao foi possivel gerar o diagnostico agora." });
    }
  }

  const isLoading = state.kind === "queued_or_running";
  const primaryLabel = !diagnostic ? "Analisar produto" : stale ? "Reanalisar" : "Reanalisar mesmo assim";
  const v2 = diagnostic && isV2Result(diagnostic.result, diagnostic.promptVersion) ? (diagnostic.result as ProductDiagnosticResultV2) : null;
  const v1 = diagnostic && diagnostic.result && !v2 ? (diagnostic.result as ProductDiagnosticResult) : null;
  const limitations = v2?.limitations ?? v1?.limitations ?? [];

  return (
    <section id="diagnostico-inteligente" className="mt-8 scroll-mt-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-950">Diagnostico inteligente</h2>
          <p className="mt-1 text-xs text-gray-500">Use os dados atuais de vendas, preco, mercado e anuncio para investigar o desempenho deste produto.</p>
        </div>

        <div className="flex flex-col items-end gap-1">
          <button
            type="button"
            disabled={!canGenerate || isLoading}
            onClick={() => runDiagnostic(!stale && Boolean(diagnostic))}
            className="rounded-xl bg-gray-950 px-4 py-2.5 text-xs font-semibold text-white shadow-sm transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
          >
            {isLoading ? (PHASE_LABEL[state.kind === "queued_or_running" ? state.phase : "evidence"] ?? "Analisando...") : primaryLabel}
          </button>
          {!canGenerate ? <p className="text-[11px] text-gray-400">Apenas Admin, Gestor ou Analista podem gerar diagnosticos.</p> : null}
        </div>
      </div>

      <Card>
        {diagnostic ? (
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-gray-500">Analisado em {dateTimeFormatter.format(new Date(diagnostic.createdAt))} · modelo {diagnostic.model}</p>
            {diagnostic.status === "succeeded" ? (
              stale ? <Badge variant="warning">Os dados podem ter mudado desde esta analise</Badge> : <Badge variant="success">Analise atual</Badge>
            ) : (
              <Badge variant="danger">Falha na ultima analise</Badge>
            )}
          </CardHeader>
        ) : null}

        <CardContent>
          {state.kind === "anthropic_not_configured" ? (
            <p className="text-sm text-amber-700">Diagnostico inteligente ainda nao esta configurado.{canGenerate ? " Configure a integracao Anthropic no ambiente do servidor." : ""}</p>
          ) : state.kind === "analysis_in_progress" ? (
            <p className="text-sm text-amber-700">Uma analise ja esta em andamento para este produto. Atualize a pagina em instantes.</p>
          ) : state.kind === "error" ? (
            <p className="text-sm text-red-700">{state.message}</p>
          ) : null}

          {!diagnostic && state.kind === "idle" ? <p className="text-sm text-gray-500">Nenhuma analise gerada ainda.</p> : null}

          {diagnostic?.status === "failed" ? <p className="text-sm text-red-700">Nao foi possivel gerar o diagnostico agora.</p> : null}

          {v2 ? <ResultViewV2 result={v2} evidence={diagnostic!.evidence} /> : v1 ? <ResultViewV1 result={v1} /> : null}

          {diagnostic ? (
            <div className="mt-5 border-t border-gray-100 pt-4">
              <button type="button" onClick={() => setShowEvidence((value) => !value)} className="text-xs font-semibold text-gray-500 hover:text-gray-800">
                {showEvidence ? "Ocultar analise completa" : "Ver analise completa"}
              </button>
              {showEvidence ? (
                <div className="mt-3 space-y-4">
                  {limitations.length > 0 ? (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Limitacoes</p>
                      <ul className="mt-2 list-disc space-y-1 pl-4">
                        {limitations.map((limitation, index) => (
                          <li key={index} className="text-xs text-gray-600">{limitation}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">Fatos e evidencias</p>
                    <EvidenceList evidence={diagnostic.evidence} />
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
