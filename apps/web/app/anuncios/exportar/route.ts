import type { NextRequest } from "next/server";

import { lastBusinessDays } from "../../../lib/business-window";
import { orderKey } from "../../../lib/listings-dashboard";
import { EXPORT_LIMIT, listingsToCsv, type ListingExportRow } from "../../../lib/listings-export";
import { resolveListingsFilters } from "../../../lib/listings-view";
import { currentMembership } from "../../../lib/membership";
import { createClient } from "../../../lib/supabase/server";

/**
 * CSV do recorte de `/anuncios` (D-385): a MESMA URL da tela, lida pelo mesmo
 * `resolveListingsFilters`, e a MESMA RPC com a mesma ordem — só sem página.
 *
 * Sessão do usuário e RPC `security invoker`: a planilha vê exatamente o que a
 * tela vê, pela RLS. Teto de 5.000 linhas, dito no nome do arquivo quando o
 * recorte passa dele — nunca cortar em silêncio (D-131).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  const supabase = await createClient();

  const [membership, contas] = await Promise.all([
    currentMembership(supabase),
    supabase.from("ml_accounts").select("id, slug"),
  ]);

  if (membership.organizationId === null) {
    return new Response("Sua conta não está associada a nenhuma organização.", { status: 403 });
  }

  const lista = contas.data ?? [];
  const filters = resolveListingsFilters(
    query,
    lista.map((conta) => conta.slug),
  );
  const conta = lista.find((item) => item.slug === filters.account) ?? null;
  const { from: dateFrom, to: dateTo } = lastBusinessDays(filters.days);

  const { data, error } = await supabase.rpc("get_listings_dashboard", {
    p_organization_id: membership.organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: conta?.id ?? null,
    p_search: filters.search,
    p_status: filters.status,
    p_link_state: filters.link,
    p_stock: filters.stock,
    p_full: filters.full,
    p_sold: filters.sold,
    p_order: orderKey(filters.order),
    p_limit: EXPORT_LIMIT,
    p_offset: 0,
  });

  if (error !== null) {
    return new Response(`Não foi possível exportar os anúncios: ${error.message}`, { status: 502 });
  }

  const rows = data as unknown as ListingExportRow[];
  const total = (data[0] as { total_count?: number } | undefined)?.total_count ?? 0;
  const sufixo = total > EXPORT_LIMIT ? `-primeiros-${String(EXPORT_LIMIT)}-de-${String(total)}` : "";
  const nome = `anuncios-${dateTo}${sufixo}.csv`;

  return new Response(listingsToCsv(rows, filters.days), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
    },
  });
}
