import type { RelistFullStockReading } from "@sb/domain";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";
import { ZodError, z } from "zod";

/**
 * Estoque do Full de cada `inventory_id` do anúncio, lido AO VIVO para o
 * preflight da republicação (D-360). `docs/MERCADO_LIVRE.md` secao 2.7:
 * `GET /inventories/{inventory_id}/stock/fulfillment`, com
 * `available_quantity` e `not_available_quantity` — os dois contam, porque o
 * indisponível (avariado, perdido, em transferência) continua no CD.
 *
 * Três desfechos por inventário, e só um deles relança:
 *
 * - leitura com os dois números → entra no mapa;
 * - resposta que o Mercado Livre recusa de vez (`not_retryable`, como um 404)
 *   ou que não tem a forma esperada → `null`. O preflight reprova com
 *   FULL_NAO_VERIFICADO: sem conferir, não se presume zero;
 * - falha passageira → relança, e o Cloud Tasks repete o job inteiro. Quem
 *   chama garante que nada foi gravado antes desta leitura.
 */

const fullStockResponseSchema = z.object({
  inventory_id: z.string(),
  available_quantity: z.number(),
  not_available_quantity: z.number(),
});

export async function readRelistFullStock(params: {
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  inventoryIds: readonly string[];
  logger: Logger;
  logFields: Record<string, string>;
}): Promise<Map<string, RelistFullStockReading | null>> {
  const readings = new Map<string, RelistFullStockReading | null>();

  // Sequencial de propósito: um anúncio tem um inventário na raiz ou um por
  // variação, e o preflight roda um anúncio por vez.
  for (const inventoryId of params.inventoryIds) {
    try {
      const stock = await params.mercadoLivre.request({
        method: "GET",
        path: `/inventories/${inventoryId}/stock/fulfillment`,
        accessToken: params.accessToken,
        schema: fullStockResponseSchema,
      });

      // Resposta de OUTRO inventário não confere nada sobre este.
      readings.set(
        inventoryId,
        stock.inventory_id === inventoryId
          ? { availableQuantity: stock.available_quantity, notAvailableQuantity: stock.not_available_quantity }
          : null,
      );
    } catch (error) {
      const unverifiable =
        error instanceof ZodError || (error instanceof MercadoLivreApiError && error.errorClass === "not_retryable");

      if (!unverifiable) {
        throw error;
      }

      params.logger.warn("relist_full_stock_unreadable", {
        ...params.logFields,
        inventory_id: inventoryId,
        reason: error.message,
      });
      readings.set(inventoryId, null);
    }
  }

  return readings;
}

/** O mapa de leituras em forma de log: `"disponível+indisponível"` ou `null`. */
export function describeFullStock(readings: ReadonlyMap<string, RelistFullStockReading | null>): Record<string, string | null> {
  return Object.fromEntries(
    [...readings].map(([inventoryId, reading]) => [
      inventoryId,
      reading === null ? null : `${String(reading.availableQuantity)}+${String(reading.notAvailableQuantity)}`,
    ]),
  );
}
