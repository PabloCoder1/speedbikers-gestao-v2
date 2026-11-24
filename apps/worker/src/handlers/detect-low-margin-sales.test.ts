import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import type { EmailMessage, EmailSender } from "../margin-alert-email.js";
import { composeMarginAlertEmail } from "../margin-alert-email.js";
import type { MarginAlertStore, PendingAlert } from "./detect-low-margin-sales.js";
import { MAX_EMAIL_ATTEMPTS, createDetectLowMarginSalesHandler } from "./detect-low-margin-sales.js";

const ORG = "11111111-0000-4000-8000-000000000858";
const envelope = { jobId: "j1" } as never;
const AGORA = new Date("2026-11-23T15:00:00.000Z");

function alerta(over: Partial<PendingAlert> = {}): PendingAlert {
  return {
    id: "a1",
    marketplace: "MERCADO_LIVRE",
    order_ref: "2000012345",
    sku_id: "s1",
    sku: "NAV-001",
    title: "Manete Navetec",
    brand: "NAVETEC",
    imported: true,
    quantity: 1,
    sold_at: "2026-11-23T13:10:00.000Z",
    sale_value: 100,
    net_received: 90,
    product_cost: 60,
    margin: 0.3,
    min_margin: 0.4,
    cost_is_current: false,
    conta: "Speed Bikers",
    email_attempts: 0,
    ...over,
  };
}

interface Registro {
  expiradoAntes: Date | null;
  enviados: string[][];
  pulados: { ids: string[]; motivo: string }[];
  falhas: { id: string; final: boolean }[];
}

function fakeStore(
  options: { pendentes?: PendingAlert[]; destinatarios?: string[]; detectErro?: string; resumo?: unknown } = {},
): { store: MarginAlertStore; registro: Registro } {
  const registro: Registro = { expiradoAntes: null, enviados: [], pulados: [], falhas: [] };
  const store: MarginAlertStore = {
    detect: () =>
      Promise.resolve(
        options.detectErro === undefined
          ? { data: options.resumo ?? { ativo: true, novos: 1, notificadas: 1, julgados: { mercado_livre: 3, shopee: 1 } }, error: null }
          : { data: null, error: options.detectErro },
      ),
    expirePending: (_org, before) => {
      registro.expiradoAntes = before;

      return Promise.resolve(null);
    },
    listPending: () => Promise.resolve({ data: options.pendentes ?? [alerta()], error: null }),
    recipients: () => Promise.resolve({ data: options.destinatarios ?? ["dono@exemplo.com", "loja@exemplo.com"], error: null }),
    markSent: (ids) => {
      registro.enviados.push(ids);

      return Promise.resolve(null);
    },
    markSkipped: (ids, motivo) => {
      registro.pulados.push({ ids, motivo });

      return Promise.resolve(null);
    },
    markAttemptFailed: (a, _motivo, final) => {
      registro.falhas.push({ id: a.id, final });

      return Promise.resolve(null);
    },
  };

  return { store, registro };
}

function fakeEmail(falha?: string): { sender: EmailSender; mensagens: EmailMessage[] } {
  const mensagens: EmailMessage[] = [];

  return {
    mensagens,
    sender: {
      send: (m) => {
        if (falha !== undefined) return Promise.reject(new Error(falha));
        mensagens.push(m);

        return Promise.resolve();
      },
    },
  };
}

async function run(store: MarginAlertStore, email: EmailSender | null, payload: unknown = { organizationId: ORG }) {
  const linhas: string[] = [];
  const logger = createLogger({}, { sink: (linha) => linhas.push(linha) });
  const outcome = await createDetectLowMarginSalesHandler({ store, email, appUrl: "https://gestao.exemplo.com/", now: () => AGORA })(envelope, {
    payload,
    logger,
  });

  return { outcome, linhas };
}

