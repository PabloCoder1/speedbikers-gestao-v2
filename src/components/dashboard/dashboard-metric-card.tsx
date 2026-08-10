type DashboardMetricCardProps = {
  label: string;

  value: string;

  helper?: string;

  variation?: number | null;
};


function formatVariation(
  variation: number,
) {
  if (
    !Number.isFinite(
      variation,
    )
  ) {
    return null;
  }


  const prefix =
    variation > 0
      ? "+"
      : "";


  return `${prefix}${variation.toFixed(
    1,
  )}%`;
}


export function DashboardMetricCard({
  label,
  value,
  helper,
  variation,
}: DashboardMetricCardProps) {
  const formattedVariation =
    typeof variation ===
      "number"
      ? formatVariation(
          variation,
        )
      : null;


  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-gray-400">
        {label}
      </p>


      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="text-2xl font-bold tracking-tight text-gray-950">
          {value}
        </p>


        {formattedVariation ? (
          <span
            className={
              variation! > 0
                ? "text-xs font-semibold text-emerald-700"
                : variation! < 0
                  ? "text-xs font-semibold text-red-700"
                  : "text-xs font-semibold text-gray-500"
            }
          >
            {formattedVariation}
          </span>
        ) : null}
      </div>


      {helper ? (
        <p className="mt-2 text-xs leading-5 text-gray-500">
          {helper}
        </p>
      ) : null}
    </div>
  );
}