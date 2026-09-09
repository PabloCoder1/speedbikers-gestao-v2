import { NextResponse } from "next/server";

import { currentMembership } from "../../../../lib/membership";
import { resolvePriceFilters } from "../../../../lib/price-filters";
import { createClient } from "../../../../lib/supabase/server";
import { loadPriceExportData } from "../load";
import { buildPriceChangesWorkbook } from "../workbook";

/**
 * `GET /precos/export/xlsx` — a exportação que D-264 registrou como candidata
 * a fatia própria (D-292).
 *
 * **A rota lê os MESMOS parâmetros da tela**, e isso é o contrato: o botão
 * exporta o recorte que está na frente do operador, não "tudo". Um botão que
 * ignorasse os filtros entregaria um arquivo que não corresponde à tela de
 * onde ele saiu — e ninguém confere planilha contra tela.
 *
 * **A autorização é a de sempre, e não há atalho aqui:** o cliente vem do
 * cookie de sessão, então a RLS decide o que a RPC enxerga. `service_role`
 * nunca entra numa rota alcançável pelo navegador (D-012).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient();

  const url = new URL(request.url);
  const filters = resolvePriceFilters(Object.fromEntries(url.searchParams.entries()));

  const [membership, accounts] = await Promise.all([
    currentMembership(supabase),
    supabase.from("ml_accounts").select("id, label").order("label"),
  ]);

  if (membership.error !== null) {
    return NextResponse.json({ error: { code: "membership_unavailable" } }, { status: 503 });
  }

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return NextResponse.json({ error: { code: "no_organization" } }, { status: 403 });
  }

  // Conta desconhecida (ou de outra organização) vira "sem filtro" antes de
  // tocar a RPC — a MESMA regra da tela, para o arquivo não sair de um recorte
  // que a tela não produziria.
  const conta = (accounts.data ?? []).find((row) => row.id === filters.account) ?? null;

  const now = new Date();
  const { data, error } = await loadPriceExportData(supabase, organizationId, filters, conta?.id ?? null, now);

  if (error !== null || data === null) {
    return NextResponse.json({ error: { code: "read_failed", message: error?.message } }, { status: 502 });
  }

  const buffer = await buildPriceChangesWorkbook({
    data,
    organizationName: membership.organizationName,
    accountLabel: conta?.label ?? null,
    direction: filters.direction,
    search: filters.search,
    generatedAt: now,
  });

  /*
    O NOME DO ARQUIVO CARREGA O RECORTE. "precos.xlsx" na pasta de Downloads,
    ao lado de outros três, é indistinguível; com o período no nome, dois
    recortes diferentes não se sobrescrevem nem se confundem.
  */
  const nome = `historico-de-precos-${data.dayFrom}-a-${data.dayTo ?? "hoje"}.xlsx`;

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nome}"`,
      // Recorte é dado vivo: cachear a planilha entregaria ontem amanhã.
      "Cache-Control": "no-store",
    },
  });
}
