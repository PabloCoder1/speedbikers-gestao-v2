import { describe, expect, it } from "vitest";

import { iniciaisDaConta, lerVisaoVinculacoes, tonsDasContas, TONS_DE_CONTA } from "./vinculacoes-visao";

/**
 * D-376 — o leitor de `get_listings_link_overview` e as peças do selo de conta.
 *
 * O ponto dos primeiros casos é o mesmo de `suppliers-overview.test.ts`: uma
 * resposta fora do contrato é recusada INTEIRA, e é essa recusa que faz a
 * página cair no caminho sem a leitura nova em vez de mostrar "—" no lugar de
 * número.
 */

const CONTAGENS = {
  todos: 4447,
  vinculados: 3976,
  por_variacao: 1422,
  sem_vinculo: 471,
  vendidos_sem_vinculo: 231,
  parados_sem_vinculo: 240,
  receita_sem_vinculo: 490019.12,
  unidades_sem_vinculo: 3999,
  candidatos_abertos: 0,
};

const LINHA = {
  listing_id: "11111111-1111-4111-8111-111111111111",
  item_id: "MLB4497213947",
  title: "Bau Bauleto Traseiro 37l",
  price: 349.9,
  ml_account_id: "22222222-2222-4222-8222-222222222222",
  account_label: "Speedbikers (loja 1)",
  account_slug: "speedbikers-loja-1",
  sku_id: null,
  sku: null,
  link_state: "unlinked",
  units_sold: 124,
  gross_revenue: 36169.42,
  full_quantity: null,
};

const CONTA = {
  ml_account_id: "22222222-2222-4222-8222-222222222222",
  account_label: "Speedbikers (loja 1)",
  account_slug: "speedbikers-loja-1",
  listings_total: 1034,
  com_vinculo: 932,
  sem_vinculo: 102,
  pct_vinculado: 90.1,
  vendidos_sem_vinculo: 61,
  receita_sem_vinculo: 194739.87,
  candidatos_abertos: 0,
};

const RESPOSTA = { total: 471, contagens: CONTAGENS, por_conta: [CONTA], linhas: [LINHA] };

describe("lerVisaoVinculacoes", () => {
  it("lê a resposta inteira do jeito que o SQL a devolve", () => {
    const visao = lerVisaoVinculacoes(RESPOSTA);

    expect(visao?.total).toBe(471);
    expect(visao?.contagens.receita_sem_vinculo).toBeCloseTo(490019.12);
    expect(visao?.contagens.por_variacao).toBe(1422);
    expect(visao?.linhas[0]?.gross_revenue).toBeCloseTo(36169.42);
    expect(visao?.porConta[0]?.pct_vinculado).toBeCloseTo(90.1);
  });

  it("aceita `sku_id` e `sku` nulos: vínculo por variação está LIGADO e tem sku_id nulo (D-122)", () => {
    const visao = lerVisaoVinculacoes({
      ...RESPOSTA,
      linhas: [{ ...LINHA, link_state: "linked_variation", sku_id: null, sku: null }],
    });

    expect(visao?.linhas[0]?.link_state).toBe("linked_variation");
    expect(visao?.linhas[0]?.sku_id).toBeNull();
  });

  it("aceita `full_quantity` nula — ausência de snapshot não é estoque zero (D-067)", () => {
    const visao = lerVisaoVinculacoes({ ...RESPOSTA, linhas: [{ ...LINHA, full_quantity: null }] });

    expect(visao?.linhas[0]?.full_quantity).toBeNull();
  });

  it("aceita `pct_vinculado` nulo — conta sem anúncio nenhum não tem percentual (D-254)", () => {
    const visao = lerVisaoVinculacoes({
      ...RESPOSTA,
      por_conta: [{ ...CONTA, listings_total: 0, com_vinculo: 0, sem_vinculo: 0, pct_vinculado: null }],
    });

    expect(visao?.porConta[0]?.pct_vinculado).toBeNull();
  });

  it("recusa a resposta inteira quando falta uma contagem", () => {
    const faltando: Record<string, number> = { ...CONTAGENS };

    delete faltando.por_variacao;

    expect(lerVisaoVinculacoes({ ...RESPOSTA, contagens: faltando })).toBeNull();
  });

  it("recusa a resposta inteira quando uma linha vem com estado desconhecido", () => {
    expect(lerVisaoVinculacoes({ ...RESPOSTA, linhas: [{ ...LINHA, link_state: "meio-vinculado" }] })).toBeNull();
  });

  it("recusa a resposta inteira quando um número chega como texto", () => {
    expect(lerVisaoVinculacoes({ ...RESPOSTA, linhas: [{ ...LINHA, units_sold: "124" }] })).toBeNull();
  });

  it("recusa o que não é a resposta desta função", () => {
    expect(lerVisaoVinculacoes(null)).toBeNull();
    expect(lerVisaoVinculacoes([])).toBeNull();
    expect(lerVisaoVinculacoes({ mensagem: "function does not exist" })).toBeNull();
  });

  it("aceita a organização vazia — zero anúncios não é resposta fora do contrato", () => {
    const visao = lerVisaoVinculacoes({
      total: 0,
      contagens: {
        todos: 0,
        vinculados: 0,
        por_variacao: 0,
        sem_vinculo: 0,
        vendidos_sem_vinculo: 0,
        parados_sem_vinculo: 0,
        receita_sem_vinculo: 0,
        unidades_sem_vinculo: 0,
        candidatos_abertos: 0,
      },
      por_conta: [],
      linhas: [],
    });

    expect(visao?.total).toBe(0);
    expect(visao?.linhas).toHaveLength(0);
  });
});

describe("tonsDasContas", () => {
  it("dá um tom diferente para cada uma das seis primeiras contas", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const tons = tonsDasContas(ids);

    expect(new Set(ids.map((id) => tons.get(id))).size).toBe(TONS_DE_CONTA);
  });

  it("volta ao primeiro tom na sétima conta, em vez de inventar cor", () => {
    const tons = tonsDasContas(["a", "b", "c", "d", "e", "f", "g"]);

    expect(tons.get("g")).toBe(tons.get("a"));
  });

  it("não conhece id que não está na lista da tela", () => {
    expect(tonsDasContas(["a"]).get("z")).toBeUndefined();
  });
});

describe("iniciaisDaConta", () => {
  it("usa o número quando ele é o que distingue duas contas de mesmo nome", () => {
    expect(iniciaisDaConta("Speedbikers (loja 1)")).toBe("S1");
    expect(iniciaisDaConta("Speedbikers (loja 2)")).toBe("S2");
  });

  it("usa a inicial da última palavra quando não há número", () => {
    expect(iniciaisDaConta("SbMotos")).toBe("S");
    expect(iniciaisDaConta("Speed Bikers")).toBe("SB");
  });

  it("não quebra com rótulo vazio", () => {
    expect(iniciaisDaConta("   ")).toBe("?");
  });
});
