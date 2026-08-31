import type { AdminClient } from "@sb/db";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

import { readAllPages } from "../read-all-pages.js";
import { listingVisitsTimeWindowSchema } from "./listing-visits-schema.js";

/**
 * Sincronização de visitas por anúncio (D-032, docs/ROADMAP.md Fase 5B) — a
 * peça pura de fetch+persist, mesmo split de `ml-listings-fetch.ts`.
 *
 * **Enumeração pelo CATÁLOGO (`listings`), status ATIVO** — não mais por
 * `sku_listing_links` (D-124). A enumeração por vínculo tinha duas falhas ao
 * mesmo tempo: deixava de fora anúncio com variação e anúncio sem vínculo
 * (1.539 ativos, medido), e gastava chamada em item que nem está ativo
 * (1.866, medido). Trocar melhora cobertura E baixa a carga: 3.252 chamadas
 * contra 3.579.
 *
 * `daily_listing_visits` não exige SKU (grão é conta+item), então anúncio sem
 * vínculo é sincronizável — diferente de Full, cujo `sku_id` é NOT NULL.
 *
 * Só ATIVOS de propósito: a API de visitas aceita **1 item por chamada**
 * (`docs/MERCADO_LIVRE.md` secao 2.15), então cada item custa uma requisição
 * por dia. Anúncio pausado ou encerrado não recebe tráfego relevante, e as
 * linhas históricas dele continuam onde estão.
 *
 * `last=3`: pega os últimos 3 dias a cada rodada (a de ontem, que já
 * fechou, mais hoje e anteontem de reforço) — a cadência do job é DIÁRIA
 * (`sync-listing-visits-snapshot.ts`), então uma folga de um dia extra
 * absorve uma rodada perdida sem esperar até o próximo dia.
 *
 * **Rate limit por medição (D-156).** Produção media ~22 execuções falhas/dia
 * por 429 sustentado (85% das execuções, D-143), porque o laço disparava
 * ~850 chamadas em rajada e a falha no meio DESCARTAVA o progresso — a
 * tentativa seguinte do Cloud Tasks recomeçava do zero, em rajada de novo,
 * com teto de 8 tentativas na fila. Duas defesas, nesta ordem de importância:
 *
 * 1. **Checkpoint pela própria tabela**: item com linha gravada nas últimas
 *    12h é pulado. Cada tentativa passa a SOMAR progresso em vez de repetir
 *    o já feito — o esgotamento das 8 tentativas deixa de perder a cauda.
 *    Item com escrita parcial (uma das 3 datas falhou) pode ser pulado até a
 *    janela expirar; o `last=3` da rodada seguinte recobre essas datas, que é
 *    exatamente a folga para a qual ele existe.
 * 2. **Espaçamento entre chamadas**: a rajada é o gatilho do 429 sustentado
 *    (a execução que completa faz ~280 ms/item; as que morrem, full speed).
 *    Sem número oficial de rate limit (D-042), o valor é conservador e
 *    ajustável por medição — nunca por chute.
 */

const LAST_DAYS = 3;

/**
 * ~6-7 chamadas/s no pior caso. Custo: +~2 min numa varredura completa de
 * ~850 itens (timeout do worker é 900s; a varredura completa media ~240s).
 */
const INTER_ITEM_DELAY_MS = 150;

/**
 * Menor que a cadência diária (24h) e maior que a cauda de retries da fila
 * (min-backoff 10s, max 600s, 8 tentativas ⇒ ~2h). Livre de fuso de
 * propósito: "sincronizado há menos de 12h" não depende de onde a meia-noite
 * cai.
 */
const CHECKPOINT_WINDOW_HOURS = 12;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchListingVisitsParams {
  db: AdminClient;
  organizationId: string;
  mlAccountId: string;
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  logger: Logger;
  now?: () => Date;
  /** Injetável para teste determinístico — produção usa `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchListingVisitsResult {
  itemsProcessed: number;
  /** Erro NÃO retryable do Mercado Livre (ex.: 404 — anúncio removido) — mesmo tratamento de Full/listings. */
  itemsFailed: number;
  /** Já sincronizados na janela do checkpoint — trabalho que uma tentativa anterior fez e esta não repete. */
  itemsSkipped: number;
}

