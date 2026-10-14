import { describe, expect, it } from "vitest";

import {
  MOTIVO_MAX,
  acaoDoVinculoShopee,
  depoisDaRemocao,
  describeShopeeLinkError,
  lerRemocaoShopee,
  lerVinculoShopee,
  podeVincularShopee,
  skuQueOAnuncioIndica,
} from "./shopee-link";

const LOJA = "5b1d0000-0000-4000-8000-000000000001";
const SKU = "5b1d0000-0000-4000-8000-0000000000aa";
const LINK = "5b1d0000-0000-4000-8000-0000000000bb";

describe("podeVincularShopee (D-429)", () => {
  it("o mesmo corte das RPCs: ADMIN, GESTOR e OPERADOR", () => {
    for (const papel of ["ADMIN", "GESTOR", "OPERADOR"]) expect(podeVincularShopee(papel)).toBe(true);
    for (const papel of ["ANALISTA", "VISUALIZADOR", "admin", ""]) expect(podeVincularShopee(papel)).toBe(false);
    expect(podeVincularShopee(null)).toBe(false);
  });
});

describe("acaoDoVinculoShopee", () => {
  it("manual: trocar e remover, com o id do vínculo", () => {
    expect(acaoDoVinculoShopee({ estado: "VINCULADO", vinculo_via: "MANUAL", manual_link_id: LINK })).toEqual({
      tipo: "manual",
      linkId: LINK,
    });
    // Sem o id não há o que trocar nem remover.
    expect(acaoDoVinculoShopee({ estado: "VINCULADO", vinculo_via: "MANUAL", manual_link_id: null }).tipo).toBe(
      "nenhuma",
    );
  });

  it("pelo SKU do anúncio: vincular a outro SKU", () => {
    expect(acaoDoVinculoShopee({ estado: "VINCULADO", vinculo_via: "SKU_DO_ANUNCIO", manual_link_id: null }).tipo).toBe(
      "outro-sku",
    );
  });

  it("sem SKU e fora do catálogo: vincular; aguardando: nada, e diz por quê", () => {
    expect(acaoDoVinculoShopee({ estado: "SEM_SKU_NO_ANUNCIO", vinculo_via: null, manual_link_id: null }).tipo).toBe(
      "vincular",
    );
    expect(acaoDoVinculoShopee({ estado: "SKU_FORA_DO_CATALOGO", vinculo_via: null, manual_link_id: null }).tipo).toBe(
      "vincular",
    );
    expect(acaoDoVinculoShopee({ estado: "AGUARDANDO_LEITURA", vinculo_via: null, manual_link_id: null }).tipo).toBe(
      "aguardando",
    );
    expect(acaoDoVinculoShopee({ estado: "NOVO", vinculo_via: null, manual_link_id: null }).tipo).toBe("nenhuma");
  });
});

describe("skuQueOAnuncioIndica", () => {
  it("só quando o manual discorda do anúncio", () => {
    expect(skuQueOAnuncioIndica({ vinculo_via: "MANUAL", sku: "A", sku_pelo_anuncio: "B" })).toBe("B");
    expect(skuQueOAnuncioIndica({ vinculo_via: "MANUAL", sku: "A", sku_pelo_anuncio: "A" })).toBeNull();
    expect(skuQueOAnuncioIndica({ vinculo_via: "MANUAL", sku: "A", sku_pelo_anuncio: null })).toBeNull();
    expect(skuQueOAnuncioIndica({ vinculo_via: "SKU_DO_ANUNCIO", sku: "A", sku_pelo_anuncio: "A" })).toBeNull();
  });
});

describe("depoisDaRemocao", () => {
  it("diz para onde a linha vai: o SKU do anúncio, ou lugar nenhum", () => {
    expect(depoisDaRemocao({ skuAnuncio: "abc", skuPeloAnuncio: "ABC" })).toMatch(/vinculada ao SKU ABC/);
    expect(depoisDaRemocao({ skuAnuncio: "XYZ", skuPeloAnuncio: null })).toMatch(/“XYZ”, que não existe no catálogo/);
    expect(depoisDaRemocao({ skuAnuncio: null, skuPeloAnuncio: null })).toMatch(/não tem SKU do vendedor/);
  });
});

