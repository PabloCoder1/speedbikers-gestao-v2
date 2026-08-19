import { NextResponse } from "next/server";

import { getOpportunitiesAccess } from "@/features/auth/get-opportunities-access";
import { getProductOpportunitiesPage } from "@/features/opportunities/get-product-opportunities-page";
import type { OpportunityPriority, OpportunityStatus, OpportunityType } from "@/features/opportunities/opportunity-domain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { access } = await getOpportunitiesAccess();
  if (!access) return NextResponse.json({ error: "not_authenticated" }, { status: 401 });

  const url = new URL(request.url);
  const rows = await getProductOpportunitiesPage({
    status: (url.searchParams.get("status") as OpportunityStatus | null) ?? "open",
    priority: url.searchParams.get("priority") as OpportunityPriority | null,
    opportunityType: url.searchParams.get("type") as OpportunityType | null,
    accountId: url.searchParams.get("accountId"),
    search: url.searchParams.get("search"),
    pageSize: 50,
  });

  return NextResponse.json({ opportunities: rows ?? [] });
}
