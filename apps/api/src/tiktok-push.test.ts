import { parseTikTokJobPayload } from "@sb/contracts";
import { createLogger } from "@sb/observability";
import { signWebhook } from "@sb/tiktok-shop";
import { describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import type { EnqueueRequest } from "./enqueue.js";
import { TIKTOK_PUSH_WINDOW_S, type TikTokPushDeps } from "./tiktok-push.js";

const APP_KEY = "68xu9ks5p4i8";
const APP_SECRET = "segredo-tiktok-push-teste";
const LOJA = { id: "bbbbbbbb-0000-4000-8000-0000000000b1", organization_id: "org-1", status: "CONNECTED" };
// 24/11/2026 às 12:02:10 UTC: a janela de 5 minutos fecha às 12:05:00.
const NOW = new Date("2026-11-24T12:02:10.000Z");
const FIM_DA_JANELA = Math.floor(new Date("2026-11-24T12:05:00.000Z").getTime() / 1000);

const PEDIDO = JSON.stringify({
  type: 1,
  tts_notification_id: "7327112393057371910",
  shop_id: "7494049642642441621",
  timestamp: 1700000000,
  data: {
    order_id: "576461413038785752",
    order_status: "AWAITING_SHIPMENT",
    is_on_hold_order: false,
    update_time: 1700000001,
  },
});

const DEVOLUCAO = JSON.stringify({
  type: 12,
  tts_notification_id: "7327112393057371911",
  shop_id: "7494049642642441621",
  timestamp: 1700000100,
  data: {
    return_id: "ret-1",
    order_id: "576461413038785752",
    return_status: "RETURN_OR_REFUND_REQUEST_PENDING",
    update_time: 1700000101,
  },
});

const DESAUTORIZACAO = JSON.stringify({
  type: 6,
  tts_notification_id: "7327112393057371912",
  shop_id: "7494049642642441621",
  timestamp: 1700000200,
  data: {},
});

function cenario(
  opcoes: {
    loja?: typeof LOJA | null;
    falhaNaLoja?: boolean;
    falhaAoEnfileirar?: boolean;
    semEnqueuer?: boolean;
    deduplica?: boolean;
  } = {},
) {
  const enfileirados: EnqueueRequest[] = [];
  const filtros: [string, unknown][] = [];
  const logs: { severity: string; message: string; [key: string]: unknown }[] = [];
  const consulta = {
    select: () => consulta,
    eq: (coluna: string, valor: unknown) => {
      filtros.push([coluna, valor]);

      return consulta;
    },
    maybeSingle: () =>
      Promise.resolve(
        opcoes.falhaNaLoja === true
          ? { data: null, error: { message: "db timeout" } }
          : { data: opcoes.loja === undefined ? LOJA : opcoes.loja, error: null },
      ),
  };
  const enqueuer: TikTokPushDeps["enqueuer"] = {
    enqueue: (request) => {
      if (opcoes.falhaAoEnfileirar === true) return Promise.reject(new Error("Cloud Tasks indisponível"));

      enfileirados.push(request);

      return Promise.resolve({ taskName: "t", envelope: {} as never, deduplicated: opcoes.deduplica === true });
    },
  };
  const deps: TikTokPushDeps = {
    db: { from: () => consulta } as unknown as TikTokPushDeps["db"],
    ...(opcoes.semEnqueuer === true ? {} : { enqueuer }),
    logger: createLogger({}, { sink: (linha) => logs.push(JSON.parse(linha) as { severity: string; message: string }) }),
    appKey: APP_KEY,
    appSecret: APP_SECRET,
    now: () => NOW,
  };
  const app = createApp({ logger: createLogger({}, { sink: () => undefined }), tiktokPush: deps });
  const enviar = (corpo: string, assinatura: string | null = signWebhook(APP_SECRET, APP_KEY, corpo)) =>
    app.request("/push/tiktok-shop", {
      method: "POST",
      body: corpo,
      headers:
        assinatura === null
          ? { "content-type": "application/json" }
          : { "content-type": "application/json", authorization: assinatura },
    });

  return { enviar, enfileirados, filtros, logs };
}

describe("POST /push/tiktok-shop (D-808)", () => {
  it("sem configuração do TikTok Shop devolve 503 not_configured", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }) });
    const res = await app.request("/push/tiktok-shop", { method: "POST", body: PEDIDO });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "not_configured" } });
  });

  it("assinatura ausente, Bearer ou adulterada devolve 401 sem consultar banco nem enfileirar", async () => {
    const { enviar, enfileirados, filtros, logs } = cenario();
    const valida = signWebhook(APP_SECRET, APP_KEY, PEDIDO);

    for (const resposta of [
      await enviar(PEDIDO, null),
      await enviar(PEDIDO, `Bearer ${valida}`),
      await enviar(`${PEDIDO} `, valida),
      await enviar(PEDIDO, "0".repeat(64)),
    ]) {
      expect(resposta.status).toBe(401);
    }

    expect(filtros).toEqual([]);
    expect(enfileirados).toEqual([]);
    expect(logs.some((entry) => entry.message === "tiktok_push_rejected")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(APP_SECRET);
    expect(JSON.stringify(logs)).not.toContain(valida);
  });

  it("pedido (tipo 1) e devolução (tipo 12) enfileiram com janela de 5 min e respondem 200 vazio", async () => {
    const { enviar, enfileirados, filtros } = cenario();
    const resPedido = await enviar(PEDIDO);
    const resDevolucao = await enviar(DEVOLUCAO);

    expect(resPedido.status).toBe(200);
    expect(await resPedido.text()).toBe("");
    expect(resDevolucao.status).toBe(200);
    expect(TIKTOK_PUSH_WINDOW_S).toBe(300);
    expect(filtros).toEqual([
      ["shop_id", "7494049642642441621"],
      ["shop_id", "7494049642642441621"],
    ]);
    expect(enfileirados).toEqual([
      {
        jobType: "tiktok.orders.sync",
        organizationId: "org-1",
        dedupeKey: `tiktok-orders-push:${LOJA.id}:${String(FIM_DA_JANELA)}`,
        queue: "backfill",
        payload: { tiktokShopId: LOJA.id, notificationId: "7327112393057371910" },
        delaySeconds: FIM_DA_JANELA - Math.floor(NOW.getTime() / 1000),
      },
      {
        jobType: "tiktok.returns.sync",
        organizationId: "org-1",
        dedupeKey: `tiktok-returns-push:${LOJA.id}:${String(FIM_DA_JANELA)}`,
        queue: "backfill",
        payload: { tiktokShopId: LOJA.id, notificationId: "7327112393057371911" },
        delaySeconds: FIM_DA_JANELA - Math.floor(NOW.getTime() / 1000),
      },
    ]);
    for (const item of enfileirados) {
      expect(parseTikTokJobPayload(item.jobType, item.payload).success).toBe(true);
    }
  });

  it("sem enqueuer ligado (modo observação pré-worker), valida loja, registra log e responde 200", async () => {
    const { enviar, enfileirados, logs } = cenario({ semEnqueuer: true });
    const res = await enviar(PEDIDO);

    expect(res.status).toBe(200);
    expect(enfileirados).toEqual([]);
    expect(logs.some((entry) => entry.message === "tiktok_push_acknowledged")).toBe(true);
  });

  it("desautorização (tipo 6), loja desconectada e JSON assinado malformado respondem 200 sem enfileirar", async () => {
    const c1 = cenario();

    expect((await c1.enviar(DESAUTORIZACAO)).status).toBe(200);
    expect(c1.enfileirados).toEqual([]);
    expect(c1.logs.some((entry) => entry.message === "tiktok_push_authorization_event")).toBe(true);

    const c2 = cenario({ loja: { ...LOJA, status: "ERROR" } });

    expect((await c2.enviar(PEDIDO)).status).toBe(200);
    expect(c2.enfileirados).toEqual([]);

    const c3 = cenario();

    expect((await c3.enviar("{json-quebrado")).status).toBe(200);
    expect(c3.enfileirados).toEqual([]);
  });

  it("falha transitória no banco ou no enqueue responde 503 para retentativa do TikTok Shop", async () => {
    const falhaDb = cenario({ falhaNaLoja: true });

    expect((await falhaDb.enviar(PEDIDO)).status).toBe(503);

    const falhaFila = cenario({ falhaAoEnfileirar: true });

    expect((await falhaFila.enviar(PEDIDO)).status).toBe(503);
  });

  it("somente POST /push/tiktok-shop é aceito; GET e rotas vizinhas respondem 404 (docs/API.md)", async () => {
    const app = createApp({ logger: createLogger({}, { sink: () => undefined }) });

    expect((await app.request("/push/tiktok-shop", { method: "GET" })).status).toBe(404);
    expect((await app.request("/push/tiktok-shop/extra", { method: "POST" })).status).toBe(404);
    expect((await app.request("/push/tiktok-shops", { method: "POST" })).status).toBe(404);
  });
});
