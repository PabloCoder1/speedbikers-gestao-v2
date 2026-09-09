import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@sb/db";

import { resolvePriceWindow, type PriceFilters } from "../../../lib/price-filters";
import type { PriceChangeExportInput } from "./rows";

/**
 * A leitura da exportação de `/precos` (D-292) — a mesma consulta da tela, sem
 * a janela de página.
 *
 * ## Por que isto pagina, se a tela já pagina
 *
 * A tela mostra 50 por vez; a planilha existe justamente para levar o recorte
 * INTEIRO. Só que "inteiro" esbarra em dois tetos, e ignorar qualquer um deles
 * produziria o defeito que esta casa persegue desde D-131: um arquivo que
 * parece completo e não é.
 *
 *  1. **`max_rows = 1000` do PostgREST** (`supabase/config.toml`): pedir
 *     "tudo" numa ida devolve mil linhas e nenhum aviso.
 *  2. **memória do processo**: montar uma planilha de 200 mil linhas em RAM
 *     derruba a rota, e uma rota que às vezes derruba é pior do que um teto
 *     declarado.
 *
 * Daí o laço de páginas de `PAGE` até `MAX_ROWS`, e o campo `truncated`, que
 * **a planilha imprime em vez de esconder**. Medido no Dev em 2026-09-09:
 * `listing.price.changed` tem **244 eventos no total** (45 nos últimos 7
 * dias), então hoje nenhum recorte chega perto do teto — ele existe para o dia
 * em que chegar, e para que nesse dia o arquivo diga a verdade.
 */

/** O teto do PostgREST. Pedir mais numa ida só devolve mil em silêncio. */
const PAGE = 1000;

/**
 * Teto da exportação. 20 mil linhas dão uma planilha de alguns megabytes e
 * cabem na memória de um pedido; acima disso o honesto é dizer que faltou, não
 * arriscar a rota inteira.
 */
export const MAX_ROWS = 20_000;

export interface PriceExportData {
  rows: PriceChangeExportInput[];
  totalCount: number;
  /** `true` quando o recorte é maior que `MAX_ROWS` — a planilha diz isso. */
  truncated: boolean;
  seriesStart: string | null;
  dayFrom: string;
  dayTo: string | null;
}

export async function loadPriceExportData(
  supabase: SupabaseClient<Database>,
  organizationId: string,
  filters: PriceFilters,
  account: string | null,
  now: Date,
): Promise<{ data: PriceExportData | null; error: { message: string } | null }> {
  const janela = resolvePriceWindow(filters, now);

  const rows: PriceChangeExportInput[] = [];
  let totalCount = 0;
  let seriesStart: string | null = null;

  for (let offset = 0; offset < MAX_ROWS; offset += PAGE) {
    const { data, error } = await supabase.rpc("get_price_changes", {
      p_organization_id: organizationId,
      p_date_from: janela.from,
      p_date_to: janela.to,
      p_ml_account_id: account,
      p_direction: filters.direction,
      p_search: filters.search,
      p_limit: PAGE,
      p_offset: offset,
    });

    if (error !== null) {
      return { data: null, error };
    }

    // `data` nao e anulavel depois da checagem de erro (o PostgREST garante o
    // array) — e o lint acusa a condicao morta, que esconderia a leitura real.
    const pagina = data;

    // O total e o início da série vêm de QUALQUER linha (a RPC os repete em
    // todas), e da primeira página basta: eles descrevem o recorte, não a
    // página. Recorte vazio devolve zero linhas, e aí o total é zero mesmo —
    // é a mesma leitura que a tela faz (D-264).
    if (offset === 0) {
      totalCount = pagina[0]?.total_count ?? 0;
      seriesStart = pagina[0]?.series_start ?? null;
    }

    rows.push(...(pagina as PriceChangeExportInput[]));

    if (pagina.length < PAGE) break;
  }

  return {
    data: {
      rows,
      totalCount,
      truncated: totalCount > rows.length,
      seriesStart,
      dayFrom: janela.dayFrom,
      dayTo: janela.dayTo,
    },
    error: null,
  };
}
