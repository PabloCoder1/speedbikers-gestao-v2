import { createMercadoLivreClient, encryptToken, loadEncryptionKey } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it, vi } from "vitest";

import type { Caller } from "./auth.js";
import { quoteMlShipping, type PricingQuoteDeps, type PricingQuoteRequest } from "./pricing-quote.js";

const ORG = "11111111-0000-4000-8000-000000000001";
const CONTA = "aaaaaaaa-0000-4000-8000-000000000001";
const AGORA = new Date("2026-09-16T12:00:00.000Z");
const CHAVE = loadEncryptionKey(Buffer.alloc(32, 7).toString("base64"));

const ADMIN: Caller = { userId: "u-admin", organizationId: ORG, role: "ADMIN" };
const OPERADOR: Caller = { userId: "u-op", organizationId: ORG, role: "OPERADOR" };

const PEDIDO: PricingQuoteRequest = {
  mlAccountId: CONTA,
  alturaCm: 10,
  larguraCm: 15,
  comprimentoCm: 20,
  pesoG: 500,
  preco: 120,
  tipoAnuncio: "premium",
  logistica: "cross_docking",
};

interface Cenario {
  contaOrg?: string;
  status?: string;
  sellerId?: number | null;
  temPermissao?: boolean;
  expiraEm?: Date;
}

function banco(c: Cenario = {}): PricingQuoteDeps["db"] {
  const linhas: Record<string, unknown> = {
    ml_accounts: {
      id: CONTA,
      organization_id: c.contaOrg ?? ORG,
      seller_id: c.sellerId === undefined ? 244878077 : c.sellerId,
      status: c.status ?? "CONNECTED",
    },
    user_account_permissions: c.temPermissao === true ? { user_id: "u-op" } : null,
    ml_credentials: {
      access_token_ciphertext: encryptToken("APP_USR-token", CHAVE),
      access_token_expires_at: (c.expiraEm ?? new Date(AGORA.getTime() + 3 * 3_600_000)).toISOString(),
    },
  };

  return {
    from: (tabela: string) => {
      const terminal = {
        eq: () => terminal,
        maybeSingle: () => Promise.resolve({ data: linhas[tabela] ?? null, error: null }),
      };

      return { select: () => terminal };
    },
  } as unknown as PricingQuoteDeps["db"];
}

function deps(c: Cenario = {}, fetchImpl?: typeof fetch): PricingQuoteDeps & { chamadas: URL[] } {
  const chamadas: URL[] = [];
  const impl =
    fetchImpl ??
    (vi.fn((url: string | URL | Request) => {
      const alvo = new URL(url as string | URL);
      chamadas.push(alvo);

      // Cada rota com a sua resposta: a cotação de frete e a tarifa fixa (D-421).
      const corpo = alvo.pathname.endsWith("/listing_prices")
        ? [{ sale_fee_details: { fixed_fee: alvo.searchParams.get("logistic_type") === "self_service" ? 7.75 : 0 } }]
        : { coverage: { all_country: { list_cost: 23.45, currency_id: "BRL", billable_weight: 620 } } };

      return Promise.resolve(new Response(JSON.stringify(corpo), { status: 200 }));
    }));

  return {
    db: banco(c),
    logger: createLogger({ service: "api-test" }),
    encryptionKey: CHAVE,
    client: createMercadoLivreClient({ fetchImpl: impl, maxAttempts: 1, sleep: () => Promise.resolve() }),
    now: () => AGORA,
    chamadas,
  };
}

