import { describe, expect, it } from "vitest";

import {
  CANCELAMENTO_MULTICANAL,
  celulaDeCancelamentoMulticanal,
  hojeDoRecorte,
  linhasDoRecorte,
  type Leitura,
  type LinhaDeCancelamento,
  type LinhaDeHoje,
} from "./cancelamento-e-hoje-multicanal";

function cancelamento(parcial: Partial<LinhaDeCancelamento> & Pick<LinhaDeCancelamento, "nivel">): LinhaDeCancelamento {
  return {
    marketplace: null,
    account_id: null,
    account_name: null,
    environment: null,
    compras_validas: 0,
    compras_canceladas: 0,
    taxa_cancelamento: null,
    ...parcial,
  };
}

function hoje(parcial: Partial<LinhaDeHoje> & Pick<LinhaDeHoje, "nivel">): LinhaDeHoje {
  return {
    marketplace: null,
    account_id: null,
    account_name: null,
    environment: null,
    compras: 0,
    unidades: 0,
    receita_bruta: 0,
    pedidos_sem_receita: 0,
    ticket_medio: null,
    ultimo_pedido_em: null,
    lido_ate: null,
    ...parcial,
  };
}

const ok = <T>(data: readonly T[]): Leitura<T> => ({ data, error: null });
const falha = <T>(message: string, code?: string): Leitura<T> => ({
  data: null,
  error: code === undefined ? { message } : { message, code },
});

const TODOS: LinhaDeCancelamento[] = [
  cancelamento({ nivel: "TOTAL", compras_validas: 90, compras_canceladas: 10, taxa_cancelamento: 0.1 }),
  cancelamento({ nivel: "MARKETPLACE", marketplace: "SHOPEE", compras_validas: 11, compras_canceladas: 1, taxa_cancelamento: 0.0833 }),
  cancelamento({ nivel: "MARKETPLACE", marketplace: "ML", compras_validas: 79, compras_canceladas: 9, taxa_cancelamento: 0.1023 }),
  cancelamento({ nivel: "CONTA", marketplace: "ML", account_id: "ml-1", taxa_cancelamento: 0.1023 }),
];
const ANTERIOR: LinhaDeCancelamento[] = [cancelamento({ nivel: "TOTAL", taxa_cancelamento: 0.05 })];

describe("linhasDoRecorte", () => {
  it("separa o TOTAL e os marketplaces, o ML primeiro, sem somar nada", () => {
    const { total, marketplaces } = linhasDoRecorte(TODOS);

    expect(total?.taxa_cancelamento).toBe(0.1);
    expect(marketplaces.map((linha) => linha.marketplace)).toEqual(["ML", "SHOPEE"]);
  });

  it("sem linha TOTAL (nada somável), o total é nulo", () => {
    expect(linhasDoRecorte([cancelamento({ nivel: "CONTA", marketplace: "SHOPEE" })]).total).toBeNull();
  });
});

