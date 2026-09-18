import type { NextRequest } from "next/server";

import { EXPORT_LIMIT, fullRowsToCsv } from "../../../lib/full-export";
import { LOW_COVERAGE_DAYS, isFullRow, resolveFullFilters } from "../../../lib/full-filters";
import { currentMembership } from "../../../lib/membership";
import { createClient } from "../../../lib/supabase/server";
import { lastBusinessDays } from "../../../lib/business-window";

/**
 * CSV do recorte da Central Full (D-380) — mesmos filtros da tela, sem página.
 *
 * Quem barra sem sessão é o `proxy.ts`, como em toda rota; quem restringe o
 * que sai é a RLS, porque a RPC é `security invoker` e esta rota usa o cliente
 * da sessão, nunca a service key. Uma conta que não pertence à organização
 * devolve um CSV vazio: a RLS esconde os saldos dela.
 */

const LOOKBACK_DAYS = 30;

export async function GET(request: NextRequest): Promise<Response> {
  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filters = resolveFullFilters(query);
  const supabase = await createClient();
  const membership = await currentMembership(supabase);

  if (membership.organizationId === null) {
    return new Response("Sua conta não está associada a nenhuma organização.", { status: 403 });
  }

  const { from: dateFrom, to: dateTo } = lastBusinessDays(LOOKBACK_DAYS);

  const { data, error } = await supabase.rpc("get_fulfillment_overview", {
    p_organization_id: membership.organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: filters.account,
    p_situation: filters.situation,
    p_search: filters.search,
    p_sku_id: null,
    p_limit: EXPORT_LIMIT,
    p_offset: 0,
    p_focus: filters.focus,
    p_sort: filters.sort,
    p_low_coverage_days: LOW_COVERAGE_DAYS,
  });

  if (error !== null) {
    return new Response(`Não foi possível exportar o Full: ${error.message}`, { status: 502 });
  }

  const linhas = data;
  const total = linhas[0]?.total_count ?? 0;
  const rows = linhas.filter(isFullRow);

  // Nunca cortar em silêncio (D-131): passou do teto, o nome do arquivo diz.
  const sufixo = total > EXPORT_LIMIT ? `-primeiros-${String(EXPORT_LIMIT)}-de-${String(total)}` : "";
  const nome = `central-full-${dateTo}${sufixo}.csv`;

  return new Response(fullRowsToCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
    },
  });
}
