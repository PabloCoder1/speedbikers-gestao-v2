import { describe, expect, it } from "vitest";

import type { RelistFullStockReading } from "./relist-preflight.js";
import {
  collectRelistInventoryIds,
  evaluateRelistPreflight,
  hasUserProductVariations,
  summarizeRelistVariations,
} from "./relist-preflight.js";

/** Forma mínima de um item SAUDÁVEL para o preflight — cada teste quebra um pedaço. */
function healthyItem(): Record<string, unknown> {
  return {
    id: "MLB910000001",
    tags: ["good_quality_picture"],
    catalog_listing: false,
    listing_type_id: "gold_special",
    available_quantity: 5,
    variations: [],
  };
}

/** Leituras do Full por `inventory_id`, como o worker entrega (D-360). */
function full(entries: Record<string, RelistFullStockReading | null>): Map<string, RelistFullStockReading | null> {
  return new Map(Object.entries(entries));
}

const ZERADO: RelistFullStockReading = { availableQuantity: 0, notAvailableQuantity: 0 };

/** Variação legível como o GET /items devolve: id, preço e estoque (D-364). */
function variacao(id: number, estoque: number, inventoryId?: string): Record<string, unknown> {
  return { id, price: 114.9, available_quantity: estoque, ...(inventoryId === undefined ? {} : { inventory_id: inventoryId }) };
}

