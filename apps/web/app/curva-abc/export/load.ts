import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@sb/db";

import { lerPaginasDaRpc } from "../../../lib/rpc-pages";
import type { AbcAnalysisRow, AbcBreakdownRow, AbcCurves, AbcDimension, SkuAccountSales, TerceiroCriterio } from "./rows";

/**
 * A leitura do Excel da Curva ABC (D-422, ampliada em D-424 e em D-450).
 *
 * - As TRÊS curvas pela `get_sku_abc_analysis`, a mesma RPC da tela, uma vez
 *   por critério: faturamento, unidades e pedidos -- ou COMPRAS, com a Shopee
 *   no recorte (o pedido do ML não soma com o dela, e a função o recusa lá).
 *   Cada uma traz a classe nos critérios, o período anterior, estoque e
 *   cobertura.
 * - Os recortes agregados do painel (conta, marca, categoria, mês, migração e,
 *   no "Todos", marketplace) pela `get_sku_abc_breakdown`: soma no Postgres,
 *   nunca aqui.
 * - A venda por SKU e conta (`get_sku_sales_by_account`) para a aba "Por
 *   conta" -- com a Shopee, uma coluna por conta ML e por loja.
 *
 * O arquivo leva o RECORTE da tela (marketplace, período, conta, marca,
 * categoria, tipo e "sem Full"); os filtros de linha (classe, estoque,
 * movimento, busca) não restringem -- viram o filtro automático das colunas, e
 * a frase do recorte diz isso.
 *
 * Tudo em páginas de 1.000 (`lerPaginasDaRpc`): a RPC devolve `returns table`,
 * e o `max_rows` do PostgREST cortaria em silêncio. As leituras saem juntas.
 */

/** Acima disso o arquivo pesa e a rota arrisca o tempo; a curva real tem ~1,8 mil SKUs. */
export const MAX_SKUS = 20_000;

export const DIMENSIONS: readonly Exclude<AbcDimension, "marketplace">[] = ["conta", "marca", "categoria", "mes", "migracao"];

export interface AbcExportInput {
  organizationId: string;
  dateFrom: string;
  dateTo: string;
  prevFrom: string;
  prevTo: string;
  /** Só no recorte ML: a conta pelo id (`p_ml_account_id`), como sempre. */
  accountId: string | null;
  brand: string | null;
  category: string | null;
  kind: string | null;
  onlyWithoutFull: boolean;
  /**
   * D-450: nulo = o recorte Mercado Livre de sempre, com as chamadas de antes.
   * Com marketplaces, as contas vão em `p_account_ids` (C-60).
   */
  marketplaces?: readonly ("ML" | "SHOPEE")[] | null;
  accountIds?: readonly string[] | null;
}

export interface AbcExportData {
  curves: AbcCurves;
  breakdowns: Readonly<Record<Exclude<AbcDimension, "marketplace">, AbcBreakdownRow[]>> & {
    readonly marketplace?: AbcBreakdownRow[];
  };
  byAccount: SkuAccountSales[];
}

export async function loadAbcExportData(
  supabase: SupabaseClient<Database>,
  input: AbcExportInput,
): Promise<{ data: AbcExportData | null; error: { message: string } | null }> {
  const marketplaces = input.marketplaces ?? null;
  const multicanal = marketplaces !== null;
  const terceiro: TerceiroCriterio = multicanal && marketplaces.includes("SHOPEE") ? "compras" : "pedidos";
  // O "Todos" ganha o recorte por marketplace; com um só, ele seria uma linha.
  const porMarketplace = multicanal && marketplaces.includes("ML") && marketplaces.includes("SHOPEE");

  const recorte = {
    p_organization_id: input.organizationId,
    p_date_from: input.dateFrom,
    p_date_to: input.dateTo,
    p_prev_from: input.prevFrom,
    p_prev_to: input.prevTo,
    // O recorte ML chama as funções EXATAMENTE como antes (C-60: marketplace
    // nulo = só ML); fora dele, a conta vai em p_account_ids.
    ...(multicanal
      ? { p_marketplaces: [...marketplaces], p_account_ids: input.accountIds === undefined || input.accountIds === null ? null : [...input.accountIds] }
      : { p_ml_account_id: input.accountId }),
    p_supplier_brand: input.brand,
    p_category: input.category,
    p_kind: input.kind,
  };

  const curva = (criterion: "faturamento" | "unidades" | TerceiroCriterio) =>
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

  const dimensoes: readonly AbcDimension[] = porMarketplace ? [...DIMENSIONS, "marketplace"] : DIMENSIONS;

  const [faturamento, unidades, terceira, porConta, ...agregados] = await Promise.all([
    curva("faturamento"),
    curva("unidades"),
    curva(terceiro),
    lerPaginasDaRpc<SkuAccountSales>(
      async (offset, limite) => {
        const pagina = await supabase.rpc("get_sku_sales_by_account", {
          p_organization_id: input.organizationId,
          p_date_from: input.dateFrom,
          p_date_to: input.dateTo,
          p_supplier_brand: input.brand,
          p_category: input.category,
          p_kind: input.kind,
          // A aba mostra TODAS as contas do marketplace, mesmo com uma escolhida.
          ...(multicanal ? { p_marketplaces: [...marketplaces] } : {}),
          p_limit: limite,
          p_offset: offset,
        });

        return { data: pagina.data ?? null, error: pagina.error };
      },
      MAX_SKUS * 8,
    ),
    ...dimensoes.map((d) => recorteAgregado(d)),
  ]);

  const falha =
    faturamento.error ?? unidades.error ?? terceira.error ?? porConta.error ?? agregados.find((a) => a.error !== null)?.error ?? null;

  if (falha !== null) return { data: null, error: falha };

  const linhasDe = (d: AbcDimension): AbcBreakdownRow[] => agregados[dimensoes.indexOf(d)]?.linhas ?? [];
  const base = {
    conta: linhasDe("conta"),
    marca: linhasDe("marca"),
    categoria: linhasDe("categoria"),
    mes: linhasDe("mes"),
    migracao: linhasDe("migracao"),
  };

  return {
    data: {
      curves:
        terceiro === "compras"
          ? { faturamento: faturamento.linhas, unidades: unidades.linhas, compras: terceira.linhas }
          : { faturamento: faturamento.linhas, unidades: unidades.linhas, pedidos: terceira.linhas },
      breakdowns: porMarketplace ? { ...base, marketplace: linhasDe("marketplace") } : base,
      byAccount: porConta.linhas,
    },
    error: null,
  };
}
