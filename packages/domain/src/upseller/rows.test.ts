import { describe, expect, it } from "vitest";

import {
  buildHeaderIndex,
  KIT_COLUMNS,
  LINK_COLUMNS,
  mapKitRow,
  mapLinkRow,
  mapProductRow,
  mapStockRow,
  missingColumns,
  PRODUCT_COLUMNS,
  STOCK_COLUMNS,
} from "./rows.js";

/**
 * Cabeçalhos e valores copiados da exportação real de 2026-08-20, incluindo os
 * acentos e o parêntese de largura total que o arquivo de estoque traz.
 */

const PRODUCT_HEADER = [
  "SKU", "SPU", "Código do Produto", "Título", "Apelido do Produto",
  "Usar o apelido do produto na NF", "Categorias",
  "Variantes1", "Variante1", "Variantes2", "Variante2", "Variantes3", "Variante3",
  "Variantes4", "Variante4", "Variantes5", "Variante5",
  "Data de Lançamento", "O produto está ativo", "Vendedor",
  "Preço de varejo", "Custo de Compra", "Descrição do Anúncio", "Marca",
  "Link do Vídeo", "Código de Barras", "Apelido de SKU", "Imagem",
  "Peso (g)", "Comprimento (cm)", "Largura (cm)", "Altura (cm)",
  "NCM", "CEST", "Unidade", "Origem", "Link do Fornecedor",
];

function productRow(overrides: Record<number, unknown> = {}): unknown[] {
  const row = new Array<unknown>(PRODUCT_HEADER.length).fill(null);
  row[0] = "PI50.DEFEITO";
  row[2] = "S148F22203";
  row[3] = "Painel Dafra Riva 150 DEFEITO";
  row[6] = "NAVETEC";
  row[18] = "Y";
  row[20] = "174.90";
  row[25] = "7893558945823";
  row[34] = "UN";
  row[35] = "0";

  for (const [k, v] of Object.entries(overrides)) {
    row[Number(k)] = v;
  }

  return row;
}

describe("buildHeaderIndex", () => {
  it("é tolerante a acento, caixa e espaço", () => {
    const index = buildHeaderIndex(["Título", "Armazém", "Código do Produto"]);

    expect(index.get("titulo")).toBe(0);
    expect(index.get("armazem")).toBe(1);
    expect(index.get("codigo do produto")).toBe(2);
  });

  it("normaliza o parêntese de largura total do arquivo de estoque", () => {
    // O cabeçalho real vem como `Em Trânsito(Transferência）` — o fecha-parêntese
    // é o caractere de largura total, não o ASCII. Comparar texto cru quebraria.
    const index = buildHeaderIndex(["Em Trânsito(Transferência）"]);

    expect(index.get("em transito transferencia")).toBe(0);
  });

  it("cabeçalho duplicado não sobrescreve o primeiro", () => {
    const index = buildHeaderIndex(["SKU", "SKU"]);

    expect(index.get("sku")).toBe(0);
  });
});

describe("missingColumns", () => {
  it("não acusa nada quando o arquivo é o esperado", () => {
    expect(missingColumns(buildHeaderIndex(PRODUCT_HEADER), PRODUCT_COLUMNS)).toEqual([]);
  });

  it("acusa a coluna ausente antes de processar milhares de linhas", () => {
    const index = buildHeaderIndex(["SKU", "Título"]);

    expect(missingColumns(index, PRODUCT_COLUMNS)).toEqual(["Código do Produto"]);
  });

  it("aponta o arquivo trocado", () => {
    const index = buildHeaderIndex(["KIT SKU", "SKU de Produto"]);

    expect(missingColumns(index, STOCK_COLUMNS).length).toBeGreaterThan(0);
  });
});

