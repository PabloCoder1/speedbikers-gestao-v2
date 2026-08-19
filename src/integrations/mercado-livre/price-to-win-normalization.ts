/*
 * Pure, free of `import "server-only"` so it's testable without a network
 * call — diagnostics.ts (which does the real HTTP fetch) uses this to
 * decide whether the monetary fields in a price_to_win response are
 * trustworthy. Production evidence: for a listing outside any catalog
 * competition, the API returned status="unknown", currency_id=null, but
 * current_price/price_to_win as literal 0 rather than omitting them. A
 * real product never costs R$0 — that 0 is a placeholder, not a price.
 */
export function isPriceToWinContextValid(params: { currencyId: string | null; status: string }): boolean {
  return params.currencyId !== null && params.status !== "unknown";
}
