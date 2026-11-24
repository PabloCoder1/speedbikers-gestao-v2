import { describe, expect, it } from "vitest";

import {
  classifyTikTokProductStatus,
  projectTikTokProductCatalog,
  type TikTokCatalogProductInput,
} from "./catalog-projection.js";

describe("D-813 — projeção de catálogo e estoque do TikTok Shop", () => {
  it("classifica estados oficiais de produto sem vazar chaves de Object.prototype", () => {
    expect(classifyTikTokProductStatus("ACTIVATE")).toBe("ATIVO");
    expect(classifyTikTokProductStatus("SELLER_DEACTIVATED")).toBe("PAUSADO");
    expect(classifyTikTokProductStatus("PLATFORM_DEACTIVATED")).toBe("PAUSADO");
    expect(classifyTikTokProductStatus("FREEZE")).toBe("PAUSADO");
    expect(classifyTikTokProductStatus("DELETED")).toBe("EXCLUIDO");
    expect(classifyTikTokProductStatus("DRAFT")).toBe("RASCUNHO");
    expect(classifyTikTokProductStatus("PENDING")).toBe("RASCUNHO");
    expect(classifyTikTokProductStatus("toString")).toBe("DESCONHECIDO");
    expect(classifyTikTokProductStatus("OUTRO")).toBe("DESCONHECIDO");
  });

  it("projeta variações, normaliza seller_sku, soma depósitos e prioriza inventory/search mantendo ausência como null", () => {
    const product: TikTokCatalogProductInput = {
      id: "1729400001",
      title: "  Capacete Urbano Preto  ",
      status: "ACTIVATE",
      create_time: 1_763_990_000,
      update_time: 1_763_996_400,
      skus: [
        {
          id: "sku-m",
          seller_sku: "  cap-urb-m  ",
          price: { currency: "BRL", tax_exclusive_price: "299.90", sale_price: "249.50" },
          inventory: [
            { warehouse_id: "w-1", quantity: 4 },
            { warehouse_id: "w-2", quantity: 6 },
          ],
        },
        {
          id: "sku-g",
          seller_sku: "   ",
          price: { currency: "BRL", tax_exclusive_price: "299.90", sale_price: null },
          inventory: null,
        },
      ],
    };

    const units = projectTikTokProductCatalog(product, {
      "sku-m": { totalAvailableQuantity: 12, totalCommittedQuantity: 2 },
    });

    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      productId: "1729400001",
      skuId: "sku-m",
      sellerSku: "cap-urb-m",
      sellerSkuKey: "CAP-URB-M",
      title: "Capacete Urbano Preto",
      lifecycle: "ATIVO",
      currency: "BRL",
      originalPriceBrl: 299.9,
      salePriceBrl: 249.5,
      availableStock: 12,
      committedStock: 2,
    });
    expect(units[1]).toMatchObject({
      productId: "1729400001",
      skuId: "sku-g",
      sellerSku: null,
      sellerSkuKey: null,
      originalPriceBrl: 299.9,
      salePriceBrl: null,
      availableStock: null,
      committedStock: null,
    });
  });

  it("usa soma de warehouses do produto quando inventory/search não foi fornecido e cria unidade sintética sem skus", () => {
    const withWarehouses = projectTikTokProductCatalog({
      id: "prod-1",
      title: "Luva",
      status: "FREEZE",
      skus: [
        {
          id: "v-1",
          seller_sku: "LUVA-P",
          inventory: [
            { warehouse_id: "w1", quantity: 3 },
            { warehouse_id: "w2", quantity: 5 },
          ],
        },
      ],
    });

    expect(withWarehouses[0]?.availableStock).toBe(8);
    expect(withWarehouses[0]?.lifecycle).toBe("PAUSADO");

    const withoutSkus = projectTikTokProductCatalog({
      id: "prod-2",
      title: "Rascunho sem SKU",
      status: "DRAFT",
      skus: [],
    });

    expect(withoutSkus).toHaveLength(1);
    expect(withoutSkus[0]).toMatchObject({
      productId: "prod-2",
      skuId: null,
      sellerSku: null,
      availableStock: null,
      salePriceBrl: null,
      lifecycle: "RASCUNHO",
    });
  });

  it("falha fechado em productId vazio e ignora quantidades/preços não finitos sem virar zero", () => {
    expect(() =>
      projectTikTokProductCatalog({ id: "   ", title: "X", status: "ACTIVATE", skus: [] }),
    ).toThrow(RangeError);

    const units = projectTikTokProductCatalog({
      id: "prod-3",
      title: "Item",
      status: "ACTIVATE",
      skus: [
        {
          id: "v-bad",
          seller_sku: "X-1",
          price: { currency: "BRL", tax_exclusive_price: "NaN", sale_price: "" },
          inventory: [{ warehouse_id: "w1", quantity: Number.NaN }],
        },
      ],
    });

    expect(units[0]?.originalPriceBrl).toBeNull();
    expect(units[0]?.salePriceBrl).toBeNull();
    expect(units[0]?.availableStock).toBeNull();
  });
});