describe("evaluateRelistPreflight (D-160)", () => {
  it("item saudável: aprovado, zero bloqueios, zero avisos", () => {
    const result = evaluateRelistPreflight(healthyItem());

    expect(result).toEqual({ approved: true, blocks: [], warnings: [] });
  });

  it("tag `relist` presente: JA_REPUBLICADO — uma republicação por pai é regra do próprio ML", () => {
    const result = evaluateRelistPreflight({ ...healthyItem(), tags: ["relist"] });

    expect(result.approved).toBe(false);
    expect(result.blocks.map((issue) => issue.code)).toEqual(["JA_REPUBLICADO"]);
  });

  it("Full pela RAIZ com unidades bloqueia — a doc de relist é silenciosa sobre o CD", () => {
    const result = evaluateRelistPreflight(
      { ...healthyItem(), inventory_id: "LCQI05831" },
      full({ LCQI05831: { availableQuantity: 3, notAvailableQuantity: 0 } }),
    );

    expect(result.approved).toBe(false);
    expect(result.blocks.map((issue) => issue.code)).toEqual(["FULL_BLOQUEADO"]);
    expect(result.blocks[0]?.descricao).toContain("3 unidade(s)");
  });

  it("unidade INDISPONÍVEL também prende estoque: avariada ou em transferência continua no CD (D-360)", () => {
    const result = evaluateRelistPreflight(
      { ...healthyItem(), inventory_id: "LCQI05831" },
      full({ LCQI05831: { availableQuantity: 0, notAvailableQuantity: 2 } }),
    );

    expect(result.blocks.map((issue) => issue.code)).toEqual(["FULL_BLOQUEADO"]);
  });

  it("Full por VARIAÇÃO com unidades bloqueia igual — cada variação tem o próprio inventory_id (§2.7)", () => {
    const result = evaluateRelistPreflight(
      {
        ...healthyItem(),
        variations: [
          { id: 123, price: 99.9, available_quantity: 2, inventory_id: "LCQI99999" },
          { id: 456, price: 99.9, available_quantity: 3 },
        ],
      },
      full({ LCQI99999: { availableQuantity: 1, notAvailableQuantity: 0 } }),
    );

    expect(result.approved).toBe(false);
    expect(result.blocks.map((issue) => issue.code)).toEqual(["FULL_BLOQUEADO"]);
  });

  it("catálogo bloqueia; e ser FILHO de relist bloqueia (encadeamento é o caso 'incerto' da doc)", () => {
    const catalogo = evaluateRelistPreflight({ ...healthyItem(), catalog_listing: true });
    expect(catalogo.blocks.map((issue) => issue.code)).toEqual(["CATALOGO_BLOQUEADO"]);

    const filho = evaluateRelistPreflight({ ...healthyItem(), parent_item_id: "MLB900000000" });
    expect(filho.blocks.map((issue) => issue.code)).toEqual(["ENCADEAMENTO_NAO_DOCUMENTADO"]);
  });

  it("fail-safe: snapshot que não é um item reprova com SNAPSHOT_ILEGIVEL — nunca presume que está tudo bem", () => {
    for (const garbage of [null, undefined, "texto", 42, ["array"]]) {
      const result = evaluateRelistPreflight(garbage);

      expect(result.approved).toBe(false);
      expect(result.blocks.map((issue) => issue.code)).toEqual(["SNAPSHOT_ILEGIVEL"]);
    }
  });

  it("fail-safe: `tags` ou `catalog_listing` ilegíveis reprovam com SNAPSHOT_INCOMPLETO", () => {
    const semTags = evaluateRelistPreflight({ ...healthyItem(), tags: undefined });
    expect(semTags.approved).toBe(false);
    expect(semTags.blocks.map((issue) => issue.code)).toEqual(["SNAPSHOT_INCOMPLETO"]);

    const semCatalogo = evaluateRelistPreflight({ ...healthyItem(), catalog_listing: "sim" });
    expect(semCatalogo.approved).toBe(false);
    expect(semCatalogo.blocks.map((issue) => issue.code)).toEqual(["SNAPSHOT_INCOMPLETO"]);
  });

  it("ausência com significado normal NÃO bloqueia: sem inventory_id = fora do Full; sem parent_item_id = não é filho", () => {
    // healthyItem() não tem nenhum dos dois — e é aprovado (primeiro teste).
    // Aqui, a prova do contraste: null explícito também é "ausente normal".
    const result = evaluateRelistPreflight({ ...healthyItem(), inventory_id: null, parent_item_id: null });

    expect(result.approved).toBe(true);
  });

  it("anúncio `free`: AVISO de herança, nunca bloqueio — republicar continua permitido", () => {
    const result = evaluateRelistPreflight({ ...healthyItem(), listing_type_id: "free" });

    expect(result.approved).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toEqual(["HERANCA_NAO_OCORRE_EM_FREE"]);
  });

  it("todos os bloqueios aparecem JUNTOS — o operador vê a lista inteira, não um por vez", () => {
    const result = evaluateRelistPreflight(
      {
        ...healthyItem(),
        tags: ["relist"],
        inventory_id: "LCQI05831",
        catalog_listing: true,
        parent_item_id: "MLB900000000",
        listing_type_id: "free",
      },
      full({ LCQI05831: { availableQuantity: 5, notAvailableQuantity: 0 } }),
    );

    expect(result.approved).toBe(false);
    expect(result.blocks.map((issue) => issue.code).sort()).toEqual([
      "CATALOGO_BLOQUEADO",
      "ENCADEAMENTO_NAO_DOCUMENTADO",
      "FULL_BLOQUEADO",
      "JA_REPUBLICADO",
    ]);
    expect(result.warnings.map((issue) => issue.code)).toEqual(["HERANCA_NAO_OCORRE_EM_FREE"]);
  });
});

