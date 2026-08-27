import { describe, expect, it } from "vitest";

import type { ClaimSupportEventInput } from "./support-events.js";
import { detectClaimSupportEvents } from "./support-events.js";

const EPOCH = "2026-08-27T21:00:00.000Z";

const BASE: ClaimSupportEventInput = {
  supportCaseId: "11111111-0000-4000-8000-000000000009",
  externalCaseId: "5256749420",
  externalStatus: "opened",
  externalStage: "dispute",
  externalType: "mediations",
  isMediation: true,
  initialInternalStatus: "NOVO",
  openedAt: "2026-08-28T10:00:00.000-03:00",
  lastActivityAt: "2026-08-28T11:00:00.000-03:00",
  notifyEpoch: EPOCH,
};

describe("detectClaimSupportEvents", () => {
  it("mediação nascida após a época vira UM evento importante", () => {
    const [event] = detectClaimSupportEvents(BASE);

    expect(event?.eventType).toBe("support.claim.disputed");
    expect(event?.severity).toBe("importante");
    expect(event?.entityType).toBe("support_case");
    expect(event?.entityId).toBe(BASE.supportCaseId);
    expect(event?.source).toBe("sync");
  });

  it("a chave é TERMINAL — re-varredura converge para a mesma linha", () => {
    // Com timestamp na chave, as 126 mediações abertas medidas em D-110
    // gerariam uma notificação POR VARREDURA, para sempre: a avalanche da V2.
    const [primeira] = detectClaimSupportEvents(BASE);
    const [segunda] = detectClaimSupportEvents({ ...BASE, lastActivityAt: "2026-08-29T09:00:00.000-03:00" });

    expect(primeira?.dedupKey).toBe(`support.claim.disputed:${BASE.supportCaseId}`);
    expect(segunda?.dedupKey).toBe(primeira?.dedupKey);
  });

  it("reclamação comum (stage=claim) NÃO notifica nesta fatia", () => {
    // 35 claims novos/dia medidos — `opened` ficou fora de propósito (D-110).
    expect(detectClaimSupportEvents({ ...BASE, isMediation: false })).toEqual([]);
  });

  it("claim que já chegou encerrado não notifica — incêndio apagado", () => {
    expect(detectClaimSupportEvents({ ...BASE, initialInternalStatus: "RESOLVIDO" })).toEqual([]);
  });

  it("nascido ANTES da época fica mudo — as 126 mediações abertas do estoque", () => {
    expect(detectClaimSupportEvents({ ...BASE, openedAt: "2026-08-20T10:00:00.000-03:00" })).toEqual([]);
  });

  it("sem nascimento conhecido não há época aplicável: silêncio seguro", () => {
    expect(detectClaimSupportEvents({ ...BASE, openedAt: null })).toEqual([]);
  });

  it("a época compara INSTANTES, nunca strings — offsets do ML vs Z", () => {
    // 18:30-04:00 = 22:30Z, DEPOIS da época de 21:00Z. Lexicograficamente
    // "18" < "21" suprimiria por engano — o bug exato que este teste trava.
    const [event] = detectClaimSupportEvents({ ...BASE, openedAt: "2026-08-27T18:30:00.000-04:00" });

    expect(event).toBeDefined();

    // E o inverso: 17:30-04:00 = 21:30Z... ainda depois. 16:59-04:00 = 20:59Z
    // fica um minuto ANTES da época e deve ser suprimido.
    expect(detectClaimSupportEvents({ ...BASE, openedAt: "2026-08-27T16:59:00.000-04:00" })).toEqual([]);
  });

  it("occurredAt carrega o relógio do Mercado Livre, nunca o nosso", () => {
    const [event] = detectClaimSupportEvents(BASE);

    expect(event?.occurredAt.toISOString()).toBe(new Date(BASE.lastActivityAt).toISOString());
  });

  it("o after descreve o claim sem inventar campo", () => {
    const [event] = detectClaimSupportEvents(BASE);

    expect(event?.before).toBeNull();
    expect(event?.after).toEqual({
      externalCaseId: "5256749420",
      externalStatus: "opened",
      externalStage: "dispute",
      externalType: "mediations",
      isMediation: true,
    });
  });
});
