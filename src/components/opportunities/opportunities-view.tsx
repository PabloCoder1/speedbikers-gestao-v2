"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { PageHeader } from "@/components/ui/page-header";
import type { ProductOpportunityRow } from "@/features/opportunities/get-product-opportunities-page";
import type { ProductOpportunitiesSummary } from "@/features/opportunities/get-product-opportunities-summary";
import {
  OPPORTUNITY_PRIORITIES,
  OPPORTUNITY_PRIORITY_LABEL,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_STATUS_LABEL,
  OPPORTUNITY_TYPES,
  OPPORTUNITY_TYPE_LABEL,
  type OpportunityPriority,
  type OpportunityStatus,
  type OpportunityType,
} from "@/features/opportunities/opportunity-domain";
import type { OrganizationAiSettings } from "@/features/opportunities/organization-ai-settings";

const PRIORITY_BADGE_VARIANT: Record<OpportunityPriority, "danger" | "warning" | "info" | "neutral"> = {
  critical: "danger",
  high: "warning",
  medium: "info",
  low: "neutral",
};

const dateFormatter = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short" });

type Filters = { status: OpportunityStatus; priority: OpportunityPriority | null; type: OpportunityType | null; search: string };

function OpportunityCard({
  opportunity,
  canSnooze,
  canDismissOrAnalyze,
  onSnooze,
  onDismiss,
  onAnalyze,
  actionState,
}: {
  opportunity: ProductOpportunityRow;
  canSnooze: boolean;
  canDismissOrAnalyze: boolean;
  onSnooze: (id: string, days: number) => void;
  onDismiss: (id: string) => void;
  onAnalyze: (id: string) => void;
  actionState: string | undefined;
}) {
  const isAnalyzing = actionState === "analyzing";
  return (
    <Card>
      <CardContent className="space-y-3 p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={PRIORITY_BADGE_VARIANT[opportunity.priority]}>{OPPORTUNITY_PRIORITY_LABEL[opportunity.priority]}</Badge>
              <span className="text-xs text-gray-400">{OPPORTUNITY_TYPE_LABEL[opportunity.opportunityType]}</span>
            </div>
            <p className="mt-1.5 text-sm font-semibold text-gray-950">{opportunity.title}</p>
            <p className="text-xs text-gray-500">
              {opportunity.sku} — {opportunity.productName ?? "Produto sem nome"}
              {opportunity.accountDisplayName ? ` · ${opportunity.accountDisplayName}` : ""}
              {opportunity.itemId ? ` · ${opportunity.itemId}` : ""}
            </p>
          </div>
          <p className="text-[11px] text-gray-400">Visto em {dateFormatter.format(new Date(opportunity.lastSeenAt))}</p>
        </div>

        <p className="text-sm text-gray-700">{opportunity.summary}</p>

        {opportunity.primaryActionText ? (
          <div className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-700">
            <span className="font-semibold">Acao principal: </span>
            {opportunity.primaryActionText}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          <Link href={`/produto/${opportunity.productId}#diagnostico-inteligente`} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-semibold text-gray-700 hover:bg-gray-50">
            Ver produto
          </Link>
          {canDismissOrAnalyze ? (
            <button
              type="button"
              disabled={isAnalyzing}
              onClick={() => onAnalyze(opportunity.id)}
              className="rounded-lg bg-gray-950 px-3 py-1.5 text-xs font-semibold text-white hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              {isAnalyzing ? "Analisando..." : opportunity.latestDiagnosticRunId ? "Reanalisar" : "Analisar com Claude"}
            </button>
          ) : null}
          {canSnooze ? (
            <>
              <button type="button" onClick={() => onSnooze(opportunity.id, 1)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                Adiar 1d
              </button>
              <button type="button" onClick={() => onSnooze(opportunity.id, 3)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                Adiar 3d
              </button>
              <button type="button" onClick={() => onSnooze(opportunity.id, 7)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
                Adiar 7d
              </button>
            </>
          ) : null}
          {canDismissOrAnalyze ? (
            <button type="button" onClick={() => onDismiss(opportunity.id)} className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">
              Dispensar
            </button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function OpportunitiesView({
  canSnooze,
  canDismissOrAnalyze,
  canConfigureAutoClaude,
  initialSummary,
  initialOpportunities,
  initialAiSettings,
}: {
  canSnooze: boolean;
  canDismissOrAnalyze: boolean;
  canConfigureAutoClaude: boolean;
  initialSummary: ProductOpportunitiesSummary | null;
  initialOpportunities: ProductOpportunityRow[];
  initialAiSettings: OrganizationAiSettings | null;
}) {
  const [opportunities, setOpportunities] = useState(initialOpportunities);
  const [summary] = useState(initialSummary);
  const [filters, setFilters] = useState<Filters>({ status: "open", priority: null, type: null, search: "" });
  const [loading, setLoading] = useState(false);
  const [actionState, setActionState] = useState<Record<string, string>>({});
  const [aiSettings, setAiSettings] = useState(initialAiSettings);
  const [savingSettings, setSavingSettings] = useState(false);

  async function reload(next: Filters) {
    setLoading(true);
    try {
      const query = new URLSearchParams();
      query.set("status", next.status);
      if (next.priority) query.set("priority", next.priority);
      if (next.type) query.set("type", next.type);
      if (next.search) query.set("search", next.search);
      const response = await fetch(`/api/opportunities?${query.toString()}`);
      const body = await response.json();
      setOpportunities(body.opportunities ?? []);
    } finally {
      setLoading(false);
    }
  }

  function applyFilter(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    reload(next);
  }

  async function handleSnooze(id: string, days: number) {
    setActionState((state) => ({ ...state, [id]: "working" }));
    await fetch(`/api/opportunities/${id}/snooze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days }) });
    setOpportunities((rows) => rows.filter((row) => row.id !== id));
    setActionState((state) => ({ ...state, [id]: "" }));
  }

  async function handleDismiss(id: string) {
    setActionState((state) => ({ ...state, [id]: "working" }));
    await fetch(`/api/opportunities/${id}/dismiss`, { method: "POST" });
    setOpportunities((rows) => rows.filter((row) => row.id !== id));
    setActionState((state) => ({ ...state, [id]: "" }));
  }

  async function handleAnalyze(id: string) {
    setActionState((state) => ({ ...state, [id]: "analyzing" }));
    await fetch(`/api/opportunities/${id}/analyze`, { method: "POST" });
    setActionState((state) => ({ ...state, [id]: "" }));
  }

  async function handleSaveSettings(next: { autoOpportunityDiagnosticsEnabled: boolean; dailyOpportunityDiagnosticLimit: number }) {
    setSavingSettings(true);
    try {
      const response = await fetch("/api/opportunities/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      const body = await response.json();
      if (body?.settings) setAiSettings(body.settings);
    } finally {
      setSavingSettings(false);
    }
  }

  const visibleOpportunities = useMemo(() => opportunities, [opportunities]);

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <PageHeader eyebrow="Operacao" title="Oportunidades" description="Prioridades comerciais e operacionais identificadas automaticamente." />

      {summary ? (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <MetricCard label="Abertas" value={String(summary.openTotal)} />
          <MetricCard label="Criticas" value={String(summary.critical)} />
          <MetricCard label="Altas" value={String(summary.high)} />
          <MetricCard label="Vendas" value={String((summary.byType.SALES_DROP ?? 0) + (summary.byType.NO_SALES_WITH_AVAILABILITY ?? 0) + (summary.byType.ACCOUNT_SPECIFIC_DROP ?? 0) + (summary.byType.PROMOTION_ENDED_SALES_DROP ?? 0))} />
          <MetricCard label="Estoque / Full" value={String((summary.byType.PHYSICAL_STOCKOUT_WITH_DEMAND ?? 0) + (summary.byType.FULL_ZERO_WITH_PHYSICAL ?? 0))} />
          <MetricCard label="Preco / Anuncio" value={String((summary.byType.PRICE_NOT_COMPETITIVE ?? 0) + (summary.byType.LISTING_QUALITY ?? 0))} />
        </div>
      ) : null}

      {canConfigureAutoClaude ? (
        <Card className="mt-6">
          <CardHeader>
            <p className="text-sm font-semibold text-gray-950">Analise automatica com Claude</p>
            <p className="mt-1 text-xs text-gray-500">Desligado por padrao. Quando ligado, analisa automaticamente oportunidades criticas/altas dos tipos que se beneficiam de IA, respeitando o limite diario.</p>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={aiSettings?.autoOpportunityDiagnosticsEnabled ?? false}
                disabled={savingSettings}
                onChange={(event) => handleSaveSettings({ autoOpportunityDiagnosticsEnabled: event.target.checked, dailyOpportunityDiagnosticLimit: aiSettings?.dailyOpportunityDiagnosticLimit ?? 5 })}
              />
              Habilitar analise automatica
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              Limite diario
              <input
                type="number"
                min={1}
                max={20}
                value={aiSettings?.dailyOpportunityDiagnosticLimit ?? 5}
                disabled={savingSettings}
                onChange={(event) => handleSaveSettings({ autoOpportunityDiagnosticsEnabled: aiSettings?.autoOpportunityDiagnosticsEnabled ?? false, dailyOpportunityDiagnosticLimit: Number(event.target.value) })}
                className="w-16 rounded-lg border border-gray-200 px-2 py-1 text-sm"
              />
            </label>
          </CardContent>
        </Card>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <select value={filters.status} onChange={(event) => applyFilter({ status: event.target.value as OpportunityStatus })} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          {OPPORTUNITY_STATUSES.map((status) => (
            <option key={status} value={status}>
              {OPPORTUNITY_STATUS_LABEL[status]}
            </option>
          ))}
        </select>
        <select value={filters.priority ?? ""} onChange={(event) => applyFilter({ priority: (event.target.value || null) as OpportunityPriority | null })} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          <option value="">Todas as prioridades</option>
          {OPPORTUNITY_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {OPPORTUNITY_PRIORITY_LABEL[priority]}
            </option>
          ))}
        </select>
        <select value={filters.type ?? ""} onChange={(event) => applyFilter({ type: (event.target.value || null) as OpportunityType | null })} className="rounded-lg border border-gray-200 px-3 py-2 text-sm">
          <option value="">Todos os tipos</option>
          {OPPORTUNITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {OPPORTUNITY_TYPE_LABEL[type]}
            </option>
          ))}
        </select>
        <input
          type="search"
          placeholder="SKU, produto ou MLB"
          value={filters.search}
          onChange={(event) => setFilters((state) => ({ ...state, search: event.target.value }))}
          onKeyDown={(event) => {
            if (event.key === "Enter") applyFilter({ search: filters.search });
          }}
          className="rounded-lg border border-gray-200 px-3 py-2 text-sm"
        />
      </div>

      <div className="mt-4 space-y-3">
        {loading ? <p className="text-sm text-gray-500">Carregando...</p> : null}
        {!loading && visibleOpportunities.length === 0 ? <p className="text-sm text-gray-500">Nenhuma oportunidade encontrada para esses filtros.</p> : null}
        {visibleOpportunities.map((opportunity) => (
          <OpportunityCard
            key={opportunity.id}
            opportunity={opportunity}
            canSnooze={canSnooze}
            canDismissOrAnalyze={canDismissOrAnalyze}
            onSnooze={handleSnooze}
            onDismiss={handleDismiss}
            onAnalyze={handleAnalyze}
            actionState={actionState[opportunity.id]}
          />
        ))}
      </div>
    </div>
  );
}
