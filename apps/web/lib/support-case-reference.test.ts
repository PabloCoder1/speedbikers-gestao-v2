import { describe, expect, it } from "vitest";

import type { SupportCaseLinkRow } from "./support-case-reference";
import { resolveSupportCaseReference } from "./support-case-reference";

function link(overrides: Partial<SupportCaseLinkRow> = {}): SupportCaseLinkRow {
  return {
    order_id: null,
    sku_id: null,
    listing_id: null,
    external_entity_kind: null,
    external_entity_id: null,
    skus: null,
    listings: null,
    ...overrides,
  };
}

const SKU_ID = "ssssssss-0000-4000-8000-000000000001";
const LISTING_ID = "llllllll-0000-4000-8000-000000000001";

describe("resolveSupportCaseReference", () => {
  it("sem vínculo nenhum devolve null — a tela mostra traço, não erro", () => {
    expect(resolveSupportCaseReference([])).toBeNull();
    expect(resolveSupportCaseReference(null)).toBeNull();
    expect(resolveSupportCaseReference(undefined)).toBeNull();
  });

  it("SKU vence, e é o único caso com rota de destino real", () => {
    const reference = resolveSupportCaseReference([
      link({ external_entity_kind: "LISTING", external_entity_id: "MLB123" }),
      link({ sku_id: SKU_ID, skus: { sku: "BAU05" } }),
    ]);

    expect(reference).toEqual({
      code: "BAU05",
      title: null,
      kind: "SKU",
      href: `/skus/${SKU_ID}`,
    });
  });

  it("anúncio resolvido localmente traz o título do produto junto", () => {
    const reference = resolveSupportCaseReference([
      link({ listing_id: LISTING_ID, listings: { item_id: "MLB1623490410", title: "Baú 45L" } }),
    ]);

    expect(reference).toMatchObject({ code: "MLB1623490410", title: "Baú 45L", kind: "LISTING" });
  });

  it("anúncio ainda não resolvido cai no item_id externo que D-086 preserva", () => {
    const reference = resolveSupportCaseReference([
      link({ external_entity_kind: "LISTING", external_entity_id: "MLB1623490410" }),
    ]);

    expect(reference).toEqual({
      code: "MLB1623490410",
      title: null,
      kind: "LISTING",
      href: null,
    });
  });

  it("anúncio NÃO ganha link — `/anuncios` é lista, não tem página por item (mesmo critério de D-074)", () => {
    const resolvido = resolveSupportCaseReference([
      link({ listing_id: LISTING_ID, listings: { item_id: "MLB1", title: null } }),
    ]);
    const externo = resolveSupportCaseReference([
      link({ external_entity_kind: "LISTING", external_entity_id: "MLB1" }),
    ]);

    expect(resolvido?.href).toBeNull();
    expect(externo?.href).toBeNull();
  });

  it("pedido só aparece quando é o único vínculo utilizável", () => {
    expect(resolveSupportCaseReference([link({ order_id: 2_000_003_508_426_396 })])).toMatchObject({
      code: "2000003508426396",
      kind: "ORDER",
    });

    // Com anúncio junto, o anúncio vence: diz QUAL produto, o pedido não.
    expect(
      resolveSupportCaseReference([
        link({ order_id: 42 }),
        link({ external_entity_kind: "LISTING", external_entity_id: "MLB9" }),
      ]),
    ).toMatchObject({ code: "MLB9", kind: "LISTING" });
  });

  it("vínculo de SKU sem o embed carregado não é tratado como SKU", () => {
    // A RLS de `skus` pode esconder a linha embutida mesmo com o vínculo
    // visível. Cair para a próxima opção é melhor que mostrar vazio.
    const reference = resolveSupportCaseReference([
      link({ sku_id: SKU_ID, skus: null }),
      link({ external_entity_kind: "LISTING", external_entity_id: "MLB7" }),
    ]);

    expect(reference).toMatchObject({ code: "MLB7", kind: "LISTING" });
  });

  it("entidade externa de outro tipo é ignorada, não vira referência de anúncio", () => {
    expect(
      resolveSupportCaseReference([
        link({ external_entity_kind: "BUYER", external_entity_id: "419067349" }),
      ]),
    ).toBeNull();
  });
});
