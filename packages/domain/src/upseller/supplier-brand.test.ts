import { describe, expect, it } from "vitest";

import { resolveSupplierBrand } from "./supplier-brand.js";
import type { SupplierBrandInput } from "./supplier-brand.js";

/** Linha do export, com os campos que a cascata lê. */
function linha(overrides: Partial<SupplierBrandInput>): SupplierBrandInput {
  return {
    sku: "12345",
    title: "Manete Curto (CB1000R) - Preto",
    brandColumn: null,
    categories: null,
    description: null,
    ...overrides,
  };
}

describe("resolveSupplierBrand — a Categorias do dono decide primeiro", () => {
  it("a Categorias vence a coluna Marca quando as duas discordam", () => {
    // ESTA ORDEM FOI MEDIDA, NÃO ESCOLHIDA. O dono exportou o catálogo em 20
    // arquivos, um por `Categorias`, e chamou cada um de marca — 1.016 SKUs
    // declarados. Com a coluna `Marca` na frente, a cascata batia com ele em
    // 77,6%; com `Categorias` na frente, 99,5%.
    const r = resolveSupplierBrand(
      linha({ brandColumn: "RT", categories: "NAVETEC", title: "Pinça De Freio Traseiro Lander 250 Até 2018 (PFT04)" }),
    );

    expect(r).toEqual({ brand: "NAVETEC", origin: "CATEGORIA" });
  });

  it("usa a coluna Marca quando a categoria não nomeia marca nenhuma", () => {
    const r = resolveSupplierBrand(linha({ brandColumn: "Off Racer", categories: "MANETE→NH 190" }));

    expect(r).toEqual({ brand: "OFF RACER", origin: "MARCA" });
  });

  it("célula suja com preço colado e DUAS marcas não decide nada — cai para a próxima etapa", () => {
    const r = resolveSupplierBrand(
      linha({ brandColumn: "TMAC - 157,11 aolixin", categories: "MANETE→NMAX", title: "Bomba de Combustível Nmax 160" }),
    );

    expect(r).toEqual({ brand: null, origin: null });
  });

  it("marca nova, que o catálogo ainda não conhece, é aceita pela forma", () => {
    const r = resolveSupplierBrand(linha({ brandColumn: "Fabrica Nova Motos" }));

    expect(r).toEqual({ brand: "FABRICA NOVA MOTOS", origin: "MARCA" });
  });

  it("grafias do mesmo fornecedor colapsam numa só", () => {
    expect(resolveSupplierBrand(linha({ brandColumn: "OFFRACER" })).brand).toBe("OFF RACER");
    expect(resolveSupplierBrand(linha({ brandColumn: "Aolixin" })).brand).toBe("AOLIXIM");
    expect(resolveSupplierBrand(linha({ brandColumn: "T-MAC" })).brand).toBe("TMAC");
    expect(resolveSupplierBrand(linha({ brandColumn: "RT PARTS" })).brand).toBe("RT");
    expect(resolveSupplierBrand(linha({ brandColumn: "Pandao" })).brand).toBe("PANDÃO");
  });
});

describe("resolveSupplierBrand — Categorias só quando é marca de verdade", () => {
  it("categoria sem seta é marca", () => {
    const r = resolveSupplierBrand(linha({ categories: "NAVETEC" }));

    expect(r).toEqual({ brand: "NAVETEC", origin: "CATEGORIA" });
  });

  it("hierarquia com seta NÃO é marca — é tipo de peça e modelo de moto", () => {
    expect(resolveSupplierBrand(linha({ categories: "MANETE→CB 300R" })).brand).toBeNull();
    expect(resolveSupplierBrand(linha({ categories: "MANETE->CB 300R" })).brand).toBeNull();
  });

  it("status de cadastro NÃO vira marca", () => {
    // Estes carimbaram 254 SKUs de produção na marcação em lote de 14/09.
    // `ESTOQUE INATIVO` segue virando `is_discontinued` em `parseCategory`.
    expect(resolveSupplierBrand(linha({ categories: "ESTOQUE INATIVO" })).brand).toBeNull();
    expect(resolveSupplierBrand(linha({ categories: "OCUPADO" })).brand).toBeNull();
  });
});