describe("detect-low-margin-sales (D-858)", () => {
  it("julga, manda UM e-mail com as vendas novas e marca como enviado", async () => {
    const { store, registro } = fakeStore({ pendentes: [alerta(), alerta({ id: "a2", order_ref: "2000012346" })] });
    const { sender, mensagens } = fakeEmail();

    const { outcome } = await run(store, sender);

    expect(outcome).toEqual({ status: "done", processed: 1 });
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]?.to).toEqual(["dono@exemplo.com", "loja@exemplo.com"]);
    expect(mensagens[0]?.subject).toBe("2 vendas abaixo da margem");
    expect(registro.enviados).toEqual([["a1", "a2"]]);
    // Pendente há mais de 48 h expira.
    expect(registro.expiradoAntes?.toISOString()).toBe("2026-11-21T15:00:00.000Z");
  });

  it("sem destinatário cadastrado, o e-mail é pulado e o alerta segue no sino", async () => {
    const { store, registro } = fakeStore({ destinatarios: [] });
    const { sender, mensagens } = fakeEmail();

    const { outcome } = await run(store, sender);

    expect(outcome.status).toBe("done");
    expect(mensagens).toHaveLength(0);
    expect(registro.pulados).toEqual([{ ids: ["a1"], motivo: "sem destinatário cadastrado" }]);
  });

  it("sem SMTP configurado, o e-mail fica pendente e o job não falha", async () => {
    const { store, registro } = fakeStore();

    const { outcome, linhas } = await run(store, null);

    expect(outcome.status).toBe("done");
    expect(registro.enviados).toHaveLength(0);
    expect(registro.pulados).toHaveLength(0);
    expect(linhas.join("\n")).toContain("low_margin_email_not_configured");
  });

  it("SMTP falhando: conta a tentativa, desiste na quinta e devolve falha repetível", async () => {
    const { store, registro } = fakeStore({ pendentes: [alerta(), alerta({ id: "a2", email_attempts: MAX_EMAIL_ATTEMPTS - 1 })] });
    const { sender } = fakeEmail("535 senha recusada");

    const { outcome } = await run(store, sender);

    expect(outcome).toEqual({ status: "failed", retryable: true, reason: "envio do e-mail: 535 senha recusada" });
    expect(registro.falhas).toEqual([
      { id: "a1", final: false },
      { id: "a2", final: true },
    ]);
    expect(registro.enviados).toHaveLength(0);
  });

  it("nada pendente: não manda e-mail", async () => {
    const { store } = fakeStore({ pendentes: [], resumo: { ativo: false, novos: 0, notificadas: 0 } });
    const { sender, mensagens } = fakeEmail();

    const { outcome } = await run(store, sender);

    expect(outcome).toEqual({ status: "done", processed: 0 });
    expect(mensagens).toHaveLength(0);
  });

  it("o banco falhando no julgamento devolve falha repetível; payload sem organização, definitiva", async () => {
    const { store } = fakeStore({ detectErro: "canceling statement due to statement timeout" });

    expect((await run(store, null)).outcome).toEqual({
      status: "failed",
      retryable: true,
      reason: "detectar_vendas_abaixo_da_margem: canceling statement due to statement timeout",
    });
    expect((await run(fakeStore().store, null, {})).outcome).toEqual({ status: "failed", retryable: false, reason: "payload sem organizationId" });
  });

  it("resposta fora do contrato não é repetida", async () => {
    const { store } = fakeStore({ resumo: { qualquer: true } });

    expect((await run(store, null)).outcome).toEqual({
      status: "failed",
      retryable: false,
      reason: "detectar_vendas_abaixo_da_margem fora do contrato",
    });
  });
});

describe("composeMarginAlertEmail (D-858)", () => {
  it("uma venda: o assunto diz o produto, a margem e a meta", () => {
    const m = composeMarginAlertEmail([alerta()], { to: ["x@exemplo.com"], appUrl: "https://gestao.exemplo.com/" });

    expect(m.subject).toBe("Venda abaixo da margem: NAV-001 com 30,0% (meta 40%)");
    expect(m.text).toContain("Margem 30,0% (meta 40%, marca importada)");
    expect(m.text).toContain("Mercado Livre · Speed Bikers · pedido 2000012345 · 23/11/2026, 10:10");
    expect(m.text).toMatch(/Venda R\$\s100,00 · recebido R\$\s90,00 · custo R\$\s60,00/);
    expect(m.text).toContain("Ver no sistema: https://gestao.exemplo.com/notificacoes");
    expect(m.html).toContain('href="https://gestao.exemplo.com/skus/s1"');
  });

  it("escapa o título no HTML e avisa quando o custo é o do cadastro", () => {
    const m = composeMarginAlertEmail([alerta({ title: "Baú <Off Racer> & cia", cost_is_current: true, marketplace: "SHOPEE", imported: false, min_margin: 0.3 })], {
      to: ["x@exemplo.com"],
    });

    expect(m.html).toContain("Baú &lt;Off Racer&gt; &amp; cia");
    expect(m.html).not.toContain("<Off Racer>");
    expect(m.text).toContain("(custo do cadastro atual)");
    expect(m.text).toContain("Shopee");
    expect(m.text).toContain("(meta 30%)");
    expect(m.text).not.toContain("Ver no sistema");
  });
});
