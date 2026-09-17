import { describe, expect, it } from "vitest";

import { cnpjValido, conferirCadastro, cpfValido } from "./supplier-form";

describe("documento", () => {
  it("CNPJ e CPF pelos dígitos verificadores", () => {
    expect(cnpjValido("11.222.333/0001-81")).toBe(true);
    expect(cnpjValido("11222333000182")).toBe(false);
    expect(cnpjValido("00000000000000")).toBe(false);
    expect(cpfValido("529.982.247-25")).toBe(true);
    expect(cpfValido("52998224726")).toBe(false);
    expect(cpfValido("11111111111")).toBe(false);
  });
});

describe("conferirCadastro", () => {
  it("só o nome é obrigatório; vazio vira NULL, nunca string vazia", () => {
    const r = conferirCadastro({ name: "  Navetec  ", email: "  ", notes: "" });

    expect(r).toEqual({
      ok: true,
      cadastro: {
        name: "Navetec",
        legalName: null,
        document: null,
        contactName: null,
        email: null,
        phone: null,
        whatsapp: null,
        website: null,
        notes: null,
      },
    });
  });

  it("o documento é guardado só com dígitos, e o e-mail em minúsculas", () => {
    const r = conferirCadastro({
      name: "X",
      document: "11.222.333/0001-81",
      email: "Vendas@Loja.com",
    });

    expect(r.ok && r.cadastro.document).toBe("11222333000181");
    expect(r.ok && r.cadastro.email).toBe("vendas@loja.com");
  });

  it("recusa o que é inequivocamente errado, campo a campo", () => {
    const r = conferirCadastro({
      name: "",
      document: "11.222.333/0001-82",
      email: "vendas-loja.com",
      phone: "3333-4444",
      whatsapp: "(11) 98765-4321",
    });

    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.erros).sort()).toEqual(["document", "email", "name", "phone"]);
  });

  it("documento de tamanho errado diz o tamanho certo", () => {
    const r = conferirCadastro({ name: "X", document: "123456" });

    expect(!r.ok && r.erros.document).toMatch(/14 dígitos/);
  });

  it("na edição, o documento já gravado passa como estava, mesmo fora da regra", () => {
    const r = conferirCadastro({ name: "X", document: "12.345.678/0001-99" }, { documentoAnterior: "12345678000199" });

    expect(r.ok && r.cadastro.document).toBe("12345678000199");
    // Alterado, volta a ser conferido.
    expect(
      conferirCadastro({ name: "X", document: "12345678000198" }, { documentoAnterior: "12345678000199" }).ok,
    ).toBe(false);
  });

  it("nome acima do limite do banco", () => {
    expect(conferirCadastro({ name: "x".repeat(201) }).ok).toBe(false);
  });
});