describe("quoteMlShipping", () => {
  it("cota com o seller da conta e o tipo de anúncio convertido para o listing_type do ML", async () => {
    const d = deps();
    const resultado = await quoteMlShipping(d, ADMIN, PEDIDO);

    expect(resultado).toMatchObject({ status: "ok", cotacao: { custoVendedor: 23.45 }, tarifaFixa: 0, freteGratis: true });
    expect(d.chamadas[0]?.pathname).toBe("/users/244878077/shipping_options/free");
    expect(d.chamadas[0]?.searchParams.get("listing_type_id")).toBe("gold_pro");
  });

  it("conta de outra organização é 'não encontrada', sem chamar o ML", async () => {
    const d = deps({ contaOrg: "22222222-0000-4000-8000-000000000002" });

    await expect(quoteMlShipping(d, ADMIN, PEDIDO)).resolves.toEqual({ status: "not_found" });
    expect(d.chamadas).toHaveLength(0);
  });

  it("quem não é ADMIN precisa de permissão na conta", async () => {
    await expect(quoteMlShipping(deps(), OPERADOR, PEDIDO)).resolves.toEqual({ status: "not_found" });
    await expect(quoteMlShipping(deps({ temPermissao: true }), OPERADOR, PEDIDO)).resolves.toMatchObject({ status: "ok" });
  });

  it("conta desconectada não cota", async () => {
    await expect(quoteMlShipping(deps({ status: "ERROR" }), ADMIN, PEDIDO)).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("token perto de vencer: NÃO renova (o refresh é de uso único e é do worker) e pede nova tentativa", async () => {
    const d = deps({ expiraEm: new Date(AGORA.getTime() + 60_000) });

    await expect(quoteMlShipping(d, ADMIN, PEDIDO)).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("renovado") as unknown,
    });
    expect(d.chamadas).toHaveLength(0);
  });

  it("recusa do ML vira 'indisponível' com o HTTP, nunca frete zero", async () => {
    const recusa = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ message: "bad" }), { status: 400 })),
    ) as unknown as typeof fetch;

    await expect(quoteMlShipping(deps({}, recusa), ADMIN, PEDIDO)).resolves.toMatchObject({
      status: "unavailable",
      reason: expect.stringContaining("HTTP 400") as unknown,
    });
  });
});

describe("quoteMlShipping — frete grátis e tarifa fixa (D-421)", () => {
  const frete = (d: { chamadas: URL[] }) => d.chamadas.find((u) => u.pathname.endsWith("/shipping_options/free"));
  const tarifa = (d: { chamadas: URL[] }) => d.chamadas.find((u) => u.pathname.endsWith("/listing_prices"));

  it("abaixo de R$ 79 sem frete grátis: cota com free_shipping=false", async () => {
    const d = deps();
    const r = await quoteMlShipping(d, ADMIN, { ...PEDIDO, preco: 50, ofereceFreteGratis: false });

    expect(r).toMatchObject({ status: "ok", freteGratis: false });
    expect(frete(d)?.searchParams.get("free_shipping")).toBe("false");
  });

  it("pedido antigo, sem o campo: abaixo de R$ 79 vale 'não oferece'", async () => {
    const d = deps();

    await expect(quoteMlShipping(d, ADMIN, { ...PEDIDO, preco: 50 })).resolves.toMatchObject({ freteGratis: false });
  });

  it("abaixo de R$ 79 oferecendo: free_shipping=true", async () => {
    const d = deps();

    await quoteMlShipping(d, ADMIN, { ...PEDIDO, preco: 50, ofereceFreteGratis: true });
    expect(frete(d)?.searchParams.get("free_shipping")).toBe("true");
  });

  it("a partir de R$ 79 o frete grátis é obrigatório, mesmo pedindo que não", async () => {
    const d = deps();
    const r = await quoteMlShipping(d, ADMIN, { ...PEDIDO, preco: 79, ofereceFreteGratis: false });

    expect(r).toMatchObject({ freteGratis: true });
    expect(frete(d)?.searchParams.get("free_shipping")).toBe("true");
  });

  it("a tarifa fixa vem de listing_prices, com a logística e o peso FATURÁVEL da cotação", async () => {
    const d = deps();
    const r = await quoteMlShipping(d, ADMIN, { ...PEDIDO, preco: 50, logistica: "self_service" });

    expect(r).toMatchObject({ status: "ok", tarifaFixa: 7.75 });
    expect(tarifa(d)?.searchParams.get("logistic_type")).toBe("self_service");
    expect(tarifa(d)?.searchParams.get("billable_weight")).toBe("620");
    expect(tarifa(d)?.searchParams.get("listing_type_id")).toBe("gold_pro");
  });
});
