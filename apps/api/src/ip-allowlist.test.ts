import { describe, expect, it } from "vitest";

import { createIpAllowlistVerifier, extractClientIp, MERCADO_LIVRE_IPS } from "./ip-allowlist.js";

describe("extractClientIp", () => {
  it("devolve undefined quando o header está ausente", () => {
    expect(extractClientIp(undefined)).toBeUndefined();
    expect(extractClientIp(null)).toBeUndefined();
  });

  it("devolve undefined quando só há um IP na lista — não é o formato que o Cloud Run produz", () => {
    // Um único IP não passou pelo load balancer do Google do jeito esperado
    // (que sempre acrescenta pelo menos <client-ip>,<load-balancer-ip>).
    expect(extractClientIp("203.0.113.10")).toBeUndefined();
  });

  it("com exatamente dois IPs, o confiável é o primeiro (penúltimo da lista)", () => {
    expect(extractClientIp("54.88.218.97,169.254.1.1")).toBe("54.88.218.97");
  });

  it("com IPs forjados prepended pelo próprio cliente, ainda pega o penúltimo real", () => {
    // O cliente pode mandar qualquer coisa antes — o load balancer do Google
    // ACRESCENTA <client-ip>,<load-balancer-ip> no fim, sem verificar o que
    // veio antes.
    expect(extractClientIp("1.2.3.4, 5.6.7.8, 54.88.218.97,169.254.1.1")).toBe("54.88.218.97");
  });

  it("ignora espaços em volta de cada IP", () => {
    expect(extractClientIp("  54.88.218.97 ,  169.254.1.1  ")).toBe("54.88.218.97");
  });
});

describe("createIpAllowlistVerifier", () => {
  it("aceita um IP da allowlist oficial do Mercado Livre", () => {
    const verifier = createIpAllowlistVerifier();

    for (const ip of MERCADO_LIVRE_IPS) {
      expect(verifier.verify(`${ip},169.254.1.1`)).toEqual({ ok: true, ip });
    }
  });

  it("recusa um IP fora da allowlist", () => {
    const verifier = createIpAllowlistVerifier();

    const result = verifier.verify("203.0.113.10,169.254.1.1");

    expect(result.ok).toBe(false);
    expect(result.ip).toBe("203.0.113.10");
  });

  it("recusa quando não há X-Forwarded-For nenhum", () => {
    const verifier = createIpAllowlistVerifier();

    expect(verifier.verify(undefined)).toEqual({ ok: false, ip: undefined });
  });

  it("aceita uma allowlist customizada, para teste isolado da lista oficial", () => {
    const verifier = createIpAllowlistVerifier(["10.0.0.1"]);

    expect(verifier.verify("10.0.0.1,169.254.1.1").ok).toBe(true);
    expect(verifier.verify("54.88.218.97,169.254.1.1").ok).toBe(false);
  });
});
