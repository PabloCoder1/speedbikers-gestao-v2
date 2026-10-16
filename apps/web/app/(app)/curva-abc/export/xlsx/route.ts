import { NextResponse } from "next/server";

import { toSalesMetricDate } from "@sb/domain";

import { aplicarContasDoRecorte, resolveAbcFilters, resolveAbcWindow } from "../../../../../lib/abc-filters";
import { formatBusinessDate } from "../../../../../lib/format";
import { currentMembership } from "../../../../../lib/membership";
import { createClient } from "../../../../../lib/supabase/server";
import { ROTULO_DO_ESCOPO, marketplacesDoEscopo, type ContaDoSeletor } from "../../../../../lib/vendas-multicanal";
import { loadAbcExportData } from "../load";
import { describeAbcExport } from "../rows";
import { buildAbcWorkbook } from "../workbook";

/**
 * `GET /curva-abc/export/xlsx` — o Excel da Curva ABC (D-422, D-424).
 *
 * Lê os MESMOS parâmetros da tela (`resolveAbcFilters`): o arquivo é o recorte
 * que está na frente de quem clicou -- marketplace e contas (D-450), período
 * (com o anterior de mesmo tamanho), conta, marca, categoria, tipo e "sem Full". Critério, classe,
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
  const pedidos = resolveAbcFilters(Object.fromEntries(url.searchParams.entries()), today);
  const multicanal = pedidos.escopo !== "ml";

  // Fora do ML, as contas e lojas vêm da fonte única (C-52): são as colunas da
  // aba "Por conta" e o que valida as contas do link.
  const [membership, accounts, contasDoRecorte] = await Promise.all([
    currentMembership(supabase),
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
    multicanal
      ? supabase
          .from("marketplace_accounts")
          .select("account_id, marketplace, name, environment")
          .order("marketplace", { ascending: true })
          .order("name", { ascending: true })
      : Promise.resolve({ data: null, error: null }),
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
  const todasAsContas: ContaDoSeletor[] = contasDoRecorte.data ?? [];
  const { filters, selecionadas, leMl } = aplicarContasDoRecorte(pedidos, todasAsContas);
  const conta = filters.escopo === "ml" ? (contas.find((a) => a.slug === filters.accountSlug) ?? null) : null;
  // As colunas da aba "Por conta": no ML, as contas; fora dele, as contas e
  // lojas do recorte de marketplace (a loja de teste aparece, marcada).
  const colunas =
    filters.escopo === "ml"
      ? contas.map((a) => ({ id: a.id, label: a.label }))
      : todasAsContas
          .filter((c) => filters.escopo === "todos" || c.marketplace === "SHOPEE")
          .map((c) => ({
            id: c.account_id,
            label: `${c.name}${c.marketplace === "SHOPEE" ? " (Shopee)" : ""}${c.environment === "live" ? "" : " — teste"}`,
          }));
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
    ...(filters.escopo === "ml"
      ? {}
      : { marketplaces: marketplacesDoEscopo(filters.escopo), accountIds: filters.contas }),
  });

  if (error !== null || data === null) {
    return NextResponse.json({ error: { code: "read_failed", message: error?.message } }, { status: 502 });
  }

  const arquivo = await buildAbcWorkbook({
    curves: data.curves,
    breakdowns: data.breakdowns,
    byAccount: data.byAccount,
    accounts: colunas,
    leMl,
    organizationName: membership.organizationName,
    recorte: describeAbcExport({
      periodLabel: filters.custom === null ? `últimos ${String(filters.days)} dias` : "período personalizado",
      dateFrom: janela.from,
      dateTo: janela.to,
      prevFrom: janela.prevFrom,
      prevTo: janela.prevTo,
      accountLabel:
        conta?.label ??
        (selecionadas === null ? null : selecionadas.map((c) => c.name).join(", ")),
      marketplaceLabel:
        filters.escopo === "todos" ? ROTULO_DO_ESCOPO.todos.toLowerCase() : filters.escopo === "shopee" ? ROTULO_DO_ESCOPO.shopee : null,
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
    filters.escopo === "ml" ? null : filters.escopo,
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
