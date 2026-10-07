import { NextResponse } from "next/server";

import { resolveAbcFilters } from "../../../../lib/abc-filters";
import { lastBusinessDays } from "../../../../lib/business-window";
import { formatBusinessDate } from "../../../../lib/format";
import { currentMembership } from "../../../../lib/membership";
import { createClient } from "../../../../lib/supabase/server";
import { loadAbcExportData } from "../load";
import { describeAbcExport } from "../rows";
import { buildAbcWorkbook } from "../workbook";

/**
 * `GET /curva-abc/export/xlsx` — o Excel da Curva ABC.
 *
 * Lê os MESMOS parâmetros da tela (`resolveAbcFilters`): o arquivo é o recorte
 * que está na frente de quem clicou -- período, conta, marca e "sem Full". A
 * classe e o critério escolhidos não restringem: o arquivo leva as três curvas
 * inteiras, e cada aba tem filtro automático.
 *
 * O cliente vem do cookie de sessão: quem decide o que a RPC enxerga é a RLS,
 * e `service_role` nunca entra numa rota alcançável pelo navegador (D-012).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const url = new URL(request.url);
  const filters = resolveAbcFilters(Object.fromEntries(url.searchParams.entries()));

  const [membership, accounts] = await Promise.all([
    currentMembership(supabase),
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
  ]);

  if (membership.error !== null) {
    return NextResponse.json({ error: { code: "membership_unavailable" } }, { status: 503 });
  }

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return NextResponse.json({ error: { code: "no_organization" } }, { status: 403 });
  }

  // Conta desconhecida cai em "todas", a MESMA regra da tela.
  const conta = (accounts.data ?? []).find((a) => a.slug === filters.accountSlug) ?? null;
  const now = new Date();
  const { from: dateFrom, to: dateTo } = lastBusinessDays(filters.days, now);

  const { data, error } = await loadAbcExportData(supabase, {
    organizationId,
    dateFrom,
    dateTo,
    accountId: conta?.id ?? null,
    brand: filters.brand,
    onlyWithoutFull: filters.onlyWithoutFull,
  });

  if (error !== null || data === null) {
    return NextResponse.json({ error: { code: "read_failed", message: error?.message } }, { status: 502 });
  }

  const buffer = await buildAbcWorkbook({
    curves: data.curves,
    extras: data.extras,
    organizationName: membership.organizationName,
    recorte: describeAbcExport({
      days: filters.days,
      dateFrom,
      dateTo,
      accountLabel: conta?.label ?? null,
      brand: filters.brand,
      onlyWithoutFull: filters.onlyWithoutFull,
      formatDay: formatBusinessDate,
    }),
    generatedAt: now,
  });

  // O recorte vai no nome: dois arquivos de recortes diferentes não se
  // confundem na pasta de Downloads.
  const partes = ["curva-abc", `${String(filters.days)}-dias`, conta?.slug, filters.brand, filters.onlyWithoutFull ? "sem-full" : null, dateTo]
    .filter((p): p is string => p !== null && p !== undefined && p !== "")
    .map((p) => p.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9-]+/g, "-").toLowerCase());
  const nome = `${partes.join("-")}.xlsx`;

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nome}"`,
      // Recorte é dado vivo: cachear entregaria ontem amanhã.
      "Cache-Control": "no-store",
    },
  });
}
