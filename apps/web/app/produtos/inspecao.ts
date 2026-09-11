"use server";

import { resolveReplenishmentPolicy, type ReplenishmentSetting } from "@sb/domain";

import { createClient } from "../../lib/supabase/server";
import { descreverCobertura, type CoberturaDescrita } from "../../lib/sku-coverage-display";

/**
 * O retrato que a gaveta "Inspeção Rápida" mostra (fatia D38).
 *
 * ## Por que é uma Server Action, e não dado da tabela
 *
 * A lista de curadoria já carrega 100 linhas; pendurar cobertura, Full e
 * última movimentação em cada uma seria pagar por 100 SKUs para mostrar UM.
 * A gaveta lê sob demanda, no clique — que é exatamente o que o frame
 * desenha: a tabela é a lista, a gaveta é a inspeção.
 *
 * ## Nenhum número novo nasce aqui
 *
 * Cada valor vem da função que JÁ é dona dele em outra tela, com a mesma
 * janela:
 *
 * | valor | fonte | quem mais usa |
 * |---|---|---|
 * | ruptura, vendas 30d, janelas de tendência | `get_stock_coverage` (`p_sku_id`) | o cartão "Cobertura" do dashboard de SKU |
 * | **cobertura em dias** | `descreverCobertura` sobre as parcelas das duas RPCs (D-314) | o MESMO módulo que o cartão "Cobertura" do dashboard de SKU usa, e a mesma conta de `/reposicao` |
 * | Full, reservado, trânsito, físico | `get_sku_dashboard` | o cartão "Estoque local" do dashboard de SKU |
 * | cobertura alvo | `replenishment_settings` + `resolveReplenishmentPolicy` | `/reposicao` |
 * | última movimentação | `stock_movements` pelo índice de extrato do SKU | `/estoque/movimentacoes` (pela RPC, que pagina) |
 *
 * A tentação era chamar `get_purchase_suggestions` com `p_search`, que traz
 * tudo numa ida. Não: ela é uma função de LISTA — filtra por `ilike` depois de
 * agregar o catálogo inteiro, e casar "o SKU certo" dentro de uma página
 * ordenada por prioridade é uma armadilha de recorte, não uma leitura. As
 * quatro daqui recebem o `sku_id` e respondem sobre ele.
 *
 * ## A janela é a mesma de `/cobertura` e do dashboard de SKU
 *
 * 30 dias encerrados HOJE. Data resolvida no servidor: `p_date_to` nulo em
 * função de janela é a armadilha que D-280 acabou de fechar em outra RPC —
 * aqui nem chega a existir, porque a data é sempre explícita.
 *
 * `organizationId` vem do cliente como em `classifySkus`, e isso é seguro
 * pelo mesmo motivo: as quatro leituras são `security invoker` sobre tabelas
 * com RLS, então um id forjado devolve VAZIO, nunca dado de outra
 * organização.
 */

const LOOKBACK_DAYS = 30;

export interface SkuInspection {
  /**
   * A cobertura já DESCRITA — valor, ressalva e a decomposição do `title`
   * (D-314).
   *
   * Era `coverageDays: number | null` com o `days_of_coverage` cru da RPC, que
   * é `local ÷ venda média` — a conta que D-288 aposentou. A gaveta e o cartão
   * do dashboard de SKU passam pelo mesmo módulo, então não conseguem imprimir
   * textos diferentes para o mesmo SKU.
   */
  cobertura: CoberturaDescrita;
  isRuptura: boolean | null;
  stockIsVirtual: boolean;
  /*
    `avgDailySales` SAIU (D-314). Ele era o divisor da conta antiga
    (`local ÷ venda média`) e, depois que a cobertura passou a vir descrita,
    ficou sem nenhum leitor — um campo desses é o número velho a um
    `{retrato.avgDailySales}` de distância de voltar à tela.
  */
  units30d: number | null;
  localQuantity: number | null;
  reservedQuantity: number | null;
  transitQuantity: number | null;
  fullQuantity: number | null;
  /** Nulo = não há política aplicável; o alvo NÃO é chutado (D-144). */
  targetCoverageDays: number | null;
  policyScope: "SKU" | "MARCA" | "PADRAO" | null;
  lastMovement: {
    occurredAt: string;
    movementType: string;
    locationKind: string;
    qtyDelta: number;
  } | null;
  /** Mensagem quando a leitura falhou — "não consegui ler" nunca vira zero. */
  error: string | null;
}

