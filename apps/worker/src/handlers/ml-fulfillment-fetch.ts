import type { AdminClient } from "@sb/db";
import { assertWritten } from "./assert-written.js";
import { detectFulfillmentEvents } from "@sb/domain";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { z } from "zod";

import { readAllPages } from "../read-all-pages.js";
import { recordDomainEvents } from "./domain-events.js";

/**
 * Captura do estoque Full por conta — a peça pura de fetch+persist,
 * compartilhada pelo handler de job (`sync-fulfillment-snapshot.ts`), mesmo
 * split de `ml-orders-fetch.ts`/`sync-orders-window.ts`.
 *
 * `docs/MERCADO_LIVRE.md` secao 2.7: `inventory_id` vem de `GET
 * /items/{item_id}` (campo raiz); o estoque em si vem de `GET
 * /inventories/{inventory_id}/stock/fulfillment`. Dois campos confirmados
 * contra a documentação oficial, lida ao vivo em 2026-08-22.
 *
 * **Escopo desta etapa, deliberadamente limitado**: só itens SEM variação
 * (`sku_listing_links.variation_id IS NULL`). Itens COM variação têm um
 * `inventory_id` por variação, mas a doc oficial não mostra o exemplo exato
 * de onde esse campo aparece dentro de `variations[]` — codar esse ramo sem
 * ver a resposta real violaria a REGRA ABSOLUTA de `docs/MERCADO_LIVRE.md`.
 * Fica para quando isso for confirmado (ex.: contra um XML/JSON real de
 * item com variação).
 *
 * **Paginado desde D-131 — e o "ver se vira problema real" já tinha virado.**
 * O texto anterior desta nota dizia que as quatro contas tinham "bem menos
 * que 1.000" vínculos sem variação e deixava o `.range()` para depois.
 * Medido em 2026-08-28: **2.012, 1.915, 1.784 e 1.640** — as QUATRO passaram
 * do teto de `max_rows` de `supabase/config.toml`. Ou seja, de 18% a 50% dos
 * vínculos de cada conta nunca chegavam a ser consultados, e o snapshot do
 * Full vinha pela metade sem que nada acusasse: `error` é nulo num resultado
 * truncado. A lição que fica registrada é sobre o formato da nota, não só
 * sobre o número — "hoje cabe, revisar depois" não tem quem revise.
 *
 * **Achado no primeiro disparo real em produção (2026-08-22)**: um
 * `sku_listing_links` pode apontar para um `item_id` que não existe mais no
 * Mercado Livre (anúncio removido/pausado) — `GET /items/{item_id}` devolve
 * 404. Sem tratamento por item, essa exceção derrubava a captura da conta
 * INTEIRA, e o mesmo item quebrava de novo em toda tentativa seguinte —
 * nenhum outro item da conta era processado. Corrigido com try/catch por
 * item: erro NÃO retryable (404/403 — problema DESTE item específico) conta
 * em `itemsFailed` e segue para o próximo; erro retryable (503/429/rede —
 * pode ser instabilidade afetando a conta inteira) continua propagando.
 *
 * **Dois anúncios, um estoque (D-230).** O Full é por `inventory_id`, e o
 * `inventory_id` é do PRODUTO do vendedor (`user_product`), não do anúncio —
 * `docs/MERCADO_LIVRE.md` secao 2.3: "um `user_product` pode aparecer em
 * vários itens". Dois vínculos da mesma conta podem, portanto, resolver para
 * o MESMO `inventory_id`, e a segunda gravação colide com a chave única
 * `(ml_account_id, inventory_id, captured_at)`. Até D-178 essa colisão era
 * ENGOLIDA (o `insert` não lia o retorno) e a captura fechava `done`; D-178
 * fez a escrita crítica abortar, e a primeira execução depois do deploy
 * (02/09/2026 21:00) falhou nas QUATRO contas, 8 tentativas cada — 32 falhas
 * com "duplicate key", cada tentativa gravando centenas de linhas antes de
 * morrer no mesmo lugar. O snapshot ficou 18 horas sem rodar.
 *
 * A regra agora é a do grão certo (D-173): UM snapshot por `inventory_id` por
 * captura. O primeiro vínculo (em ordem de `item_id`) grava; os seguintes com
 * o mesmo inventário são contados em `inventoriesShared` e logados com os
 * dois anúncios e se apontam para o mesmo SKU — sem segunda chamada de
 * estoque, sem segunda linha, sem abortar. Não é `partial`: é a estrutura do
 * catálogo do vendedor, não um defeito de dado.
 *
 * **Item morto sai da varredura até o recheque (18/09/2026).** O try/catch
 * por item resolveu a queda, mas não o custo: medido em produção, os MESMOS
 * 356 anúncios responderam 404 em 14 das 15 execuções de 15/09 a 18/09 (a
 * outra foi a de 403 em todos os itens) — 1.424 chamadas por dia para ouvir
 * a mesma resposta. Agora o 404/403 de
 * `GET /items/{id}` grava uma marca em `fulfillment_item_absences`, e o item
 * é pulado (`itemsDeferred`) até `recheck_after`. Sucesso posterior apaga a
 * marca. Três guardas mantêm isso do lado de "otimização", nunca de "estoque
 * escondido":
 *
 *   1. toda marca vence — as janelas estão em `ITEM_ABSENCE_RECHECK_MS`. Um
 *      404 isolado atrasa a captura 12 h, como um 403; só o segundo 404
 *      seguido leva à janela longa (recheque em 48 h). O bucket de um falso
 *      404 continua no "Full atual" (3 dias, D-173) enquanto as execuções
 *      vizinhas capturarem — é atraso, não garantia contra toda sequência de
 *      falhas;
 *   2. falha em MASSA não marca ninguém — em 16/09 21:00 as quatro contas
 *      tomaram 403 em todos os 3.220 itens de uma vez e a execução seguinte
 *      capturou normal; marcar ali teria apagado mais uma execução inteira;
 *   3. a tabela é lida e escrita em modo "falhou, segue": sem ela (erro, ou
 *      código no ar antes da migration) o worker busca todos os itens, que é
 *      o comportamento anterior.
 *
 * A tabela guarda só item VINCULADO: a marca de um item que saiu de
 * `sku_listing_links` (vínculo apagado ou refeito para outro anúncio) é
 * apagada na execução seguinte, junto com as dos itens que voltaram.
 */