describe("Full sem estoque (D-360)", () => {
  it("o caso de produção: cadastro no Full ZERADO e envio por coleta libera, com aviso — MLB5805901782", () => {
    const result = evaluateRelistPreflight(
      { ...healthyItem(), inventory_id: "TBWT07652", shipping: { mode: "me2", logistic_type: "cross_docking" } },
      full({ TBWT07652: ZERADO }),
    );

    expect(result.approved).toBe(true);
    expect(result.blocks).toEqual([]);
    expect(result.warnings.map((issue) => issue.code)).toEqual(["FULL_CADASTRO_SEM_ESTOQUE"]);
    expect(result.warnings[0]?.descricao).toContain("TBWT07652");
  });

  it("sem leitura do estoque, cadastro no Full reprova com FULL_NAO_VERIFICADO — nunca presume zero", () => {
    const semLeitura = evaluateRelistPreflight({ ...healthyItem(), inventory_id: "TBWT07652" });
    expect(semLeitura.approved).toBe(false);
    expect(semLeitura.blocks.map((issue) => issue.code)).toEqual(["FULL_NAO_VERIFICADO"]);

    const leituraFalhou = evaluateRelistPreflight({ ...healthyItem(), inventory_id: "TBWT07652" }, full({ TBWT07652: null }));
    expect(leituraFalhou.blocks.map((issue) => issue.code)).toEqual(["FULL_NAO_VERIFICADO"]);
  });

  it("uma variação sem leitura reprova, mesmo com as outras zeradas", () => {
    const result = evaluateRelistPreflight(
      { ...healthyItem(), variations: [variacao(1, 2, "INV-A"), variacao(2, 2, "INV-B")] },
      full({ "INV-A": ZERADO }),
    );

    expect(result.blocks.map((issue) => issue.code)).toEqual(["FULL_NAO_VERIFICADO"]);
    expect(result.blocks[0]?.descricao).toContain("INV-B");
  });

  it("leitura negativa ou não finita conta como não lida", () => {
    for (const invalida of [
      { availableQuantity: -1, notAvailableQuantity: 0 },
      { availableQuantity: Number.NaN, notAvailableQuantity: 0 },
      { availableQuantity: 0, notAvailableQuantity: Number.POSITIVE_INFINITY },
    ]) {
      const result = evaluateRelistPreflight({ ...healthyItem(), inventory_id: "TBWT07652" }, full({ TBWT07652: invalida }));

      expect(result.blocks.map((issue) => issue.code)).toEqual(["FULL_NAO_VERIFICADO"]);
    }
  });

  it("envio ativo pelo Full bloqueia mesmo com o estoque zerado, e mesmo sem inventory_id", () => {
    const zerado = evaluateRelistPreflight(
      { ...healthyItem(), inventory_id: "TBWT07652", shipping: { logistic_type: "fulfillment" } },
      full({ TBWT07652: ZERADO }),
    );
    expect(zerado.blocks.map((issue) => issue.code)).toEqual(["FULL_BLOQUEADO"]);
    expect(zerado.warnings).toEqual([]);

    const semInventario = evaluateRelistPreflight({ ...healthyItem(), shipping: { logistic_type: "fulfillment" } });
    expect(semInventario.blocks.map((issue) => issue.code)).toEqual(["FULL_BLOQUEADO"]);
  });

  it("as unidades somam raiz e variações", () => {
    const result = evaluateRelistPreflight(
      { ...healthyItem(), inventory_id: "INV-RAIZ", variations: [variacao(1, 2, "INV-VAR")] },
      full({ "INV-RAIZ": ZERADO, "INV-VAR": { availableQuantity: 1, notAvailableQuantity: 1 } }),
    );

    expect(result.blocks.map((issue) => issue.code)).toEqual(["FULL_BLOQUEADO"]);
    expect(result.blocks[0]?.descricao).toContain("2 unidade(s)");
  });
});

describe("estoque que a republicação leva (D-364)", () => {
  it("dez variações com estoque e SEM user_product_id aprovam, sem aviso", () => {
    const result = evaluateRelistPreflight({
      ...healthyItem(),
      available_quantity: 17_135,
      shipping: { logistic_type: "cross_docking" },
      variations: Array.from({ length: 10 }, (_, indice) => variacao(180_214_523_000 + indice, 1_700 + indice)),
    });

    expect(result).toEqual({ approved: true, blocks: [], warnings: [] });
  });

  it("variações TODAS sem estoque bloqueiam com VARIACOES_SEM_ESTOQUE — o POST não teria corpo, e o pai seria fechado à toa", () => {
    const result = evaluateRelistPreflight({ ...healthyItem(), variations: [variacao(1, 0), variacao(2, 0)] });

    expect(result.approved).toBe(false);
    expect(result.blocks.map((issue) => issue.code)).toEqual(["VARIACOES_SEM_ESTOQUE"]);
    expect(result.warnings).toEqual([]);
  });

  it("parte das variações sem estoque: aprovado, com o aviso VARIACOES_SEM_ESTOQUE_FORA nomeando as que ficam de fora", () => {
    const result = evaluateRelistPreflight({ ...healthyItem(), variations: [variacao(1, 0), variacao(2, 4), variacao(3, 0)] });

    expect(result.approved).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toEqual(["VARIACOES_SEM_ESTOQUE_FORA"]);
    expect(result.warnings[0]?.descricao).toContain("2 de 3");
    expect(result.warnings[0]?.descricao).toContain("1, 3");
  });

  it("sem variação e sem estoque bloqueia com SEM_ESTOQUE — a mesma regra, pela raiz", () => {
    const result = evaluateRelistPreflight({ ...healthyItem(), available_quantity: 0 });

    expect(result.approved).toBe(false);
    expect(result.blocks.map((issue) => issue.code)).toEqual(["SEM_ESTOQUE"]);
  });

  it("fail-safe: variations, estoque da raiz ou id/preço/estoque de variação ilegíveis reprovam com SNAPSHOT_INCOMPLETO", () => {
    for (const snapshot of [
      { ...healthyItem(), variations: undefined },
      { ...healthyItem(), available_quantity: "5" },
      { ...healthyItem(), variations: [variacao(1, 3), { id: 2, available_quantity: 3 }] },
      { ...healthyItem(), variations: [{ id: "abc", price: 10, available_quantity: 3 }] },
      { ...healthyItem(), variations: [{ id: 2 ** 60, price: 10, available_quantity: 3 }] },
      { ...healthyItem(), variations: [{ id: 1, price: 10, available_quantity: -1 }] },
    ]) {
      const result = evaluateRelistPreflight(snapshot);

      expect(result.approved).toBe(false);
      expect(result.blocks.map((issue) => issue.code)).toEqual(["SNAPSHOT_INCOMPLETO"]);
    }
  });
});

