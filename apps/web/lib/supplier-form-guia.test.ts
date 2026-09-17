import { describe, expect, it } from "vitest";

import {
  acharDuplicados,
  acrescentarCondicao,
  completude,
  estadoDocumento,
  formatarTelefone,
  nomeComparavel,
  type ValoresGuia,
} from "./supplier-form-guia";

// CNPJ e CPF de exemplo com dígitos verificadores corretos.
const CNPJ = "11.222.333/0001-81";
const CPF = "529.982.247-25";

const vazio: ValoresGuia = {
  name: "",
  legalName: "",
  document: "",
  contactName: "",
  email: "",
  phone: "",
  whatsapp: "",
  website: "",
  notes: "",
};

describe("estadoDocumento", () => {
  it("vazio e digitando não acusam erro", () => {
    expect(estadoDocumento("")).toEqual({ tipo: "vazio" });
    expect(estadoDocumento("11.222")).toEqual({ tipo: "digitando", faltam: 6 });
  });

  it("reconhece CNPJ e CPF válidos", () => {
    expect(estadoDocumento(CNPJ)).toEqual({ tipo: "valido", rotulo: "CNPJ" });
    expect(estadoDocumento(CPF)).toEqual({ tipo: "valido", rotulo: "CPF" });
  });

  it("11 dígitos que não fecham como CPF ainda podem virar CNPJ", () => {
    expect(estadoDocumento("11222333000")).toEqual({ tipo: "digitando", faltam: 3 });
  });

  it("14 dígitos errados e dígitos a mais são inválidos", () => {
    expect(estadoDocumento("11.222.333/0001-82")).toEqual({ tipo: "invalido", texto: "CNPJ não confere" });
    expect(estadoDocumento("112223330001811")).toMatchObject({ tipo: "invalido" });
  });
});

describe("formatarTelefone", () => {
  it("formata celular, fixo e o 55 na frente", () => {
    expect(formatarTelefone("11987654321")).toBe("(11) 98765-4321");
    expect(formatarTelefone("1133334444")).toBe("(11) 3333-4444");
    expect(formatarTelefone("+55 11 98765-4321")).toBe("(11) 98765-4321");
  });

  it("o que não reconhece fica como veio", () => {
    expect(formatarTelefone(" 3333-4444 ")).toBe("3333-4444");
  });
});

describe("duplicados", () => {
  const existentes = [
    { id: "a", name: "Navetec Distribuidora Ltda.", document: "11222333000181", isActive: true },
    { id: "b", name: "Plasmoto", document: null, isActive: false },
  ];

  it("acha o mesmo nome escrito de outro jeito", () => {
    expect(nomeComparavel("NAVETEC  Distribuidora LTDA")).toBe("navetec distribuidora");
    expect(acharDuplicados(existentes, { name: "navetec distribuidora", document: "" }, null).porNome?.id).toBe("a");
    expect(acharDuplicados(existentes, { name: "Plásmoto", document: "" }, null).porNome?.id).toBe("b");
  });

  it("acha o mesmo documento com ou sem máscara", () => {
    expect(acharDuplicados(existentes, { name: "", document: CNPJ }, null).porDocumento?.id).toBe("a");
  });

  it("na edição, o próprio fornecedor não é duplicado", () => {
    const r = acharDuplicados(existentes, { name: "Navetec Distribuidora", document: CNPJ }, "a");

    expect(r).toEqual({ porNome: null, porDocumento: null });
  });

  it("nome curto e documento incompleto não disparam aviso", () => {
    expect(acharDuplicados(existentes, { name: "Pl", document: "1122" }, null)).toEqual({ porNome: null, porDocumento: null });
  });
});

describe("completude", () => {
  it("conta telefone OU WhatsApp como um item só", () => {
    const soFone = completude({ ...vazio, name: "X", phone: "(11) 3333-4444" });
    const comOsDois = completude({ ...vazio, name: "X", phone: "1", whatsapp: "2" });

    expect(soFone.feitos).toBe(2);
    expect(comOsDois.feitos).toBe(2);
  });

  it("documento só conta quando é válido", () => {
    expect(completude({ ...vazio, document: "123" }).feitos).toBe(0);
    expect(completude({ ...vazio, document: CNPJ }).feitos).toBe(1);
  });

  it("cadastro cheio chega a 100%", () => {
    const cheio = completude({
      name: "N",
      legalName: "N Ltda",
      document: CPF,
      contactName: "Ana",
      email: "a@b.com",
      phone: "",
      whatsapp: "11987654321",
      website: "",
      notes: "Frete: FOB",
    });

    expect(cheio.percentual).toBe(100);
  });
});

describe("acrescentarCondicao", () => {
  it("acrescenta no fim, numa linha nova", () => {
    expect(acrescentarCondicao("", "Frete")).toBe("Frete: ");
    expect(acrescentarCondicao("Pagamento: 30 dias\n\n", "Frete")).toBe("Pagamento: 30 dias\nFrete: ");
  });

  it("não repete a condição que já está no texto", () => {
    expect(acrescentarCondicao("frete: CIF", "Frete")).toBe("frete: CIF");
  });
});
