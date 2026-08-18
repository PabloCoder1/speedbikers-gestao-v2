/*
 * Pure interpretation of refresh_stock_sale_deductions()'s result,
 * extracted to its own server-only-free file so it's directly
 * testable — refresh-stock-sale-deductions.ts has `import
 * "server-only"` in its chain (createAdminClient) and can't be
 * imported by tests.
 *
 * Never returns anything that should make a caller throw: both an
 * RPC-level error and a {refreshed:false} result are logged, not
 * fatal — orders were already persisted; stock_sale_deductions being
 * one cycle stale is the accepted tradeoff over blocking a foreground
 * read.
 */
export function describeRefreshOutcome(
  data: unknown,
  error: { message: string } | null,
): string | null {
  if (error) {
    return `Stock sale deductions refresh failed: ${error.message.slice(0, 500)}`;
  }

  if (
    data &&
    typeof data === "object" &&
    (data as Record<string, unknown>).refreshed === false
  ) {
    const reason = (data as Record<string, unknown>).reason;
    return `Stock sale deductions refresh skipped: ${
      typeof reason === "string" ? reason : "unknown_reason"
    }`;
  }

  return null;
}
