import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@sb/db";

import { lerPaginasDaRpc } from "../../../lib/rpc-pages";
import type { AbcCriterionKey, AbcCurveRow, SkuExtra } from "./rows";

/**
 * A leitura do Excel da Curva ABC.
 *
 * As TRÊS curvas saem do mesmo recorte da tela (período, conta, marca, "sem
 * Full") pela mesma RPC da tela, uma vez por critério. A classe escolhida na
 * tela NÃO filtra o arquivo: a planilha leva a curva inteira e o filtro
 * automático da coluna "Classe" faz o recorte -- e a frase do recorte diz isso.
 *
 * Tudo em páginas de 1.000 (`lerPaginasDaRpc`): a RPC devolve `returns table`,
 * e o `max_rows` do PostgREST cortaria em silêncio (auditoria de 28/09). As
 * cinco leituras saem juntas -- nenhuma depende de outra --, então o tempo é
 * o da mais lenta, não a soma.
 */

/** Acima disso o arquivo pesa e a rota arrisca o tempo; a curva real tem ~1,5 mil SKUs. */
export const MAX_SKUS = 20_000;

export interface AbcExportData {
  curves: Record<AbcCriterionKey, AbcCurveRow[]>;
  extras: Map<string, SkuExtra>;
}

export async function loadAbcExportData(
  supabase: SupabaseClient<Database>,
  input: {
    organizationId: string;
    dateFrom: string;
    dateTo: string;
    accountId: string | null;
    brand: string | null;
    onlyWithoutFull: boolean;
  },
): Promise<{ data: AbcExportData | null; error: { message: string } | null }> {
  const curva = (criterion: AbcCriterionKey) =>
    lerPaginasDaRpc<AbcCurveRow>(
      async (offset, limite) => {
        const pagina = await supabase.rpc("get_sku_abc_curve", {
          p_organization_id: input.organizationId,
          p_date_from: input.dateFrom,
          p_date_to: input.dateTo,
          p_ml_account_id: input.accountId,
          p_criterion: criterion,
          p_only_without_full: input.onlyWithoutFull,
          p_supplier_brand: input.brand,
          p_limit: limite,
          p_offset: offset,
        });

        return { data: (pagina.data ?? null) as AbcCurveRow[] | null, error: pagina.error };
      },
      MAX_SKUS,
    );

  const [faturamento, unidades, pedidos, skus, saldos] = await Promise.all([
    curva("faturamento"),
    curva("unidades"),
    curva("pedidos"),
    // Ordem estável por chave única: sem ela, duas páginas podem repetir ou
    // pular um SKU.
    lerPaginasDaRpc(
      async (offset, limite) =>
        supabase
          .from("skus")
          .select("id, supplier_brand, purchase_cost")
          .eq("organization_id", input.organizationId)
          .order("id")
          .range(offset, offset + limite - 1),
      MAX_SKUS * 4,
    ),
    lerPaginasDaRpc(
      async (offset, limite) =>
        supabase
          .from("inventory_balances")
          .select("sku_id, quantity")
          .eq("organization_id", input.organizationId)
          .eq("location_kind", "LOCAL")
          .order("sku_id")
          .range(offset, offset + limite - 1),
      MAX_SKUS * 4,
    ),
  ]);

  const falha = faturamento.error ?? unidades.error ?? pedidos.error ?? skus.error ?? saldos.error;

  if (falha !== null) return { data: null, error: falha };

  const estoqueLocal = new Map(saldos.linhas.map((s) => [s.sku_id, s.quantity]));
  const extras = new Map<string, SkuExtra>(
    skus.linhas.map((s) => [
      s.id,
      {
        supplierBrand: s.supplier_brand,
        purchaseCost: s.purchase_cost,
        // Sem linha de saldo é "não registrado", não zero (D-067).
        localStock: estoqueLocal.get(s.id) ?? null,
      },
    ]),
  );

  return {
    data: { curves: { faturamento: faturamento.linhas, unidades: unidades.linhas, pedidos: pedidos.linhas }, extras },
    error: null,
  };
}
