import { redirect } from "next/navigation";

import { OperationalAlertsView } from "@/components/stock/operational-alerts-view";
import {
  getOperationalAlerts,
  type OperationalAlertScope,
  type OperationalAlertSeverity,
} from "@/features/stock/get-operational-alerts";

export const metadata = {
  title: "Alertas",
};

type AlertsPageProps = {
  searchParams: Promise<{
    q?: string | string[];
    severity?: string | string[];
    scope?: string | string[];
  }>;
};

const allowedSeverities = new Set(["all", "critical", "warning", "info"]);
const allowedScopes = new Set(["open", "resolved", "all"]);

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AlertsPage({ searchParams }: AlertsPageProps) {
  const rawSearchParams = await searchParams;
  const rawScope = firstValue(rawSearchParams.scope);
  const rawSeverity = firstValue(rawSearchParams.severity);
  const scope = (allowedScopes.has(rawScope ?? "") ? rawScope : "open") as OperationalAlertScope;
  const severity = (allowedSeverities.has(rawSeverity ?? "") ? rawSeverity : "all") as OperationalAlertSeverity | "all";
  const query = firstValue(rawSearchParams.q)?.trim().slice(0, 100) ?? "";

  /*
   * Severidade e busca vão para o banco junto do escopo: a RPC filtra e
   * limita antes de serializar, em vez de a tela receber a lista inteira
   * e recortar em memória.
   */
  const overview = await getOperationalAlerts(scope, { severity, query });

  if (!overview) redirect("/login");

  return (
    <OperationalAlertsView
      overview={overview}
      query={query}
      severity={severity}
      scope={scope}
    />
  );
}
