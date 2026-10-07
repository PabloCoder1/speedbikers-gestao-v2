import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@sb/db";

import { lerPaginasDaRpc } from "../../../lib/rpc-pages";
import type { AbcAnalysisRow, AbcBreakdownRow, AbcCriterionKey, AbcDimension, SkuAccountSales } from "./rows";

/**
 * A leitura do Excel da Curva ABC (D-422, ampliada em D-424).
 *
 * - As TRÊS curvas (faturamento, unidades, pedidos) pela `get_sku_abc_analysis`,
 *   a mesma RPC da tela, uma vez por critério: cada uma traz a classe nos três
 *   critérios, o período anterior, estoque e cobertura.
 * - Os recortes agregados do painel (conta, marca, categoria, mês, migração)
 *   pela `get_sku_abc_breakdown`: soma no Postgres, nunca aqui.
 * - A venda por SKU e conta (`get_sku_sales_by_account`) para a aba "Por conta".
 *
 * O arquivo leva o RECORTE da tela (período, conta, marca, categoria, tipo e
 * "sem Full"); os filtros de linha (classe, estoque, movimento, busca) não
 * restringem -- viram o filtro automático das colunas, e a frase do recorte
 * diz isso.
 *
 * Tudo em páginas de 1.000 (`lerPaginasDaRpc`): a RPC devolve `returns table`,
 * e o `max_rows` do PostgREST cortaria em silêncio. As leituras saem juntas.
 */

/** Acima disso o arquivo pesa e a rota arrisca o tempo; a curva real tem ~1,8 mil SKUs. */
export const MAX_SKUS = 20_000;

export const DIMENSIONS: readonly AbcDimension[] = ["conta", "marca", "categoria", "mes", "migracao"];

export interface AbcExportInput {
  organizationId: string;
  dateFrom: string;
  dateTo: string;
  prevFrom: string;
  prevTo: string;
  accountId: string | null;
  brand: string | null;
  category: string | null;
  kind: string | null;
  onlyWithoutFull: boolean;
}

export interface AbcExportData {
  curves: Record<AbcCriterionKey, AbcAnalysisRow[]>;
  breakdowns: Record<AbcDimension, AbcBreakdownRow[]>;
  byAccount: SkuAccountSales[];
}

export async function loadAbcExportData(
  supabase: SupabaseClient<Database>,
  input: AbcExportInput,
): Promise<{ data: AbcExportData | null; error: { message: string } | null }> {
  const recorte = {
    p_organization_id: input.organizationId,
    p_date_from: input.dateFrom,
    p_date_to: input.dateTo,
    p_prev_from: input.prevFrom,
    p_prev_to: input.prevTo,
    p_ml_account_id: input.accountId,
    p_supplier_brand: input.brand,
    p_category: input.category,
    p_kind: input.kind,
  };

  const curva = (criterion: AbcCriterionKey) =>
    lerPaginasDaRpc<AbcAnalysisRow>(
      async (offset, limite) => {
        const pagina = await supabase.rpc("get_sku_abc_analysis", {
          ...recorte,
          p_criterion: criterion,
          p_only_without_full: input.onlyWithoutFull,
          p_order: "curva",
          p_limit: limite,
          p_offset: offset,
        });

        return { data: (pagina.data ?? null) as AbcAnalysisRow[] | null, error: pagina.error };
      },
      MAX_SKUS,
    );

  // O recorte agregado devolve poucas linhas (contas, marcas, meses): uma ida basta.
  const recorteAgregado = async (dimension: AbcDimension) => {
    const resposta = await supabase.rpc("get_sku_abc_breakdown", {
      ...recorte,
      p_dimension: dimension,
      p_criterion: "faturamento",
    });

    return { linhas: (resposta.data ?? []) as AbcBreakdownRow[], error: resposta.error };
  };

  const [faturamento, unidades, pedidos, porConta, ...agregados] = await Promise.all([
    curva("faturamento"),
    curva("unidades"),
    curva("pedidos"),
    lerPaginasDaRpc<SkuAccountSales>(
      async (offset, limite) => {
        const pagina = await supabase.rpc("get_sku_sales_by_account", {
          p_organization_id: input.organizationId,
          p_date_from: input.dateFrom,
          p_date_to: input.dateTo,
          p_supplier_brand: input.brand,
          p_category: input.category,
          p_kind: input.kind,
          p_limit: limite,
          p_offset: offset,
        });

        return { data: (pagina.data ?? null), error: pagina.error };
      },
      MAX_SKUS * 8,
    ),
    ...DIMENSIONS.map((d) => recorteAgregado(d)),
  ]);

  const falha =
    faturamento.error ?? unidades.error ?? pedidos.error ?? porConta.error ?? agregados.find((a) => a.error !== null)?.error ?? null;

  if (falha !== null) return { data: null, error: falha };

  const breakdowns = Object.fromEntries(DIMENSIONS.map((d, i) => [d, agregados[i]?.linhas ?? []])) as Record<
    AbcDimension,
    AbcBreakdownRow[]
  >;

  return {
    data: {
      curves: { faturamento: faturamento.linhas, unidades: unidades.linhas, pedidos: pedidos.linhas },
      breakdowns,
      byAccount: porConta.linhas,
    },
    error: null,
  };
}
