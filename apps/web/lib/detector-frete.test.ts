import { describe, expect, it } from "vitest";

import {
  lerDetectorFrete,
  motivosDoAlerta,
  paraRevisar,
  sugestaoDoAlerta,
  type AlertaDeFrete,
  type DetectorDeFrete,
  type SinaisDoFrete,
} from "./detector-frete";

/** `Intl` separa "R$" do número com espaço rígido; os textos esperados usam espaço comum. */
function limpo(texto: string): string {
  return texto.replaceAll(String.fromCharCode(160), " ");
}

const SINAIS_ZERADOS = {
  historico: 0,
  irmaos: 0,
  pares: 0,
  proporcao: 0,
  margem: 0,
  deixou_de_ser_rentavel: false,
  prejuizo: false,
  frete_tirou_margem: false,
};

/**
 * O protetor de escape do protótipo em produção (23/09, backfill em curso):
 * paga R$ 15,05 onde o mesmo SKU paga R$ 7,35 no outro anúncio e a categoria
 * paga R$ 7,15. Os campos a mais (`z_pares`, `impacto_frete`) vêm da RPC e a
 * tela não usa — o leitor os ignora.
 */
const PROTETOR = {
  anuncio: "MLB1186723528",
  sku_id: "7f0c3a52-2f6a-4d1e-9a51-3c1a7c2b9d10",
  sku: "15008",
  titulo: "Protetor Escape Pcx150 2016 2017 2018",
  conta: "Speedbikers (loja 2)",
  categoria: "MLB3936",
  nivel: "forte",
  pontos: 6,
  faixa: "ate_40",
  pedidos_atual: 34,
  pedidos_antes: 7,
  frete_atual: 15.05,
  frete_antes: 15.05,
  preco_atual: 36.49,
  preco_antes: 36.18,
  razao: 0.4124,
  razao_p95: 0.3519,
  frete_irmaos: 7.35,
  irmaos: 1,
  frete_pares: 7.15,
  pares: 7,
  z_pares: 26.6,
  margem_atual: 0.148,
  margem_antes: null,
  cobertos_atual: 30,
  cobertos_antes: 0,
  frete_share_atual: 0.4124,
  frete_share_antes: 0.416,
  impacto_frete: 0.0036,
  excesso: 261.8,
  mudou_em: null,
  sinais: { ...SINAIS_ZERADOS, irmaos: 3, pares: 2, proporcao: 1 },
};

const RESPOSTA = {
  janela: { inicio: "2026-06-25", corte: "2026-09-09", fim: "2026-09-22" },
  resumo: {
    analisados: 783,
    anuncios: 764,
    com_historico: 264,
    com_irmaos: 476,
    com_pares: 374,
    normal: 739,
    atencao: 38,
    provavel: 5,
    forte: 1,
    excesso_14_dias: 2325,
    skus: 428,
    skus_com_peso: 17,
  },
  faixas: [{ faixa: "ate_40", anuncios: 130, razao_mediana: 0.2191, razao_p95: 0.3519 }],
  alertas: [PROTETOR],
};

function detector(): DetectorDeFrete {
  const lido = lerDetectorFrete(RESPOSTA);

  if (lido === null) throw new Error("fixture fora do contrato");

  return lido;
}

function alerta(parcial: Omit<Partial<AlertaDeFrete>, "sinais"> & { sinais?: Partial<SinaisDoFrete> }): AlertaDeFrete {
  const base = detector().alertas[0];

  if (base === undefined) throw new Error("fixture sem alerta");

  return { ...base, ...parcial, sinais: { ...SINAIS_ZERADOS, ...parcial.sinais } };
}

