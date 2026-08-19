import {
  saoPauloStartOfDayIso,
  shiftSaoPauloDateKey,
} from "@/lib/date/sao-paulo";

export type SalesOrdersPeriodPreset = "today" | "yesterday" | "7d" | "30d" | "custom";

export type ResolvedSalesOrdersPeriod = {
  preset: SalesOrdersPeriodPreset;
  fromDateKey: string;
  toDateKey: string;
};

export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

export function resolveSalesOrdersPeriod({
  preset,
  today,
  customFrom,
  customTo,
}: {
  preset: string | null | undefined;
  today: string;
  customFrom?: string | null;
  customTo?: string | null;
}): ResolvedSalesOrdersPeriod {
  if (
    preset === "custom" &&
    isValidDateKey(customFrom) &&
    isValidDateKey(customTo) &&
    customFrom <= customTo &&
    customFrom <= today
  ) {
    return {
      preset: "custom",
      fromDateKey: customFrom,
      toDateKey: customTo > today ? today : customTo,
    };
  }

  switch (preset) {
    case "yesterday": {
      const dateKey = shiftSaoPauloDateKey(today, -1);
      return { preset: "yesterday", fromDateKey: dateKey, toDateKey: dateKey };
    }
    case "7d":
      return { preset: "7d", fromDateKey: shiftSaoPauloDateKey(today, -6), toDateKey: today };
    case "30d":
      return { preset: "30d", fromDateKey: shiftSaoPauloDateKey(today, -29), toDateKey: today };
    case "today":
    default:
      return { preset: "today", fromDateKey: today, toDateKey: today };
  }
}

/*
 * The two RPCs that take a date range (get_sales_orders_summary,
 * get_sales_orders_page) compare against orders.date_created, a
 * timestamptz — so a Sao Paulo calendar-day range must become a
 * [fromIso, toIsoExclusive) instant range before it reaches SQL.
 *
 * Composes shiftSaoPauloDateKey + saoPauloStartOfDayIso (both existing
 * helpers) rather than nextSaoPauloDayStartIso: that helper takes a
 * live instant, not a bare date-key — feeding it "2026-08-19" parses
 * as UTC midnight first, which reformats to "2026-08-18" in Sao Paulo
 * and silently shifts the exclusive bound back by a day.
 */
export function periodToIsoRange(period: { fromDateKey: string; toDateKey: string }) {
  return {
    fromIso: saoPauloStartOfDayIso(period.fromDateKey),
    toIsoExclusive: saoPauloStartOfDayIso(shiftSaoPauloDateKey(period.toDateKey, 1)),
  };
}
