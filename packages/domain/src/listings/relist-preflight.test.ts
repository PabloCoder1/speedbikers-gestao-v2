import { describe, expect, it } from "vitest";

import { evaluateRelistPreflight } from "./relist-preflight.js";

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

  it("Full pela RAIZ (inventory_id) bloqueia — a doc de relist é silenciosa sobre o CD", () => {
    const result = evaluateRelistPreflight({ ...healthyItem(), inventory_id: "LCQI05831" });

    expect(result.approved).toBe(false);
    expect(result.blocks.map((issue) => issue.code)).toEqual(["FULL_BLOQUEADO"]);
  });

  it("Full por VARIAÇÃO bloqueia igual — cada variação tem o próprio inventory_id (§2.7)", () => {
    const result = evaluateRelistPreflight({
      ...healthyItem(),
      variations: [{ id: 123, inventory_id: "LCQI99999" }, { id: 456 }],
    });

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
    const result = evaluateRelistPreflight({
      ...healthyItem(),
      tags: ["relist"],
      inventory_id: "LCQI05831",
      catalog_listing: true,
      parent_item_id: "MLB900000000",
      listing_type_id: "free",
    });

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
