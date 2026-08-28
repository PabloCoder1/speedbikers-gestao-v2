import { describe, expect, it } from "vitest";

import {
  readKitComponent,
  readListingLink,
  readSkuUpsert,
  readStockSnapshot,
} from "./apply.js";
import { mapKitRow, mapLinkRow, mapProductRow, mapStockRow, buildHeaderIndex } from "./rows.js";

/**
 * O teste que mais importa aqui é o de ida e volta: o que o parser gravou tem
 * que voltar íntegro depois de passar por `jsonb`. Se as duas metades
 * divergirem, a importação grava dado plausível e errado — o modo de falha
 * mais caro deste projeto.
 */
function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

describe("leitura do payload gravado na conferência", () => {
  it("produto sobrevive à ida e volta pelo jsonb", () => {
    const header = ["SKU", "Título", "Preço de varejo", "Custo de Compra", "Categorias", "Origem"];
    const index = buildHeaderIndex(header);

    const mapped = mapProductRow(
      ["PI150", "Painel Titan 150", "174,90", "89,50", "PLASMOTO", "0"],
      index,
    );

    expect(mapped.ok).toBe(true);

    const read = readSkuUpsert(roundTrip(mapped.ok ? mapped.value : null));

    expect(read.ok).toBe(true);

    if (!read.ok) return;

    expect(read.value.sku).toBe("PI150");
    // O bug histórico: 174,90 virando 17490. Se voltasse errado daqui, o preço
    // entraria multiplicado por cem no catálogo.
    expect(read.value.retail_price).toBe(174.9);
    expect(read.value.purchase_cost).toBe(89.5);
    expect(read.value.origin_code).toBe(0);
  });

  it("vínculo com variação sobrevive à ida e volta", () => {
    const index = buildHeaderIndex([
      "SKU",
      "Mapeado SKU do Anúncio",
      "Variante",
      "ID do Anúncio",
      "ID da Variante",
      "Nome da Loja",
    ]);

    const mapped = mapLinkRow(
      ["PI150", "-", "-", "MLB1722724235", "205704879161", "mercado-ML- Speedbikers (loja 1)"],
      index,
    );

    expect(mapped.ok).toBe(true);

    const read = readListingLink(roundTrip(mapped.ok ? mapped.value : null));

    expect(read.ok).toBe(true);

    if (!read.ok) return;

    expect(read.value.refKind).toBe("ITEM");
    expect(read.value.itemId).toBe("MLB1722724235");
    expect(read.value.variationId).toBe("205704879161");
    expect(read.value.storeSlug).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("kit e estoque sobrevivem à ida e volta", () => {
    const kitIndex = buildHeaderIndex(["KIT SKU", "Título", "SKU de Produto", "Qtd. SKU de Produto"]);
    const kit = mapKitRow(["KIT01", "Kit revisão", "PI150", "2"], kitIndex);

    expect(kit.ok).toBe(true);

    const readKit = readKitComponent(roundTrip(kit.ok ? kit.value : null));

    expect(readKit).toMatchObject({
      ok: true,
      value: { kitSkuKey: "KIT01", componentSkuKey: "PI150", quantity: 2 },
    });

    const stockIndex = buildHeaderIndex([
      "SKU",
      "Armazém",
      "Ocupado",
      "Disponível",
      "Estoque Atual",
      "Em Trânsito(Compra)",
    ]);
    const stock = mapStockRow(["FA100", "ESTOQUE LOJA", "2", "8", "10", "0"], stockIndex);

    expect(stock.ok).toBe(true);

    const readStock = readStockSnapshot(roundTrip(stock.ok ? stock.value : null));

    expect(readStock).toMatchObject({
      ok: true,
      value: { skuKey: "FA100", warehouse: "ESTOQUE LOJA", onHand: 10, available: 8, reserved: 2 },
    });
  });
});

describe("recusa antes do banco, e não pelo banco", () => {
  it("payload que não é objeto não vira INSERT", () => {
    for (const bad of [null, "texto", 42, [1, 2]]) {
      expect(readSkuUpsert(bad).ok).toBe(false);
      expect(readListingLink(bad).ok).toBe(false);
      expect(readStockSnapshot(bad).ok).toBe(false);
      expect(readKitComponent(bad).ok).toBe(false);
    }
  });

  it("origem fora de 0..8 é descartada, e o resto da linha é preservado", () => {
    // O banco tem `check (origin_code between 0 and 8)`. Um valor fora dali
    // derrubaria o bloco inteiro de mil linhas.
    const read = readSkuUpsert({ sku: "X1", originCode: 42, title: "Peça" });

    expect(read).toMatchObject({ ok: true, value: { origin_code: null, title: "Peça" } });
  });

  it("número não finito não chega ao banco", () => {
    const read = readSkuUpsert({ sku: "X1", retailPrice: Number.NaN, weightG: Infinity });

    expect(read).toMatchObject({ ok: true, value: { retail_price: null, weight_g: null } });
  });

  it("identificador de anúncio fora do formato vira pendência, não erro do lote", () => {
    const base = { skuKey: "X1", storeSlug: "ml-loja", storeLabel: "ML - Loja" };

    expect(readListingLink({ ...base, ref: { kind: "ITEM", itemId: "ABC123" } }).ok).toBe(false);
    expect(
      readListingLink({ ...base, ref: { kind: "ITEM", itemId: "MLB1", variationId: "x9" } }).ok,
    ).toBe(false);
    expect(readListingLink({ ...base, ref: { kind: "USER_PRODUCT", userProductId: "MLB1" } }).ok).toBe(
      false,
    );
    expect(readListingLink({ ...base, ref: { kind: "INVALID", reason: "x" } }).ok).toBe(false);
  });

  it("MLBU não pode entrar como se fosse anúncio", () => {
    // `MLBU123` casa com o prefixo `MLB`. Se passasse como ITEM, o vínculo
    // apontaria para um anúncio que não existe.
    const read = readListingLink({
      skuKey: "X1",
      storeSlug: "ml-loja",
      storeLabel: "ML - Loja",
      ref: { kind: "ITEM", itemId: "MLBU123" },
    });

    expect(read.ok).toBe(false);
  });

  it("quantidade não positiva e kit dentro de si mesmo são recusados", () => {
    expect(readKitComponent({ kitSkuKey: "K", componentSkuKey: "C", quantity: 0 }).ok).toBe(false);
    expect(readKitComponent({ kitSkuKey: "K", componentSkuKey: "C", quantity: -1 }).ok).toBe(false);
    expect(readKitComponent({ kitSkuKey: "K", componentSkuKey: "K", quantity: 1 }).ok).toBe(false);
  });

  it("estoque sem saldo é pendência; sem reservado apenas vira zero", () => {
    expect(readStockSnapshot({ skuKey: "X", warehouse: "LOJA" }).ok).toBe(false);
    expect(
      readStockSnapshot({ skuKey: "X", warehouse: "LOJA", onHand: 5, available: 5 }),
    ).toMatchObject({ ok: true, value: { reserved: 0, inTransit: 0 } });
  });

  it("produto sem marcação de ativo é tratado como ativo", () => {
    // O ERP só marca o contrário. Tratar ausência como inativo desligaria o
    // catálogo inteiro.
    expect(readSkuUpsert({ sku: "X1" })).toMatchObject({ ok: true, value: { is_active: true } });
    expect(readSkuUpsert({ sku: "X1", isActive: false })).toMatchObject({
      ok: true,
      value: { is_active: false },
    });
  });
});

describe("as colunas de CURADORIA são imunes ao importador (D-133)", () => {
  // ESTE TESTE É UMA TRAVA, não uma verificação de rotina.
  //
  // Quatro colunas de `skus` só podem ser preenchidas por gente:
  // `stock_is_virtual` (D-127), `supplier_brand` (D-129) e as duas datas de
  // decisão (D-133). A imunidade delas ao importador é INCIDENTAL — vem de
  // `applyProducts` fazer `.update(item.record)`, um UPDATE parcial com as
  // chaves que `readSkuUpsert` devolve. Basta alguém acrescentar um campo a
  // `SkuUpsert` sem pensar nisto para a curadoria começar a ser apagada a
  // cada planilha, EM SILÊNCIO: o import continua verde e a decisão humana
  // some.
  //
  // Foi exatamente esse mecanismo que obrigou D-129 a criar `supplier_brand`
  // em vez de corrigir `brand` — o importador sobrescreve `brand` sempre.
  //
  // Se você está aqui porque este teste ficou vermelho: confira se a coluna
  // nova é mesmo do ERP. Se for, acrescente a chave à lista abaixo. Se for
  // decisão humana, ela NÃO pode entrar em `SkuUpsert`.
  const CHAVES_DO_ERP = [
    "barcode",
    "brand",
    "category_raw",
    "cest",
    "erp_product_code",
    "erp_spu",
    "height_cm",
    "image_url",
    "is_active",
    "is_discontinued",
    "length_cm",
    "ncm",
    "origin_code",
    "purchase_cost",
    "retail_price",
    "sku",
    "title",
    "unit",
    "weight_g",
    "width_cm",
  ];

  const CURADAS = [
    "stock_is_virtual",
    "stock_is_virtual_set_at",
    "stock_is_virtual_set_by",
    "supplier_brand",
    "supplier_brand_source",
    "supplier_brand_set_at",
    "supplier_brand_set_by",
  ];

  it("readSkuUpsert devolve EXATAMENTE as chaves do ERP, nem uma a mais", () => {
    const read = readSkuUpsert({ sku: "ABC-1", title: "Peça" });

    expect(read.ok).toBe(true);
    expect(Object.keys(read.ok ? read.value : {}).sort()).toEqual(CHAVES_DO_ERP);
  });

  it("nenhuma coluna de curadoria aparece no que o importador escreve", () => {
    const read = readSkuUpsert({ sku: "ABC-1", title: "Peça" });
    const escritas = new Set(Object.keys(read.ok ? read.value : {}));

    for (const curada of CURADAS) {
      expect(escritas.has(curada)).toBe(false);
    }
  });
});
