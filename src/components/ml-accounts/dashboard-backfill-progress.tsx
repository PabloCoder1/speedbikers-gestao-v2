"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { Badge } from "@/components/ui/badge";

import type {
  DashboardBackfillProgress as ProgressData,
  DashboardBackfillStatus,
} from "@/features/ml-sync/get-dashboard-backfill-progress";

type DashboardBackfillProgressProps = {
  progress: ProgressData;
};

const labels: Record<DashboardBackfillStatus, string> = {
  queued: "Na fila",
  running: "Processando",
  succeeded: "Concluído",
  failed: "Falhou",
  partial: "Parcial",
  cancelled: "Cancelado",
};

export function DashboardBackfillProgress({
  progress,
}: DashboardBackfillProgressProps) {
  const router = useRouter();

  const active =
    progress.status === "queued" || progress.status === "running";

  // enquanto está rodando, atualiza a cada 10s pra a barra andar sozinha
  useEffect(() => {
    if (!active) {
      return;
    }

    const interval = window.setInterval(() => {
      router.refresh();
    }, 10000);

    return () => {
      window.clearInterval(interval);
    };
  }, [active, router]);

  const displayedProcessed =
    progress.recordsDiscovered > 0
      ? Math.min(progress.recordsProcessed, progress.recordsDiscovered)
      : progress.recordsProcessed;

  const percentage =
    progress.recordsDiscovered > 0
      ? Math.min(
          100,
          Math.round(
            (displayedProcessed / progress.recordsDiscovered) * 100,
          ),
        )
      : 0;

  const badgeVariant =
    progress.status === "succeeded"
      ? "success"
      : progress.status === "failed"
        ? "danger"
        : progress.status === "running"
          ? "info"
          : progress.status === "queued"
            ? "warning"
            : "neutral";

  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Priorização dos últimos 90 dias
          </p>

          <p className="mt-1 text-sm font-semibold text-gray-950">
            {displayedProcessed} / {progress.recordsDiscovered}
          </p>
        </div>

        <Badge variant={badgeVariant}>{labels[progress.status]}</Badge>
      </div>

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-200">
        <div
          className="h-full rounded-full bg-gray-950 transition-all duration-500"
          style={{ width: `${percentage}%` }}
        />
      </div>

      <div className="mt-2 flex justify-between text-xs text-gray-500">
        <span>{percentage}%</span>
        <span>{progress.recordsUpserted} pedidos processados</span>
      </div>

      {progress.errorMessage ? (
        <div className="mt-4 border-t border-gray-200 pt-3 text-xs leading-5">
          <p className="text-red-700">{progress.errorMessage}</p>
        </div>
      ) : null}

      {active ? (
        <p className="mt-3 text-xs text-gray-500">
          A priorização continua rodando mesmo com esta página fechada.
        </p>
      ) : null}
    </div>
  );
}