describe("mapProductRow", () => {
  const index = buildHeaderIndex(PRODUCT_HEADER);

  it("mapeia uma linha real do catálogo", () => {
    const result = mapProductRow(productRow(), index);

    expect(result.ok && result.value).toMatchObject({
      sku: "PI50.DEFEITO",
      skuKey: "PI50.DEFEITO",
      erpProductCode: "S148F22203",
      brand: "NAVETEC",
      originCode: 0,
      unit: "UN",
      retailPrice: 174.9,
      isActive: true,
      isDiscontinued: false,
    });
  });

  it("posição da coluna não importa — o mapeamento é por nome", () => {
    // Simula o UpSeller inserindo uma coluna nova no início. Com mapeamento
    // posicional, tudo deslocaria em silêncio.
    const header = ["Coluna Nova", ...PRODUCT_HEADER];
    const row = ["lixo", ...productRow()];

    const result = mapProductRow(row, buildHeaderIndex(header));

    expect(result.ok && result.value.sku).toBe("PI50.DEFEITO");
    expect(result.ok && result.value.retailPrice).toBe(174.9);
  });

  it("ESTOQUE INATIVO marca descontinuado e não vira marca", () => {
    const result = mapProductRow(productRow({ 6: "ESTOQUE INATIVO" }), index);

    expect(result.ok && result.value.isDiscontinued).toBe(true);
    expect(result.ok && result.value.brand).toBeNull();
  });

  it("origem importada é preservada como código fiscal", () => {
    const result = mapProductRow(productRow({ 35: "1" }), index);

    expect(result.ok && result.value.originCode).toBe(1);
  });

  it("recusa linha sem SKU", () => {
    expect(mapProductRow(productRow({ 0: null }), index).ok).toBe(false);
  });
});

describe("mapKitRow", () => {
  const header = [
    "KIT SKU", "Título", "Apelido do Produto", "Usar o apelido do produto na NF",
    "Categorias", "O produto está ativo", "Imagem", "SKU de Produto", "Qtd. SKU de Produto",
  ];
  const index = buildHeaderIndex(header);

  it("mapeia um componente real", () => {
    const row = ["BAULATPTO.BAU98.SUP99", "Kit Bau Traseiro", "", "N", "OFFRACER", "Y", "", "BAU98", 1];

    expect(mapKitRow(row, index)).toEqual({
      ok: true,
      value: {
        kitSku: "BAULATPTO.BAU98.SUP99",
        kitSkuKey: "BAULATPTO.BAU98.SUP99",
        kitTitle: "Kit Bau Traseiro",
        componentSku: "BAU98",
        componentSkuKey: "BAU98",
        quantity: 1,
      },
    });
  });

  it("aceita quantidade maior que um — medido: 2, 3, 4 e 10", () => {
    const row = ["KIT.X", "t", "", "N", "", "Y", "", "COMP", 10];

    expect(mapKitRow(row, index).ok && mapKitRow(row, index)).toMatchObject({
      value: { quantity: 10 },
    });
  });

  it("recusa kit que contém a si mesmo", () => {
    const row = ["KIT.X", "t", "", "N", "", "Y", "", "kit.x", 1];

    expect(mapKitRow(row, index).ok).toBe(false);
  });

  it("recusa quantidade zero ou negativa", () => {
    const row = ["KIT.X", "t", "", "N", "", "Y", "", "COMP", 0];

    expect(mapKitRow(row, index).ok).toBe(false);
  });

  it("valida a presença das colunas obrigatórias", () => {
    expect(missingColumns(index, KIT_COLUMNS)).toEqual([]);
  });
});