describe("lerVinculoShopee", () => {
  const valido = { lojaId: LOJA, itemId: 990_000_102, modelId: 2, skuId: SKU };

  it("aceita variação e item sem variação; motivo aparado, vazio é nulo", () => {
    expect(lerVinculoShopee({ ...valido, motivo: "  conferido na caixa  " })).toEqual({
      ok: true,
      value: { ...valido, motivo: "conferido na caixa" },
    });
    expect(lerVinculoShopee({ ...valido, modelId: null, motivo: "   " })).toEqual({
      ok: true,
      value: { ...valido, modelId: null, motivo: null },
    });
  });

  it("recusa forma errada antes de tocar o banco", () => {
    expect(lerVinculoShopee(null).ok).toBe(false);
    expect(lerVinculoShopee({ ...valido, lojaId: "loja" }).ok).toBe(false);
    expect(lerVinculoShopee({ ...valido, itemId: 0 }).ok).toBe(false);
    expect(lerVinculoShopee({ ...valido, itemId: 1.5 }).ok).toBe(false);
    expect(lerVinculoShopee({ ...valido, itemId: "990000102" }).ok).toBe(false);
    expect(lerVinculoShopee({ ...valido, modelId: -1 }).ok).toBe(false);
    expect(lerVinculoShopee({ ...valido, skuId: "" })).toEqual({ ok: false, message: "Escolha o SKU de destino." });
    expect(lerVinculoShopee({ ...valido, motivo: "x".repeat(MOTIVO_MAX + 1) }).ok).toBe(false);
  });
});

describe("lerRemocaoShopee", () => {
  it("motivo obrigatório, aparado e com teto", () => {
    expect(lerRemocaoShopee(LINK, "  vinculado errado ")).toEqual({
      ok: true,
      value: { linkId: LINK, motivo: "vinculado errado" },
    });
    expect(lerRemocaoShopee(LINK, "   ")).toEqual({
      ok: false,
      message: "Informe o motivo da remoção — ele fica no histórico.",
    });
    expect(lerRemocaoShopee(LINK, "x".repeat(MOTIVO_MAX + 1)).ok).toBe(false);
    expect(lerRemocaoShopee("não-é-uuid", "motivo").ok).toBe(false);
  });
});

describe("describeShopeeLinkError", () => {
  it("sem erro é nulo", () => {
    expect(describeShopeeLinkError(null)).toBeNull();
  });

  it("cada recusa nomeada da migration vira uma frase própria", () => {
    const frases = [
      "sem permissao para vincular anuncios desta loja",
      "SKU pertence a outra organizacao",
      "variacao nao encontrada no catalogo sincronizado",
      "item sem variacao nao encontrado no catalogo sincronizado",
      "item com variacao: vincule cada variacao",
      `loja shopee ${LOJA} nao encontrada`,
      "motivo obrigatorio para remover o vinculo",
      `vinculo ${LINK} nao encontrado`,
    ].map((message) => describeShopeeLinkError({ message }));

    expect(new Set(frases).size).toBe(frases.length);
    expect(frases[0]).toMatch(/permissão/);
    expect(frases[1]).toMatch(/outra organização/);
    expect(frases[2]).toMatch(/variação não está no catálogo/);
    expect(frases[3]).toMatch(/ainda não foi lido por inteiro/);
    expect(frases[4]).toMatch(/o vínculo é por variação/);
    expect(frases[5]).toMatch(/loja deste anúncio/);
    expect(frases[6]).toMatch(/motivo da remoção/);
    expect(frases[7]).toMatch(/vínculo manual não existe mais/);
  });

  it("função ausente é a novidade que não chegou; o resto, genérico — nunca o texto cru", () => {
    expect(describeShopeeLinkError({ message: "x", code: "PGRST202" })).toMatch(/próxima atualização do banco/);
    expect(describeShopeeLinkError({ message: "duplicate key", code: "23505" })).toMatch(/agora mesmo/);
    expect(describeShopeeLinkError({ message: "deadlock detected", code: "40P01" })).toBe(
      "Não foi possível gravar agora. Tente de novo.",
    );
  });
});
