import { describe, expect, it } from "vitest";

import {
  barraDaMargem,
  escalaDasMargens,
  lerFaturamento,
  montarCascata,
  participacao,
  tomDaMargem,
} from "./faturamento";

/** O resumo do fixture de integração de `get_faturamento` (packages/db). */
const RESUMO = {
  pedidos: 4,
  compras: 4,
  unidades: 5,
  receita_bruta: 280,
  taxas_ml: 28,
  ticket_medio: 70,
  preco_medio: 56,
  comissao_percentual: 0.1,
  pedidos_com_custos: 3,
  receita_com_custos: 240,
  taxas_ml_com_custos: 24,
  frete_vendedor: 37,
  desconto_vendedor: 8,
  margem_operacional: 179,
  frete_medio_pedido: 12.33,
  pedidos_cobertos: 2,
  receita_coberta: 180,
  taxas_ml_cobertas: 18,
  frete_vendedor_coberto: 27,
  margem_operacional_coberta: 135,
  custo_produtos: 105,
  resultado_venda: 30,
  margem_venda: 0.1667,
  pedidos_custo_atual: 1,
  pedidos_sem_sku: 1,
  pedidos_sem_custo: 1,
  pedidos_sem_frete: 1,
  pedidos_multi_item: 0,
};

const SKU = {
  sku_id: "a",
  sku: "FAT-A",
  title: null,
  unidades: 2,
  pedidos: 1,
  receita_bruta: 100,
  taxas_ml: 10,
  pedidos_cobertos: 1,
  receita_coberta: 100,
  frete_vendedor: 15,
  custo_produtos: 50,
  resultado_venda: 25,
  margem_venda: 0.25,
  custo_atual: false,
};

const COMPLETO = {
  resumo: RESUMO,
  diario: [
    {
      dia: "2026-07-10",
      pedidos: 4,
      receita_bruta: 280,
      taxas_ml: 28,
      frete_vendedor: 37,
      receita_coberta: 180,
      resultado_venda: 30,
      margem_venda: 0.1667,
    },
  ],
  por_conta: [
    {
      ml_account_id: "conta",
      conta: "Conta A",
      pedidos: 4,
      receita_bruta: 280,
      taxas_ml: 28,
      pedidos_com_custos: 3,
      frete_vendedor: 37,
      margem_operacional: 179,
      pedidos_cobertos: 2,
      receita_coberta: 180,
      resultado_venda: 30,
      margem_venda: 0.1667,
    },
  ],
  por_sku: {
    maior_receita: [SKU],
    menor_margem: [],
    skus_com_venda: 3,
    skus_margem_abaixo_10: 1,
    skus_margem_negativa: 0,
  },
};

describe("lerFaturamento", () => {
  it("lê a resposta completa", () => {
    const lido = lerFaturamento(COMPLETO);

    expect(lido?.resumo.margem_venda).toBe(0.1667);
    expect(lido?.diario?.[0]?.dia).toBe("2026-07-10");
    expect(lido?.porConta?.[0]?.conta).toBe("Conta A");
    expect(lido?.produtos).toMatchObject({ skusComVenda: 3, skusAbaixoDaMargem: 1, skusMargemNegativa: 0 });
    expect(lido?.produtos?.maiorReceita[0]).toMatchObject({ sku: "FAT-A", title: null, custo_atual: false });
  });

  it("sem detalhe, série, contas e produtos voltam nulos — e o resumo continua", () => {
    const lido = lerFaturamento({ resumo: RESUMO, diario: null, por_conta: null, por_sku: null });

    expect(lido?.resumo.receita_bruta).toBe(280);
    expect(lido?.diario).toBeNull();
    expect(lido?.porConta).toBeNull();
    expect(lido?.produtos).toBeNull();
  });

  it("nulo continua nulo: margem sem cobertura não vira 0%", () => {
    const lido = lerFaturamento({ ...COMPLETO, resumo: { ...RESUMO, margem_venda: null, resultado_venda: null } });

    expect(lido?.resumo.margem_venda).toBeNull();
    expect(lido?.resumo.resultado_venda).toBeNull();
  });

  it("aceita numeric em texto", () => {
    expect(lerFaturamento({ ...COMPLETO, resumo: { ...RESUMO, receita_bruta: "280.00" } })?.resumo.receita_bruta).toBe(280);
  });

  it("recusa a resposta INTEIRA quando o contrato quebra", () => {
    const semMargem: Partial<typeof RESUMO> = { ...RESUMO };

    delete semMargem.margem_venda;

    // Chave anulável ausente: o SQL mudou e a tela não sabe.
    expect(lerFaturamento({ ...COMPLETO, resumo: semMargem })).toBeNull();
    // Contagem nula nunca vem do SQL: é contrato quebrado, não zero.
    expect(lerFaturamento({ ...COMPLETO, resumo: { ...RESUMO, pedidos: null } })).toBeNull();
    expect(lerFaturamento({ ...COMPLETO, resumo: { ...RESUMO, pedidos: "muitos" } })).toBeNull();
    expect(lerFaturamento({ ...COMPLETO, por_sku: { ...COMPLETO.por_sku, maior_receita: [{ ...SKU, custo_atual: "sim" }] } })).toBeNull();
    expect(lerFaturamento({ resumo: RESUMO })).toBeNull();
    expect(lerFaturamento(null)).toBeNull();
    expect(lerFaturamento([])).toBeNull();
  });
});

