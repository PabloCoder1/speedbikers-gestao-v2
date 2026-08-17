type ImportPreviewSummary = {
  stockRows?: unknown;
  productRows?: unknown;
  relationshipRows?: unknown;
  kitRows?: unknown;
};

export type UpsellerImportProgressInput = {
  status: string;
  phase: string | null;
  cursorRow: number;
  previewSummary: unknown;
  createdAt: string;
  now?: Date;
};

export type UpsellerImportProgress = {
  percent: number;
  phaseProcessedRows: number;
  phaseTotalRows: number;
  completedWorkUnits: number;
  totalWorkUnits: number;
  elapsedSeconds: number;
  estimatedSecondsRemaining: number | null;
};

type PhaseWork = {
  phase: string;
  total: number;
};

function nonNegativeInteger(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

function summaryFrom(value: unknown): ImportPreviewSummary {
  return value && typeof value === "object" ? value as ImportPreviewSummary : {};
}

function buildPhaseWork(previewSummary: unknown): PhaseWork[] {
  const summary = summaryFrom(previewSummary);
  const stockRows = Math.max(nonNegativeInteger(summary.stockRows), 1);
  const productRows = Math.max(nonNegativeInteger(summary.productRows), 1);
  const relationshipRows = Math.max(nonNegativeInteger(summary.relationshipRows), 1);
  const kitRows = Math.max(nonNegativeInteger(summary.kitRows), 1);

  return [
    { phase: "stock", total: stockRows },
    { phase: "products", total: productRows },
    { phase: "relationships", total: relationshipRows },
    { phase: "kits", total: kitRows },
    { phase: "promote_catalog", total: productRows },
    { phase: "promote_stock", total: stockRows },
    { phase: "promote_relationships", total: relationshipRows },
    { phase: "promote_kits", total: kitRows },
    { phase: "derive_kits", total: productRows },
    { phase: "build_links_exact", total: productRows },
    { phase: "build_links_item", total: relationshipRows },
    { phase: "build_links_variation", total: relationshipRows },
    { phase: "build_links_user_product", total: relationshipRows },
    { phase: "promote_links", total: productRows },
    { phase: "finalize", total: 1 },
  ];
}

export function calculateUpsellerImportProgress({
  status,
  phase,
  cursorRow,
  previewSummary,
  createdAt,
  now = new Date(),
}: UpsellerImportProgressInput): UpsellerImportProgress {
  const phases = buildPhaseWork(previewSummary);
  const totalWorkUnits = phases.reduce((total, current) => total + current.total, 0);
  const normalizedPhase = phase === "promote" ? "promote_catalog" : phase;
  const phaseIndex = phases.findIndex((current) => current.phase === normalizedPhase);
  const applied = status === "applied";
  const previewed = status === "previewed" || phase === "preview" || !normalizedPhase;
  const current = phaseIndex >= 0 ? phases[phaseIndex] : null;
  const workBeforePhase = phaseIndex > 0
    ? phases.slice(0, phaseIndex).reduce((total, item) => total + item.total, 0)
    : 0;
  const phaseProcessedRows = current
    ? clamp(nonNegativeInteger(cursorRow), 0, current.total)
    : 0;
  const completedWorkUnits = applied
    ? totalWorkUnits
    : previewed
      ? 0
      : clamp(workBeforePhase + phaseProcessedRows, 0, totalWorkUnits);
  const rawPercent = totalWorkUnits > 0 ? completedWorkUnits / totalWorkUnits * 100 : 0;
  const percent = applied ? 100 : Math.min(99.9, Math.round(rawPercent * 10) / 10);
  const startedAt = Date.parse(createdAt);
  const elapsedSeconds = Number.isFinite(startedAt)
    ? Math.max(0, Math.floor((now.getTime() - startedAt) / 1_000))
    : 0;
  const progressRatio = totalWorkUnits > 0 ? completedWorkUnits / totalWorkUnits : 0;
  const active = status === "queued" || status === "running" || status === "processing";
  const estimatedSecondsRemaining = active && progressRatio >= 0.02 && elapsedSeconds >= 15
    ? Math.max(0, Math.round(elapsedSeconds * (1 - progressRatio) / progressRatio))
    : null;

  return {
    percent,
    phaseProcessedRows,
    phaseTotalRows: current?.total ?? 0,
    completedWorkUnits,
    totalWorkUnits,
    elapsedSeconds,
    estimatedSecondsRemaining,
  };
}
