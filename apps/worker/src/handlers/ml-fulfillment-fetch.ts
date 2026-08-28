import type { AdminClient } from "@sb/db";
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

  for (const link of links) {
    if (link.item_id === null) {
      // Não deveria acontecer (ref_kind='ITEM' garante item_id no banco,
      // constraint sku_listing_links_ref_shape) — defesa, não caminho normal.
      continue;
    }

    let item: z.infer<typeof itemResponseSchema>;

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
        itemsFailed += 1;
        params.logger.warn("fulfillment_item_fetch_failed", {
          ml_account_id: params.mlAccountId,
          item_id: link.item_id,
          reason: error.message,
        });

        continue;
      }

      throw error;
    }

    if (item.inventory_id === null) {
      itemsSkipped += 1;
      continue;
    }

    let stock: z.infer<typeof fulfillmentStockResponseSchema>;

    try {
      stock = await params.mercadoLivre.request({
        method: "GET",
        path: `/inventories/${item.inventory_id}/stock/fulfillment`,
        accessToken: params.accessToken,
        schema: fulfillmentStockResponseSchema,
      });
    } catch (error) {
      if (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable") {
        itemsFailed += 1;
        params.logger.warn("fulfillment_stock_fetch_failed", {
          ml_account_id: params.mlAccountId,
          item_id: link.item_id,
          inventory_id: item.inventory_id,
          reason: error.message,
        });

        continue;
      }

      throw error;
    }

    const previousRow = await params.db
      .from("fulfillment_stock_snapshots")
      .select("quantity, captured_at")
      .eq("ml_account_id", params.mlAccountId)
      .eq("inventory_id", stock.inventory_id)
      .order("captured_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const previous =
      previousRow.data === null
        ? null
        : {
            inventoryId: stock.inventory_id,
            skuId: link.sku_id,
            quantity: previousRow.data.quantity,
            capturedAt: new Date(previousRow.data.captured_at),
          };

    const current = {
      inventoryId: stock.inventory_id,
      skuId: link.sku_id,
      quantity: stock.available_quantity,
      capturedAt,
    };

    await params.db.from("fulfillment_stock_snapshots").insert({
      organization_id: params.organizationId,
      ml_account_id: params.mlAccountId,
      inventory_id: stock.inventory_id,
      item_id: link.item_id,
      variation_id: null,
      sku_id: link.sku_id,
      quantity: stock.available_quantity,
      captured_at: capturedAt.toISOString(),
    });

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

  return { itemsProcessed, itemsSkipped, itemsFailed };
}
