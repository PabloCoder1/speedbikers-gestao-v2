import { describe, expect, it } from "vitest";

import { compararPrecoDaConta, diagnosticarSku, type EntradaDoDiagnostico } from "./sku-diagnostico";
import type { AnuncioDoSku } from "./sku-listings";

/**
 * O diagnóstico do SKU (D-317).
 *
 * O que estes casos guardam não é a aritmética — é a **régua**. Cada selo tem
 * uma condição escrita, e o que não tem condição não vira selo: vira linha em
 * `semRegua`. Um teste que aceitasse "atenção" sem régua tornaria o módulo
 * inteiro decorativo.
 */
const AGORA = new Date("2026-09-11T18:00:00.000Z");

const anuncio = (over: Partial<AnuncioDoSku> = {}): AnuncioDoSku => ({
  listing_id: "l1",
  ml_account_id: "c1",
  account_label: "Loja 1",
  item_id: "MLB1",
  title: "Farol",
  status: "active",
  price: 100,
  available_quantity: 5,
  synced_at: "2026-09-11T17:00:00.000Z",
  vinculo_forma: "item_inteiro",
  apenas_cache: false,
  links: [],
  ...over,
});

const entrada = (over: Partial<EntradaDoDiagnostico> = {}): EntradaDoDiagnostico => ({
  anuncios: [anuncio()],
  estoqueInterno: { local: 10, reservado: 0, transito: 0, full: 0, virtual: false },
  acoesAbertas: [],
  agora: AGORA,
  contaEscopo: null,
  ...over,
});

