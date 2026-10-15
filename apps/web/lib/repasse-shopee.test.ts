import { describe, expect, it } from "vitest";

import { divergenciaEmTodos, lojaDeTesteDoRepasse, separarPorNivel, type LinhaRepasse } from "./repasse-shopee";

function linha(sobre: Partial<LinhaRepasse>): LinhaRepasse {
  return {
    nivel: "CONTA",
    account_id: "5bf2ce24-4c02-4c8b-a1d7-a7973bbc96c4",
    account_name: "Speed Bikers Oficial",
    environment: "live",
    cobertura_completa: true,
    lido_ate: "2026-10-14T20:00:00+00:00",
    liberado: 500,
    pedidos_liberados: 6,
    liberacoes_sem_valor: 0,
    previsto: 498,
    pedidos_com_previsto: 5,
    diferenca: 2,
    pedidos_divergentes: 1,
    ...sobre,
  };
}

/** Repasses nunca lidos: tudo nulo (D-451). */
const NUNCA_LIDA = linha({
  account_name: "Loja de teste",
  environment: "sandbox",
  cobertura_completa: null,
  lido_ate: null,
  liberado: null,
  pedidos_liberados: null,
  liberacoes_sem_valor: null,
  previsto: null,
  pedidos_com_previsto: null,
  diferenca: null,
  pedidos_divergentes: null,
});

describe("separarPorNivel (D-458)", () => {
  it("separa o TOTAL das lojas, sem somar nada", () => {
    const total = linha({ nivel: "TOTAL", account_id: null, account_name: null, environment: null });
    const r = separarPorNivel([total, linha({}), NUNCA_LIDA]);

    expect(r.total).toBe(total);
    expect(r.lojas).toHaveLength(2);
  });

  it("sem loja real lida não há TOTAL — e isso não vira um total de zeros", () => {
    expect(separarPorNivel([NUNCA_LIDA]).total).toBeNull();
    expect(separarPorNivel(null)).toEqual({ total: null, lojas: [] });
  });
});

describe("a loja de teste (D-458)", () => {
  it("é marcada; a real e o TOTAL (sem ambiente) não", () => {
    expect(lojaDeTesteDoRepasse(NUNCA_LIDA)).toBe(true);
    expect(lojaDeTesteDoRepasse(linha({}))).toBe(false);
    expect(lojaDeTesteDoRepasse({ environment: null })).toBe(false);
  });
});

describe("divergenciaEmTodos — o sinal de unidade trocada (D-451, D-458)", () => {
  it("todos os comparáveis divergindo, com pelo menos 3, é o padrão", () => {
    expect(divergenciaEmTodos(linha({ pedidos_com_previsto: 5, pedidos_divergentes: 5 }))).toBe(true);
  });

  it("um pedido divergente só, ou parte deles, não alarma", () => {
    expect(divergenciaEmTodos(linha({ pedidos_com_previsto: 1, pedidos_divergentes: 1 }))).toBe(false);
    expect(divergenciaEmTodos(linha({ pedidos_com_previsto: 2, pedidos_divergentes: 2 }))).toBe(false);
    expect(divergenciaEmTodos(linha({ pedidos_com_previsto: 5, pedidos_divergentes: 4 }))).toBe(false);
  });

  it("sem leitura não há sinal nenhum", () => {
    expect(divergenciaEmTodos(NUNCA_LIDA)).toBe(false);
    expect(divergenciaEmTodos(linha({ pedidos_com_previsto: 0, pedidos_divergentes: 0 }))).toBe(false);
  });
});
