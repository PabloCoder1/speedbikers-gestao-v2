import { describe, expect, it } from "vitest";

import { ALERTA_PADRAO, lerAlerta, lerFormularioDoAlerta, metaComoTexto } from "./alerta-margem";

/** O formulário do alerta de venda abaixo da margem (D-858). */

function ler(campos: Partial<Record<string, string>>) {
  return lerFormularioDoAlerta((nome) => campos[nome] ?? "");
}

describe("lerFormularioDoAlerta (D-858)", () => {
  it("lê as metas em porcentagem, as marcas e os e-mails sem repetir", () => {
    const r = ler({
      enabled: "on",
      imported_min_margin: "40",
      default_min_margin: "32,5%",
      imported_brands: "Navetec\noff  racer\nNAVETEC; Off Volt",
      email_recipients: "Loja@Exemplo.com\nloja@exemplo.com, outro@exemplo.com.br",
    });

    expect(r).toEqual({
      ok: true,
      valores: {
        enabled: true,
        imported_min_margin: 0.4,
        default_min_margin: 0.325,
        imported_brands: ["NAVETEC", "OFF RACER", "OFF VOLT"],
        email_recipients: ["loja@exemplo.com", "outro@exemplo.com.br"],
      },
    });
  });

  it("caixa desmarcada desliga; e-mail vazio é permitido", () => {
    const r = ler({ imported_min_margin: "40", default_min_margin: "30" });

    expect(r.ok && r.valores.enabled).toBe(false);
    expect(r.ok && r.valores.email_recipients).toEqual([]);
  });

  it("e-mail inválido e meta fora da faixa saem ao lado do campo", () => {
    const r = ler({ imported_min_margin: "100", default_min_margin: "trinta", email_recipients: "bom@exemplo.com\nsem-arroba" });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.erros.email_recipients).toBe("Este e-mail não parece válido: sem-arroba.");
    expect(r.erros.imported_min_margin).toMatch(/0 a 99,99%/);
    expect(r.erros.default_min_margin).toMatch(/como 30 ou 32,5/);
  });

  it("mais de 20 e-mails é recusado", () => {
    const muitos = Array.from({ length: 21 }, (_, i) => `p${String(i)}@exemplo.com`).join("\n");
    const r = ler({ imported_min_margin: "40", default_min_margin: "30", email_recipients: muitos });

    expect(!r.ok && r.erros.email_recipients).toBe("No máximo 20 e-mails.");
  });
});

describe("lerAlerta e metaComoTexto (D-858)", () => {
  it("sem linha, os padrões do dono", () => {
    expect(lerAlerta(null)).toBe(ALERTA_PADRAO);
    expect(ALERTA_PADRAO.imported_brands).toEqual(["NAVETEC", "OFF RACER", "OFF VOLT"]);
  });

  it("numeric em texto vira número; a fração vira o texto do campo", () => {
    const a = lerAlerta({ enabled: true, default_min_margin: "0.3000", imported_min_margin: 0.4, imported_brands: ["X"], email_recipients: ["a@b.co"] });

    expect(a.default_min_margin).toBe(0.3);
    expect(metaComoTexto(a.default_min_margin)).toBe("30");
    expect(metaComoTexto(0.325)).toBe("32,5");
  });
});
