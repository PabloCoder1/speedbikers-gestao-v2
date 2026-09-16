import { describe, expect, it } from "vitest";

import { campanhasEmAlerta, lerVisaoAds, rotuloEstrategia, tomDoRoas, type CampanhaAds } from "./ads";

const campanha: CampanhaAds = {
  ml_account_id: "acc-1",
  conta: "Loja 1",
  campaign_id: 355189450,
  nome: "Relações",
  status: "active",
  estrategia: "PROFITABILITY",
  orcamento: 30,
  roas_alvo: 8,
  investimento: 120.5,
  receita_ads: 1205,
  receita_direta: 1000,
  receita_indireta: 205,
  cliques: 90,
  impressoes: 9000,
  unidades: 7,
  acos: 0.1,
  roas: 10,
};

const resposta = {
  resumo: {
    investimento: 120.5,
    receita_ads: 1205,
    receita_direta: 1000,
    receita_indireta: 205,
    cliques: 90,
    impressoes: 9000,
    unidades: 7,
    campanhas_com_metrica: 1,
    acos: 0.1,
    roas: 10,
    ctr: 0.01,
    cpc: 1.34,
    receita_bruta: 30000,
    tacos: 0.004,
  },
  campanhas: [campanha],
  diario: [{ dia: "2026-09-15", investimento: 12.5, receita_ads: 150 }],
  contas: [{ ml_account_id: "acc-1", conta: "Loja 1", ads: "habilitado", verificado_em: "2026-09-16T14:00:00Z" }],
  sincronizado_em: "2026-09-16T14:00:00Z",
};

describe("lerVisaoAds", () => {
  it("lê a resposta dentro do contrato", () => {
    const visao = lerVisaoAds(resposta);

    expect(visao?.resumo.roas).toBe(10);
    expect(visao?.campanhas[0]?.nome).toBe("Relações");
    expect(visao?.contas[0]?.ads).toBe("habilitado");
  });

  it("sem investimento as razões chegam nulas e são aceitas", () => {
    const visao = lerVisaoAds({ ...resposta, resumo: { ...resposta.resumo, acos: null, roas: null, ctr: null, cpc: null, tacos: null } });

    expect(visao?.resumo.acos).toBeNull();
  });

  it("recusa inteira quando o contrato muda", () => {
    expect(lerVisaoAds({ ...resposta, resumo: { ...resposta.resumo, investimento: "120" } })).toBeNull();
    expect(lerVisaoAds({ ...resposta, contas: [{ ...resposta.contas[0], ads: "talvez" }] })).toBeNull();
    expect(lerVisaoAds({ ...resposta, campanhas: [{ ...campanha, nome: undefined }] })).toBeNull();
    expect(lerVisaoAds(null)).toBeNull();
  });
});

describe("tomDoRoas", () => {
  it("abaixo de 1 é perigo, abaixo do alvo é atenção, no alvo é ok, sem investimento é neutro", () => {
    expect(tomDoRoas(0.8, 5)).toBe("perigo");
    expect(tomDoRoas(3, 5)).toBe("atencao");
    expect(tomDoRoas(5, 5)).toBe("ok");
    expect(tomDoRoas(2, null)).toBe("ok");
    expect(tomDoRoas(null, 5)).toBe("neutro");
  });

  it("conta as campanhas em alerta", () => {
    expect(campanhasEmAlerta([campanha, { ...campanha, roas: 0.5 }, { ...campanha, roas: 4 }, { ...campanha, roas: null }])).toBe(2);
  });
});

describe("rotuloEstrategia", () => {
  it("traduz as estratégias conhecidas e não inventa as outras", () => {
    expect(rotuloEstrategia("PROFITABILITY")).toBe("rentabilidade");
    expect(rotuloEstrategia("VISIBILITY")).toBe("visibilidade");
    expect(rotuloEstrategia("NOVA")).toBe("nova");
    expect(rotuloEstrategia(null)).toBeNull();
  });
});
