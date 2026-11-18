import { shiftBusinessDate } from "@sb/domain";
import type { CorrelatedEvent } from "@sb/domain";

import { lerPaginasDaRpc } from "./rpc-pages";
import type { createClient } from "./supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

export const CORRELATION_WINDOW_DAYS_BEFORE = 3;
export const CORRELATION_WINDOW_DAYS_AFTER = 1;

/** Janela do preço médio para o impacto — a mesma dos outros dois consumidores. */
export const AVERAGE_PRICE_WINDOW_DAYS = 30;

/** Teto amplo para não cortar em `max_rows = 1000` sem travar memória em consultas anômalas. */
export const TETO_DIAGNOSTICO = 20_000;

/** Limite por lote no `.in()` do PostgREST para não estourar a query string da URL. */
export const DIAGNOSTICO_CHUNK = 200;

export interface BaselineRow {
  sku_id: string;
  sku: string;
  title: string | null;
  weekday: number;
  current_units_sold: number;
  baseline_mean: number;
  baseline_stddev: number;
  sample_count: number;
}

const contarPrimeira = (offset: number): { count: "exact" } | undefined =>
  offset === 0 ? { count: "exact" } : undefined;

function fatiar<T>(itens: readonly T[], tamanho: number): T[][] {
  const lotes: T[][] = [];

  for (let i = 0; i < itens.length; i += tamanho) {
    lotes.push(itens.slice(i, i + tamanho));
  }

  return lotes;
}

/**
 * Lê todo o baseline do recorte padrão (`ML`) acima de `max_rows = 1000`
 * (D-739). Usa `{ count: "exact" }` só na primeira página para encerrar em uma
 * única ida quando o catálogo cabe nela.
 */
export async function lerBaselineDoDiagnostico(
  supabase: Supabase,
  organizationId: string,
  asOf: string,
): Promise<{ data: BaselineRow[]; error: { message: string } | null }> {
  const { linhas, error } = await lerPaginasDaRpc(
    (offset, limite) =>
      supabase
        .rpc(
          "get_sku_sales_baseline",
          { p_organization_id: organizationId, p_as_of: asOf },
          contarPrimeira(offset),
        )
        // Sem `p_marketplaces`, o retorno tem uma linha única por SKU.
        .order("sku_id")
        .range(offset, offset + limite - 1),
    TETO_DIAGNOSTICO,
  );

  if (error !== null) {
    return { data: [], error };
  }

  return { data: linhas, error: null };
}

/**
 * Lê eventos correlatos (paginados) e reclamações abertas (em lotes `.in` de
 * `DIAGNOSTICO_CHUNK` também paginados). Se qualquer lote de SAC falhar,
 * descarta leituras parciais para não inventar "zero reclamações" (D-067).
 */
export async function lerEvidenciasDoDiagnostico(
  supabase: Supabase,
  organizationId: string,
  asOf: string,
  candidateSkuIds: readonly string[],
): Promise<{
  eventsBySku: Map<string, CorrelatedEvent[]>;
  openClaimsBySku: Map<string, Set<string>>;
  eventsError: { message: string } | null;
  claimsError: { message: string } | null;
}> {
  const eventsBySku = new Map<string, CorrelatedEvent[]>();
  const openClaimsBySku = new Map<string, Set<string>>();

  if (candidateSkuIds.length === 0) {
    return { eventsBySku, openClaimsBySku, eventsError: null, claimsError: null };
  }

  const windowStart = shiftBusinessDate(asOf, -CORRELATION_WINDOW_DAYS_BEFORE);
  const windowEnd = shiftBusinessDate(asOf, CORRELATION_WINDOW_DAYS_AFTER);
  const skuIds = [...candidateSkuIds];

  const [eventsResult, claimChunkResults] = await Promise.all([
    lerPaginasDaRpc(
      (offset, limite) =>
        supabase
          .rpc(
            "get_sku_correlated_events",
            {
              p_organization_id: organizationId,
              p_sku_ids: skuIds,
              p_from: windowStart,
              p_to: windowEnd,
            },
            contarPrimeira(offset),
          )
          .order("sku_id")
          .order("occurred_at")
          .order("event_type")
          .order("marketplace", { nullsFirst: true })
          .range(offset, offset + limite - 1),
      TETO_DIAGNOSTICO,
    ),
    Promise.all(
      fatiar(skuIds, DIAGNOSTICO_CHUNK).map((skuChunk) =>
        lerPaginasDaRpc(
          (offset, limite) =>
            supabase
              .from("support_case_links")
              .select(
                "sku_id, support_case_id, support_cases!inner(internal_status, channel)",
                contarPrimeira(offset),
              )
              .in("sku_id", skuChunk)
              .eq("support_cases.channel", "CLAIM")
              .neq("support_cases.internal_status", "RESOLVIDO")
              .order("id")
              .range(offset, offset + limite - 1),
          TETO_DIAGNOSTICO,
        ),
      ),
    ),
  ]);

  if (eventsResult.error === null) {
    for (const event of eventsResult.linhas) {
      const list = eventsBySku.get(event.sku_id) ?? [];
      list.push({ eventType: event.event_type, occurredAt: new Date(event.occurred_at) });
      eventsBySku.set(event.sku_id, list);
    }
  }

  const claimsError = claimChunkResults.find((chunkResult) => chunkResult.error !== null)?.error ?? null;

  if (claimsError === null) {
    for (const chunkResult of claimChunkResults) {
      for (const link of chunkResult.linhas) {
        if (link.sku_id === null) continue;

        const set = openClaimsBySku.get(link.sku_id) ?? new Set<string>();
        set.add(link.support_case_id);
        openClaimsBySku.set(link.sku_id, set);
      }
    }
  }

  return {
    eventsBySku,
    openClaimsBySku,
    eventsError: eventsResult.error,
    claimsError,
  };
}

/**
 * Lê preços médios paginados acima de 1.000 linhas com ordem estável.
 */
export async function lerPrecosMediosDoDiagnostico(
  supabase: Supabase,
  organizationId: string,
  asOf: string,
  skuIds: readonly string[],
): Promise<{ precoPorSku: Map<string, number>; error: { message: string } | null }> {
  const precoPorSku = new Map<string, number>();

  if (skuIds.length === 0) {
    return { precoPorSku, error: null };
  }

  const { linhas, error } = await lerPaginasDaRpc(
    (offset, limite) =>
      supabase
        .rpc(
          "get_sku_average_prices",
          {
            p_organization_id: organizationId,
            p_sku_ids: [...skuIds],
            p_date_from: shiftBusinessDate(asOf, -AVERAGE_PRICE_WINDOW_DAYS),
            p_date_to: asOf,
          },
          contarPrimeira(offset),
        )
        .order("sku_id")
        .order("marketplace")
        .range(offset, offset + limite - 1),
    TETO_DIAGNOSTICO,
  );

  if (error !== null) {
    return { precoPorSku, error };
  }

  for (const linha of linhas) {
    precoPorSku.set(linha.sku_id, linha.average_price);
  }

  return { precoPorSku, error: null };
}
