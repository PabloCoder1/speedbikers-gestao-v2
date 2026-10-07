import { NextResponse } from "next/server";

import { toSalesMetricDate } from "@sb/domain";

import { resolveAbcFilters, resolveAbcWindow } from "../../../../lib/abc-filters";
import { formatBusinessDate } from "../../../../lib/format";
import { currentMembership } from "../../../../lib/membership";
import { createClient } from "../../../../lib/supabase/server";
import { loadAbcExportData } from "../load";
import { describeAbcExport } from "../rows";
import { buildAbcWorkbook } from "../workbook";

/**
 * `GET /curva-abc/export/xlsx` — o Excel da Curva ABC (D-422, D-424).
 *
 * Lê os MESMOS parâmetros da tela (`resolveAbcFilters`): o arquivo é o recorte
 * que está na frente de quem clicou -- período (com o anterior de mesmo
 * tamanho), conta, marca, categoria, tipo e "sem Full". Critério, classe,
 * estoque, movimento e busca não restringem: o arquivo leva as três curvas
 * inteiras do recorte, e cada aba tem filtro automático.
 *
 * O cliente vem do cookie de sessão: quem decide o que a RPC enxerga é a RLS,
 * e `service_role` nunca entra numa rota alcançável pelo navegador (D-012).
 */
export async function GET(request: Request): Promise<NextResponse> {
  const supabase = await createClient();
  const url = new URL(request.url);
  const today = toSalesMetricDate(new Date());
  const filters = resolveAbcFilters(Object.fromEntries(url.searchParams.entries()), today);

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
  const contas = accounts.data ?? [];
  const conta = contas.find((a) => a.slug === filters.accountSlug) ?? null;
  const now = new Date();
  const janela = resolveAbcWindow(filters, today);

  const { data, error } = await loadAbcExportData(supabase, {
    organizationId,
    dateFrom: janela.from,
    dateTo: janela.to,
    prevFrom: janela.prevFrom,
    prevTo: janela.prevTo,
    accountId: conta?.id ?? null,
    brand: filters.brand,
    category: filters.category,
    kind: filters.kind?.value ?? null,
    onlyWithoutFull: filters.onlyWithoutFull,
  });

  if (error !== null || data === null) {
    return NextResponse.json({ error: { code: "read_failed", message: error?.message } }, { status: 502 });
  }

  const arquivo = await buildAbcWorkbook({
    curves: data.curves,
    breakdowns: data.breakdowns,
    byAccount: data.byAccount,
    accounts: contas.map((a) => ({ id: a.id, label: a.label })),
    organizationName: membership.organizationName,
    recorte: describeAbcExport({
      periodLabel: filters.custom === null ? `últimos ${String(filters.days)} dias` : "período personalizado",
      dateFrom: janela.from,
      dateTo: janela.to,
      prevFrom: janela.prevFrom,
      prevTo: janela.prevTo,
      accountLabel: conta?.label ?? null,
      brand: filters.brand,
      category: filters.category,
      kindLabel: filters.kind?.label ?? null,
      onlyWithoutFull: filters.onlyWithoutFull,
      formatDay: formatBusinessDate,
    }),
    dayCount: janela.dayCount,
    generatedAt: now,
  });

  // O recorte vai no nome: dois arquivos de recortes diferentes não se
  // confundem na pasta de Downloads.
  const partes = [
    "curva-abc",
    filters.custom === null ? `${String(filters.days)}-dias` : `${janela.from}-a`,
    conta?.slug,
    filters.brand,
    filters.category,
    filters.kind?.key,
    filters.onlyWithoutFull ? "sem-full" : null,
    janela.to,
  ]
    .filter((p): p is string => p !== null && p !== undefined && p !== "")
    .map((p) => p.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Za-z0-9-]+/g, "-").toLowerCase());
  const nome = `${partes.join("-")}.xlsx`;

  return new NextResponse(arquivo as unknown as BodyInit, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${nome}"`,
      // Recorte é dado vivo: cachear entregaria ontem amanhã.
      "Cache-Control": "no-store",
    },
  });
}
