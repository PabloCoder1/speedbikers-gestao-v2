"use client";

import { shiftBusinessDate, toSalesMetricDate, type ReplenishmentSetting } from "@sb/domain";
import { useEffect, useMemo, useState } from "react";

import { lerAnalise, lerMargens, type LinhaAnalise, type MargemDoSku } from "../../../../lib/purchase-analysis";
import { createClient } from "../../../../lib/supabase/browser";

/**
 * A análise de compra dos SKUs do pedido (D-721), lida no navegador como a
 * sugestão de D-371: uma leitura por conjunto de SKUs, com espera curta, e
 * nunca bloqueando o pedido — falhou, a revisão diz "indisponível" e o
 * comprador segue.
 *
 * Três leituras: a análise (com a sugestão), a margem de 30 dias e SÓ as regras
 * de reposição que alcançam estes SKUs (a do SKU, a da marca dele e o padrão) —
 * nunca a tabela inteira de regras, que passa de 1.000 linhas (D-679).
 */

export const DIAS_MARGEM_PEDIDO = 30;
const LIMITE = 500;

export interface AnalisePedido {
  readonly linhas: ReadonlyMap<string, LinhaAnalise>;
  readonly margens: ReadonlyMap<string, MargemDoSku>;
  readonly settings: readonly ReplenishmentSetting[];
  readonly margemMinima: number;
  readonly newProductDays: number;
  readonly lojasTiktok: number;
  readonly periodo: { readonly de: string; readonly ate: string };
}

export type EstadoAnalise = "ocioso" | "carregando" | "pronta" | "indisponivel";

/** Aspas do PostgREST para valores de `in.(...)` — a marca vem do cadastro e pode ter vírgula. */
function citar(valor: string): string {
  return `"${valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A leitura em si — usada pelo hook e por "Trazer produtos do fornecedor". */
export async function carregarAnalisePedido(params: {
  readonly organizationId: string;
  readonly skuIds: readonly string[];
  readonly supplierId: string | null;
  readonly orderId: string | undefined;
}): Promise<AnalisePedido | null> {
  const { organizationId, supplierId, orderId } = params;
  const ids = [...new Set(params.skuIds)].slice(0, LIMITE);

  if (ids.length === 0) return null;

  const supabase = createClient();
  const hoje = toSalesMetricDate(new Date());
  const [a, m] = await Promise.all([
    supabase.rpc("get_purchase_analysis", {
      p_organization_id: organizationId,
      p_sku_ids: ids,
      p_date_to: hoje,
      ...(orderId === undefined ? {} : { p_exclude_order_id: orderId }),
      ...(supplierId === null ? {} : { p_supplier_id: supplierId }),
    }),
    supabase.rpc("get_sku_margins", {
      p_organization_id: organizationId,
      p_sku_ids: ids,
      p_date_from: shiftBusinessDate(hoje, -(DIAS_MARGEM_PEDIDO - 1)),
      p_date_to: hoje,
    }),
  ]);

  const lida = a.error === null ? lerAnalise(a.data) : null;
  const margens = m.error === null ? lerMargens(m.data) : null;

  if (lida === null || margens === null) return null;

  const marcas = [...new Set(lida.linhas.flatMap((l) => (l.supplier_brand === null ? [] : [l.supplier_brand])))];
  const filtros = [`sku_id.in.(${ids.join(",")})`, "and(sku_id.is.null,supplier_brand.is.null)"];

  if (marcas.length > 0) filtros.push(`and(sku_id.is.null,supplier_brand.in.(${marcas.map(citar).join(",")}))`);

  const regras = await supabase
    .from("replenishment_settings")
    .select("supplier_brand, sku_id, lead_time_days, target_coverage_days, safety_stock_days, max_coverage_days, policy_note")
    .eq("organization_id", organizationId)
    .or(filtros.join(","))
    .limit(LIMITE + marcas.length + 1);

  if (regras.error !== null) return null;

  return {
    linhas: new Map(lida.linhas.map((l) => [l.sku_id, l])),
    margens: margens.porSku,
    settings: regras.data.map((r) => ({
      supplierBrand: r.supplier_brand,
      skuId: r.sku_id,
      leadTimeDays: r.lead_time_days,
      targetCoverageDays: r.target_coverage_days,
      safetyStockDays: r.safety_stock_days,
      maxCoverageDays: r.max_coverage_days,
      policyNote: r.policy_note,
    })),
    margemMinima: lida.margemMinima,
    newProductDays: lida.newProductDays,
    lojasTiktok: margens.lojasTiktok,
    periodo: { de: margens.de, ate: margens.ate },
  };
}

export function useAnalisePedido(params: {
  readonly organizationId: string | undefined;
  readonly skuIds: readonly string[];
  readonly supplierId: string | null;
  readonly orderId: string | undefined;
}): { analise: AnalisePedido | null; estado: EstadoAnalise; foraDoLimite: number } {
  const { organizationId, supplierId, orderId } = params;
  const chave = useMemo(() => [...new Set(params.skuIds)].sort().join(","), [params.skuIds]);
  const [analise, setAnalise] = useState<AnalisePedido | null>(null);
  const [estado, setEstado] = useState<EstadoAnalise>("ocioso");

  useEffect(() => {
    if (organizationId === undefined || chave === "") {
      setAnalise(null);
      setEstado("ocioso");

      return;
    }

    const vigente = { sim: true };

    setEstado("carregando");

    const espera = setTimeout(() => {
      void carregarAnalisePedido({ organizationId, skuIds: chave.split(","), supplierId, orderId }).then((lida) => {
        if (!vigente.sim) return;

        if (lida === null) {
          setEstado("indisponivel");

          return;
        }

        setAnalise(lida);
        setEstado("pronta");
      });
    }, 400);

    return () => {
      vigente.sim = false;
      clearTimeout(espera);
    };
  }, [chave, organizationId, supplierId, orderId]);

  const total = chave === "" ? 0 : chave.split(",").length;

  return { analise, estado, foraDoLimite: Math.max(0, total - LIMITE) };
}
