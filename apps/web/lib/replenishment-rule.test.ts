import { describe, expect, it } from "vitest";

import { fraseDaRegra, janelaDaRegra, reguaDaPolitica, validarRegra } from "./replenishment-rule";

const valida = { prazo: "15", cobertura: "30", seguranca: "5", teto: "", nota: "" };

describe("validarRegra", () => {
  it("aceita a regra mínima e devolve números, com teto e nota nulos", () => {
    expect(validarRegra(valida)).toEqual({
      ok: true,
      valores: { prazo: 15, cobertura: 30, seguranca: 5, teto: null, nota: null },
    });
  });

  it("segurança vazia é zero — o default da coluna, não erro", () => {
    expect(validarRegra({ ...valida, seguranca: " " })).toMatchObject({ ok: true, valores: { seguranca: 0 } });
  });

  it("recusa fora dos limites do CHECK, cada erro no seu campo", () => {
    const resultado = validarRegra({ prazo: "0", cobertura: "366", seguranca: "-1", teto: "1096", nota: "" });

    expect(resultado.ok).toBe(false);

    if (!resultado.ok) {
      expect(Object.keys(resultado.erros).sort()).toEqual([
        "lead_time_days",
        "max_coverage_days",
        "safety_stock_days",
        "target_coverage_days",
      ]);
    }
  });

  it("recusa número quebrado ou com letra, em vez de arredondar em silêncio", () => {
    expect(validarRegra({ ...valida, prazo: "1.5" }).ok).toBe(false);
    expect(validarRegra({ ...valida, cobertura: "30d" }).ok).toBe(false);
  });

  it("teto abaixo da janela é recusado com a janela na frase (o max_covers_window do banco)", () => {
    const resultado = validarRegra({ ...valida, teto: "49" });

    expect(resultado.ok).toBe(false);

    if (!resultado.ok) {
      expect(resultado.erros.max_coverage_days).toContain("50 dias");
    }
  });

  it("teto IGUAL à janela é aceito — o CHECK também aceita", () => {
    expect(validarRegra({ ...valida, teto: "50" })).toMatchObject({ ok: true, valores: { teto: 50 } });
  });

  it("não acusa o teto contra uma janela que ainda não existe (prazo inválido)", () => {
    const resultado = validarRegra({ ...valida, prazo: "", teto: "10" });

    expect(resultado.ok).toBe(false);

    if (!resultado.ok) {
      expect(resultado.erros.max_coverage_days).toBeUndefined();
      expect(resultado.erros.lead_time_days).toBeDefined();
    }
  });

  it("nota acima de 500 caracteres é recusada; espaço nas pontas não conta", () => {
    expect(validarRegra({ ...valida, nota: "x".repeat(501) }).ok).toBe(false);
    expect(validarRegra({ ...valida, nota: `  ${"x".repeat(500)}  ` }).ok).toBe(true);
  });
});

describe("reguaDaPolitica", () => {
  it("as faixas seguem os limiares de classifyStockState, em ordem e contíguas", () => {
    const regua = reguaDaPolitica({ prazo: 15, cobertura: 30, seguranca: 5, teto: 90 });

    expect(regua.pontoDePedido).toBe(20);
    expect(regua.janela).toBe(50);
    expect(regua.faixas).toEqual([
      { faixa: "COMPRA_URGENTE", de: 0, ate: 15 },
      { faixa: "COMPRAR_EM_BREVE", de: 15, ate: 20 },
      { faixa: "COBERTURA_BAIXA", de: 20, ate: 50 },
      { faixa: "ADEQUADA", de: 50, ate: 90 },
      { faixa: "EXCESSO", de: 90, ate: regua.escala },
    ]);
    expect(regua.escala).toBeGreaterThan(90);
  });

  it("sem teto não há excesso: a régua não inventa o 'demais'", () => {
    const regua = reguaDaPolitica({ prazo: 15, cobertura: 30, seguranca: 5, teto: null });

    expect(regua.faixas.map((f) => f.faixa)).not.toContain("EXCESSO");
    expect(regua.faixas.at(-1)).toEqual({ faixa: "ADEQUADA", de: 50, ate: regua.escala });
  });

  it("segurança zero some da régua em vez de virar um risco de largura zero", () => {
    expect(reguaDaPolitica({ prazo: 15, cobertura: 30, seguranca: 0, teto: null }).faixas.map((f) => f.faixa)).toEqual([
      "COMPRA_URGENTE",
      "COBERTURA_BAIXA",
      "ADEQUADA",
    ]);
  });

  it("teto igual à janela: sem faixa adequada, direto ao excesso", () => {
    expect(reguaDaPolitica({ prazo: 10, cobertura: 10, seguranca: 0, teto: 20 }).faixas.map((f) => f.faixa)).toEqual([
      "COMPRA_URGENTE",
      "COBERTURA_BAIXA",
      "EXCESSO",
    ]);
  });

  it("a janela é a soma de D-144", () => {
    expect(janelaDaRegra({ prazo: 60, cobertura: 90, seguranca: 15 })).toBe(165);
  });
});

describe("fraseDaRegra", () => {
  it("diz o ponto de pedido, a janela e o teto na ordem da régua", () => {
    expect(fraseDaRegra({ prazo: 15, cobertura: 30, seguranca: 5, teto: 90 })).toBe(
      "O pedido sai quando a cobertura chega a 20 dias (prazo de 15 dias + 5 dias de segurança). Cada compra repõe até 50 dias de venda. Acima de 90 dias, é excesso.",
    );
  });

  it("sem segurança e sem teto, diz as duas ausências em vez de calar", () => {
    expect(fraseDaRegra({ prazo: 1, cobertura: 30, seguranca: 0, teto: null })).toBe(
      "O pedido sai quando a cobertura chega a 1 dia — sem margem de segurança além do prazo. Cada compra repõe até 31 dias de venda. Sem teto, excesso nunca é apontado.",
    );
  });
});
