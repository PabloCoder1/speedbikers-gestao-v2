import { describe, expect, it } from "vitest";

import { conversationHref, parseConversationCursor } from "./support-conversation";

const id = "12345678-1234-4123-8123-000000000001";
const occurredAt = "2026-11-12T19:30:00.123456+00:00";

describe("cursor da conversa", () => {
  it("preserva a precisão do banco e o retorno filtrado para a fila", () => {
    const back = "/atendimento?canal=QUESTION&status=ABERTO";
    const href = conversationHref(id, back, { direction: "antes", occurredAt, id });
    const url = new URL(href, "http://localhost");

    expect(url.hash).toBe("#conversa");
    expect(url.searchParams.get("volta")).toBe(back);
    expect(parseConversationCursor(url.searchParams.get("mensagens") ?? undefined)).toEqual({
      direction: "antes", occurredAt, id,
    });
  });

  it.each([
    { value: undefined },
    { value: [`antes|${occurredAt}|${id}`] },
    { value: `lado|${occurredAt}|${id}` },
    { value: `antes|2026-02-30T19:30:00Z|${id}` },
    { value: `antes|${occurredAt}|x)` },
    { value: `depois|${occurredAt},id.gt.x|${id}` },
  ])("ignora cursores malformados ($value)", ({ value }) => {
    expect(parseConversationCursor(value)).toBeNull();
  });
});