const itemResponseSchema = z.object({
  id: z.string(),
  /** `null` quando o item nunca foi enviado ao Full — não é erro. */
  inventory_id: z.string().nullable(),
});

const fulfillmentStockResponseSchema = z.object({
  inventory_id: z.string(),
  /** O número acionável (o que pode vender) — não `total`, que inclui avariado/perdido/em trânsito interno. */
  available_quantity: z.number(),
});

const MAX_CONCURRENT_ML_REQUESTS = 3;

const HOUR_MS = 3_600_000;

/**
 * Quanto tempo um item que respondeu 403/404 em `GET /items/{id}` fica fora
 * da varredura. A cadência do job é de 6 h (`infra/cloud-scheduler.sh`,
 * `v3-fulfillment-snapshot`), e as duas janelas caem no MEIO do intervalo
 * entre execuções de propósito: com um múltiplo exato de 6 h, alguns segundos
 * de atraso no disparo fariam o recheque escorregar uma execução inteira.
 *
 * - **curta — 9 h: pula UMA execução e volta na seguinte.** Vale para todo
 *   403 e para o PRIMEIRO 404 de uma sequência. 403 é permissão, e permissão
 *   muda: o único 403 medido em produção (16/09 21:00) passou sozinho na
 *   execução seguinte. E um 404 isolado num anúncio vivo, se existir, custa o
 *   mesmo atraso de um 403: 12 h.
 * - **longa — 45 h: recheque na oitava execução (48 h)**, só a partir do
 *   SEGUNDO 404 seguido (`failures >= 2`). 404 em `/items/{id}` é anúncio que
 *   não existe mais: os 356 medidos responderam 404 em 14 das 15 execuções de
 *   72 h (a outra foi 403 em massa, em todos os itens). Exigir o segundo 404
 *   custa UMA chamada a mais por anúncio morto, uma vez, e desarma o falso
 *   404 único.
 *
 * O teto da longa não é "quanto dá para economizar", é a janela de 3 dias do
 * "Full atual" (D-173): último snapshot bom até 6 h antes do primeiro 404 +
 * 12 h até o segundo + 48 h até o recheque = 66 h < 72 h. Isso vale enquanto
 * as execuções vizinhas capturarem: se a anterior ao primeiro 404 também
 * falhou, ou se a do recheque falhar, o intervalo passa de 72 h e o bucket sai
 * do "Full atual" até a próxima captura. Subir a janela longa acima de 48 h
 * tira a folga de vez.
 */
