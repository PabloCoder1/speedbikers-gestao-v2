import { describe, expect, it } from "vitest";

import { evaluateConversationRemoteTransition, evaluateQuestionRemoteTransition } from "./remote-transition.js";

describe("evaluateQuestionRemoteTransition", () => {
  it("pergunta ainda sem resposta remota: nenhuma transição", () => {
    expect(
      evaluateQuestionRemoteTransition({
        caseId: "case-1",
        remotelyResolved: false,
        resolvedAt: null,
        lastActivityAt: "2026-08-27T10:00:00.000Z",
      }),
    ).toBeNull();
  });

  it("respondida fora da V3: resolve o case NOVO, com o instante da resposta remota", () => {
    const transition = evaluateQuestionRemoteTransition({
      caseId: "case-1",
      remotelyResolved: true,
      resolvedAt: "2026-08-27T11:30:00.000Z",
      lastActivityAt: "2026-08-27T10:00:00.000Z",
    });

    expect(transition).toEqual({
      expectedStatuses: ["NOVO"],
      newStatus: "RESOLVIDO",
      eventType: "support.case.auto_resolved",
      dedupKey: "auto-resolve:case-1",
      occurredAt: "2026-08-27T11:30:00.000Z",
    });
  });

  it("sem resolvedAt explícito, cai para lastActivityAt — nunca o relógio da V3", () => {
    const transition = evaluateQuestionRemoteTransition({
      caseId: "case-1",
      remotelyResolved: true,
      resolvedAt: null,
      lastActivityAt: "2026-08-27T10:00:00.000Z",
    });

    expect(transition?.occurredAt).toBe("2026-08-27T10:00:00.000Z");
  });

  it("dedupKey não leva timestamp — pergunta só resolve automaticamente uma vez, webhook e reconciliação convergem", () => {
    const transition = evaluateQuestionRemoteTransition({
      caseId: "case-9",
      remotelyResolved: true,
      resolvedAt: "2026-08-27T11:30:00.000Z",
      lastActivityAt: "2026-08-27T10:00:00.000Z",
    });

    expect(transition?.dedupKey).toBe("auto-resolve:case-9");
  });
});

describe("evaluateConversationRemoteTransition", () => {
  it("vendedor respondeu por último (por fora ou pela V3): NOVO vira AGUARDANDO_CLIENTE", () => {
    const transition = evaluateConversationRemoteTransition({
      caseId: "case-2",
      lastInboundAt: "2026-08-27T09:00:00.000Z",
      lastOutboundAt: "2026-08-27T10:00:00.000Z",
    });

    expect(transition).toEqual({
      expectedStatuses: ["NOVO"],
      newStatus: "AGUARDANDO_CLIENTE",
      eventType: "support.case.auto_awaiting_customer",
      dedupKey: "auto-await:case-2:2026-08-27T10:00:00.000Z",
      occurredAt: "2026-08-27T10:00:00.000Z",
    });
  });

  it("cliente respondeu por último: AGUARDANDO_CLIENTE/RESOLVIDO reabre para NOVO — a regra adiada em D-086", () => {
    const transition = evaluateConversationRemoteTransition({
      caseId: "case-2",
      lastInboundAt: "2026-08-27T12:00:00.000Z",
      lastOutboundAt: "2026-08-27T10:00:00.000Z",
    });

    expect(transition).toEqual({
      expectedStatuses: ["AGUARDANDO_CLIENTE", "RESOLVIDO"],
      newStatus: "NOVO",
      eventType: "support.case.auto_reopened",
      dedupKey: "auto-reopen:case-2:2026-08-27T12:00:00.000Z",
      occurredAt: "2026-08-27T12:00:00.000Z",
    });
  });

  it("só inbound (cliente iniciou, vendedor nunca respondeu): reabriria — mas o case NOVO não está no expected, então a RPC não faz nada", () => {
    const transition = evaluateConversationRemoteTransition({
      caseId: "case-3",
      lastInboundAt: "2026-08-27T09:00:00.000Z",
      lastOutboundAt: null,
    });

    // A decisão pura devolve a transição de reabertura; o guard do banco
    // (expectedStatuses) é quem garante que um case NOVO fica NOVO.
    expect(transition?.newStatus).toBe("NOVO");
    expect(transition?.expectedStatuses).toEqual(["AGUARDANDO_CLIENTE", "RESOLVIDO"]);
  });

  it("só outbound (vendedor iniciou a conversa): AGUARDANDO_CLIENTE", () => {
    const transition = evaluateConversationRemoteTransition({
      caseId: "case-4",
      lastInboundAt: null,
      lastOutboundAt: "2026-08-27T10:00:00.000Z",
    });

    expect(transition?.newStatus).toBe("AGUARDANDO_CLIENTE");
  });

  it("empate de timestamp conta como vendedor respondeu — reabrir num empate oscilaria entre estados", () => {
    const transition = evaluateConversationRemoteTransition({
      caseId: "case-5",
      lastInboundAt: "2026-08-27T10:00:00.000Z",
      lastOutboundAt: "2026-08-27T10:00:00.000Z",
    });

    expect(transition?.newStatus).toBe("AGUARDANDO_CLIENTE");
  });

  it("conversa sem mensagem nenhuma: nenhuma transição", () => {
    expect(
      evaluateConversationRemoteTransition({ caseId: "case-6", lastInboundAt: null, lastOutboundAt: null }),
    ).toBeNull();
  });

  it("dedupKey leva o timestamp — depois de uma reabertura, a resposta seguinte do vendedor é um fato NOVO", () => {
    const primeira = evaluateConversationRemoteTransition({
      caseId: "case-7",
      lastInboundAt: "2026-08-27T09:00:00.000Z",
      lastOutboundAt: "2026-08-27T10:00:00.000Z",
    });
    const segunda = evaluateConversationRemoteTransition({
      caseId: "case-7",
      lastInboundAt: "2026-08-27T11:00:00.000Z",
      lastOutboundAt: "2026-08-27T12:00:00.000Z",
    });

    expect(primeira?.dedupKey).not.toBe(segunda?.dedupKey);
  });
});