const VAZIO: SkuInspection = {
  cobertura: descreverCobertura(null),
  isRuptura: null,
  stockIsVirtual: false,
  units30d: null,
  localQuantity: null,
  reservedQuantity: null,
  transitQuantity: null,
  fullQuantity: null,
  targetCoverageDays: null,
  policyScope: null,
  lastMovement: null,
  error: null,
};

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function inspecionarSku(
  organizationId: string,
  skuId: string,
  supplierBrand: string | null,
): Promise<SkuInspection> {
  const supabase = await createClient();

  const dateTo = new Date();
  const dateFrom = new Date(dateTo);

  dateFrom.setDate(dateFrom.getDate() - (LOOKBACK_DAYS - 1));

  const [coverageResult, dashboardResult, settingsResult, movementResult] = await Promise.all([
    supabase
      .rpc("get_stock_coverage", {
        p_organization_id: organizationId,
        p_date_from: isoDate(dateFrom),
        p_date_to: isoDate(dateTo),
        p_sku_id: skuId,
      })
      .maybeSingle(),
    supabase
      .rpc("get_sku_dashboard", {
        p_organization_id: organizationId,
        p_sku_id: skuId,
        p_date_from: isoDate(dateFrom),
        p_date_to: isoDate(dateTo),
      })
      .maybeSingle(),
    supabase
      .from("replenishment_settings")
      .select("supplier_brand, sku_id, lead_time_days, target_coverage_days, safety_stock_days, max_coverage_days, policy_note"),
    /*
      A última movimentação sai da TABELA, não da RPC de `/estoque/movimentacoes`.
      Aquela filtra por TEXTO (`sku ilike`), e o código de um SKU casa qualquer
      outro que o contenha: a linha mais recente do conjunto poderia ser de
      outro produto, com a cara de ser deste. Aqui o filtro é `sku_id`, e o
      índice existe para exatamente esta pergunta —
      `stock_movements_sku_timeline_idx (organization_id, sku_id, occurred_at desc)`,
      cujo comentário na migration é "extrato de um SKU, mais recente primeiro".
      A RLS de `stock_movements` dá SELECT ao membro da organização.
    */
    supabase
      .from("stock_movements")
      .select("occurred_at, movement_type, location_kind, qty_delta")
      .eq("organization_id", organizationId)
      .eq("sku_id", skuId)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const erro =
    coverageResult.error ?? dashboardResult.error ?? settingsResult.error ?? movementResult.error;

  if (erro !== null) {
    return { ...VAZIO, error: "Não foi possível ler o retrato deste SKU." };
  }

  const coverage = coverageResult.data;
  const dashboard = dashboardResult.data;

  const settings: ReplenishmentSetting[] = (settingsResult.data ?? []).map((s) => ({
    supplierBrand: s.supplier_brand,
    skuId: s.sku_id,
    leadTimeDays: s.lead_time_days,
    targetCoverageDays: s.target_coverage_days,
    safetyStockDays: s.safety_stock_days,
    maxCoverageDays: s.max_coverage_days,
    policyNote: s.policy_note,
  }));

  const policy = resolveReplenishmentPolicy(settings, { id: skuId, supplierBrand });

  const movement = movementResult.data;

  return {
    /*
      As parcelas saem das DUAS leituras que este `Promise.all` já faz: as
      quantidades de `get_sku_dashboard` e as janelas de venda de
      `get_stock_coverage`. Zero ida nova.
    */
    cobertura: descreverCobertura(
      coverage === null || dashboard === null
        ? null
        : {
            local: dashboard.local_quantity,
            full: dashboard.full_quantity,
            transito: dashboard.transito_quantity,
            reservado: dashboard.reservado_quantity,
            stockIsVirtual: coverage.stock_is_virtual,
            units15: coverage.units_15d,
            units30: coverage.units_30d,
            units60: coverage.units_60d,
            units90: coverage.units_90d,
            historyDays90: coverage.history_days_90,
          },
    ),
    isRuptura: coverage?.is_ruptura ?? null,
    stockIsVirtual: coverage?.stock_is_virtual ?? false,
    units30d: coverage?.units_30d ?? null,
    localQuantity: dashboard?.local_quantity ?? null,
    reservedQuantity: dashboard?.reservado_quantity ?? null,
    transitQuantity: dashboard?.transito_quantity ?? null,
    fullQuantity: dashboard?.full_quantity ?? null,
    targetCoverageDays: policy?.targetCoverageDays ?? null,
    policyScope: policy?.scope ?? null,
    lastMovement:
      movement === null
        ? null
        : {
            occurredAt: movement.occurred_at,
            movementType: movement.movement_type,
            locationKind: movement.location_kind,
            qtyDelta: movement.qty_delta,
          },
    error: null,
  };
}