describe("variações em conta de user products (D-369)", () => {
  /** Variação com o `user_product_id` que o GET /items devolve em cada uma. */
  function variacaoUp(id: number, estoque: number, userProductId: unknown): Record<string, unknown> {
    return { ...variacao(id, estoque), user_product_id: userProductId };
  }

  it("o pai do incidente (MLB1476804187): variações com user_product_id e sem UP na raiz bloqueiam com VARIACOES_USER_PRODUCT", () => {
    const result = evaluateRelistPreflight({
      ...healthyItem(),
      available_quantity: 17_135,
      user_product_id: null,
      shipping: { logistic_type: "cross_docking" },
      variations: [variacaoUp(52_844_432_013, 698, "MLBU1406603522"), variacaoUp(52_844_432_017, 9_981, "MLBU1402620069")],
    });

    expect(result.approved).toBe(false);
    expect(result.blocks).toEqual([
      {
        code: "VARIACOES_USER_PRODUCT",
        descricao:
          "O Mercado Livre não permite republicar anúncio com variações de conta no modelo de user products — fechar o anúncio o deixaria fora do ar sem filho.",
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("basta UMA variação com user_product_id; valor não textual preenchido também conta (na dúvida, não fecha)", () => {
    for (const variations of [
      [variacao(1, 3), variacaoUp(2, 4, "MLBU1")],
      [variacaoUp(1, 3, 1_406_603_522)],
    ]) {
      const result = evaluateRelistPreflight({ ...healthyItem(), variations });

      expect(result.blocks.map((issue) => issue.code)).toEqual(["VARIACOES_USER_PRODUCT"]);
    }
  });

  it("variações SEM user_product_id (ausente, nulo ou vazio) continuam permitidas", () => {
    const result = evaluateRelistPreflight({
      ...healthyItem(),
      variations: [variacao(1, 3), variacaoUp(2, 4, null), variacaoUp(3, 5, ""), variacaoUp(4, 6, "  ")],
    });

    expect(result).toEqual({ approved: true, blocks: [], warnings: [] });
  });

  it("SEM variações e com user_product_id na raiz continua permitido — o filho mantém o mesmo user product", () => {
    const result = evaluateRelistPreflight({ ...healthyItem(), user_product_id: "MLBU3858499373", variations: [] });

    expect(result).toEqual({ approved: true, blocks: [], warnings: [] });
  });

  it("aparece junto dos outros bloqueios de variação", () => {
    const result = evaluateRelistPreflight({
      ...healthyItem(),
      variations: [variacaoUp(1, 0, "MLBU1"), variacaoUp(2, 0, "MLBU2")],
    });

    expect(result.blocks.map((issue) => issue.code)).toEqual(["VARIACOES_SEM_ESTOQUE", "VARIACOES_USER_PRODUCT"]);
  });

  it("hasUserProductVariations: só com variações; forma ilegível não conta", () => {
    expect(hasUserProductVariations({ variations: [{ user_product_id: "MLBU1" }] })).toBe(true);
    expect(hasUserProductVariations({ user_product_id: "MLBU1", variations: [] })).toBe(false);
    expect(hasUserProductVariations({ user_product_id: "MLBU1" })).toBe(false);

    for (const garbage of [null, undefined, "texto", 42, ["array"], { variations: "x" }, { variations: ["MLBU1", null] }]) {
      expect(hasUserProductVariations(garbage)).toBe(false);
    }
  });
});

describe("collectRelistInventoryIds (D-360)", () => {
  it("junta a raiz e as variações, sem repetir, e ignora ausentes", () => {
    expect(
      collectRelistInventoryIds({
        inventory_id: "A",
        variations: [{ inventory_id: "B" }, { inventory_id: "A" }, { id: 1 }, { inventory_id: null }, "lixo"],
      }),
    ).toEqual(["A", "B"]);
  });

  it("o que não é item não tem inventário", () => {
    for (const garbage of [null, undefined, "texto", 42, ["array"]]) {
      expect(collectRelistInventoryIds(garbage)).toEqual([]);
    }
  });
});

describe("summarizeRelistVariations (D-364)", () => {
  /** Variação como o GET /items devolve, com combinação e SKU. */
  function variacaoCompleta(id: number, estoque: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...variacao(id, estoque),
      attribute_combinations: [{ id: null, name: "Color", value_id: null, value_name: "Preto" }],
      seller_custom_field: null,
      ...extra,
    };
  }

  it("lista as variações sem estoque que ficam fora, com a combinação e o SKU — as mesmas do aviso", () => {
    const item = {
      ...healthyItem(),
      variations: [
        variacaoCompleta(52_844_432_013, 698),
        variacaoCompleta(52_844_432_007, 0, { seller_custom_field: "SB-RETRO-PRETO" }),
        variacaoCompleta(52_844_432_008, 0, {
          attribute_combinations: [
            { name: "Color", value_name: "Vermelho" },
            { name: "Lado", value_name: "Esquerdo" },
          ],
          attributes: [{ id: "SELLER_SKU", value_name: "SB-RETRO-VERM-E" }],
        }),
        variacaoCompleta(52_844_432_009, 0, { attribute_combinations: [] }),
      ],
    };

    const summary = summarizeRelistVariations(item);

    expect(summary).toEqual({
      total: 4,
      leftOut: [
        { id: "52844432007", label: "Color: Preto", sku: "SB-RETRO-PRETO" },
        { id: "52844432008", label: "Color: Vermelho, Lado: Esquerdo", sku: "SB-RETRO-VERM-E" },
        { id: "52844432009", label: null, sku: null },
      ],
    });

    const warning = evaluateRelistPreflight(item).warnings.find((issue) => issue.code === "VARIACOES_SEM_ESTOQUE_FORA");
    expect(warning?.descricao).toContain("3 de 4");
    expect(warning?.descricao).toContain("52844432007, 52844432008, 52844432009");
  });

  it("todas com estoque, sem variação, forma ilegível ou nenhuma com estoque (o preflight bloqueia): nada fica de fora", () => {
    expect(summarizeRelistVariations({ ...healthyItem(), variations: [variacao(1, 3), variacao(2, 1)] })).toEqual({
      total: 2,
      leftOut: [],
    });
    expect(summarizeRelistVariations(healthyItem())).toEqual({ total: 0, leftOut: [] });
    expect(summarizeRelistVariations({ ...healthyItem(), variations: [variacao(1, 0), variacao(2, 0)] })).toEqual({
      total: 2,
      leftOut: [],
    });
    expect(summarizeRelistVariations({ ...healthyItem(), variations: [variacao(1, 3), { id: 2, available_quantity: 0 }] })).toEqual({
      total: 2,
      leftOut: [],
    });

    for (const garbage of [null, undefined, "texto", { variations: "x" }]) {
      expect(summarizeRelistVariations(garbage)).toEqual({ total: 0, leftOut: [] });
    }
  });
});
