import { describe, expect, it } from "vitest";

import {
  demandaDaShopee,
  idadeDaLeitura,
  lerVisaoReposicao,
  posicaoCobertura,
  seloDaShopee,
} from "./replenishment-overview";

const agregado = { skus: 3, unidades: 40, investimento: 1234.5, sem_custo: 1 };

const linha = {
  sku_id: "9a3bde68-678d-4a0b-8078-29d83cbe865d",
  sku: "E2E-SKU-001",
  title: "Produto de teste E2E",
  supplier_brand: null,
  purchase_cost: 12.5,
  stock_is_virtual: false,
  local_quantity: 50,
  reservado: 0,
  transito: 0,
  full_quantity: 3,
  units_15d: 5,
  units_30d: 5,
  units_60d: 8,
  units_90d: 8,
  history_days_90: 10,
  abc_class: "B",
  coverage_days: 318,
  state: null,
  suggested_quantity: null,
};

const resposta = {
  total: 1,
  contagens: [{ state: "SEM_ESTADO", ...agregado }],
  totais: agregado,
  comprar_agora: { skus: 0, unidades: 0, investimento: 0, sem_custo: 0 },
  linhas: [linha],
  vendas_calculadas_em: "2026-09-16T12:02:29.319548+00:00",
  full_capturado_em: null,
};

describe("lerVisaoReposicao", () => {
  it("lê a resposta dentro do contrato", () => {
    const visao = lerVisaoReposicao(resposta);

    expect(visao?.total).toBe(1);
    expect(visao?.linhas[0]?.sku).toBe("E2E-SKU-001");
    expect(visao?.comprarAgora.skus).toBe(0);
    expect(visao?.contagens[0]?.state).toBe("SEM_ESTADO");
    expect(visao?.fullCapturadoEm).toBeNull();
  });

  it("recusa INTEIRA quando um campo some — nunca meia tela com '—' no lugar do dado", () => {
    expect(lerVisaoReposicao({ ...resposta, totais: undefined })).toBeNull();
    expect(lerVisaoReposicao({ ...resposta, linhas: [{ ...linha, units_30d: "5" }] })).toBeNull();
    expect(lerVisaoReposicao({ ...resposta, contagens: [{ ...agregado }] })).toBeNull();
    expect(lerVisaoReposicao(null)).toBeNull();
  });

  it("aceita nulo onde o SQL devolve nulo: custo, cobertura, sugestão, classe, estado", () => {
    const visao = lerVisaoReposicao({
      ...resposta,
      linhas: [{ ...linha, purchase_cost: null, coverage_days: null, abc_class: null }],
    });

    expect(visao?.linhas[0]?.purchase_cost).toBeNull();
    expect(visao?.linhas[0]?.coverage_days).toBeNull();
  });
});

describe("posicaoCobertura", () => {
  it("a janela fica no meio da barra, e passar do dobro satura em 100%", () => {
    expect(posicaoCobertura(45, 45)).toBe(50);
    expect(posicaoCobertura(0, 45)).toBe(0);
    expect(posicaoCobertura(400, 45)).toBe(100);
  });

  it("sem cobertura ou sem janela, não há barra — nunca uma barra zerada", () => {
    expect(posicaoCobertura(null, 45)).toBeNull();
    expect(posicaoCobertura(10, null)).toBeNull();
    expect(posicaoCobertura(10, 0)).toBeNull();
  });
});

describe("idadeDaLeitura", () => {
  const agora = new Date("2026-09-16T12:00:00Z");

  it("diz a idade e marca como velha depois de 26 h", () => {
    expect(idadeDaLeitura("2026-09-16T11:30:00Z", agora)).toEqual({ texto: "há 30 min", velha: false });
    expect(idadeDaLeitura("2026-09-15T08:00:00Z", agora)).toEqual({ texto: "há 28 h", velha: true });
    expect(idadeDaLeitura("2026-09-12T12:00:00Z", agora)).toEqual({ texto: "há 4 dias", velha: true });
  });

  it("nunca capturado é nulo, não 'agora'", () => {
    expect(idadeDaLeitura(null, agora)).toBeNull();
  });
});

