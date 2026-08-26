import { describe, expect, it } from "vitest";

import { createIpAllowlistVerifier, extractClientIp, MERCADO_LIVRE_IPS } from "./ip-allowlist.js";

describe("extractClientIp", () => {
  it("devolve undefined quando o header está ausente", () => {
    expect(extractClientIp(undefined)).toBeUndefined();
    expect(extractClientIp(null)).toBeUndefined();
  });

  it("UM IP só é o caso NORMAL do Cloud Run, e é o IP do cliente (D-093)", () => {
    // Medido em produção: cliente que não manda o header recebe
    // `X-Forwarded-For: <ip-do-cliente>`, uma entrada só. A versão anterior
    // tratava isso como "não deu para ler" e devolvia undefined — o que
    // rejeitava TODA notificação legítima do Mercado Livre.
    expect(extractClientIp("203.0.113.10")).toBe("203.0.113.10");
  });

  it("o IP confiável é o ÚLTIMO: é o que o Cloud Run acrescenta (D-093)", () => {
    expect(extractClientIp("54.88.218.97,203.0.113.10")).toBe("203.0.113.10");
  });

  it("REGRESSÃO DE SEGURANÇA: header forjado pelo cliente não vira o IP confiável", () => {
    // Medido em produção em 2026-08-26: enviar
    // `X-Forwarded-For: 54.88.218.97` (IP real da allowlist do Mercado Livre)
    // fazia o Cloud Run entregar `54.88.218.97,<ip-real-do-cliente>`. Lendo o
    // PENÚLTIMO, a allowlist aceitava o valor FORJADO — e aceitou mesmo, com
    // status 200. O último elemento é o único que o cliente não controla.
    expect(extractClientIp("54.88.218.97,203.0.113.10")).not.toBe("54.88.218.97");
    expect(extractClientIp("1.2.3.4, 5.6.7.8, 54.88.218.97,203.0.113.10")).toBe("203.0.113.10");
  });

  it("ignora espaços em volta de cada IP", () => {
    expect(extractClientIp("  54.88.218.97 ,  203.0.113.10  ")).toBe("203.0.113.10");
  });
});

describe("createIpAllowlistVerifier", () => {
  it("REGRESSÃO DE SEGURANÇA: não dá para entrar forjando um IP da allowlist", () => {
    const verifier = createIpAllowlistVerifier();

    // O que um atacante manda; o Cloud Run acrescenta o IP real dele no fim.
    const result = verifier.verify("54.88.218.97,203.0.113.10");

    expect(result.ok).toBe(false);
    expect(result.ip).toBe("203.0.113.10");
  });

  it("aceita um IP da allowlist oficial do Mercado Livre", () => {
    const verifier = createIpAllowlistVerifier();

    for (const ip of MERCADO_LIVRE_IPS) {
      // Uma entrada só: o formato real que o Cloud Run entrega quando o
      // Mercado Livre não manda o header (D-093).
      expect(verifier.verify(ip)).toEqual({ ok: true, ip });
    }
  });

  it("recusa um IP fora da allowlist", () => {
    const verifier = createIpAllowlistVerifier();

    const result = verifier.verify("203.0.113.10");

    expect(result.ok).toBe(false);
    expect(result.ip).toBe("203.0.113.10");
  });

  it("recusa quando não há X-Forwarded-For nenhum", () => {
    const verifier = createIpAllowlistVerifier();

    expect(verifier.verify(undefined)).toEqual({ ok: false, ip: undefined });
  });

  it("aceita uma allowlist customizada, para teste isolado da lista oficial", () => {
    const verifier = createIpAllowlistVerifier(["10.0.0.1"]);

    expect(verifier.verify("10.0.0.1").ok).toBe(true);
    expect(verifier.verify("54.88.218.97,169.254.1.1").ok).toBe(false);
  });
});
