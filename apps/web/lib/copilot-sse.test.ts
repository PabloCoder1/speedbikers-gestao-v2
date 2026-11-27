import { describe, expect, it } from "vitest";

import { extrairEventosSse } from "./copilot-sse";

describe("extrairEventosSse (D-745)", () => {
  it("consome chunks incrementais e preserva evento partido entre pacotes", () => {
    const parte1 = extrairEventosSse('data: {"type":"text","delta":"Olá"}\n\ndata: {"type":"te');

    expect(parte1.events).toEqual([{ type: "text", delta: "Olá" }]);
    expect(parte1.rest).toBe('data: {"type":"te');

    const parte2 = extrairEventosSse(`${parte1.rest}xt","delta":" mundo"}\n\n`);

    expect(parte2.events).toEqual([{ type: "text", delta: " mundo" }]);
    expect(parte2.rest).toBe("");
  });

  it("no flush final (EOF), consome o último evento mesmo sem linha em branco final", () => {
    const streaming = extrairEventosSse('data: {"type":"text","delta":"fim"}\n\ndata: {"type":"done","toolsUsed":["sales_summary"]}');

    expect(streaming.events).toEqual([{ type: "text", delta: "fim" }]);
    expect(streaming.rest).toBe('data: {"type":"done","toolsUsed":["sales_summary"]}');

    const flushed = extrairEventosSse(streaming.rest, true);

    expect(flushed.events).toEqual([{ type: "done", toolsUsed: ["sales_summary"] }]);
    expect(flushed.rest).toBe("");
  });

  it("aceita separadores CRLF de proxies HTTP/1.1 e ignora JSON inválido", () => {
    const res = extrairEventosSse(
      'data: {quebrado}\r\n\r\ndata: {"type":"tool","name":"sales_summary"}\r\n\r\ndata: {"type":"error","message":"limite"}\r\n\r\n',
    );

    expect(res.events).toEqual([
      { type: "tool", name: "sales_summary" },
      { type: "error", message: "limite" },
    ]);
    expect(res.rest).toBe("");
  });
});
