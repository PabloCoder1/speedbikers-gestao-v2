import { describe, expect, it } from "vitest";

import { pendingSupportReply, type StoredSupportReply } from "./pending-support-reply";

const attempt: StoredSupportReply = {
  status: "PENDING",
  requested_by: "operador",
  client_request_id: "confirmacao",
  final_text: "A peça está disponível.",
  suggested_text: "Temos a peça em estoque.",
  dispatch_queue: "ml-sync-loja",
  dispatch_started_at: null,
};

describe("pendingSupportReply", () => {
  it("restaura a confirmação original com o texto final e a sugestão", () => {
    expect(pendingSupportReply([attempt], "operador")).toEqual({
      clientRequestId: "confirmacao",
      text: "A peça está disponível.",
      suggestedText: "Temos a peça em estoque.",
    });
  });

  it.each([
    { requested_by: "outro-operador" },
    { dispatch_queue: null },
    { dispatch_started_at: "2026-11-12T12:00:00Z" },
    { status: "FAILED" },
  ] satisfies Partial<StoredSupportReply>[])("oculta uma tentativa que o operador não pode retomar (%o)", (changes) => {
    expect(pendingSupportReply([{ ...attempt, ...changes }], "operador")).toBeNull();
  });

  it("exige um usuário identificado", () => {
    expect(pendingSupportReply([attempt], null)).toBeNull();
  });
});