describe("resolveSupplierBrand — o balde 999", () => {
  it("é Off Racer, por declaração do dono, mas só depois de todas as outras etapas", () => {
    const r = resolveSupplierBrand(linha({ categories: "999", title: "Guidão 28mm Alto", sku: "G28A-PRATA" }));

    expect(r).toEqual({ brand: "OFF RACER", origin: "BALDE" });
  });

  it("marca escrita no título vence o balde — as cinco linhas `Manete RT CG LONA`", () => {
    const r = resolveSupplierBrand(linha({ categories: "999", brandColumn: "RT", title: "Manete RT CG LONA" }));

    expect(r).toEqual({ brand: "RT", origin: "MARCA" });
  });
});

describe("resolveSupplierBrand — texto do anúncio e código do SKU", () => {
  it('lê "Marca: Off Racer;" da descrição', () => {
    const r = resolveSupplierBrand(
      linha({ categories: "999", description: "CARACTERÍSTICAS\n\nMarca: Off Racer;\nLinha: Extreme;" }),
    );

    expect(r).toEqual({ brand: "OFF RACER", origin: "DESCRICAO" });
  });

  it("descrição sem marca reconhecível não inventa nada", () => {
    const r = resolveSupplierBrand(linha({ categories: "MANETE→PCX", description: "Marca: IMPORTADA PRODUTO NOVO" }));

    expect(r.brand).toBeNull();
  });

  it("marca escrita no título vence a falta de tudo — o caso RT PARTS do dono", () => {
    const r = resolveSupplierBrand(
      linha({ categories: "MANETE→CB 300R", title: "Manete Esportivo Cb300 RT PARTS - Prata" }),
    );

    expect(r).toEqual({ brand: "RT", origin: "TITULO" });
  });

  it("prefixo off/kitoff do código carrega marca que o título não carrega (D-129)", () => {
    expect(resolveSupplierBrand(linha({ sku: "Off03-11", categories: "MANETE→XRE/BROS/TORNADO" })).brand).toBe(
      "OFF RACER",
    );
    expect(resolveSupplierBrand(linha({ sku: "KitOff12", categories: "MANETE→HORNET" })).brand).toBe("OFF RACER");
  });

  it("título que cita DUAS marcas conhecidas não decide", () => {
    const r = resolveSupplierBrand(linha({ title: "Kit Plasmoto e Navetec para Titan", categories: "MANETE→PCX" }));

    expect(r.brand).toBeNull();
  });
});

describe("resolveSupplierBrand — linhas de produto Off Racer", () => {
  it("Manopla V2 é Off Racer — o segundo exemplo do dono", () => {
    const r = resolveSupplierBrand(
      linha({ categories: "MANETE→NINJA 250", title: "Manopla V2 Manete Curto Ninja 250r - Preto reg Vermelho" }),
    );

    expect(r).toEqual({ brand: "OFF RACER", origin: "LINHA" });
  });

  it("Jupiter, XL, Pegasus, Naked, Sahara e TM2 também", () => {
    const casos = [
      "Kit Manopla Jupiter + Manete Sahara 300 XR300L Tornado",
      "Kit Manopla XL + Peso + Manete Citycom 300i",
      "Kit Manopla Pegasus Manete Nmax 160",
      "Guidão Naked Retrovisor Yamaha Factor Fazer 150 Ubs(preto)",
      "Kit TM2 + Manete Pop 100 110",
    ];

    for (const title of casos) {
      expect(resolveSupplierBrand(linha({ categories: "MANETE→PCX", title })).brand).toBe("OFF RACER");
    }
  });

  it("a linha é FRASE: a moto Honda XL e a NX 350 Sahara não viram Off Racer", () => {
    expect(
      resolveSupplierBrand(linha({ categories: "MANETE→PCX", title: "Manete Curto Honda XL 250 - Preto" })).brand,
    ).toBeNull();
    expect(resolveSupplierBrand(linha({ categories: "MANETE→PCX", title: "Pinça de Freio Sahara 350" })).brand).toBeNull();
  });
});

describe("resolveSupplierBrand — sem evidência fica sem marca", () => {
  it("manete genérico, só com o modelo da moto no título, não recebe marca", () => {
    const r = resolveSupplierBrand(linha({ categories: "MANETE→MT-03", title: "Manete Curto (MT03) - Azul" }));

    expect(r).toEqual({ brand: null, origin: null });
  });

  it("linha inteiramente vazia não quebra", () => {
    const r = resolveSupplierBrand({ sku: "X1", title: null, brandColumn: null, categories: null, description: null });

    expect(r).toEqual({ brand: null, origin: null });
  });
});
