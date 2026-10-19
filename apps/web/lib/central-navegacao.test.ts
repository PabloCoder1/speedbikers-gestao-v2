import { describe, expect, it } from "vitest";

import { abasDaCentral, contextoDaCentral } from "./central-navegacao";

describe("contextoDaCentral", () => {
  it("leva o período e a conta, na ordem fixa", () => {
    expect(contextoDaCentral({ account: "e2e-loja", p: "7d" })).toBe("p=7d&account=e2e-loja");
    expect(contextoDaCentral({ from: "2026-10-01", to: "2026-10-15" })).toBe("from=2026-10-01&to=2026-10-15");
  });

  it("deixa de fora o que é de cada tela (ordem do ranking, nível do detector, página)", () => {
    expect(contextoDaCentral({ p: "30d", ordem: "lucro", pagina: "2", nivel: "forte" })).toBe("p=30d");
  });

  it("não devolve à URL valor fora da forma", () => {
    expect(contextoDaCentral({ p: "<script>", from: "ontem", account: "a b" })).toBe("");
  });

  it("ignora parâmetro repetido (vem como lista)", () => {
    expect(contextoDaCentral({ p: ["7d", "30d"] })).toBe("");
  });
});

describe("abasDaCentral", () => {
  it("são as seis telas, com a atual marcada", () => {
    const abas = abasDaCentral("metas", {});

    expect(abas.map((aba) => aba.label)).toEqual([
      "Central",
      "Metas e imposto",
      "Limites",
      "Detector de frete",
      "Sinais de Ads",
      "Ranking de produtos",
    ]);
    expect(abas.filter((aba) => aba.ativa).map((aba) => aba.href)).toEqual(["/central/metas"]);
  });

  it("cada aba leva o contexto da URL atual", () => {
    const abas = abasDaCentral("central", { p: "7d", account: "e2e-loja" });

    expect(abas.find((aba) => aba.label === "Ranking de produtos")?.href).toBe("/central/produtos?p=7d&account=e2e-loja");
    expect(abas.find((aba) => aba.label === "Central")?.href).toBe("/central?p=7d&account=e2e-loja");
  });

  it("sem contexto, o caminho limpo", () => {
    expect(abasDaCentral("frete", {}).find((aba) => aba.label === "Sinais de Ads")?.href).toBe("/central/ads");
  });
});