describe("a Shopee na demanda (C-65, D-464)", () => {
  it("a chave ausente é a função de antes da migration: lê como nulo, a demanda é só a do ML", () => {
    const visao = lerVisaoReposicao(resposta);

    expect(visao?.linhas[0]?.units_30d_shopee).toBeNull();
    expect(visao?.linhas[0]?.units_90d_shopee).toBeNull();
    expect(demandaDaShopee(visao?.linhas ?? [])).toBe("fora");
  });

  it("número é a parte da Shopee, e zero é zero (há loja e o SKU não vendeu nela)", () => {
    const visao = lerVisaoReposicao({
      ...resposta,
      linhas: [
        { ...linha, units_30d: 9, units_30d_shopee: 4, units_90d_shopee: 6 },
        { ...linha, sku: "E2E-SKU-002", units_30d_shopee: 0, units_90d_shopee: 0 },
      ],
    });

    expect(visao?.linhas[0]?.units_30d_shopee).toBe(4);
    expect(visao?.linhas[1]?.units_30d_shopee).toBe(0);
    expect(demandaDaShopee(visao?.linhas ?? [])).toBe("inclui");
  });

  it("a parte da Shopee em texto continua fora do contrato: recusa INTEIRA", () => {
    expect(lerVisaoReposicao({ ...resposta, linhas: [{ ...linha, units_30d_shopee: "4" }] })).toBeNull();
  });

  it("página sem linha não diz se a Shopee entra", () => {
    expect(demandaDaShopee([])).toBe("sem-linhas");
    expect(seloDaShopee("sem-linhas", [], new Date())).toBeNull();
  });
});

describe("seloDaShopee", () => {
  const agora = new Date("2026-10-15T15:00:00Z");
  const live = (orders_synced_at: string | null) => ({ environment: "live", orders_synced_at });
  const teste = { environment: "test", orders_synced_at: "2026-10-15T14:30:00Z" };

  it("inclui: diz quando os pedidos foram lidos, e a loja mais atrasada manda", () => {
    expect(seloDaShopee("inclui", [live("2026-10-15T14:20:00Z")], agora)).toMatchObject({
      texto: "Shopee na demanda · pedidos lidos há 40 min",
      alerta: false,
    });
    expect(seloDaShopee("inclui", [live("2026-10-15T14:20:00Z"), live("2026-10-15T10:00:00Z"), teste], agora))
      .toMatchObject({ texto: "Shopee na demanda · 2 lojas, a mais atrasada lida há 5 h", alerta: true });
  });

  it("inclui com a leitura das lojas falhando: diz que entra, sem inventar frescor", () => {
    expect(seloDaShopee("inclui", null, agora)).toMatchObject({
      texto: "Shopee na demanda · frescor não lido",
      alerta: false,
    });
  });

  it("fora com só loja de teste: a Shopee não entra, e isso é normal", () => {
    expect(seloDaShopee("fora", [teste], agora)).toMatchObject({
      texto: "Shopee fora da demanda · nenhuma loja em produção lida",
      alerta: false,
    });
  });

  it("fora com loja em produção já lida: a conta ainda não a soma, e isso pede atenção", () => {
    expect(seloDaShopee("fora", [live("2026-10-15T14:20:00Z")], agora)).toMatchObject({
      texto: "Shopee fora da demanda · a conta ainda não a soma",
      alerta: true,
    });
  });

  it("organização sem loja Shopee não ganha selo; leitura das lojas falhando diz só que é o ML", () => {
    expect(seloDaShopee("fora", [], agora)).toBeNull();
    expect(seloDaShopee("fora", null, agora)).toMatchObject({ texto: "Shopee fora da demanda", alerta: false });
  });

  it("loja em produção que nunca leu pedidos não conta como lida", () => {
    expect(seloDaShopee("fora", [live(null)], agora)?.alerta).toBe(false);
  });
});
