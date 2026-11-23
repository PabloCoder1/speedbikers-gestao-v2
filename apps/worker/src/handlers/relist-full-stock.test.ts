import type { MercadoLivreClient } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import { readRelistFullStock } from "./relist-full-stock.js";

describe("readRelistFullStock (D-801)", () => {
  it("recusa quantidades negativas ou fracionárias do ML como leitura não verificável (null) em vez de cancelar estoque real", async () => {
    const request = vi.fn(({ schema }: { schema: { parse: (value: unknown) => unknown } }) =>
      Promise.resolve(
        schema.parse({
          inventory_id: "INV-1",
          available_quantity: -5,
          not_available_quantity: 5,
        }),
      ),
    );
    const mercadoLivre = { request } as unknown as MercadoLivreClient;
    const logger = createLogger({}, { sink: () => undefined });

    const readings = await readRelistFullStock({
      mercadoLivre,
      accessToken: "token",
      inventoryIds: ["INV-1"],
      logger,
      logFields: { relist_id: "rel-1" },
    });

    expect(readings.get("INV-1")).toBeNull();
  });

  it("codifica o inventoryId na URL antes de chamar /inventories/.../stock/fulfillment", async () => {
    const paths: string[] = [];
    const request = vi.fn(({ path, schema }: { path: string; schema: { parse: (value: unknown) => unknown } }) => {
      paths.push(path);

      return Promise.resolve(
        schema.parse({
          inventory_id: "INV/1?x=2",
          available_quantity: 0,
          not_available_quantity: 0,
        }),
      );
    });
    const mercadoLivre = { request } as unknown as MercadoLivreClient;
    const logger = createLogger({}, { sink: () => undefined });

    const readings = await readRelistFullStock({
      mercadoLivre,
      accessToken: "token",
      inventoryIds: ["INV/1?x=2"],
      logger,
      logFields: { relist_id: "rel-1" },
    });

    expect(paths).toEqual(["/inventories/INV%2F1%3Fx%3D2/stock/fulfillment"]);
    expect(readings.get("INV/1?x=2")).toEqual({ availableQuantity: 0, notAvailableQuantity: 0 });
  });
});
