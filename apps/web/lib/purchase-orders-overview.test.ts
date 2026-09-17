import { describe, expect, it } from "vitest";

import {
  etapaDoPedido,
  leituraPrevisao,
  lerVisaoCompras,
  linhaDoLegado,
  proximoPasso,
  type LinhaCompra,
} from "./purchase-orders-overview";

const agregado = { pedidos: 2, valor: 252.5, unidades: 7, sem_custo: 0 };

const linha: LinhaCompra = {
  id: "9a3bde68-678d-4a0b-8078-29d83cbe865d",
  order_number: 12,
  status: "ORDERED",
  supplier_id: "5c2a1f7e-1111-4a0b-8078-29d83cbe865d",
  supplier_name: "Plasmoto",
  destination_warehouse_name: "Depósito Central",
  created_at: "2026-09-10T13:00:00+00:00",
  created_by_name: "Ana",
  approved_at: "2026-09-10T14:00:00+00:00",
  ordered_at: "2026-09-11T14:00:00+00:00",
  received_at: null,
  cancelled_at: null,
  previsao: "2026-09-20",
  dias_para_previsao: 3,
  atrasado: false,
  itens: 2,
  unidades: 7,
  sem_custo: 0,
  valor: 252.5,
};

const resposta = {
  total: 1,
  contagens: [{ status: "ORDERED", pedidos: 1, valor: 252.5, sem_custo: 0 }],
  em_aberto: agregado,
  atrasados: { ...agregado, maior_atraso_dias: 4 },
  chegando: agregado,
  recebidos: { pedidos: 0, valor: 0, unidades: 0, sem_custo: 0 },
  linhas: [linha],
};

describe("lerVisaoCompras", () => {
  it("lê a resposta no contrato", () => {
    const visao = lerVisaoCompras(resposta);

    expect(visao?.total).toBe(1);
    expect(visao?.atrasados.maiorAtrasoDias).toBe(4);
    expect(visao?.linhas[0]).toEqual(linha);
  });

  /** D-254: valor desconhecido chega nulo e continua nulo — nunca vira zero na leitura. */
  it("aceita valor nulo no agregado, na contagem e na linha", () => {
    const visao = lerVisaoCompras({
      ...resposta,
      em_aberto: { ...agregado, valor: null, sem_custo: 2 },
      contagens: [{ status: "DRAFT", pedidos: 2, valor: null, sem_custo: 2 }],
      linhas: [{ ...linha, valor: null, sem_custo: 2 }],
    });

    expect(visao?.emAberto.valor).toBeNull();
    expect(visao?.contagens[0]?.valor).toBeNull();
    expect(visao?.linhas[0]?.valor).toBeNull();
  });

  it("recusa a resposta INTEIRA quando um campo sai do contrato", () => {
    expect(lerVisaoCompras(null)).toBeNull();
    expect(lerVisaoCompras({ ...resposta, total: "1" })).toBeNull();
    expect(lerVisaoCompras({ ...resposta, atrasados: agregado })).toBeNull();
    expect(lerVisaoCompras({ ...resposta, chegando: undefined })).toBeNull();
    expect(lerVisaoCompras({ ...resposta, linhas: [{ ...linha, previsao: undefined }] })).toBeNull();
    expect(lerVisaoCompras({ ...resposta, linhas: [{ ...linha, order_number: "12" }] })).toBeNull();
    expect(lerVisaoCompras({ ...resposta, contagens: [{ status: "DRAFT", pedidos: 1 }] })).toBeNull();
  });
});

describe("linhaDoLegado", () => {
  it("corta a data de negócio do instante e não inventa o que a leitura antiga não sabe", () => {
    const nova = linhaDoLegado({
      id: linha.id,
      order_number: 12,
      status: "APPROVED",
      supplier_name: null,
      destination_warehouse_name: null,
      expected_at: "2026-09-20T00:00:00+00:00",
      created_at: linha.created_at,
      created_by_name: null,
      items_count: 2,
      items_missing_cost: 1,
      estimated_value: 52.5,
    });

    expect(nova.previsao).toBe("2026-09-20");
    expect(nova.unidades).toBeNull();
    expect(nova.dias_para_previsao).toBeNull();
    expect(nova.atrasado).toBe(false);
    expect(nova.valor).toBe(52.5);
  });
});

