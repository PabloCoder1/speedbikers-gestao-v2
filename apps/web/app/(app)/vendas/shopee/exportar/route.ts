import { toSalesMetricDate } from "@sb/domain";
import type { NextRequest } from "next/server";

import { EXPORT_LIMIT } from "../../../../../lib/listings-export";
import { currentMembership } from "../../../../../lib/membership";
import { lerPaginasDaRpc } from "../../../../../lib/rpc-pages";
import { pedidosShopeeParaCsv } from "../../../../../lib/shopee-export";
import { SHOPEE_SITUACOES, resolveShopeeSalesFilters } from "../../../../../lib/shopee-sales";
import { createClient } from "../../../../../lib/supabase/server";

/**
 * CSV dos pedidos de `/vendas/shopee` (D-490): a MESMA URL da tela, lida pelo
 * mesmo `resolveShopeeSalesFilters` (período, loja, situação e o pedido aberto
 * pela busca), e a MESMA RPC — só sem página, como o CSV de `/anuncios` (D-385).
 *
 * Sessão do usuário e RPC `security invoker`: a planilha vê só as lojas que a
 * pessoa alcança (D-433). Teto de 5.000 linhas, dito no nome do arquivo quando o
 * recorte passa dele — nunca cortar em silêncio (D-131).
 */
export async function GET(request: NextRequest): Promise<Response> {
  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  const supabase = await createClient();

  const [membership, lojas] = await Promise.all([
    currentMembership(supabase),
    supabase.from("shopee_shops").select("id, organization_id"),
  ]);

  if (membership.organizationId === null) {
    return new Response("Sua conta não está associada a nenhuma organização.", { status: 403 });
  }

  if (lojas.error !== null) {
    return new Response(`Não foi possível ler as lojas Shopee: ${lojas.error.message}`, { status: 502 });
  }

  const organizationId = membership.organizationId;
  const { filters } = resolveShopeeSalesFilters(
    query,
    lojas.data.filter((loja) => loja.organization_id === organizationId).map((loja) => loja.id),
    toSalesMetricDate(new Date()),
  );
  const situacao = SHOPEE_SITUACOES.find((s) => s.slug === filters.situacao) ?? null;

  // Em páginas: pedir o teto numa ida só devolvia mil linhas (max_rows).
  const { linhas, error } = await lerPaginasDaRpc(
    (offset, limite) =>
      supabase.rpc("get_shopee_orders", {
        p_organization_id: organizationId,
        p_date_from: filters.range.from,
        p_date_to: filters.range.to,
        p_shopee_shop_id: filters.loja,
        p_situacao: situacao?.codigo ?? null,
        // Só com pedido, como a tela (D-476 §5).
        ...(filters.pedido === null ? {} : { p_order_sn: filters.pedido }),
        p_limit: limite,
        p_offset: offset,
      }),
    EXPORT_LIMIT,
  );

  if (error !== null) {
    return new Response(`Não foi possível exportar os pedidos: ${error.message}`, { status: 502 });
  }

  const total = linhas[0]?.total_count ?? 0;
  const sufixo = total > EXPORT_LIMIT ? `-primeiros-${String(EXPORT_LIMIT)}-de-${String(total)}` : "";
  const nome = `pedidos-shopee-${filters.range.from}-a-${filters.range.to}${sufixo}.csv`;

  return new Response(pedidosShopeeParaCsv(linhas), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${nome}"`,
      "Cache-Control": "no-store",
    },
  });
}
