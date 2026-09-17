import { MercadoLivreApiError } from "@sb/mercado-livre";
import type { MercadoLivreClient, RequestOptions } from "@sb/mercado-livre";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { createShipmentLogistics, shipmentSchema } from "./shipment-logistics.js";

/**
 * D-352 — a leitura do envio.
 *
 * O contrato medido em 2026-09-17 contra a API real (4 envios, gravados em
 * `scratchpad/d352/leitura-real/`): `GET /shipments/{id}` devolve um objeto
 * grande, do qual a V3 lê UM campo. Os testes fixam as duas coisas que
 * importam: o caminho chamado, e que nada do envio pode derrubar o job.
 */

const AGORA = new Date("2026-09-17T21:00:00.000Z");

function fakeClient(responder: (options: RequestOptions<unknown>) => unknown): {
  client: MercadoLivreClient;
  requests: RequestOptions<unknown>[];
} {
  const requests: RequestOptions<unknown>[] = [];

  const client = {
    request: (options: RequestOptions<unknown>) => {
      requests.push(options);

      const resposta = responder(options);

      return resposta instanceof Error ? Promise.reject(resposta) : Promise.resolve(resposta);
    },
  } as unknown as MercadoLivreClient;

  return { client, requests };
}

function leitor(responder: (options: RequestOptions<unknown>) => unknown, linhas: string[] = []) {
  const { client, requests } = fakeClient(responder);

  return {
    requests,
    linhas,
    logistics: createShipmentLogistics({
      mercadoLivre: client,
      accessToken: "token-de-teste",
      logger: createLogger({}, { sink: (line) => linhas.push(line) }),
      now: () => AGORA,
    }),
  };
}

describe("shipmentSchema", () => {
  it("le logistic_type e IGNORA o resto do envio — a resposta real tem dezenas de campos", () => {
    // Recorte do envio 48041052940, lido de verdade em 17/09.
    const real = {
      id: 48_041_052_940,
      logistic_type: "fulfillment",
      status: "ready_to_ship",
      substatus: "in_warehouse",
      mode: "me2",
      type: "forward",
      site_id: "MLB",
      order_id: 2_000_018_515_005_942,
      base_cost: 23.9,
      shipping_items: [{ id: "MLB1382501176", quantity: 1 }],
    };

    expect(shipmentSchema.parse(real)).toEqual({ logistic_type: "fulfillment" });
  });

  it("aceita cross_docking e qualquer outro valor — o vocabulario e do Mercado Livre", () => {
    expect(shipmentSchema.parse({ logistic_type: "cross_docking" }).logistic_type).toBe("cross_docking");
    expect(shipmentSchema.parse({ logistic_type: "logistica_nova" }).logistic_type).toBe("logistica_nova");
  });

  it("envio SEM logistic_type, e com ele nulo, passam — um campo ausente nao pode virar ZodError", () => {
    expect(shipmentSchema.parse({}).logistic_type).toBeUndefined();
    expect(shipmentSchema.parse({ logistic_type: null }).logistic_type).toBeNull();
  });
});

describe("createShipmentLogistics", () => {
  it("chama GET /shipments/{id} com o token da conta e devolve o valor cru", async () => {
    const { logistics, requests } = leitor(() => ({ logistic_type: "fulfillment" }));

    await expect(logistics.read(48_041_052_940, 2_000_018_515_005_942)).resolves.toEqual({
      logisticType: "fulfillment",
      capturedAt: AGORA,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "GET",
      path: "/shipments/48041052940",
      accessToken: "token-de-teste",
    });
  });

  it("envio sem logistic_type volta com valor NULO e captura carimbada — leu, e nao disse", async () => {
    const { logistics } = leitor(() => ({}));

    await expect(logistics.read(1, 2)).resolves.toEqual({ logisticType: null, capturedAt: AGORA });
  });

  it("falha do Mercado Livre volta NULO e registra — nunca lanca, nunca derruba o job", async () => {
    const linhas: string[] = [];
    const { logistics } = leitor(
      () =>
        new MercadoLivreApiError("500 no envio", {
          status: 500,
          errorClass: "retryable",
          url: "https://api.mercadolibre.com/shipments/48041052940",
        }),
      linhas,
    );

    await expect(logistics.read(48_041_052_940, 2_000_018_515_005_942)).resolves.toBeNull();
    expect(linhas.join("\n")).toContain("order_logistic_leitura_falhou");
    expect(linhas.join("\n")).toContain("2000018515005942");
  });

  it("resposta fora do contrato tambem volta NULO — o pedido fica pendente, nao quebrado", async () => {
    const { logistics } = leitor(() => new Error("ZodError: logistic_type esperava string"));

    await expect(logistics.read(1, 2)).resolves.toBeNull();
  });

  it("`now` e o MESMO relogio que a captura carimba", () => {
    const { logistics } = leitor(() => ({}));

    expect(logistics.now()).toEqual(AGORA);
  });
});