describe("proximoPasso", () => {
  it("rascunho diz o que falta antes de dizer aprovar", () => {
    expect(proximoPasso({ ...linha, status: "DRAFT", supplier_name: null, sem_custo: 1 })?.texto).toBe(
      "Completar fornecedor e custo",
    );
    expect(proximoPasso({ ...linha, status: "DRAFT", itens: 0 })?.texto).toBe("Completar itens");
    expect(proximoPasso({ ...linha, status: "DRAFT" })).toEqual({ texto: "Aprovar", tom: "info" });
  });

  it("em andamento, o atraso pinta o passo de perigo", () => {
    expect(proximoPasso({ ...linha, status: "APPROVED" })?.texto).toBe("Enviar ao fornecedor");
    expect(proximoPasso({ ...linha, atrasado: true })).toEqual({ texto: "Conferir recebimento", tom: "perigo" });
  });

  it("terminado não pede nada", () => {
    expect(proximoPasso({ ...linha, status: "RECEIVED" })).toBeNull();
    expect(proximoPasso({ ...linha, status: "CANCELLED" })).toBeNull();
  });
});

describe("leituraPrevisao", () => {
  it("escreve a data de negócio sem passar por fuso", () => {
    expect(leituraPrevisao(linha)?.data).toBe("20/09/2026");
    expect(leituraPrevisao({ ...linha, previsao: null })).toBeNull();
  });

  it("diz quanto falta ou quanto passou, com a flexão certa", () => {
    expect(leituraPrevisao({ ...linha, dias_para_previsao: -1 })).toMatchObject({ nota: "atrasado 1 dia", tom: "perigo" });
    expect(leituraPrevisao({ ...linha, dias_para_previsao: -5 })?.nota).toBe("atrasado 5 dias");
    expect(leituraPrevisao({ ...linha, dias_para_previsao: 0 })?.nota).toBe("chega hoje");
    expect(leituraPrevisao({ ...linha, dias_para_previsao: 1 })?.nota).toBe("em 1 dia");
    expect(leituraPrevisao({ ...linha, dias_para_previsao: 30 })).toMatchObject({ nota: "em 30 dias", tom: "neutro" });
  });

  it("recebido, rascunho e leitura antiga mostram só a data", () => {
    expect(leituraPrevisao({ ...linha, status: "RECEIVED", dias_para_previsao: -9 })?.nota).toBeNull();
    expect(leituraPrevisao({ ...linha, status: "DRAFT" })?.nota).toBeNull();
    expect(leituraPrevisao({ ...linha, dias_para_previsao: null })?.nota).toBeNull();
  });
});

describe("etapaDoPedido", () => {
  it("segue o ciclo de quatro etapas", () => {
    expect(etapaDoPedido({ ...linha, status: "DRAFT" }).feitas).toBe(1);
    expect(etapaDoPedido(linha)).toEqual({ feitas: 3, cancelado: false });
    expect(etapaDoPedido({ ...linha, status: "RECEIVED" }).feitas).toBe(4);
  });

  it("cancelado para onde os carimbos dizem que ele chegou", () => {
    expect(etapaDoPedido({ ...linha, status: "CANCELLED" })).toEqual({ feitas: 3, cancelado: true });
    expect(etapaDoPedido({ ...linha, status: "CANCELLED", ordered_at: null })).toEqual({ feitas: 2, cancelado: true });
    expect(
      etapaDoPedido({ ...linha, status: "CANCELLED", ordered_at: null, approved_at: null }),
    ).toEqual({ feitas: 1, cancelado: true });
  });
});
