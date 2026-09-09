import { describe, expect, it } from "vitest";

import { purchaseOrderEtapas } from "./purchase-order-steps.js";

/**
 * Etapas do pedido de compra (D-277). O que estes casos protegem: o
 * cancelamento tem LUGAR (não é uma quinta bolinha no fim), e a data só
 * aparece onde o banco garante que ela existe.
 */
describe("etapas do pedido de compra (D-277)", () => {
  const vazio = { approvedAt: null, orderedAt: null, receivedAt: null, cancelledAt: null };

  it("DRAFT: aprovação é a etapa em curso, e nada tem data ainda", () => {
    const etapas = purchaseOrderEtapas({ ...vazio, status: "DRAFT" });

    expect(etapas.map((e) => e.label)).toEqual(["Rascunho", "Aprovado", "Pedido enviado", "Recebido"]);
    expect(etapas[0]?.estado).toBe("concluida");
    expect(etapas[1]?.estado).toBe("atual");
    expect(etapas.every((e) => e.nota === undefined)).toBe(true);
  });

  it("cada etapa concluída mostra QUANDO — a `CHECK` de coerência garante a data", () => {
    const etapas = purchaseOrderEtapas({
      status: "ORDERED",
      approvedAt: "2026-09-01T12:00:00Z",
      orderedAt: "2026-09-02T15:30:00Z",
      receivedAt: null,
      cancelledAt: null,
    });

    expect(etapas[1]?.estado).toBe("concluida");
    expect(etapas[1]?.nota).toBeDefined();
    expect(etapas[2]?.estado).toBe("concluida");
    expect(etapas[3]?.estado).toBe("atual");
    expect(etapas[3]?.nota).toBeUndefined();
  });

  it("RECEIVED fecha as quatro", () => {
    const etapas = purchaseOrderEtapas({
      status: "RECEIVED",
      approvedAt: "2026-09-01T12:00:00Z",
      orderedAt: "2026-09-02T15:30:00Z",
      receivedAt: "2026-09-09T09:00:00Z",
      cancelledAt: null,
    });

    expect(etapas.every((e) => e.estado === "concluida")).toBe(true);
  });

  it("CANCELLED em rascunho para na APROVAÇÃO — não vira uma quinta etapa no fim", () => {
    const etapas = purchaseOrderEtapas({
      ...vazio,
      status: "CANCELLED",
      cancelledAt: "2026-09-03T08:00:00Z",
    });

    expect(etapas).toHaveLength(4);
    expect(etapas[1]?.estado).toBe("cancelada");
    expect(etapas[1]?.nota).toBeDefined();
    // As posteriores continuam pendentes: o pedido nunca passou por elas.
    expect(etapas[2]?.estado).toBe("pendente");
    expect(etapas[3]?.estado).toBe("pendente");
  });

  it("CANCELLED depois de pedido para no RECEBIMENTO — o lugar muda com o histórico", () => {
    const etapas = purchaseOrderEtapas({
      status: "CANCELLED",
      approvedAt: "2026-09-01T12:00:00Z",
      orderedAt: "2026-09-02T15:30:00Z",
      receivedAt: null,
      cancelledAt: "2026-09-04T10:00:00Z",
    });

    expect(etapas[1]?.estado).toBe("concluida");
    expect(etapas[2]?.estado).toBe("concluida");
    expect(etapas[3]?.estado).toBe("cancelada");
  });

  it("nenhuma etapa fica em curso depois do cancelamento", () => {
    // A guarda contra o defeito que o mesmo caso pegou no lado da NF-e:
    // procurar por "atual" para marcar o cancelamento deixava pedido
    // cancelado sem lugar nenhum, porque CANCELLED não é DRAFT/APPROVED/ORDERED.
    const etapas = purchaseOrderEtapas({
      ...vazio,
      status: "CANCELLED",
      cancelledAt: "2026-09-03T08:00:00Z",
    });

    expect(etapas.some((e) => e.estado === "atual")).toBe(false);
    expect(etapas.some((e) => e.estado === "cancelada")).toBe(true);
  });
});