describe("diagnosticarSku", () => {
  it("tudo em ordem é SAUDÁVEL, e saudável não inventa problema", () => {
    const d = diagnosticarSku(entrada());

    expect(d.nivel).toBe("ok");
    expect(d.problemas).toHaveLength(0);
    expect(d.ativos).toBe(1);
  });

  it("sem anúncio nenhum não há veredito — `null`, não “ok”", () => {
    const d = diagnosticarSku(entrada({ anuncios: [] }));

    expect(d.nivel).toBeNull();
  });

  it("ativo com zero anunciado é CRÍTICO, e a régua sai junto", () => {
    const d = diagnosticarSku(entrada({ anuncios: [anuncio({ available_quantity: 0 })] }));

    expect(d.nivel).toBe("critico");
    expect(d.problemas[0]?.titulo).toBe("Anúncio ativo sem estoque");
    expect(d.problemas[0]?.regua).toBe("status = ativo e estoque anunciado = 0");
    // As quatro partes que o dono pediu, e nenhuma vazia.
    expect(d.problemas[0]?.problema.length).toBeGreaterThan(10);
    expect(d.problemas[0]?.causa.length).toBeGreaterThan(10);
    expect(d.problemas[0]?.recomendacao.length).toBeGreaterThan(10);
  });

  it("pausado com estoque é ATENÇÃO — pausar pode ter sido deliberado", () => {
    const d = diagnosticarSku(entrada({ anuncios: [anuncio({ status: "paused" })] }));

    expect(d.nivel).toBe("critico"); // estoque sem vitrine entra junto
    expect(d.problemas.map((p) => p.titulo)).toContain("Anúncio pausado com estoque disponível");
    expect(d.problemas.map((p) => p.titulo)).toContain("Estoque sem anúncio ativo");
  });

  /*
    SALDO SENTINELA NÃO GERA VEREDITO NENHUM (D-127): o número do ERP existe
    para o anúncio não pausar, e compará-lo produziria divergência inventada.
  */
  it("estoque virtual não vira problema de estoque — vira linha de `semRegua`", () => {
    const d = diagnosticarSku(
      entrada({
        anuncios: [anuncio({ status: "paused" })],
        estoqueInterno: { local: 9999, reservado: 0, transito: 0, full: 0, virtual: true },
      }),
    );

    expect(d.problemas.map((p) => p.titulo)).not.toContain("Anúncio pausado com estoque disponível");
    expect(d.semRegua.join(" ")).toContain("sentinela");
  });

  it("catálogo velho acende com a cadência REAL do job, não com número inventado", () => {
    // 13 horas: mais que 2 × 6 h de cadência do catálogo.
    const d = diagnosticarSku({
      ...entrada(),
      anuncios: [anuncio({ synced_at: "2026-09-11T05:00:00.000Z" })],
    });

    const problema = d.problemas.find((p) => p.titulo === "Retrato do anúncio desatualizado");

    expect(problema?.nivel).toBe("atencao");
    expect(problema?.regua).toContain("360 min");
  });

  it("11 horas NÃO acende — uma janela perdida é ruído, duas são sinal", () => {
    const d = diagnosticarSku({
      ...entrada(),
      anuncios: [anuncio({ synced_at: "2026-09-11T07:00:00.000Z" })],
    });

    expect(d.problemas.map((p) => p.titulo)).not.toContain("Retrato do anúncio desatualizado");
  });

  it("ação aberta entra com a severidade DELA, sem recalcular nada", () => {
    const d = diagnosticarSku(
      entrada({
        acoesAbertas: [
          { id: "a1", kind: "venda_anomala", severity: "alta", recommendation: "Conferir exposição", mlbId: "MLB1" },
        ],
      }),
    );

    expect(d.nivel).toBe("critico");
    expect(d.problemas[0]?.recomendacao).toBe("Conferir exposição");
    expect(d.problemas[0]?.regua).toContain("severidade alta");
  });

  /*
    A DISPERSÃO DE PREÇO É NÚMERO, NUNCA SELO. D-148: "quanto é demais é
    decisão do ADMIN, não constante do código" — e não há teto configurado.
  */
  it("preços divergentes dão NÚMERO e uma linha de `semRegua`, não um alerta", () => {
    const d = diagnosticarSku(
      entrada({
        anuncios: [anuncio({ price: 89.9 }), anuncio({ item_id: "MLB2", ml_account_id: "c2", price: 99.9 })],
      }),
    );

    expect(d.precos?.menor).toBe(89.9);
    expect(d.precos?.maior).toBe(99.9);
    expect(d.precos?.dispersaoPct).toBe(11.1);
    expect(d.nivel).toBe("ok");
    expect(d.semRegua.join(" ")).toContain("teto de dispersão");
  });

  it("no escopo de UMA conta, a tela diz que estoque interno não tem conta", () => {
    const d = diagnosticarSku(entrada({ contaEscopo: "Loja 1" }));

    expect(d.semRegua.join(" ")).toContain("não existe saldo por conta");
  });

  it("anúncio vinculado e ainda não sincronizado não é julgado — é declarado", () => {
    const d = diagnosticarSku({
      ...entrada(),
      anuncios: [anuncio({ status: null, price: null, available_quantity: null, synced_at: null })],
    });

    expect(d.problemas).toHaveLength(0);
    expect(d.semRegua.join(" ")).toContain("sem sincronização");
  });
});

describe("compararPrecoDaConta", () => {
  it("compara a conta com a média das OUTRAS", () => {
    const r = compararPrecoDaConta(
      [
        anuncio({ ml_account_id: "c1", price: 89.9 }),
        anuncio({ item_id: "MLB2", ml_account_id: "c2", price: 99.9 }),
        anuncio({ item_id: "MLB3", ml_account_id: "c3", price: 89.9 }),
      ],
      "c1",
    );

    expect(r?.daConta).toBe(89.9);
    expect(r?.dasOutras).toBe(94.9);
    expect(r?.diferencaPct).toBe(-5.3);
  });

  it("sem outra conta não há comparação — `null`, nunca 0%", () => {
    expect(compararPrecoDaConta([anuncio()], "c1")).toBeNull();
  });
});