describe("celulaDeCancelamentoMulticanal", () => {
  it("mostra a taxa do TOTAL, a anterior e, no Todos, a de cada marketplace na ressalva", () => {
    const celula = celulaDeCancelamentoMulticanal(ok(TODOS), ok(ANTERIOR), "todos");

    expect(celula.metricId).toBe("multicanal_taxa_cancelamento");
    expect(celula.value).toBe("10,0%");
    expect(celula.previous).toBe("5,0%");
    expect(celula.ressalva).toContain("Por compra");
    expect(celula.ressalva).toContain("Mercado Livre 10,2% · Shopee 8,3%.");
  });

  it("na Shopee, ou com um marketplace só, não repete a taxa na ressalva", () => {
    const soShopee = [
      cancelamento({ nivel: "TOTAL", taxa_cancelamento: 0.0833 }),
      cancelamento({ nivel: "MARKETPLACE", marketplace: "SHOPEE", taxa_cancelamento: 0.0833 }),
    ];

    expect(celulaDeCancelamentoMulticanal(ok(soShopee), ok(ANTERIOR), "shopee").ressalva).not.toContain("Shopee 8,3%");
    expect(celulaDeCancelamentoMulticanal(ok(soShopee), ok(ANTERIOR), "todos").ressalva).not.toContain("Shopee 8,3%");
  });

  it("taxa nula (nenhuma compra) é '—' com o porquê, nunca 0%", () => {
    const vazio = [cancelamento({ nivel: "TOTAL", taxa_cancelamento: null })];
    const celula = celulaDeCancelamentoMulticanal(ok(vazio), ok(vazio), "todos");

    expect(celula.value).toBe("—");
    expect(celula.previous).toBe("—");
    expect(celula.ressalva).toContain("Nenhuma compra no período.");
  });

  it("sem nada somável, '—' com a mesma frase das outras células", () => {
    const celula = celulaDeCancelamentoMulticanal(ok([]), ok([]), "shopee");

    expect(celula.value).toBe("—");
    expect(celula.ressalva).toBe("nenhuma conta com venda somável neste recorte");
  });

  it("falha do período atual: diz que não leu, com o motivo, sem comparação", () => {
    const celula = celulaDeCancelamentoMulticanal(falha("timeout"), ok(ANTERIOR), "todos");

    expect(celula.value).toBe("—");
    expect(celula.previous).toBeNull();
    expect(celula.ressalva).toBe("não foi possível ler agora (timeout)");
  });

  it("função ausente (antes da migration): diz que ainda não chegou, não que falhou", () => {
    const celula = celulaDeCancelamentoMulticanal(falha("Could not find the function", "PGRST202"), ok([]), "todos");

    expect(celula.value).toBe("—");
    expect(celula.ressalva).toMatch(/^ainda não disponível neste ambiente/u);
  });

  it("falha só do anterior: o número de agora aparece e a comparação omitida é dita", () => {
    const celula = celulaDeCancelamentoMulticanal(ok(TODOS), falha("timeout"), "todos");

    expect(celula.value).toBe("10,0%");
    expect(celula.previous).toBeNull();
    expect(celula.ressalva).toContain("A comparação foi omitida, e isso não é zero: o período anterior não pôde ser lido (timeout).");
  });

  it("anterior sem nada somável: sem comparação, sem inventar", () => {
    expect(celulaDeCancelamentoMulticanal(ok(TODOS), ok([]), "todos").previous).toBeNull();
  });

  it("a identidade é a mesma em todos os estados", () => {
    for (const celula of [
      celulaDeCancelamentoMulticanal(ok(TODOS), ok(ANTERIOR), "todos"),
      celulaDeCancelamentoMulticanal(falha("x"), ok(ANTERIOR), "todos"),
    ]) {
      expect(celula.label).toBe(CANCELAMENTO_MULTICANAL.label);
      expect(celula.formula).toBe(CANCELAMENTO_MULTICANAL.formula);
    }
  });
});

describe("hojeDoRecorte", () => {
  it("pronto: o TOTAL e a linha da Shopee", () => {
    const resultado = hojeDoRecorte(
      ok([
        hoje({ nivel: "TOTAL", compras: 3, lido_ate: "2026-10-20T17:00:00Z" }),
        hoje({ nivel: "MARKETPLACE", marketplace: "ML", compras: 2 }),
        hoje({ nivel: "MARKETPLACE", marketplace: "SHOPEE", compras: 1, lido_ate: "2026-10-20T17:00:00Z" }),
      ]),
    );

    expect(resultado.estado).toBe("pronto");
    if (resultado.estado !== "pronto") return;
    expect(resultado.total.compras).toBe(3);
    expect(resultado.shopee?.lido_ate).toBe("2026-10-20T17:00:00Z");
  });

  it("só ML: sem linha da Shopee", () => {
    const resultado = hojeDoRecorte(ok([hoje({ nivel: "TOTAL" }), hoje({ nivel: "MARKETPLACE", marketplace: "ML" })]));

    expect(resultado.estado === "pronto" && resultado.shopee).toBeNull();
  });

  it("nada somável, falha e função ausente são estados diferentes", () => {
    expect(hojeDoRecorte(ok([])).estado).toBe("nada-somavel");
    expect(hojeDoRecorte(falha("timeout"))).toEqual({ estado: "falha", motivo: "timeout" });
    expect(hojeDoRecorte(falha("x", "PGRST202")).estado).toBe("ausente");
  });
});
