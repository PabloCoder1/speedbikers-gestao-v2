import { describe, expect, it } from "vitest";

import { avaliarVariacao, textoDaVariacao } from "./variacao";

describe("avaliarVariacao", () => {
  it("sem um dos lados não há comparação — nunca zero", () => {
    expect(avaliarVariacao(null, 10, "maior-melhor", "valor")).toBeNull();
    expect(avaliarVariacao(10, null, "maior-melhor", "valor")).toBeNull();
  });

  it("receita que sobe além da zona neutra é boa", () => {
    const v = avaliarVariacao(112.8, 100, "maior-melhor", "valor");

    expect(v?.relativa).toBeCloseTo(0.128);
    expect(v?.tom).toBe("ok");
    expect(v && textoDaVariacao(v, "valor")).toBe("↑ 12,8%");
  });

  it("frete que sobe é ruim: atenção até 10%, perigo acima", () => {
    expect(avaliarVariacao(105, 100, "menor-melhor", "valor")?.tom).toBe("atencao");
    expect(avaliarVariacao(125, 100, "menor-melhor", "valor")?.tom).toBe("perigo");
    expect(avaliarVariacao(90, 100, "menor-melhor", "valor")?.tom).toBe("ok");
  });

  it("dentro da zona neutra o movimento aparece, mas sem cor", () => {
    const v = avaliarVariacao(101, 100, "maior-melhor", "valor");

    expect(v?.relevante).toBe(false);
    expect(v?.tom).toBe("neutro");
    expect(v?.direcao).toBe("sobe");
  });

  it("porcentagem compara em pontos percentuais", () => {
    const v = avaliarVariacao(0.187, 0.208, "maior-melhor", "fracao");

    expect(v?.diferenca).toBeCloseTo(-0.021);
    expect(v?.relativa).toBeNull();
    expect(v?.tom).toBe("perigo");
    expect(v && textoDaVariacao(v, "fracao")).toBe("↓ 2,1 p.p.");
    expect(avaliarVariacao(0.2, 0.203, "maior-melhor", "fracao")?.tom).toBe("neutro");
    expect(avaliarVariacao(0.2, 0.21, "maior-melhor", "fracao")?.tom).toBe("atencao");
  });

  it("polaridade neutra mostra o movimento e nunca julga", () => {
    const v = avaliarVariacao(200, 100, "neutra", "valor");

    expect(v?.relevante).toBe(true);
    expect(v?.tom).toBe("neutro");
  });

  it("dia em andamento mantém os números e tira o julgamento", () => {
    const v = avaliarVariacao(40, 100, "maior-melhor", "valor", { semJulgamento: true });

    expect(v?.relativa).toBeCloseTo(-0.6);
    expect(v?.tom).toBe("neutro");
  });

  it("anterior zero ou negativo não tem variação percentual honesta", () => {
    const zero = avaliarVariacao(50, 0, "maior-melhor", "valor");

    expect(zero?.relativa).toBeNull();
    expect(zero?.tom).toBe("neutro");
    expect(zero && textoDaVariacao(zero, "valor")).toBe("↑");

    const negativo = avaliarVariacao(10, -20, "maior-melhor", "valor");

    expect(negativo?.relativa).toBeNull();
    expect(negativo?.diferenca).toBe(30);
  });
});
