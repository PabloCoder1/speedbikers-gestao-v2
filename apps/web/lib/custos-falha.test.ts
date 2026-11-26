import { describe, expect, it } from "vitest";

import { destinoDepoisDaAcao, falhaDaAcao, mensagemDaFalha } from "./custos-falha";

describe("falhaDaAcao", () => {
  it("reconhece a trava do mês fechado e extrai o mês", () => {
    const falha = falhaDaAcao(
      { code: "P0001", message: "a competência 10/2026 está fechada: reabra o mês antes de alterar a despesa" },
      null,
    );
    expect(falha).toEqual({ tipo: "mes-fechado", mes: "10/2026" });
  });

  it("separa permissão, erro genérico, nenhuma linha e sucesso", () => {
    expect(falhaDaAcao({ code: "42501", message: "permission denied" }, null)).toEqual({ tipo: "permissao" });
    expect(falhaDaAcao({ code: "XX000", message: "boom" }, null)).toEqual({ tipo: "erro" });
    expect(falhaDaAcao(null, 0)).toEqual({ tipo: "nao-alterada" });
    expect(falhaDaAcao(null, null)).toEqual({ tipo: "nao-alterada" });
    expect(falhaDaAcao(null, 1)).toBeNull();
  });
});

describe("destinoDepoisDaAcao", () => {
  it("mantém os filtros da tela e acrescenta a falha", () => {
    expect(
      destinoDepoisDaAcao("https://app.test/central/custos?periodo=30d", { tipo: "mes-fechado", mes: "10/2026" }),
    ).toBe("/central/custos?periodo=30d&falha=mes-fechado&mes=10%2F2026");
  });

  it("limpa a falha antiga depois de uma ação que deu certo", () => {
    expect(destinoDepoisDaAcao("https://app.test/central/custos?periodo=30d&falha=erro", null)).toBe(
      "/central/custos?periodo=30d",
    );
  });

  it("não redireciona quando não há falha nem antes nem agora", () => {
    expect(destinoDepoisDaAcao("https://app.test/central/custos?periodo=30d", null)).toBeNull();
  });

  it("ignora referer de outra tela ou inválido", () => {
    expect(destinoDepoisDaAcao("https://app.test/compras?x=1", { tipo: "erro" })).toBe("/central/custos?falha=erro");
    expect(destinoDepoisDaAcao("nao-e-url", { tipo: "permissao" })).toBe("/central/custos?falha=permissao");
    expect(destinoDepoisDaAcao(null, { tipo: "nao-alterada" })).toBe("/central/custos?falha=nao-alterada");
  });
});

describe("mensagemDaFalha", () => {
  it("diz o mês fechado só quando o mês é válido", () => {
    expect(mensagemDaFalha({ falha: "mes-fechado", mes: "10/2026" })).toMatch(/^A competência 10\/2026 está fechada/);
    expect(mensagemDaFalha({ falha: "mes-fechado", mes: "<script>" })).toMatch(/^O mês está fechado/);
  });

  it("não mostra texto de código desconhecido", () => {
    expect(mensagemDaFalha({ falha: "qualquer frase" })).toBeNull();
    expect(mensagemDaFalha({})).toBeNull();
    expect(mensagemDaFalha({ falha: ["erro", "erro"] })).toBeNull();
  });
});
