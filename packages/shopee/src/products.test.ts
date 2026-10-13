import { describe, expect, it } from "vitest";

import { createShopeeClient } from "./client.js";
import { getItemBaseInfo, getItemListPage, getModelList, precoEEstoque } from "./products.js";

const SHOP = { accessToken: "tok", shopId: 227974834 };

function clienteCom(corpo: unknown) {
  const urls: URL[] = [];
  const fetchImpl = (url: URL) => {
    urls.push(url);

    return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
  };

  return {
    client: createShopeeClient({
      environment: "sandbox",
      partnerId: 1248019,
      partnerKey: "chave-de-teste-nao-real",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => new Date("2026-10-13T15:00:00.000Z"),
    }),
    urls,
  };
}

describe("get_item_list (D-428)", () => {
  it("status como parâmetro REPETIDO, 100 por página, janela opcional, e o próximo offset só quando há mais", async () => {
    const { client, urls } = clienteCom({
      error: "",
      response: {
        item: [{ item_id: 892617482, item_status: "NORMAL", update_time: 1760360000 }],
        total_count: 101,
        has_next_page: true,
        next_offset: 100,
      },
    });

    const pagina = await getItemListPage(client, SHOP, {
      offset: 0,
      statuses: ["NORMAL", "UNLIST"],
      updateTimeFrom: 1760000000,
      updateTimeTo: 1760360000,
    });

    expect(pagina).toEqual({
      items: [{ itemId: 892617482, itemStatus: "NORMAL", updateTime: 1760360000 }],
      nextOffset: 100,
      totalCount: 101,
    });
    expect(urls[0]?.pathname).toBe("/api/v2/product/get_item_list");
    expect(urls[0]?.searchParams.getAll("item_status")).toEqual(["NORMAL", "UNLIST"]);
    expect(urls[0]?.searchParams.get("page_size")).toBe("100");
    expect(urls[0]?.searchParams.get("update_time_from")).toBe("1760000000");

    const fim = clienteCom({ error: "", response: { has_next_page: false, next_offset: 101 } });

    expect(await getItemListPage(fim.client, SHOP, { offset: 100, statuses: ["NORMAL"] })).toEqual({
      items: [],
      nextOffset: null,
      totalCount: null,
    });
    expect(fim.urls[0]?.searchParams.has("update_time_from")).toBe(false);
  });
});

describe("get_item_base_info (D-428)", () => {
  it("até 50 por vírgula; item fora do contrato é contado e não derruba os outros", async () => {
    const { client, urls } = clienteCom({
      error: "",
      response: {
        item_list: [
          {
            item_id: 1,
            item_name: "Painel",
            item_sku: "PAINEL-01",
            has_model: false,
            price_info: [{ currency: "BRL", current_price: 149.9, original_price: 159.9 }],
            stock_info_v2: { summary_info: { total_available_stock: 7 } },
            image: { image_url_list: ["https://cf.shopee.com.br/file/a"] },
            campo_novo_da_shopee: { qualquer: true },
          },
          { item_id: 2, item_name: 42 },
          "lixo",
        ],
      },
    });

    const lido = await getItemBaseInfo(client, SHOP, [1, 2, 3]);

    expect(urls[0]?.searchParams.get("item_id_list")).toBe("1,2,3");
    expect(lido.invalid).toBe(2);
    expect(lido.invalidItemIds).toEqual([2]);
    expect(lido.items).toHaveLength(1);
    expect(lido.items[0]).toMatchObject({ item_id: 1, item_sku: "PAINEL-01", has_model: false });
    expect(precoEEstoque(lido.items[0] ?? {})).toEqual({
      currency: "BRL",
      currentPrice: 149.9,
      originalPrice: 159.9,
      availableStock: 7,
    });
  });

  it("nenhum item não chama; mais de 50 recusa antes de chamar", async () => {
    const { client, urls } = clienteCom({});

    expect(await getItemBaseInfo(client, SHOP, [])).toEqual({ items: [], invalid: 0, invalidItemIds: [] });
    await expect(getItemBaseInfo(client, SHOP, Array.from({ length: 51 }, (_, i) => i + 1))).rejects.toThrow(/50/);
    expect(urls).toEqual([]);
  });

  it("item com variação: sem preço e estoque no item, ausente fica nulo — nunca zero", () => {
    expect(precoEEstoque({})).toEqual({ currency: null, currentPrice: null, originalPrice: null, availableStock: null });
  });
});

describe("get_model_list (D-428)", () => {
  it("o nome da variação sai das opções pelos índices; variação fora do contrato é contada", async () => {
    const { client, urls } = clienteCom({
      error: "",
      response: {
        tier_variation: [
          { name: "Cor", option_list: [{ option: "Azul" }, { option: "Preto" }] },
          { name: "Tamanho", option_list: [{ option: "P" }, { option: "" }] },
        ],
        model: [
          {
            model_id: 10,
            model_sku: "BAU-AZUL-P",
            model_status: "MODEL_NORMAL",
            tier_index: [0, 0],
            price_info: [{ currency: "BRL", current_price: 99.9 }],
            stock_info_v2: { summary_info: { total_available_stock: 3 } },
          },
          { model_id: 11, model_sku: "", tier_index: [1, 1] },
          { model_sku: "sem-id" },
        ],
      },
    });

    const lido = await getModelList(client, SHOP, 892617482);

    expect(urls[0]?.searchParams.get("item_id")).toBe("892617482");
    expect(lido.invalid).toBe(1);
    expect(lido.models.map((m) => [m.model_id, m.name])).toEqual([
      [10, "Azul / P"],
      // Opção vazia não entra no nome.
      [11, "Preto"],
    ]);
    expect(precoEEstoque(lido.models[0] ?? {})).toMatchObject({ currentPrice: 99.9, availableStock: 3 });
  });
});
