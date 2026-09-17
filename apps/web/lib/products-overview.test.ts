import { describe, expect, it } from "vitest";

import {
  DEFAULT_PAGE_SIZE,
  SEM_CATEGORIA,
  buildCurationHref,
  filtrosAtivos,
  resolveCurationFilters,
  toOverviewRpcArgs,
} from "./curation-filters";
import { lerVisaoProdutos, linhaDoLegado, opcoesDeLista } from "./products-overview";

const linha = {
  sku_id: "9a3bde68-678d-4a0b-8078-29d83cbe865d",
  sku: "E2E-SKU-001",
  title: "Manete esportiva",
  brand: "MANETE",
  supplier_brand: "NAVETEC",
  supplier_brand_source: "DERIVED",
  stock_is_virtual: false,
  stock_is_virtual_set_at: null,
  snapshot_available: 950,
  has_sentinel_signature: true,
  units_sold_90d: 12,
  decision_diverges_from_signature: false,
  listing_count: 2,
  created_at: "2026-09-10T13:00:00+00:00",
  updated_at: "2026-09-11T13:00:00+00:00",
  kind: "PRODUTO",
  situacao: "ATIVO",
  retail_price: 89.9,
  purchase_cost: 41.5,
};

const resposta = {
  total: 1,
  linhas: [linha],
  facetas: {
    estado: { todos: 1, pendente: 1, virtual: 0, fisico: 0 },
    sinal: { todos: 1, sentinela: 1, sem_sinal: 0, sem_retrato: 0, divergente: 0 },
    marcas: [{ valor: "NAVETEC", n: 1 }],
    categorias: [{ valor: "MANETE", n: 1 }],
    tipo: { todos: 1, produto: 1, kit: 0 },
    situacao: { todos: 1, ativo: 1, encerrando: 0, inativo: 0 },
    anuncios: { todos: 1, com: 1, sem: 0 },
    vendas: { todos: 1, com: 1, sem: 0 },
  },
  resumo: {
    total: 1,
    nunca_classificados: 1,
    virtuais: 0,
    sem_marca: 0,
    a_revisar: 0,
    sem_anuncio: 0,
    sem_venda_90d: 0,
    encerrando: 0,
    retrato_em: "2026-09-10T10:00:00+00:00",
  },
};

describe("lerVisaoProdutos", () => {
  it("lê a resposta no contrato", () => {
    const visao = lerVisaoProdutos(resposta);

    expect(visao?.total).toBe(1);
    expect(visao?.linhas[0]?.kind).toBe("PRODUTO");
    expect(visao?.facetas.categorias[0]).toEqual({ valor: "MANETE", n: 1 });
    expect(visao?.resumo.retrato_em).toBe("2026-09-10T10:00:00+00:00");
  });

  it("aceita os nulos legítimos: sem retrato, sem preço, sem marca", () => {
    const visao = lerVisaoProdutos({
      ...resposta,
      linhas: [{ ...linha, has_sentinel_signature: null, snapshot_available: null, retail_price: null, supplier_brand: null }],
      facetas: { ...resposta.facetas, marcas: [{ valor: null, n: 1 }] },
    });

    expect(visao?.linhas[0]?.has_sentinel_signature).toBeNull();
    expect(visao?.facetas.marcas[0]?.valor).toBeNull();
  });

  it("recusa a resposta INTEIRA quando algo sai do contrato", () => {
    expect(lerVisaoProdutos(null)).toBeNull();
    expect(lerVisaoProdutos({ ...resposta, total: "1" })).toBeNull();
    expect(lerVisaoProdutos({ ...resposta, linhas: [{ ...linha, kind: "SERVICO" }] })).toBeNull();
    expect(lerVisaoProdutos({ ...resposta, linhas: [{ ...linha, situacao: undefined }] })).toBeNull();
    expect(lerVisaoProdutos({ ...resposta, facetas: { ...resposta.facetas, tipo: { todos: 1 } } })).toBeNull();
    expect(lerVisaoProdutos({ ...resposta, resumo: { ...resposta.resumo, sem_anuncio: null } })).toBeNull();
  });
});

describe("linhaDoLegado", () => {
  it("não inventa o que a leitura antiga não traz", () => {
    const nova = linhaDoLegado({ ...linha, total_count: 5 });

    expect(nova.kind).toBeNull();
    expect(nova.situacao).toBeNull();
    expect(nova.retail_price).toBeNull();
    expect(nova.sku).toBe("E2E-SKU-001");
  });
});

describe("opcoesDeLista", () => {
  const lista = [
    { valor: "MANETE", n: 90 },
    { valor: "PISCA", n: 40 },
    { valor: "BAU", n: 3 },
    { valor: null, n: 7 },
  ];

  it("as maiores ficam à vista e a ausência vai por último em 'demais'", () => {
    const r = opcoesDeLista(lista, null, SEM_CATEGORIA, 2);

    expect(r.principais.map((c) => c.valor)).toEqual(["MANETE", "PISCA"]);
    expect(r.demais.map((c) => c.valor)).toEqual(["BAU", null]);
  });

  it("a opção ATIVA nunca some do menu, mesmo pequena ou zerada", () => {
    expect(opcoesDeLista(lista, "BAU", SEM_CATEGORIA, 2).principais.map((c) => c.valor)).toEqual([
      "MANETE",
      "PISCA",
      "BAU",
    ]);
    expect(opcoesDeLista(lista, "SELIM", SEM_CATEGORIA, 2).principais.at(-1)).toEqual({ valor: "SELIM", n: 0 });
  });
});

describe("filtros de catálogo na URL (D-373)", () => {
  it("o padrão é o catálogo inteiro, e /produtos limpo continua limpo", () => {
    const atual = resolveCurationFilters({});

    expect(atual.estado).toBe("todos");
    expect(buildCurationHref(atual, {})).toBe("/produtos");
    expect(filtrosAtivos(atual)).toBe(0);
  });

  it("lê os eixos novos contra lista fechada", () => {
    const atual = resolveCurationFilters({ tipo: "kit", situacao: "encerrando", anuncios: "sem", vendas: "xyz" });

    expect(atual.tipo).toBe("kit");
    expect(atual.situacao).toBe("encerrando");
    expect(atual.anuncios).toBe("sem");
    expect(atual.vendas).toBeNull();
    expect(filtrosAtivos(atual)).toBe(3);
  });

  it("os argumentos da RPC omitem o que não filtra e traduzem o vocabulário", () => {
    const atual = resolveCurationFilters({ categoria: SEM_CATEGORIA, tipo: "kit", estado: "pendente", pagina: "2" });

    expect(toOverviewRpcArgs(atual)).toEqual({
      p_limit: DEFAULT_PAGE_SIZE,
      p_offset: DEFAULT_PAGE_SIZE,
      p_order: "curadoria",
      p_missing_brand: false,
      p_missing_category: true,
      p_classified: "PENDENTE",
      p_kind: "KIT",
    });
  });

  it("trocar um eixo volta para a página 1 e preserva os outros", () => {
    const atual = resolveCurationFilters({ categoria: "MANETE", pagina: "3" });

    expect(buildCurationHref(atual, { tipo: "kit" })).toBe("/produtos?categoria=MANETE&tipo=kit");
  });
});
