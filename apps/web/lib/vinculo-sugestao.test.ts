import { describe, expect, it } from "vitest";

import { lerSugestoesDoAnuncio, planejarVinculo, type SugestoesDoAnuncio, type VariacaoVista } from "./vinculo-sugestao";

const vista = (parcial: Partial<VariacaoVista>): VariacaoVista => ({
  variationId: null,
  sellerSku: "13014",
  pedidos: 10,
  unidades: 10,
  ultimoPedidoEm: "2026-09-14T16:47:08Z",
  titulo: "Farol CG",
  skuId: "sku-13014",
  sku: "13014",
  skuTitle: "Farol Cg 125",
  ...parcial,
});

const sugestoes = (variacoes: VariacaoVista[], vinculos: SugestoesDoAnuncio["vinculos"] = []): SugestoesDoAnuncio => ({
  variacoes,
  vinculos,
});

describe("lerSugestoesDoAnuncio", () => {
  it("lê a resposta real do Dev (anúncio sem variação, SKU casado)", () => {
    const r = lerSugestoesDoAnuncio({
      variacoes: [
        {
          sku: "FA160",
          sku_id: "abf72ee2-ba00-43f5-9f51-65e87479bba0",
          titulo: "Farol Nmax 160",
          pedidos: 8,
          unidades: 8,
          sku_title: "Farol Nmax 160 2025",
          seller_sku: "FA160",
          variation_id: null,
          ultimo_pedido_em: "2026-09-12T14:46:46.913849+00:00",
          coluna_futura: "ignorada",
        },
      ],
      vinculos: [],
    });

    expect(r?.variacoes[0]).toMatchObject({ sku: "FA160", variationId: null, unidades: 8 });
  });

  it("fora do contrato é recusado inteiro", () => {
    expect(lerSugestoesDoAnuncio({ variacoes: [{ pedidos: "8" }], vinculos: [] })).toBeNull();
    expect(lerSugestoesDoAnuncio({ variacoes: [] })).toBeNull();
    expect(lerSugestoesDoAnuncio(null)).toBeNull();
  });
});

describe("planejarVinculo", () => {
  it("anúncio sem variação com um SKU casado: sugestão certa do anúncio inteiro", () => {
    const plano = planejarVinculo(sugestoes([vista({})]));

    expect(plano.forma).toBe("inteiro");
    expect(plano.completo).toBe(false);
    expect(plano.alvos[0]?.sugestao?.sku).toBe("13014");
  });

  it("dois SKUs vendidos no mesmo anúncio: ambíguo, lista as opções sem pré-selecionar", () => {
    const plano = planejarVinculo(
      sugestoes([vista({ unidades: 3 }), vista({ sellerSku: "FA160", skuId: "sku-fa160", sku: "FA160", unidades: 9 })]),
    );

    expect(plano.alvos[0]?.sugestao).toBeNull();
    // Do que mais vendeu ao que menos.
    expect(plano.alvos[0]?.opcoes.map((o) => o.sku)).toEqual(["FA160", "13014"]);
  });

  it("um SKU casado e outro código sem cadastro no mesmo alvo: também não é certeza", () => {
    const plano = planejarVinculo(
      sugestoes([vista({}), vista({ sellerSku: "XPTO-9", skuId: null, sku: null, skuTitle: null })]),
    );

    expect(plano.alvos[0]?.sugestao).toBeNull();
    expect(plano.alvos[0]?.semCadastro).toEqual(["XPTO-9"]);
  });

  it("pedidos com variação: um alvo por variação, cada um com a sua sugestão", () => {
    const plano = planejarVinculo(
      sugestoes([
        vista({ variationId: "111", unidades: 2, sellerSku: "A", skuId: "sku-a", sku: "A" }),
        vista({ variationId: "222", unidades: 7, sellerSku: "B", skuId: "sku-b", sku: "B" }),
      ]),
    );

    expect(plano.forma).toBe("variacoes");
    expect(plano.alvos.map((a) => [a.variationId, a.sugestao?.sku])).toEqual([
      ["222", "B"],
      ["111", "A"],
    ]);
  });

  it("vínculo existente: variação já vinculada vai para o fim; anúncio inteiro vinculado encerra", () => {
    const porVariacao = planejarVinculo(
      sugestoes(
        [
          vista({ variationId: "111", unidades: 50, sellerSku: "A", skuId: "sku-a", sku: "A" }),
          vista({ variationId: "222", unidades: 1, sellerSku: "B", skuId: "sku-b", sku: "B" }),
        ],
        [{ linkId: "l1", variationId: "111", skuId: "sku-a", sku: "A" }],
      ),
    );

    expect(porVariacao.alvos.map((a) => a.variationId)).toEqual(["222", "111"]);
    expect(porVariacao.completo).toBe(false);

    const inteiro = planejarVinculo(sugestoes([vista({})], [{ linkId: "l2", variationId: null, skuId: "sku-13014", sku: "13014" }]));

    expect(inteiro.completo).toBe(true);
  });

  it("sem pedido nenhum: um alvo do anúncio inteiro, sem sugestão", () => {
    const plano = planejarVinculo(sugestoes([]));

    expect(plano).toMatchObject({ forma: "inteiro", completo: false });
    expect(plano.alvos[0]?.opcoes).toEqual([]);
  });
});
