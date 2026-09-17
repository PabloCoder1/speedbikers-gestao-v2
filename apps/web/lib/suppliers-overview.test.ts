import { describe, expect, it } from "vitest";

import {
  formatarDocumento,
  idadeRelativa,
  iniciais,
  lerVisaoFornecedores,
  linkEmail,
  linkSite,
  linkTelefone,
  linkWhatsapp,
  rotuloSite,
} from "./suppliers-overview";

/** A forma exata que `get_suppliers_overview` devolveu no banco local (D-366). */
const linha = {
  id: "227c8a3b-fbf4-4171-b494-6fae7ce38479",
  name: "Fornecedor E2E",
  email: null,
  phone: null,
  website: null,
  document: "12345678000199",
  whatsapp: null,
  is_active: true,
  created_at: "2026-09-16T18:19:11.53886+00:00",
  legal_name: null,
  contact_name: null,
  orders_total: 4,
  valor_pedido: 347.0,
  skus_distintos: 5,
  itens_sem_custo: 1,
  valor_em_aberto: 305.0,
  orders_em_aberto: 2,
  ultimo_pedido_em: "2026-09-16T18:19:11.727478+00:00",
  itens_em_aberto_sem_custo: 1,
};

const resposta = {
  total: 1,
  linhas: [linha],
  totais: {
    valor_comprado: 347.0,
    itens_sem_custo: 1,
    valor_em_aberto: 305.0,
    ultimo_pedido_em: "2026-09-16T18:19:11.727478+00:00",
    pedidos_em_aberto: 2,
    ultimo_pedido_fornecedor: "Fornecedor E2E",
    itens_em_aberto_sem_custo: 1,
  },
  contagens: { todos: 2, ativos: 1, inativos: 1, em_aberto: 1, sem_pedido: 1 },
};

describe("lerVisaoFornecedores", () => {
  it("lê a resposta real do banco", () => {
    const visao = lerVisaoFornecedores(resposta);

    expect(visao?.total).toBe(1);
    expect(visao?.contagens.em_aberto).toBe(1);
    expect(visao?.totais.valorEmAberto).toBe(305);
    expect(visao?.linhas[0]?.orders_em_aberto).toBe(2);
  });

  it("valor NULO continua nulo — itens sem custo não viram R$ 0,00 (D-258)", () => {
    const visao = lerVisaoFornecedores({
      ...resposta,
      linhas: [{ ...linha, valor_pedido: null }],
      totais: { ...resposta.totais, valor_comprado: null },
    });

    expect(visao?.linhas[0]?.valor_pedido).toBeNull();
    expect(visao?.totais.valorComprado).toBeNull();
  });

  it("um campo renomeado no SQL recusa a resposta inteira", () => {
    const semCampo: Record<string, unknown> = { ...linha };
    delete semCampo.orders_em_aberto;

    expect(lerVisaoFornecedores({ ...resposta, linhas: [semCampo] })).toBeNull();
    expect(lerVisaoFornecedores({ ...resposta, contagens: { todos: 2 } })).toBeNull();
    expect(
      lerVisaoFornecedores({
        ...resposta,
        totais: { ...resposta.totais, valor_comprado: "347" },
      }),
    ).toBeNull();
    expect(lerVisaoFornecedores(null)).toBeNull();
    expect(lerVisaoFornecedores([])).toBeNull();
  });
});

describe("links de contato", () => {
  it("WhatsApp brasileiro ganha o 55; com DDI fica como está", () => {
    expect(linkWhatsapp("(11) 98765-4321")).toBe("https://wa.me/5511987654321");
    expect(linkWhatsapp("+55 11 98765-4321")).toBe("https://wa.me/5511987654321");
    expect(linkWhatsapp("011 3333-4444")).toBe("https://wa.me/551133334444");
  });

  it("número que não dá para interpretar não vira link", () => {
    expect(linkWhatsapp("98765-4321")).toBeNull();
    expect(linkWhatsapp("ramal 22")).toBeNull();
    expect(linkWhatsapp(null)).toBeNull();
  });

  it("telefone precisa de DDD", () => {
    expect(linkTelefone("(47) 3333-4444")).toBe("tel:+554733334444");
    expect(linkTelefone("3333-4444")).toBeNull();
  });

  it("e-mail e site só quando parecem de verdade", () => {
    expect(linkEmail(" vendas@navetec.com.br ")).toBe("mailto:vendas@navetec.com.br");
    expect(linkEmail("falar com João")).toBeNull();
    expect(linkSite("navetec.com.br")).toBe("https://navetec.com.br/");
    expect(linkSite("http://loja.com/catalogo")).toBe("http://loja.com/catalogo");
    expect(linkSite("sem site")).toBeNull();
    expect(linkSite("localhost")).toBeNull();
    expect(rotuloSite("https://www.navetec.com.br/")).toBe("navetec.com.br");
  });
});

describe("formatação", () => {
  it("CNPJ e CPF ganham pontuação; o resto fica como veio", () => {
    expect(formatarDocumento("12345678000199")).toBe("12.345.678/0001-99");
    expect(formatarDocumento("12.345.678/0001-99")).toBe("12.345.678/0001-99");
    expect(formatarDocumento("12345678901")).toBe("123.456.789-01");
    expect(formatarDocumento(" EIN 12-3456789 ")).toBe("EIN 12-3456789");
    expect(formatarDocumento(null)).toBeNull();
  });

  it("iniciais do avatar", () => {
    expect(iniciais("Navetec Distribuidora")).toBe("ND");
    expect(iniciais("Givi")).toBe("GI");
    expect(iniciais("  Pro - Tork Motos ")).toBe("PM");
    expect(iniciais("")).toBe("?");
  });

  it("idade do último pedido", () => {
    const agora = new Date("2026-09-17T12:00:00Z");

    expect(idadeRelativa("2026-09-17T08:00:00Z", agora)).toBe("hoje");
    expect(idadeRelativa("2026-09-16T08:00:00Z", agora)).toBe("ontem");
    expect(idadeRelativa("2026-09-07T12:00:00Z", agora)).toBe("há 10 dias");
    expect(idadeRelativa("2026-06-17T12:00:00Z", agora)).toBe("há 3 meses");
    expect(idadeRelativa("2024-09-01T12:00:00Z", agora)).toBe("há 2 anos");
    expect(idadeRelativa(null, agora)).toBeNull();
  });
});
