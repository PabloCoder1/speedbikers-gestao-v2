import { createLogger } from "@sb/observability";
import { signPush } from "@sb/shopee";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { EnqueueRequest } from "./enqueue.js";
import type { ShopeePushDeps } from "./shopee-push.js";
import { PUSH_JANELA_S } from "./shopee-push.js";

const CHAVE = "chave-de-teste-nao-real";
const URL_PUSH = "https://api.speedbikers.test/push/shopee";
const LOJA = { id: "aaaaaaaa-0000-4000-8000-0000000000a1", organization_id: "org-1", status: "CONNECTED" };
// 14/10/2026 às 15:02:10 UTC: a janela de 5 minutos fecha às 15:05:00.
const NOW = new Date("2026-10-14T15:02:10.000Z");
const FIM_DA_JANELA = Math.floor(new Date("2026-10-14T15:05:00.000Z").getTime() / 1000);

// O exemplo oficial do `order_status_push`.
const PEDIDO =
  '{"data":{"items":[],"ordersn":"220810QSK8S7BX","status":"PROCESSED","completed_scenario":"","update_time":1660123127},"shop_id":727720655,"code":3,"timestamp":1660123127}';
// O exemplo oficial do `return_updates_push`.
const DEVOLUCAO = JSON.stringify({
  data: {
    order_sn: "241128EDQ9YKJ0",
    return_sn: "2411280EDT4JRV5",
    updated_values: [{ update_field: "return_status", old_value: "JUDGING", new_value: "PROCESSING", update_time: 1732796767 }],
  },
  shop_id: 727720655,
  code: 29,
  timestamp: 1732796767,
});
// `shop_authorization_canceled_push`, um dos exemplos oficiais.
const CANCELADA = '{"data":{"authorize_type":"expiry","shopid":727720655,"success":1,"extra":"The authorization is expired."},"code":2,"partner_id":800000,"timestamp":1653026985}';

function cenario(opcoes: { loja?: typeof LOJA | null; falhaNaLoja?: boolean; falhaAoEnfileirar?: boolean; deduplica?: boolean } = {}) {
  const enfileirados: EnqueueRequest[] = [];
  const filtros: [string, unknown][] = [];
  const logs: { severity: string; message: string }[] = [];
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);

      return consulta;
    },
    maybeSingle: () =>
      Promise.resolve(
        opcoes.falhaNaLoja === true
          ? { data: null, error: { message: "boom" } }
          : { data: opcoes.loja === undefined ? LOJA : opcoes.loja, error: null },
      ),
  };
  const deps: ShopeePushDeps = {
    db: { from: () => consulta } as unknown as ShopeePushDeps["db"],
    enqueuer: {
      enqueue: (request) => {
        if (opcoes.falhaAoEnfileirar === true) return Promise.reject(new Error("Cloud Tasks fora"));

        enfileirados.push(request);

        return Promise.resolve({ taskName: "t", envelope: {} as never, deduplicated: opcoes.deduplica === true });
      },
    },
    logger: createLogger({}, { sink: (linha) => logs.push(JSON.parse(linha) as { severity: string; message: string }) }),
    environment: "sandbox",
    partnerKey: CHAVE,
    pushUrl: URL_PUSH,
    now: () => NOW,
  };
  const app = createApp({ logger: createLogger({}, { sink: () => undefined }), shopeePush: deps });
  const enviar = (corpo: string, assinatura: string | null = signPush(CHAVE, URL_PUSH, corpo)) =>
    app.request("/push/shopee", {
      method: "POST",
      body: corpo,
      headers: assinatura === null ? { "content-type": "application/json" } : { "content-type": "application/json", authorization: assinatura },
    });

  return { enviar, enfileirados, filtros, logs };
}

