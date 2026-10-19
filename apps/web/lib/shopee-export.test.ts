import { describe, expect, it } from "vitest";

import { anunciosShopeeParaCsv, pedidosShopeeParaCsv, type AnuncioShopeeExport, type PedidoShopeeExport } from "./shopee-export";

const PEDIDO: PedidoShopeeExport = {
  order_sn: "251016ABC",
  shop_name: "Loja Real",
  environment: "live",
  shopee_created_at: "2026-10-15T15:00:00Z",
  situacao: "VALIDA",
  order_status: "COMPLETED",
  unidades: 2,
  receita_bruta: 199.9,
  recebido: 160.5,
  financeiro_lido: true,
  com_devolucao: false,
  itens: [{ item_id: 1, model_id: 2, nome: "Pastilha", variacao: "Dianteira", quantidade: 2, sku: "PAST-01" }],
};

/** As linhas do documento, sem o BOM e sem a quebra final. */
function linhas(csv: string): string[] {
  return csv.replace(/^\uFEFF/u, "").replace(/\r\n$/u, "").split("\r\n");
}

describe("pedidosShopeeParaCsv", () => {
  it("cabeçalho e uma linha com as palavras da tela, vírgula decimal e os itens", () => {
    const [cabecalho, linha] = linhas(pedidosShopeeParaCsv([PEDIDO]));

    expect(cabecalho).toBe(
      "Pedido;Loja;Ambiente;Criado em;Situação;Status na Shopee;Unidades;Receita bruta;Recebido;Financeiro lido;Devolução;Itens",
    );
    expect(linha?.split(";")).toEqual([
      "251016ABC",
      "Loja Real",
      "Real",
      expect.stringMatching(/^15\/10\/2026/u) as unknown as string,
      "Válida",
      "COMPLETED",
      "2",
      "199,9",
      "160,5",
      "Sim",
      "Não",
      "2× Pastilha — Dianteira (PAST-01)",
    ]);
  });

  it("receita e recebido desconhecidos ficam vazios, nunca 0; a loja de teste é dita", () => {
    const [, linha] = linhas(
      pedidosShopeeParaCsv([{ ...PEDIDO, environment: "sandbox", receita_bruta: null, recebido: null, financeiro_lido: false }]),
    );
    const celulas = linha?.split(";") ?? [];

    expect(celulas[2]).toBe("Teste");
    expect(celulas[7]).toBe("");
    expect(celulas[8]).toBe("");
    expect(celulas[9]).toBe("Não");
  });

  it("situação desconhecida não sai crua; nome com separador vai entre aspas; fórmula é neutralizada", () => {
    const [, linha] = linhas(pedidosShopeeParaCsv([{ ...PEDIDO, situacao: "NOVA_DA_SHOPEE", shop_name: "=HYPERLINK(1)" }]));

    expect(linha).toContain("Outra situação");
    expect(linha).not.toContain("NOVA_DA_SHOPEE");
    expect(linha).toContain("'=HYPERLINK(1)");
  });

  it("sem pedidos, só o cabeçalho", () => {
    expect(linhas(pedidosShopeeParaCsv([]))).toHaveLength(1);
  });
});

const ANUNCIO: AnuncioShopeeExport = {
  item_id: 990777001,
  model_id: null,
  item_name: "Pastilha de freio",
  model_name: null,
  shop_name: "Loja Real",
  estado: "VINCULADO",
  item_status: "NORMAL",
  sku_anuncio: "PAST-01",
  sku: "PAST-01",
  vinculo_via: "SKU_DO_ANUNCIO",
  current_price: 100,
  original_price: 120,
  currency: "BRL",
  available_stock: 7,
  details_synced_at: "2026-10-16T12:00:00Z",
};

describe("anunciosShopeeParaCsv", () => {
  it("o estado do vínculo e o status no singular da linha, a origem do SKU e os números", () => {
    const [cabecalho, linha] = linhas(anunciosShopeeParaCsv([ANUNCIO]));

    expect(cabecalho?.split(";")).toHaveLength(19);
    expect(linha).toContain(";Vinculado;Ativo;PAST-01;PAST-01;pelo SKU do anúncio;100;120;BRL;7;");
  });

  it("item aguardando leitura: preço, estoque e data vazios, nunca 0", () => {
    const [, linha] = linhas(
      anunciosShopeeParaCsv([
        {
          ...ANUNCIO,
          estado: "AGUARDANDO_LEITURA",
          item_name: null,
          current_price: null,
          original_price: null,
          currency: null,
          available_stock: null,
          details_synced_at: null,
        },
      ]),
    );

    expect(linha).toContain(";Aguardando leitura;");
    expect(linha?.endsWith(";;;;;")).toBe(true);
  });

  it("as vendas do período no fim (D-606): número quando lidas, vazio quando a loja nunca foi lida ou a receita é desconhecida", () => {
    const [cabecalho, vendeu, semReceita, nuncaLida] = linhas(
      anunciosShopeeParaCsv([
        { ...ANUNCIO, unidades_vendidas: 11, receita_bruta: 1100.5, pedidos: 11, unidades_sem_receita: 0 },
        { ...ANUNCIO, unidades_vendidas: 2, receita_bruta: null, pedidos: 2, unidades_sem_receita: 2 },
        { ...ANUNCIO, unidades_vendidas: null, receita_bruta: null, pedidos: null, unidades_sem_receita: null },
      ]),
    );

    expect(cabecalho?.endsWith(";Unidades vendidas;Faturamento;Pedidos;Unidades sem receita conhecida")).toBe(true);
    expect(vendeu?.endsWith(";11;1100,5;11;0")).toBe(true);
    expect(semReceita?.endsWith(";2;;2;2")).toBe(true);
    expect(nuncaLida?.endsWith(";;;;")).toBe(true);
  });

  it("estado desconhecido não sai cru", () => {
    const [, linha] = linhas(anunciosShopeeParaCsv([{ ...ANUNCIO, estado: "NOVO_ESTADO" }]));

    expect(linha).toContain("Outro estado");
    expect(linha).not.toContain("NOVO_ESTADO");
  });
});
