/**
 * A série diária do C-53 (`get_marketplace_sales_daily`) INTEIRA, em páginas
 * (D-496). Uma linha por dia e marketplace, mais o total do dia: no "Todos",
 * três por dia. O período personalizado de `/vendas` não tem teto, e acima de
 * ~333 dias a leitura numa ida só passava do `max_rows = 1000` do PostgREST —
 * cortada em silêncio, o gráfico e o CSV perderiam o fim do período (D-131).
 *
 * A ordem é estável entre as páginas: dia e marketplace são a chave da linha
 * (o total do dia tem marketplace nulo, por último). A MESMA leitura serve a
 * tela e o CSV, para os dois nunca divergirem.
 */

import type { Database } from "@sb/db";

import { lerPaginasDaRpc } from "./rpc-pages";
import type { createClient } from "./supabase/server";

type Supabase = Awaited<ReturnType<typeof createClient>>;

type Argumentos = Database["public"]["Functions"]["get_marketplace_sales_daily"]["Args"];
type Linha = Database["public"]["Functions"]["get_marketplace_sales_daily"]["Returns"][number];

/** O teto da série: ~4,5 anos no "Todos". Passou dele, quem chama diz — nunca corta calado. */
export const TETO_DA_SERIE = 5000;

export function lerSerieDiaria(
  supabase: Supabase,
  argumentos: Argumentos,
): Promise<{ linhas: Linha[]; error: { message: string } | null }> {
  return lerPaginasDaRpc(
    (offset, limite) =>
      supabase
        .rpc("get_marketplace_sales_daily", argumentos)
        .order("dia")
        .order("marketplace", { nullsFirst: false })
        .range(offset, offset + limite - 1),
    TETO_DA_SERIE,
  );
}

type ArgumentosDoMl = Database["public"]["Functions"]["get_sales_daily_series"]["Args"];
type LinhaDoMl = Database["public"]["Functions"]["get_sales_daily_series"]["Returns"][number];

/**
 * A série diária da `/vendas` do Mercado Livre (`get_sales_daily_series`, com a
 * conta e a marca) INTEIRA, em páginas e por dia (D-602) -- a mesma defesa da
 * série do "Todos": um dia por linha passa das 1.000 com ~2,7 anos de período
 * personalizado. Devolve `{ data, error }`, o formato que a página já lia da RPC;
 * o CSV do recorte usa a MESMA leitura.
 */
export async function lerSerieDoMl(
  supabase: Supabase,
  argumentos: ArgumentosDoMl,
): Promise<{ data: LinhaDoMl[]; error: { message: string } | null }> {
  const { linhas, error } = await lerPaginasDaRpc(
    (offset, limite) =>
      supabase
        .rpc("get_sales_daily_series", argumentos)
        .order("metric_date")
        .range(offset, offset + limite - 1),
    TETO_DA_SERIE,
  );

  return { data: linhas, error };
}