describe("POST /push/shopee (D-453)", () => {
  it("pedido mudou: antecipa os pedidos da loja para o fim da janela de 5 minutos e responde 200 de corpo vazio", async () => {
    const { enviar, enfileirados, filtros } = cenario();
    const resposta = await enviar(PEDIDO);

    expect(resposta.status).toBe(200);
    expect(await resposta.text()).toBe("");
    expect(filtros).toEqual([
      ["environment", "sandbox"],
      ["shop_id", 727720655],
    ]);
    expect(enfileirados).toEqual([
      {
        jobType: "shopee.orders.sync",
        organizationId: "org-1",
        dedupeKey: `shopee-orders-push:${LOJA.id}:${String(FIM_DA_JANELA)}`,
        queue: "backfill",
        payload: { shopeeShopId: LOJA.id },
        delaySeconds: FIM_DA_JANELA - Math.floor(NOW.getTime() / 1000),
      },
    ]);
    expect(PUSH_JANELA_S).toBe(300);
  });

  it("devolução mudou: antecipa as devoluções; o aviso repetido na mesma janela cai na mesma tarefa", async () => {
    const { enviar, enfileirados } = cenario({ deduplica: true });

    expect((await enviar(DEVOLUCAO)).status).toBe(200);
    expect((await enviar(DEVOLUCAO)).status).toBe(200);
    expect(enfileirados.map((e) => [e.jobType, e.dedupeKey])).toEqual([
      ["shopee.returns.sync", `shopee-returns-push:${LOJA.id}:${String(FIM_DA_JANELA)}`],
      ["shopee.returns.sync", `shopee-returns-push:${LOJA.id}:${String(FIM_DA_JANELA)}`],
    ]);
  });

  it("sem assinatura válida: 200, mas nada acontece", async () => {
    const { enviar, enfileirados, filtros } = cenario();

    for (const resposta of [
      await enviar(PEDIDO, null),
      await enviar(PEDIDO, signPush("outra-chave-de-teste-nao-real", URL_PUSH, PEDIDO)),
      // Assinada para outro endereço.
      await enviar(PEDIDO, signPush(CHAVE, "https://outro.test/push/shopee", PEDIDO)),
      // Corpo trocado depois de assinado.
      await enviar(PEDIDO.replace("PROCESSED", "CANCELLED"), signPush(CHAVE, URL_PUSH, PEDIDO)),
    ]) {
      expect(resposta.status).toBe(200);
      expect(await resposta.text()).toBe("");
    }

    expect(enfileirados).toEqual([]);
    expect(filtros).toEqual([]);
  });

  it("assinada com outra forma do endereço (barra no fim) ou com espaço no cabeçalho: aceita, com aviso da variação", async () => {
    const { enviar, enfileirados, logs } = cenario();

    expect((await enviar(PEDIDO, signPush(CHAVE, `${URL_PUSH}/`, PEDIDO))).status).toBe(200);
    expect((await enviar(PEDIDO, ` ${signPush(CHAVE, URL_PUSH, PEDIDO)} `)).status).toBe(200);
    expect(enfileirados).toHaveLength(2);
    expect(logs.filter((l) => l.message === "shopee_push_url_variant").map((l) => (l as unknown as { variante: string }).variante)).toEqual([
      "com_barra",
    ]);
  });

  it("a recusa diz o que chegou sem expor a assinatura: cabeçalho, formato, tamanho, chaves e código", async () => {
    const { enviar, logs } = cenario();

    await enviar(PEDIDO, null);
    await enviar(PEDIDO, "nao-e-hex");

    const recusas = logs.filter((l) => l.message === "shopee_push_signature_rejected") as unknown as Record<string, unknown>[];

    expect(recusas).toEqual([
      expect.objectContaining({
        assinatura_presente: false,
        assinatura_tamanho: 0,
        assinatura_formato: null,
        corpo_bytes: PEDIDO.length,
        corpo_chaves: ["data", "shop_id", "code", "timestamp"],
        code: 3,
      }),
      expect.objectContaining({ assinatura_presente: true, assinatura_tamanho: 9, assinatura_formato: "outro" }),
    ]);
    expect(JSON.stringify(recusas)).not.toContain("REDACTED");
    expect(JSON.stringify(recusas)).not.toContain("nao-e-hex");
  });

  it("loja desconhecida ou desconectada, push sem ação e autorização cancelada: 200 sem enfileirar", async () => {
    const desconhecida = cenario({ loja: null });
    const desconectada = cenario({ loja: { ...LOJA, status: "ERROR" } });
    const outros = cenario();

    expect((await desconhecida.enviar(PEDIDO)).status).toBe(200);
    expect((await desconectada.enviar(PEDIDO)).status).toBe(200);
    // `order_trackingno_push` (código 4): sem ação na V3.
    expect((await outros.enviar('{"data":{"ordersn":"X","tracking_no":"Y"},"shop_id":727720655,"code":4,"timestamp":1}')).status).toBe(200);
    expect((await outros.enviar(CANCELADA)).status).toBe(200);
    expect([...desconhecida.enfileirados, ...desconectada.enfileirados, ...outros.enfileirados]).toEqual([]);
    expect(outros.logs.some((l) => l.message === "shopee_push_authorization_canceled" && l.severity === "WARNING")).toBe(true);
  });

  it("falha passageira ao ler a loja ou enfileirar: 503, para a Shopee repetir; corpo inválido: 200", async () => {
    expect((await cenario({ falhaNaLoja: true }).enviar(PEDIDO)).status).toBe(503);
    expect((await cenario({ falhaAoEnfileirar: true }).enviar(PEDIDO)).status).toBe(503);
    expect((await cenario().enviar("não é json")).status).toBe(200);
    expect((await cenario().enviar('{"shop_id":727720655}')).status).toBe(200);
  });

  it("sem a Shopee configurada: 503; não passa pela allowlist de IP do Mercado Livre", async () => {
    const desligada = await createApp({ logger: createLogger({}, { sink: () => undefined }) }).request("/push/shopee", {
      method: "POST",
      body: PEDIDO,
    });

    expect(desligada.status).toBe(503);
    expect(await desligada.json()).toEqual({ error: { code: "not_configured" } });
    // Sem `ipAllowlist` nas dependências, qualquer rota de `/webhooks/*` daria 503:
    // o push respondeu 200 nos testes acima sem ela.
  });

  it("só o POST exato é público: GET e caminhos vizinhos dão 404", async () => {
    const { enviar } = cenario();
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }) });

    expect((await enviar(PEDIDO)).status).toBe(200);

    for (const [caminho, metodo] of [
      ["/push/shopee", "GET"],
      ["/push/shopee/x", "POST"],
      ["/push", "POST"],
      ["/push/mercado-livre", "POST"],
    ] as const) {
      expect((await app.request(caminho, { method: metodo, body: metodo === "POST" ? PEDIDO : null })).status).toBe(404);
    }
  });
});
