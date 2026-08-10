"use client";

import {
  useEffect,
} from "react";

import {
  useRouter,
} from "next/navigation";

import { Badge } from "@/components/ui/badge";
import type {
  ListingsSyncProgress as ListingsSyncProgressData,
  ListingsSyncStatus,
} from "@/features/ml-sync/get-listings-sync-progress";


type ListingsSyncProgressProps = {
  progress:
    ListingsSyncProgressData;
};


const statusLabels:
  Record<
    ListingsSyncStatus,
    string
  > = {
    queued:
      "Na fila",

    running:
      "Em andamento",

    succeeded:
      "Concluída",

    failed:
      "Falhou",

    partial:
      "Parcial",

    cancelled:
      "Cancelada",
  };


export function ListingsSyncProgress({
  progress,
}: ListingsSyncProgressProps) {
  const router =
    useRouter();


  const isActive =
    progress.status ===
      "queued" ||
    progress.status ===
      "running";


  useEffect(() => {
    if (!isActive) {
      return;
    }


    const interval =
      window.setInterval(
        () => {
          router.refresh();
        },
        5000,
      );


    return () => {
      window.clearInterval(
        interval,
      );
    };
  }, [
    isActive,
    router,
  ]);


  const percentage =
    progress.recordsDiscovered >
    0
      ? Math.min(
          100,
          Math.round(
            (
              progress.recordsProcessed /
              progress.recordsDiscovered
            ) * 100,
          ),
        )
      : 0;


  const badgeVariant =
    progress.status ===
    "succeeded"
      ? "success"
      : progress.status ===
          "failed"
        ? "danger"
        : progress.status ===
            "running"
          ? "info"
          : progress.status ===
              "queued"
            ? "warning"
            : "neutral";


  return (
    <div className="mt-4 rounded-xl border border-gray-200 bg-gray-50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Sincronização de anúncios
          </p>

          <p className="mt-1 text-sm font-semibold text-gray-950">
            {
              progress
                .recordsProcessed
            }{" "}
            /{" "}
            {
              progress
                .recordsDiscovered
            }
          </p>
        </div>

        <Badge
          variant={
            badgeVariant
          }
        >
          {
            statusLabels[
              progress.status
            ]
          }
        </Badge>
      </div>


      <div className="mt-4 h-2 overflow-hidden rounded-full bg-gray-200">
        <div
          className="h-full rounded-full bg-gray-950 transition-all duration-500"
          style={{
            width:
              `${percentage}%`,
          }}
        />
      </div>


      <div className="mt-2 flex items-center justify-between gap-4 text-xs text-gray-500">
        <span>
          {percentage}%
        </span>

        <span>
          {
            progress
              .recordsUpserted
          }{" "}
          anúncios persistidos
        </span>
      </div>


      {progress.retryCount >
      0 ? (
        <p className="mt-3 text-xs text-amber-700">
          Tentativas automáticas:{" "}
          {
            progress
              .retryCount
          }
        </p>
      ) : null}


      {progress.errorMessage ? (
        <p className="mt-3 text-xs leading-5 text-red-700">
          {
            progress
              .errorMessage
          }
        </p>
      ) : null}


      {isActive ? (
        <p className="mt-3 text-xs text-gray-500">
          O processamento continua
          automaticamente no servidor.
          Esta tela é atualizada a cada
          5 segundos.
        </p>
      ) : null}
    </div>
  );
}