describe("tomDaMargem", () => {
  it("negativa é perigo, abaixo de 10% é atenção, sem margem é neutro", () => {
    expect(tomDaMargem(-0.01)).toBe("perigo");
    expect(tomDaMargem(0)).toBe("atencao");
    expect(tomDaMargem(0.0999)).toBe("atencao");
    expect(tomDaMargem(0.1)).toBe("ok");
    expect(tomDaMargem(null)).toBe("neutro");
  });
});

describe("participacao", () => {
  it("denominador zero ou lado ausente é nulo, nunca 0%", () => {
    expect(participacao(180, 280)).toBeCloseTo(0.6429, 4);
    expect(participacao(0, 280)).toBe(0);
    expect(participacao(10, 0)).toBeNull();
    expect(participacao(null, 280)).toBeNull();
    expect(participacao(10, null)).toBeNull();
  });
});

describe("montarCascata", () => {
  it("todos os degraus saem do subconjunto coberto, e cada dedução começa onde a anterior terminou", () => {
    const degraus = montarCascata(RESUMO);

    expect(degraus?.map((d) => [d.chave, d.valor])).toEqual([
      ["receita", 180],
      ["comissao", -18],
      ["frete", -27],
      ["recebido", 135],
      ["custo", -105],
      ["resultado", 30],
    ]);

    const [receita, comissao, frete, recebido, custo, resultado] = degraus ?? [];

    expect(receita).toMatchObject({ inicio: 0, largura: 1 });
    expect(comissao?.inicio).toBeCloseTo(0.9, 6);
    expect(comissao?.largura).toBeCloseTo(0.1, 6);
    expect(frete?.inicio).toBeCloseTo(0.75, 6);
    expect(frete?.largura).toBeCloseTo(0.15, 6);
    expect(recebido?.largura).toBeCloseTo(0.75, 6);
    expect(custo?.inicio).toBeCloseTo(30 / 180, 6);
    expect(custo?.largura).toBeCloseTo(105 / 180, 6);
    expect(resultado?.fracao).toBeCloseTo(30 / 180, 6);
  });

  it("resultado negativo desenha a barra pelo tamanho, com a fração negativa", () => {
    const degraus = montarCascata({
      ...RESUMO,
      custo_produtos: 171,
      resultado_venda: -36,
      margem_venda: -0.2,
    });
    const resultado = degraus?.at(-1);

    expect(resultado?.fracao).toBeCloseTo(-0.2, 6);
    expect(resultado).toMatchObject({ inicio: 0 });
    expect(resultado?.largura).toBeCloseTo(0.2, 6);
    // O custo passou do recebido: a barra dele para no zero, não sai do trilho.
    expect(degraus?.[4]?.inicio).toBe(0);
  });

  it("sem pedido coberto não há cascata", () => {
    expect(
      montarCascata({ ...RESUMO, pedidos_cobertos: 0, receita_coberta: null, resultado_venda: null }),
    ).toBeNull();
  });
});

describe("escala da margem", () => {
  it("só positivas: o zero fica na base, e o teto não baixa de 15%", () => {
    const escala = escalaDasMargens([0.05, null, 0.08]);

    expect(escala.zero).toBe(0);
    expect(escala.total).toBeCloseTo(0.15, 6);
    expect(barraDaMargem(0.075, escala).altura).toBeCloseTo(0.5, 6);
  });

  it("com negativa, um centímetro vale o mesmo dos dois lados do zero", () => {
    const escala = escalaDasMargens([0.3, -0.1]);

    expect(escala.zero).toBeCloseTo(0.25, 6);
    const positiva = barraDaMargem(0.3, escala);

    expect(positiva.base).toBe(escala.zero);
    expect(positiva.altura).toBeCloseTo(0.75, 6);

    const negativa = barraDaMargem(-0.1, escala);

    expect(negativa.altura).toBeCloseTo(0.25, 6);
    expect(negativa.base).toBeCloseTo(0, 6);
  });

  it("margem fora de ±100% é desenhada no limite", () => {
    const escala = escalaDasMargens([0.2, -4]);

    expect(escala.total).toBeCloseTo(1.2, 6);
    expect(barraDaMargem(-4, escala).base).toBeCloseTo(0, 6);
  });
});