export const ITEM_ABSENCE_RECHECK_MS = {
  short: 9 * HOUR_MS,
  long: 45 * HOUR_MS,
} as const;

type AbsenceStatus = 403 | 404;

/** A janela da marca que está sendo gravada — `failures` já conta esta falha. */
export function itemAbsenceRecheckMs(status: AbsenceStatus, failures: number): number {
  return status === 404 && failures >= 2 ? ITEM_ABSENCE_RECHECK_MS.long : ITEM_ABSENCE_RECHECK_MS.short;
}

/** O `.in()` vai na URL do PostgREST: lotes de 100 ids mantêm a URL curta. */
const ABSENCE_DELETE_CHUNK = 100;

interface ItemAbsence {
  item_id: string;
  failures: number;
  first_failed_at: string;
  recheck_after: string;
}

type ItemResponse = z.infer<typeof itemResponseSchema>;

interface ItemOutcome {
  link: { item_id: string | null; sku_id: string };
  item: ItemResponse | null;
  failed: boolean;
  /** Pulado por marca vigente em `fulfillment_item_absences`. */
  deferred: boolean;
  /** 403/404 NESTA execução — candidato a marca. */
  absentStatus: AbsenceStatus | null;
}

function absenceStatusOf(error: MercadoLivreApiError): AbsenceStatus | null {
  return error.status === 403 || error.status === 404 ? error.status : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Marcas da conta, uma leitura por execução. Falha aqui NÃO derruba a
 * captura: devolve vazio e o worker busca tudo, como antes da marca existir.
 */
async function readItemAbsences(params: FetchFulfillmentSnapshotsParams): Promise<Map<string, ItemAbsence>> {
  try {
    const rows = await readAllPages<ItemAbsence>((from, to) =>
      params.db
        .from("fulfillment_item_absences")
        .select("item_id, failures, first_failed_at, recheck_after")
        .eq("ml_account_id", params.mlAccountId)
        .order("item_id")
        .range(from, to),
      { label: "falha ao ler fulfillment_item_absences" },
    );

    return new Map(rows.map((row) => [row.item_id, row]));
  } catch (error) {
    params.logger.warn("fulfillment_item_absences_unreadable", {
      ml_account_id: params.mlAccountId,
      reason: errorMessage(error),
    });

    return new Map();
  }
}

/**
 * Grava as marcas novas e apaga as dos itens que voltaram a responder ou que
 * deixaram de estar vinculados. As duas escritas são "falhou, segue": perder
 * uma marca custa uma chamada a mais na próxima execução, nunca um snapshot.
 */
async function updateItemAbsences(
  params: FetchFulfillmentSnapshotsParams,
  capturedAt: Date,
  absences: ReadonlyMap<string, ItemAbsence>,
  outcomes: readonly ItemOutcome[],
): Promise<void> {
  const fetched = outcomes.filter((entry) => !entry.deferred && entry.link.item_id !== null).length;
  const failed = outcomes.filter((entry) => entry.failed).length;
  const candidates = outcomes.filter((entry) => entry.absentStatus !== null);

  // Mais da metade das consultas desta execução falhando não é "estes itens
  // sumiram", é a conta (ou o Mercado Livre) com problema — 16/09 21:00, 403
  // em 100% dos itens das quatro contas. Marcar ali pularia os mesmos itens
  // na execução seguinte, que em 16/09 foi normal.
  const massFailure = failed * 2 > fetched;

  if (massFailure && candidates.length > 0) {
    params.logger.warn("fulfillment_item_absences_skipped_mass_failure", {
      ml_account_id: params.mlAccountId,
      items_failed: failed,
      items_fetched: fetched,
    });
  }

  const marks = massFailure
    ? []
    : candidates.flatMap((entry) => {
        const itemId = entry.link.item_id;
        const status = entry.absentStatus;

        if (itemId === null || status === null) return [];

        const previous = absences.get(itemId);
        const failures = (previous?.failures ?? 0) + 1;

        return [
          {
            organization_id: params.organizationId,
            ml_account_id: params.mlAccountId,
            item_id: itemId,
            http_status: status,
            failures,
            first_failed_at: previous?.first_failed_at ?? capturedAt.toISOString(),
            last_failed_at: capturedAt.toISOString(),
            recheck_after: new Date(capturedAt.getTime() + itemAbsenceRecheckMs(status, failures)).toISOString(),
          },
        ];
      });

  if (marks.length > 0) {
    const written = await params.db
      .from("fulfillment_item_absences")
      .upsert(marks, { onConflict: "ml_account_id,item_id" });

    if (written.error !== null) {
      params.logger.warn("fulfillment_item_absences_not_recorded", {
        ml_account_id: params.mlAccountId,
        items: marks.length,
        reason: written.error.message,
      });
    }
  }

  // Marca vencida + resposta 200 = o item voltou. Apagar mantém a tabela
  // como "o que está fora do ar AGORA": sem isto a marca vencida ficaria para
  // sempre, e uma falha futura herdaria `failures` e `first_failed_at` de
  // outra época.
  const recovered = outcomes.flatMap((entry) =>
    entry.item !== null && entry.link.item_id !== null && absences.has(entry.link.item_id) ? [entry.link.item_id] : [],
  );

  // Marca de item que não está mais em `sku_listing_links` (vínculo apagado,
  // ou refeito para outro anúncio): o item nunca mais é consultado, então
  // nenhuma resposta viria apagá-la, e ela ficaria vencida para sempre. Todo
  // vínculo lido nesta execução está em `outcomes`, adiado ou não.
  const linked = new Set(outcomes.flatMap((entry) => (entry.link.item_id === null ? [] : [entry.link.item_id])));
  const unlinked = [...absences.keys()].filter((itemId) => !linked.has(itemId));
  const toClear = [...recovered, ...unlinked];

  for (let start = 0; start < toClear.length; start += ABSENCE_DELETE_CHUNK) {
    const chunk = toClear.slice(start, start + ABSENCE_DELETE_CHUNK);
    const cleared = await params.db
      .from("fulfillment_item_absences")
      .delete()
      .eq("ml_account_id", params.mlAccountId)
      .in("item_id", chunk);

    if (cleared.error !== null) {
      params.logger.warn("fulfillment_item_absences_not_cleared", {
        ml_account_id: params.mlAccountId,
        items: chunk.length,
        reason: cleared.error.message,
      });
    }
  }

  if (marks.length > 0 || toClear.length > 0) {
    params.logger.info("fulfillment_item_absences_updated", {
      ml_account_id: params.mlAccountId,
      marked: marks.length,
      cleared: recovered.length,
      unlinked: unlinked.length,
    });
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const result = new Array<R>(values.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= values.length) return;
      result[index] = await fn(values[index] as T);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

export interface FetchFulfillmentSnapshotsParams {
  db: AdminClient;
  organizationId: string;
  mlAccountId: string;
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  logger: Logger;
  now?: () => Date;
}

export interface FetchFulfillmentSnapshotsResult {
  itemsProcessed: number;
  /** Item sem `inventory_id` (nunca foi ao Full) — contado, não é falha. */
  itemsSkipped: number;
  /**
   * Item que falhou com erro NÃO retryable do Mercado Livre (ex.: 404 —
   * anúncio removido/pausado, mas o vínculo em `sku_listing_links` ainda
   * aponta pra ele). Contado e logado, não derruba a varredura da conta —
   * achado em produção: sem isso, um único item nesse estado impedia
   * `sync.fulfillment.snapshot` de processar QUALQUER item da conta,
   * inclusive nas tentativas seguintes (o mesmo item quebra de novo).
   */
  itemsFailed: number;
  /**
   * Item NÃO consultado nesta execução porque respondeu 404/403 numa
   * anterior e a marca em `fulfillment_item_absences` ainda não venceu.
   * Separado de `itemsFailed` para a queda de chamadas inúteis aparecer no
   * log — mas continua sendo vínculo com anúncio fora do ar, então o handler
   * o trata como `partial` do mesmo jeito.
   */
  itemsDeferred: number;
  /**
   * Vínculos cujo `inventory_id` já tinha sido capturado NESTA execução por
   * outro anúncio da mesma conta (D-230). Contados e logados, nunca gravados
   * de novo — a chave única é por inventário.
   */
  inventoriesShared: number;
}

export async function fetchFulfillmentSnapshots(
  params: FetchFulfillmentSnapshotsParams,
): Promise<FetchFulfillmentSnapshotsResult> {
  const capturedAt = params.now?.() ?? new Date();

  // `readAllPages` propaga o erro como exceção — e é o que se quer aqui.
  // Mesmo raciocínio de ml-listings-fetch.ts: o chamador
  // (sync-fulfillment-snapshot.ts) já tem try/catch em volta e registra falha
  // de verdade — engolir viraria "done, 0 processados".
  const links = await readAllPages<{ item_id: string | null; sku_id: string }>((from, to) =>
    params.db
      .from("sku_listing_links")
      .select("item_id, sku_id")
      .eq("ml_account_id", params.mlAccountId)
      .eq("ref_kind", "ITEM")
      .is("variation_id", null)
      .order("item_id")
      .range(from, to),
    { label: "falha ao ler sku_listing_links" },
  );

  let itemsProcessed = 0;
  let itemsSkipped = 0;
  let itemsFailed = 0;
  let inventoriesShared = 0;

  // Inventário -> primeiro anúncio que o capturou nesta execução (D-230).
  const inventoriesSeen = new Map<string, { itemId: string; skuId: string }>();

  const absences = await readItemAbsences(params);

  // A fase de rede é limitada a três chamadas simultâneas por conta. A fila
  // continua sendo o orçamento maior; isto apenas remove a espera serial do
  // catálogo sem transformar uma conta em rajada ilimitada.
  const itemResults = await mapWithConcurrency(links, MAX_CONCURRENT_ML_REQUESTS, async (link): Promise<ItemOutcome> => {
    if (link.item_id === null) {
      // Não deveria acontecer (ref_kind='ITEM' garante item_id no banco,
      // constraint sku_listing_links_ref_shape) — defesa, não caminho normal.
      return { link, item: null, failed: false, deferred: false, absentStatus: null };
    }

    // Respondeu 404/403 numa execução anterior e a janela não venceu: não
    // pergunta de novo. Sem log por item — 356 linhas iguais a cada 6 h eram
    // parte do ruído; a contagem vai em `items_deferred`.
    const absence = absences.get(link.item_id);

    if (absence !== undefined && Date.parse(absence.recheck_after) > capturedAt.getTime()) {
      return { link, item: null, failed: false, deferred: true, absentStatus: null };
    }

    let item: ItemResponse;

    try {
      item = await params.mercadoLivre.request({
        method: "GET",
        path: `/items/${link.item_id}`,
        accessToken: params.accessToken,
        schema: itemResponseSchema,
      });
    } catch (error) {
      // Erro NÃO retryable é do ITEM (404 anúncio removido, 403 sem acesso a
      // esse item específico) — pula só ele. Erro retryable (503/429/rede)
      // pode ser instabilidade afetando a conta inteira: propaga para o
      // handler decidir sobre reentrega do job inteiro, mesmo raciocínio já
      // usado para erro de rede em `fetchOrdersWindow`.
      if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
        params.logger.warn("fulfillment_item_fetch_failed", {
          ml_account_id: params.mlAccountId,
          item_id: link.item_id,
          status: error.status,
          reason: error.message,
        });

        return { link, item: null, failed: true, deferred: false, absentStatus: absenceStatusOf(error) };
      }

      throw error;
    }

    return { link, item, failed: false, deferred: false, absentStatus: null };
  });

  await updateItemAbsences(params, capturedAt, absences, itemResults);

  const uniqueItems = itemResults.filter((entry) => entry.item !== null && entry.item.inventory_id !== null);
  itemsFailed += itemResults.filter((entry) => entry.failed).length;
  itemsSkipped += itemResults.filter((entry) => entry.item?.inventory_id === null).length;
  const itemsDeferred = itemResults.filter((entry) => entry.deferred).length;

  const inventories = [...new Set(uniqueItems.map((entry) => entry.item?.inventory_id).filter((id): id is string => id !== null && id !== undefined))];
  const stockResults = await mapWithConcurrency(inventories, MAX_CONCURRENT_ML_REQUESTS, async (inventoryId) => {
    try {
      return { inventoryId, stock: await params.mercadoLivre.request({ method: "GET", path: `/inventories/${inventoryId}/stock/fulfillment`, accessToken: params.accessToken, schema: fulfillmentStockResponseSchema }), failed: false };
    } catch (error) {
      if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
        params.logger.warn("fulfillment_stock_fetch_failed", { ml_account_id: params.mlAccountId, inventory_id: inventoryId, reason: error.message });
        return { inventoryId, stock: null, failed: true };
      }
      throw error;
    }
  });
  const stocks = new Map(
    stockResults.flatMap((entry) => (entry.stock === null ? [] : [[entry.inventoryId, entry.stock] as const])),
  );
  itemsFailed += stockResults.filter((entry) => entry.failed).length;

  const previousRows = new Map<string, { quantity: number; captured_at: string }>();
  if (inventories.length > 0) {
    const previous = await readAllPages<{ inventory_id: string; quantity: number; captured_at: string }>((from, to) =>
      params.db.from("fulfillment_stock_snapshots").select("inventory_id, quantity, captured_at").eq("ml_account_id", params.mlAccountId).in("inventory_id", inventories).order("captured_at", { ascending: false }).range(from, to),
      { label: "falha ao ler snapshots anteriores do Full" },
    );
    for (const row of previous) if (!previousRows.has(row.inventory_id)) previousRows.set(row.inventory_id, row);
  }

  for (const entry of uniqueItems) {
    const link = entry.link;
    const item = entry.item;
    if (link.item_id === null || item === null) continue;
    if (item.inventory_id === null) continue;
    const inventoryId = item.inventory_id;
    const stock = stocks.get(inventoryId);
    if (stock === undefined) continue;

    const firstItem = inventoriesSeen.get(inventoryId);

    if (firstItem !== undefined) {
      // Mesmo estoque físico já capturado por outro anúncio desta conta
      // (user product em mais de um item). A segunda linha colidiria com a
      // chave única e, desde D-178, derrubaria a captura inteira. `same_sku`
      // no log é a informação útil para quem cuida dos vínculos: dois anúncios
      // do mesmo inventário apontando para SKUs diferentes é vínculo a revisar.
      inventoriesShared += 1;
      params.logger.info("fulfillment_inventory_shared", {
        ml_account_id: params.mlAccountId,
        inventory_id: inventoryId,
        item_id: link.item_id,
        first_item_id: firstItem.itemId,
        same_sku: firstItem.skuId === link.sku_id,
      });

      continue;
    }

    inventoriesSeen.set(inventoryId, { itemId: link.item_id, skuId: link.sku_id });

    const previous =
      !previousRows.has(stock.inventory_id)
        ? null
        : {
            inventoryId: stock.inventory_id,
            skuId: link.sku_id,
            quantity: previousRows.get(stock.inventory_id)?.quantity ?? 0,
            capturedAt: new Date(previousRows.get(stock.inventory_id)?.captured_at ?? capturedAt.toISOString()),
          };

    const current = {
      inventoryId: stock.inventory_id,
      skuId: link.sku_id,
      quantity: stock.available_quantity,
      capturedAt,
    };

    // O snapshot e a base do diff logo abaixo: se ele nao gravou, os eventos
    // de Full sairiam de uma comparacao com estado que nao existe (D-178).
    assertWritten(
      await params.db.from("fulfillment_stock_snapshots").insert({
      organization_id: params.organizationId,
      ml_account_id: params.mlAccountId,
      inventory_id: stock.inventory_id,
      item_id: link.item_id,
      variation_id: null,
      sku_id: link.sku_id,
      quantity: stock.available_quantity,
        captured_at: capturedAt.toISOString(),
      }),
      "fulfillment_stock_snapshots.insert",
    );

    const events = detectFulfillmentEvents(previous, current);

    if (events.length > 0) {
      await recordDomainEvents(
        params.db,
        { organizationId: params.organizationId, mlAccountId: params.mlAccountId },
        events,
        params.logger,
      );
    }

    itemsProcessed += 1;
  }

  return { itemsProcessed, itemsSkipped, itemsFailed, itemsDeferred, inventoriesShared };
}