describe("lerDetectorFrete", () => {
  it("lê a resposta inteira e ignora os campos que a tela não usa", () => {
    const d = detector();

    expect(d.janela).toEqual({ inicio: "2026-06-25", corte: "2026-09-09", fim: "2026-09-22" });
    expect(d.resumo.forte).toBe(1);
    expect(d.resumo.excesso_14_dias).toBe(2325);
    expect(d.faixas[0]?.razao_p95).toBe(0.3519);
    expect(d.alertas[0]?.nivel).toBe("forte");
    expect(d.alertas[0]?.sinais.irmaos).toBe(3);
    expect(d.alertas[0]).not.toHaveProperty("z_pares");
  });

  it("devolve null quando falta campo, o nível é desconhecido ou a faixa não existe", () => {
    const semFrete = Object.fromEntries(Object.entries(PROTETOR).filter(([chave]) => chave !== "frete_atual"));

    expect(lerDetectorFrete({ ...RESPOSTA, alertas: [semFrete] })).toBeNull();
    expect(lerDetectorFrete({ ...RESPOSTA, alertas: [{ ...PROTETOR, nivel: "critico" }] })).toBeNull();
    expect(lerDetectorFrete({ ...RESPOSTA, alertas: [{ ...PROTETOR, faixa: "ate_79" }] })).toBeNull();
    expect(lerDetectorFrete({ ...RESPOSTA, resumo: { ...RESPOSTA.resumo, forte: null } })).toBeNull();
    expect(lerDetectorFrete(null)).toBeNull();
  });

  it("os campos de D-399 são nulos num banco anterior e lidos quando existem", () => {
    expect(detector().alertas[0]?.frete_esperado).toBeNull();
    expect(detector().faixas[0]?.variacao_geral).toBeNull();

    const novo = lerDetectorFrete({
      ...RESPOSTA,
      faixas: [{ ...RESPOSTA.faixas[0], variacao_geral: 0.0458, anuncios_comparados: 98 }],
      alertas: [{ ...PROTETOR, frete_esperado: 15.74, variacao_geral_faixa: 0.0458 }],
    });

    expect(novo?.alertas[0]).toMatchObject({ frete_esperado: 15.74, variacao_geral_faixa: 0.0458 });
    expect(novo?.faixas[0]).toMatchObject({ variacao_geral: 0.0458, anuncios_comparados: 98 });
    expect(lerDetectorFrete({ ...RESPOSTA, alertas: [{ ...PROTETOR, frete_esperado: "alto" }] })).toBeNull();
  });

  it("aceita o excesso nulo: sem alerta com referência, não há frete a mais para somar", () => {
    const lido = lerDetectorFrete({ ...RESPOSTA, resumo: { ...RESPOSTA.resumo, excesso_14_dias: null } });

    expect(lido?.resumo.excesso_14_dias).toBeNull();
  });

  it("paraRevisar soma só provável e forte", () => {
    expect(paraRevisar(detector().resumo)).toBe(6);
  });
});