describe("mapLinkRow", () => {
  const header = [
    "SKU", "Mapeado SKU do Anúncio", "Variante",
    "ID do Anúncio", "ID da Variante", "Nome da Loja", "Atualizado",
  ];
  const index = buildHeaderIndex(header);

  it("mapeia anúncio com variação real", () => {
    const row = ["PI150", "-", "-", "MLB1722724235", "205704879161", "mercado-ML- Speedbikers (loja 1)", null];
    const result = mapLinkRow(row, index);

    expect(result.ok && result.value).toMatchObject({
      skuKey: "PI150",
      storeSlug: "ml-speedbikers-loja-1",
      ref: { kind: "ITEM", itemId: "MLB1722724235", variationId: "205704879161" },
    });
  });

  it("normaliza a variação repetida para null", () => {
    const row = ["PI150", "-", "-", "MLB1722724235", "MLB1722724235", "mercado-ML - GMR", null];
    const result = mapLinkRow(row, index);

    expect(result.ok && result.value.ref).toEqual({
      kind: "ITEM",
      itemId: "MLB1722724235",
      variationId: null,
    });
  });

  it("reconhece user product", () => {
    const row = ["PI50.DEFEITO", "PI50.DEFEITO", "-", "MLBU4818089142", "MLBU4818089142", "mercado-ML - SbMotos", null];
    const result = mapLinkRow(row, index);

    expect(result.ok && result.value.ref).toEqual({
      kind: "USER_PRODUCT",
      userProductId: "MLBU4818089142",
    });
  });

  it("guarda o SKU declarado no anúncio quando difere do interno", () => {
    const row = ["KP14", "632001", "-", "MLB1", "MLB1", "mercado-ML - GMR", null];
    const result = mapLinkRow(row, index);

    expect(result.ok && result.value.channelSku).toBe("632001");
  });

  it.each(["shopee-Speedbikers", "kwai-SpeedBikers", "temu-Speed Bikers", "tiktok-Speed Bikers"])(
    "descarta %s como decisão, não como erro",
    (store) => {
      const row = ["PI150", "-", "-", "MLB1", "MLB1", store, null];
      const result = mapLinkRow(row, index);

      expect(result.ok).toBe(false);
      expect(!result.ok && result.skipped).toBe(true);
    },
  );

  it("linha inválida NÃO é marcada como descartada", () => {
    // A distinção importa no relatório: descartado por decisão é esperado;
    // inválido precisa de atenção humana.
    const row = [null, "-", "-", "MLB1", "MLB1", "mercado-ML - GMR", null];
    const result = mapLinkRow(row, index);

    expect(!result.ok && result.skipped).toBeUndefined();
  });

  it("valida a presença das colunas obrigatórias", () => {
    expect(missingColumns(index, LINK_COLUMNS)).toEqual([]);
  });
});

describe("mapStockRow", () => {
  const header = [
    "SKU", "Título", "Armazém", "Estante", "Estoque Baixo",
    "Em Trânsito(Compra)", "Em Trânsito(Transferência）", "Ocupado",
    "Disponível", "Estoque Atual", "Custo Médio", "Subtotal", "Criado",
  ];
  const index = buildHeaderIndex(header);

  it("mapeia uma linha real de estoque", () => {
    const row = ["PI50.DEFEITO", "Painel", "ESTOQUE LOJA", null, 0, 0, 0, 0, 4, 4, null, null, null];

    expect(mapStockRow(row, index)).toEqual({
      ok: true,
      value: {
        skuKey: "PI50.DEFEITO",
        warehouse: "ESTOQUE LOJA",
        onHand: 4,
        available: 4,
        reserved: 0,
        inTransit: 0,
        averageCost: null,
      },
    });
  });

  it("'Ocupado' do ERP vira o reservado da V3", () => {
    const row = ["X", "t", "ESTOQUE LOJA", null, 0, 0, 0, 3, 7, 10, null, null, null];
    const result = mapStockRow(row, index);

    expect(result.ok && result.value.reserved).toBe(3);
    expect(result.ok && result.value.available).toBe(7);
  });

  it("soma as duas colunas de trânsito", () => {
    const row = ["X", "t", "ESTOQUE LOJA", null, 0, 2, 5, 0, 10, 10, null, null, null];
    const result = mapStockRow(row, index);

    expect(result.ok && result.value.inTransit).toBe(7);
  });

  it("custo médio ausente vira null, não zero", () => {
    const row = ["X", "t", "ESTOQUE LOJA", null, 0, 0, 0, 0, 1, 1, "-", null, null];
    const result = mapStockRow(row, index);

    expect(result.ok && result.value.averageCost).toBeNull();
  });

  it("recusa linha sem Estoque Atual", () => {
    const row = ["X", "t", "ESTOQUE LOJA", null, 0, 0, 0, 0, null, null, null, null, null];

    expect(mapStockRow(row, index).ok).toBe(false);
  });

  it("valida a presença das colunas obrigatórias", () => {
    expect(missingColumns(index, STOCK_COLUMNS)).toEqual([]);
  });
});
