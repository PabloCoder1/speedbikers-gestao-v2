import { describe, expect, it } from "vitest";

import { acaoDeVinculo, motivoDaRemocao, resumoDeAnuncios, type AnuncioDoSku } from "./sku-listings";

/**
 * O que a tela do SKU pode oferecer em cada linha (D-316).
 *
 * O caso que dá nome ao módulo é o terceiro: uma linha que só existe pela
 * projeção do sync não tem vínculo para remover, e a tela tem de dizer isso em
 * vez de mostrar um botão que a RPC recusaria com "vinculo nao encontrado".
 */
const BASE: AnuncioDoSku = {
  listing_id: "l1",
  ml_account_id: "c1",
  account_label: "Loja E2E",
  item_id: "MLB800000001",
  title: "Kit Relação",
  status: "active",
  price: 189.9,
  available_quantity: 12,
  synced_at: "2026-09-11T10:41:00.000Z",
  vinculo_forma: "item_inteiro",
  apenas_cache: false,
  links: [{ id: "k1", variation_id: null, source: "MANUAL", confirmed_at: null }],
};

describe("acaoDeVinculo", () => {
  it("vínculo do anúncio inteiro: dá para remover, e o alvo é ele", () => {
    const r = acaoDeVinculo(BASE);

    expect(r.linkId).toBe("k1");
    expect(r.motivoSemAcao).toBeNull();
    expect(r.rotuloForma).toBe("anúncio inteiro");
  });

  it("uma variação só: também dá para remover", () => {
    const r = acaoDeVinculo({
      ...BASE,
      vinculo_forma: "variacao",
      links: [{ id: "k2", variation_id: "77", source: "IMPORT_UPSELLER", confirmed_at: null }],
    });

    expect(r.linkId).toBe("k2");
    expect(r.rotuloForma).toBe("por variação");
  });

  it("sem linha de vínculo NÃO oferece remoção — e diz por quê", () => {
    const r = acaoDeVinculo({ ...BASE, vinculo_forma: "cache_sem_linha", apenas_cache: true, links: [] });

    expect(r.linkId).toBeNull();
    expect(r.motivoSemAcao).toContain("não há linha de vínculo");
    expect(r.rotuloForma).toBe("herdado da sincronização");
  });

  /*
    DUAS VARIAÇÕES VINCULADAS: remover "o vínculo" deixa de ser uma ação só, e
    a tela não escolhe por quem opera. Se houver vínculo do anúncio inteiro
    junto, é ELE o alvo — remover o todo é a ação que a linha representa.
  */
  it("várias variações e nenhum vínculo de anúncio inteiro: manda para Vinculações", () => {
    const r = acaoDeVinculo({
      ...BASE,
      vinculo_forma: "variacao",
      links: [
        { id: "k2", variation_id: "77", source: "MANUAL", confirmed_at: null },
        { id: "k3", variation_id: "78", source: "MANUAL", confirmed_at: null },
      ],
    });

    expect(r.linkId).toBeNull();
    expect(r.variosVinculos).toBe(true);
    expect(r.motivoSemAcao).toContain("2 vínculos por variação");
  });

  it("anúncio inteiro convivendo com variação: o alvo é o do anúncio inteiro", () => {
    const r = acaoDeVinculo({
      ...BASE,
      links: [
        { id: "k3", variation_id: "78", source: "MANUAL", confirmed_at: null },
        { id: "k1", variation_id: null, source: "MANUAL", confirmed_at: null },
      ],
    });

    expect(r.linkId).toBe("k1");
    expect(r.variosVinculos).toBe(true);
    expect(r.motivoSemAcao).toBeNull();
  });
});

describe("o texto que fica no histórico e na tela", () => {
  it("o motivo da remoção diz de onde veio — a constraint recusa vazio", () => {
    expect(motivoDaRemocao("E2E-SKU-001")).toBe("Removido no Dashboard do SKU E2E-SKU-001");
    expect(motivoDaRemocao("X").trim()).not.toBe("");
  });

  it("a contagem carrega a régua, porque o número SUBIU ao virar canônico", () => {
    expect(resumoDeAnuncios(1)).toBe("1 anúncio deste SKU — vínculo direto ou por variação, uma vez por conta e anúncio");
    expect(resumoDeAnuncios(2)).toContain("2 anúncios");
  });
});