export async function fetchListingVisits(
  params: FetchListingVisitsParams,
): Promise<FetchListingVisitsResult> {
  const syncedAt = params.now?.() ?? new Date();
  const sleep = params.sleep ?? defaultSleep;

  // Paginado (D-131): a maior conta tem 857 ativos MEDIDOS contra o teto de
  // 1.000 do PostgREST — sem `.range()`, o crescimento do catálogo truncaria
  // a enumeração em silêncio. `item_id` é único dentro da conta.
  const listings = await readAllPages<{ item_id: string }>(
    (from, to) =>
      params.db
        .from("listings")
        .select("item_id")
        .eq("ml_account_id", params.mlAccountId)
        .eq("status", "active")
        .order("item_id")
        .range(from, to),
    { label: "falha ao ler listings" },
  );

  const checkpointCutoff = new Date(
    syncedAt.getTime() - CHECKPOINT_WINDOW_HOURS * 3_600_000,
  ).toISOString();

  // Até 3 linhas por item (uma por metric_date da mesma rodada) — ordenação
  // pelo par único da conta, dedupe no Set.
  const recentRows = await readAllPages<{ item_id: string }>(
    (from, to) =>
      params.db
        .from("daily_listing_visits")
        .select("item_id")
        .eq("ml_account_id", params.mlAccountId)
        .gte("synced_at", checkpointCutoff)
        .order("item_id")
        .order("metric_date")
        .range(from, to),
    { label: "falha ao ler o checkpoint de daily_listing_visits" },
  );

  const alreadySynced = new Set(recentRows.map((row) => row.item_id));

  let itemsProcessed = 0;
  let itemsFailed = 0;
  let itemsSkipped = 0;
  let requestsMade = 0;

  for (const listing of listings) {
    if (alreadySynced.has(listing.item_id)) {
      itemsSkipped += 1;

      continue;
    }

    if (requestsMade > 0) {
      await sleep(INTER_ITEM_DELAY_MS);
    }

    requestsMade += 1;

    let timeWindow;

    try {
      timeWindow = await params.mercadoLivre.request({
        method: "GET",
        path: `/items/${listing.item_id}/visits/time_window`,
        accessToken: params.accessToken,
        searchParams: { last: LAST_DAYS, unit: "day" },
        schema: listingVisitsTimeWindowSchema,
      });
    } catch (error) {
      if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
        itemsFailed += 1;
        params.logger.warn("listing_visits_fetch_failed", {
          ml_account_id: params.mlAccountId,
          item_id: listing.item_id,
          reason: error.message,
        });

        continue;
      }

      // Retryable (429/5xx) esgotado: propaga e a fila tenta de novo — mas o
      // progresso já persistido fica, e o checkpoint acima faz a próxima
      // tentativa continuar daqui em vez de recomeçar (D-156).
      throw error;
    }

    let recorded = true;

    for (const entry of timeWindow.results) {
      const result = await params.db.from("daily_listing_visits").upsert(
        {
          organization_id: params.organizationId,
          ml_account_id: params.mlAccountId,
          item_id: listing.item_id,
          // Data de negócio, sem hora — mesmo raciocínio de `formatBusinessDate`:
          // manipulação de string, nunca `new Date(...)`, para não deslocar o
          // dia por fuso (a API devolve `"2021-08-04T00:00:00Z"`).
          metric_date: entry.date.slice(0, 10),
          visits: entry.total,
          synced_at: syncedAt.toISOString(),
        },
        { onConflict: "ml_account_id,item_id,metric_date" },
      );

      if (result.error !== null) {
        params.logger.error("listing_visits_not_recorded", {
          ml_account_id: params.mlAccountId,
          item_id: listing.item_id,
          metric_date: entry.date.slice(0, 10),
          reason: result.error.message,
        });

        recorded = false;
      }
    }

    if (recorded) {
      itemsProcessed += 1;
    }
  }

  return { itemsProcessed, itemsFailed, itemsSkipped };
}
