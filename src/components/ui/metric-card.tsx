import type {
  ReactNode,
} from "react";

import {
  Card,
  CardContent,
} from "@/components/ui/card";

type MetricCardProps = {
  label: string;
  value: ReactNode;
  description?: string;
  badge?: ReactNode;
};

export function MetricCard({
  label,
  value,
  description,
  badge,
}: MetricCardProps) {
  return (
    <Card>
      <CardContent>
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm font-medium text-gray-500">
            {label}
          </p>

          {badge}
        </div>

        <div className="mt-3 text-2xl font-semibold tracking-tight text-gray-950">
          {value}
        </div>

        {description ? (
          <p className="mt-2 text-sm leading-5 text-gray-500">
            {description}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}