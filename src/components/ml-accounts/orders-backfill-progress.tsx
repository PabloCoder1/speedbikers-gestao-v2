"use client";

import {
  useEffect,
} from "react";

import {
  useRouter,
} from "next/navigation";

import { Badge } from "@/components/ui/badge";

import type {
  OrdersBackfillProgress as ProgressData,
  OrdersBackfillStatus,
} from "@/features/ml-sync/get-orders-backfill-progress";


type OrdersBackfillProgressProps = {
  progress:
    ProgressData;
};


const labels:
  Record<
    OrdersBackfillStatus,
    string
  > = {
    queued:
      "Na fila",

    running:
      "Processando",

    succeeded:
      "Concluído",

    failed:
      "Falhou",

    partial:
      "Parcial",

    cancelled:
      "Cancelado",
  };


function formatDate(
  value: string | null,
) {
  if (!value) {
    return "—";
  }


  return new Intl.DateTimeFormat(
    "pt-BR",
    {
      dateStyle:
        "short",

      timeZone:
        "America/Sao_Paulo",
    },
  ).format(
    new Date(
      value,
    ),
  );
}


export function OrdersBackfillProgress({
  progress,
}: OrdersBackfillProgressProps) {
  const router =
    useRouter();


  const active =
    progress.status ===
      "queued" ||
    progress.status ===
      "running";


  useEffect(() => {
    if (!active) {
      return;
    }


    const interval =
      window.setInterval(
        () => {
          router.refresh();
        },
        10000,
      );


    return () => {
      window.clearInterval(
        interval,
      );
    };
  }, [
    active,
    router,
  ]);


  const displayedProcessed =
    progress.recordsDiscovered >
    0
      ? Math.min(
          progress.recordsProcessed,
          progress.recordsDiscovered,
        )
      : progress.recordsProcessed;


  const percentage =
    progress.recordsDiscovered >
    0
      ? Math.min(
          100,
          Math.round(
            (
              displayedProcessed /
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
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            Histórico de pedidos
          </p>

          <p className="mt-1 text-sm font-semibold text-gray-950">
            {displayedProcessed}{" "}
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
            labels[
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


      <div className="mt-2 flex justify-between text-xs text-gray-500">
        <span>
          {percentage}%
        </span>

        <span>
          {
            progress
              .recordsUpserted
          }{" "}
          pedidos processados
        </span>
      </div>


      <div className="mt-4 border-t border-gray-200 pt-3 text-xs leading-5 text-gray-500">
        <p>
          Intervalo:{" "}
          {formatDate(
            progress.historyFrom,
          )}{" "}
          até{" "}
          {formatDate(
            progress.historyUntil,
          )}
        </p>


        {active ? (
          <p>
            Janela atual:{" "}
            {formatDate(
              progress.windowFrom,
            )}{" "}
            →{" "}
            {formatDate(
              progress.windowTo,
            )}
          </p>
        ) : null}


        {progress.retryCount >
        0 ? (
          <p className="text-amber-700">
            Tentativas automáticas:{" "}
            {
              progress
                .retryCount
            }
          </p>
        ) : null}


        {progress.errorMessage ? (
          <p className="text-red-700">
            {
              progress
                .errorMessage
            }
          </p>
        ) : null}
      </div>


      {active ? (
        <p className="mt-3 text-xs text-gray-500">
          O histórico continua sendo importado mesmo com esta página fechada.
        </p>
      ) : null}
    </div>
  );
}
