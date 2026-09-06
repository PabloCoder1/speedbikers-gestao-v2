import { describe, expect, it } from "vitest";

import { purchaseOrderCostNote, summarizePurchaseOrderCost } from "./purchase-order-cost";

describe("valor estimado do pedido", () => {
  it("soma quantidade × custo quando todos os itens têm custo", () => {
    const resumo = summarizePurchaseOrderCost([
      { quantity_ordered: 5, unit_cost: 10.5 },
      { quantity_ordered: 2, unit_cost: 100 },
    ]);

    expect(resumo.total).toBe(252.5);
    expect(resumo.missingCost).toBe(0);
    expect(purchaseOrderCostNote(resumo)).toBeNull();
  });

  /**
   * O DEFEITO que motivou a extração, fixado como teste (D-197: teste contra o
   * defeito, não só a favor do acerto). A versão anterior somava
   * `unit_cost ?? 0` e devolvia 52,5 — um total MENOR que o real, com cara de
   * número fechado, enquanto a linha do item mostrava "—" para o mesmo custo.
   */
  it("item sem custo NÃO entra como zero — o total é parcial e diz que é", () => {
    const resumo = summarizePurchaseOrderCost([
      { quantity_ordered: 5, unit_cost: 10.5 },
      { quantity_ordered: 3, unit_cost: null },
    ]);

    expect(resumo.total).toBe(52.5);
    expect(resumo.missingCost).toBe(1);
    expect(resumo.totalItems).toBe(2);
    expect(purchaseOrderCostNote(resumo)).toBe("1 de 2 sem custo");
  });

  /**
   * Nenhum item com custo é "desconhecido", não "zero": R$ 0,00 afirmaria um
   * pedido sem valor onde o que há é um pedido sem custo preenchido — que é o
   * estado normal de um rascunho recém-criado.
   */
  it("nenhum item com custo devolve desconhecido, nunca R$ 0,00", () => {
    const resumo = summarizePurchaseOrderCost([
      { quantity_ordered: 5, unit_cost: null },
      { quantity_ordered: 3, unit_cost: null },
    ]);

    expect(resumo.total).toBeNull();
    expect(purchaseOrderCostNote(resumo)).toBe("2 de 2 sem custo");
  });

  /** Pedido genuinamente vazio: aí o total É conhecido, e é zero. */
  it("pedido sem itens vale zero, e isso é sabido", () => {
    const resumo = summarizePurchaseOrderCost([]);

    expect(resumo.total).toBe(0);
    expect(resumo.missingCost).toBe(0);
  });

  /** Falha de leitura ≠ pedido vazio — o defeito de D-067 nível 1. */
  it("falha de leitura é desconhecido, não pedido vazio", () => {
    const resumo = summarizePurchaseOrderCost(null);

    expect(resumo.total).toBeNull();
    expect(resumo.totalItems).toBe(0);
    expect(purchaseOrderCostNote(resumo)).toBeNull();
  });

  /** Custo zero é um custo, e é diferente de custo ausente. */
  it("custo ZERO é conhecido e entra na conta", () => {
    const resumo = summarizePurchaseOrderCost([{ quantity_ordered: 4, unit_cost: 0 }]);

    expect(resumo.total).toBe(0);
    expect(resumo.missingCost).toBe(0);
  });
});
