import { redirect } from "next/navigation";

import { SalesOrdersListView } from "@/components/sales-orders/sales-orders-list-view";
import { getMlAccounts } from "@/features/ml-accounts/get-ml-accounts";
import { getSalesOrdersPage } from "@/features/sales-orders/get-sales-orders-page";
import { getSalesOrdersSummary } from "@/features/sales-orders/get-sales-orders-summary";
import {
  periodToIsoRange,
  resolveSalesOrdersPeriod,
} from "@/features/sales-orders/resolve-sales-orders-period";
import { saoPauloDateKey } from "@/lib/date/sao-paulo";

export const metadata = {
  title: "Pedidos de venda",
};

type PedidosPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const allowedPresets = new Set(["today", "yesterday", "7d", "30d", "custom"]);
const allowedStatuses = new Set(["all", "paid", "cancelled", "attention"]);

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PedidosPage({ searchParams }: PedidosPageProps) {
  const raw = await searchParams;

  const rawPreset = first(raw.periodo);
  const preset = allowedPresets.has(rawPreset ?? "") ? (rawPreset as string) : "today";
  const today = saoPauloDateKey();
  const period = resolveSalesOrdersPeriod({
    preset,
    today,
    customFrom: first(raw.de) ?? null,
    customTo: first(raw.ate) ?? null,
  });
  const { fromIso, toIsoExclusive } = periodToIsoRange(period);

  const rawStatus = first(raw.status);
  const status = allowedStatuses.has(rawStatus ?? "") ? (rawStatus as string) : "all";
  const query = (first(raw.q) ?? "").trim().slice(0, 100);
  const accountCode = first(raw.conta) ?? "all";
  const cursorDate = first(raw.cd) ?? null;
  const cursorId = first(raw.ci) ?? null;
  const pageSize = Number(first(raw.tamanho)) === 100 ? 100 : 50;

  const { accounts } = await getMlAccounts();
  const selectedAccount =
    accountCode !== "all" ? (accounts.find((account) => account.code === accountCode) ?? null) : null;

  const [summary, page] = await Promise.all([
    getSalesOrdersSummary({
      fromIso,
      toIsoExclusive,
      accountId: selectedAccount?.id ?? null,
    }),
    getSalesOrdersPage({
      fromIso,
      toIsoExclusive,
      accountId: selectedAccount?.id ?? null,
      status,
      search: query,
      cursorDate,
      cursorId,
      pageSize,
    }),
  ]);

  if (!summary || !page) {
    redirect("/login");
  }

  return (
    <SalesOrdersListView
      summary={summary}
      page={page}
      accounts={accounts}
      selectedAccountCode={accountCode}
      preset={period.preset}
      fromDateKey={period.fromDateKey}
      toDateKey={period.toDateKey}
      status={status}
      query={query}
      pageSize={pageSize}
    />
  );
}