describe("motivosDoAlerta", () => {
  it("escreve um motivo por sinal que pontuou, com os números da RPC", () => {
    const d = detector();
    const motivos = motivosDoAlerta(alerta({ sinais: { irmaos: 3, pares: 2, proporcao: 1 } }), d.janela);

    expect(motivos.map((m) => [m.sinal, m.pontos])).toEqual([
      ["irmaos", 3],
      ["pares", 2],
      ["proporcao", 1],
    ]);
    expect(limpo(motivos[0]?.texto ?? "")).toBe(
      "Frete 105% acima de outro anúncio do mesmo produto na mesma faixa de preço (R$ 7,35). " +
        "O mesmo produto com frete diferente costuma vir de medida ou peso cadastrado diferente no anúncio.",
    );
    expect(limpo(motivos[1]?.texto ?? "")).toBe(
      "Frete 110% acima da mediana de 7 produtos da mesma categoria do Mercado Livre (MLB3936) e da mesma faixa de preço (R$ 7,15).",
    );
    expect(limpo(motivos[2]?.texto ?? "")).toBe(
      "O frete é 41,2% do preço (R$ 15,05 sobre R$ 36,49). Na faixa até R$ 40, 95% dos anúncios ficam em até 35,2%.",
    );
  });

  it("o histórico diz de quanto para quanto, em que janela e desde quando", () => {
    // O exemplo do pedido do dono: frete médio de R$ 11,20 que virou R$ 24,70.
    const a = alerta({ frete_atual: 24.7, frete_antes: 11.2, mudou_em: "2026-09-12", sinais: { historico: 3 } });
    const [motivo] = motivosDoAlerta(a, detector().janela);

    expect(limpo(motivo?.texto ?? "")).toBe(
      "Frete 121% acima do que este anúncio pagava: R$ 24,70 nos últimos 14 dias contra R$ 11,20 nos 76 dias anteriores, " +
        "na mesma faixa de preço. A mudança aparece a partir de 12/09/2026.",
    );
  });

  it("com mudança geral medida na faixa, compara com o esperado e diz quanto foi a tabela (D-399)", () => {
    const a = alerta({
      frete_atual: 10.15,
      frete_antes: 7,
      frete_esperado: 7.35,
      variacao_geral_faixa: 0.05,
      mudou_em: null,
      sinais: { historico: 1 },
    });
    const [motivo] = motivosDoAlerta(a, detector().janela);

    expect(limpo(motivo?.texto ?? "")).toBe(
      "Frete 38% acima do esperado: R$ 10,15 nos últimos 14 dias contra R$ 7,00 nos 76 dias anteriores, que com a alta geral de 5,0% da faixa seriam R$ 7,35.",
    );
  });

  it("vários irmãos viram mediana", () => {
    const [motivo] = motivosDoAlerta(alerta({ irmaos: 3, frete_irmaos: 10, sinais: { irmaos: 2 } }), detector().janela);

    expect(limpo(motivo?.texto ?? "")).toContain("acima de 3 outros anúncios do mesmo produto na mesma faixa de preço (R$ 10,00 de mediana)");
  });

  it("deixou de dar resultado: margem e frete antes e depois", () => {
    const a = alerta({
      margem_antes: 0.22,
      margem_atual: -0.03,
      frete_share_antes: 0.12,
      frete_share_atual: 0.27,
      sinais: { margem: 2, deixou_de_ser_rentavel: true },
    });
    const [motivo] = motivosDoAlerta(a, detector().janela);

    expect(limpo(motivo?.texto ?? "")).toBe(
      "Deixou de dar resultado: a margem foi de 22,0% para -3,0%, e o frete passou de 12,0% para 27,0% do preço — o frete explica pelo menos metade da queda.",
    );
  });

  it("prejuízo e frete que tirou margem entram na mesma frase de margem", () => {
    const a = alerta({
      margem_antes: 0.02,
      margem_atual: -0.05,
      cobertos_antes: 9,
      cobertos_atual: 12,
      frete_share_antes: 0.3,
      frete_share_atual: 0.37,
      sinais: { margem: 2, prejuizo: true, frete_tirou_margem: true },
    });
    const [motivo] = motivosDoAlerta(a, detector().janela);

    expect(limpo(motivo?.texto ?? "")).toBe(
      "Vende no prejuízo: margem de -5,0% nos 12 pedidos com custo conhecido, com o frete levando 37,0% do preço. " +
        "O frete passou de 30,0% para 37,0% do preço (+7,0 p.p.); a margem foi de 2,0% para -5,0%.",
    );
  });

  it("sem margem conhecida nas duas janelas, a frase do frete não fala de margem", () => {
    const a = alerta({
      margem_antes: null,
      cobertos_antes: 0,
      frete_share_antes: 0.2,
      frete_share_atual: 0.26,
      sinais: { margem: 1, frete_tirou_margem: true },
    });
    const [motivo] = motivosDoAlerta(a, detector().janela);

    expect(limpo(motivo?.texto ?? "")).toBe("O frete passou de 20,0% para 26,0% do preço (+6,0 p.p.).");
  });

  it("sinal zerado não vira motivo", () => {
    expect(motivosDoAlerta(alerta({ sinais: {} }), detector().janela)).toEqual([]);
  });
});

describe("sugestaoDoAlerta", () => {
  it("frete diferente para o mesmo produto aponta o cadastro do anúncio", () => {
    expect(sugestaoDoAlerta(alerta({ sinais: { irmaos: 1, proporcao: 3 } }))).toContain("compará-los com os do anúncio do mesmo produto");
  });

  it("histórico ou categoria apontam medidas e peso", () => {
    expect(sugestaoDoAlerta(alerta({ sinais: { historico: 2 } }))).toContain("mudaram ou estão maiores");
    expect(sugestaoDoAlerta(alerta({ sinais: { pares: 1 } }))).toContain("mudaram ou estão maiores");
  });

  it("só proporção ou margem apontam preço e forma de envio", () => {
    expect(sugestaoDoAlerta(alerta({ sinais: { proporcao: 3, margem: 1 } }))).toContain("revisar o preço ou a forma de envio");
  });
});
