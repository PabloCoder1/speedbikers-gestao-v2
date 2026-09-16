import { describe, expect, it } from "vitest";

import type { RelistFullStockReading } from "./relist-preflight.js";
import { collectRelistInventoryIds, evaluateRelistPreflight } from "./relist-preflight.js";

/** Forma mínima de um item SAUDÁVEL para o preflight — cada teste quebra um pedaço. */
function healthyItem(): Record<string, unknown> {
  return {
    id: "MLB910000001",
    tags: ["good_quality_picture"],
    catalog_listing: false,
    listing_type_id: "gold_special",
    variations: [],
  };
}

/** Leituras do Full por `inventory_id`, como o worker entrega (D-360). */
function full(entries: Record<string, RelistFullStockReading | null>): Map<string, RelistFullStockReading | null> {
  return new Map(Object.entries(entries));
}

const ZERADO: RelistFullStockReading = { availableQuantity: 0, notAvailableQuantity: 0 };

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
        variations: [{ id: 123, inventory_id: "LCQI99999" }, { id: 456 }],
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
      { ...healthyItem(), variations: [{ id: 1, inventory_id: "INV-A" }, { id: 2, inventory_id: "INV-B" }] },
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
      { ...healthyItem(), inventory_id: "INV-RAIZ", variations: [{ id: 1, inventory_id: "INV-VAR" }] },
      full({ "INV-RAIZ": ZERADO, "INV-VAR": { availableQuantity: 1, notAvailableQuantity: 1 } }),
    );

    expect(result.blocks.map((issue) => issue.code)).toEqual(["FULL_BLOQUEADO"]);
    expect(result.blocks[0]?.descricao).toContain("2 unidade(s)");
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
