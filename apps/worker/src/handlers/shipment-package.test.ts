import type { AdminClient } from "@sb/db";
import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { gravarPacoteDoEnvio, lerMedidas, pacoteDoEnvio, type PacoteDoEnvio } from "./shipment-package.js";

/**
 * D-405 — as medidas do pacote. Os textos são os dos 4 envios reais de
 * 17/09/2026 (`d352/leitura-real/`).
 */
describe("lerMedidas", () => {
  it("os quatro envios reais: peso, volume e maior lado", () => {
    expect(lerMedidas("4.0x19.0x26.0,710.0")).toEqual({ pesoG: 710, volumeCm3: 1976, maiorLadoCm: 26 });
    expect(lerMedidas("12.0x16.0x18.0,1025.0")).toEqual({ pesoG: 1025, volumeCm3: 3456, maiorLadoCm: 18 });
    expect(lerMedidas("4.0x13.0x26.0,240.0")).toEqual({ pesoG: 240, volumeCm3: 1352, maiorLadoCm: 26 });
    expect(lerMedidas("4.0x6.0x59.0,160.0")).toEqual({ pesoG: 160, volumeCm3: 1416, maiorLadoCm: 59 });
  });

  it("inteiros e espaços também; zero, vazio e outra forma não são medida", () => {
    expect(lerMedidas("10x20x30,500")).toEqual({ pesoG: 500, volumeCm3: 6000, maiorLadoCm: 30 });
    expect(lerMedidas(" 10 x 20 x 30 , 500 ")).toEqual({ pesoG: 500, volumeCm3: 6000, maiorLadoCm: 30 });
    expect(lerMedidas("0x20x30,500")).toBeNull();
    expect(lerMedidas("10x20x30,0")).toBeNull();
    expect(lerMedidas("10x20,500")).toBeNull();
    expect(lerMedidas("")).toBeNull();
    expect(lerMedidas(null)).toBeNull();
    expect(lerMedidas(undefined)).toBeNull();
  });
});

describe("pacoteDoEnvio", () => {
  const ITEM_REAL = {
    item_ponderation: null,
    quantity: 1,
    measurable_picked_quantity: null,
    dimensions_source: { origin: "bmp", id: "MLB1382501176__1" },
    user_product_id: "MLBU4290374161",
    sender_id: 463_776_938,
    domain_id: null,
    id: "MLB1382501176",
    bundle: null,
    dimensions: "4.0x19.0x26.0,710.0",
  };

  it("um item: as medidas do anúncio, com quem mediu", () => {
    expect(pacoteDoEnvio([ITEM_REAL])).toEqual({
      itens: 1,
      itemId: "MLB1382501176",
      medidas: "4.0x19.0x26.0,710.0",
      pesoG: 710,
      volumeCm3: 1976,
      maiorLadoCm: 26,
      origem: "bmp",
    });
  });

  it("mais de um item: o pacote é de todos, e só a contagem vale", () => {
    expect(pacoteDoEnvio([ITEM_REAL, { ...ITEM_REAL, id: "MLB2" }])).toEqual({
      itens: 2,
      itemId: null,
      medidas: null,
      pesoG: null,
      volumeCm3: null,
      maiorLadoCm: null,
      origem: null,
    });
  });

  it("item sem medida legível: o item fica, a medida fica nula", () => {
    expect(pacoteDoEnvio([{ ...ITEM_REAL, dimensions: null, dimensions_source: null }])).toMatchObject({
      itens: 1,
      itemId: "MLB1382501176",
      medidas: null,
      pesoG: null,
      origem: null,
    });
  });

  it("forma desconhecida ou ausente: nulo, nunca erro", () => {
    for (const bruto of [undefined, null, "texto", {}, [], [{ id: 7 }], 42]) {
      expect(pacoteDoEnvio(bruto)).toBeNull();
    }
  });
});

describe("gravarPacoteDoEnvio", () => {
  const PACOTE: PacoteDoEnvio = {
    itens: 1,
    itemId: "MLB1382501176",
    medidas: "4.0x19.0x26.0,710.0",
    pesoG: 710,
    volumeCm3: 1976,
    maiorLadoCm: 26,
    origem: "bmp",
  };
  const CONTEXTO = { organizationId: "org-1", mlAccountId: "conta-1" };
  const AGORA = new Date("2026-09-24T12:00:00.000Z");

  function fakeDb(resposta: () => Promise<{ error: { message: string } | null }>): {
    db: AdminClient;
    gravados: { tabela: string; linha: Record<string, unknown>; opcoes: unknown }[];
  } {
    const gravados: { tabela: string; linha: Record<string, unknown>; opcoes: unknown }[] = [];
    const db = {
      from: (tabela: string) => ({
        upsert: (linha: Record<string, unknown>, opcoes: unknown) => {
          gravados.push({ tabela, linha, opcoes });

          return resposta();
        },
      }),
    } as unknown as AdminClient;

    return { db, gravados };
  }

  it("uma linha por pedido, na chave do pedido", async () => {
    const { db, gravados } = fakeDb(() => Promise.resolve({ error: null }));
    const logger = createLogger({}, { sink: () => undefined });

    await expect(gravarPacoteDoEnvio(db, CONTEXTO, 2_000_018_515_005_942, 48_040_752_377, PACOTE, logger, AGORA)).resolves.toBe(
      true,
    );
    expect(gravados).toEqual([
      {
        tabela: "shipment_packages",
        linha: {
          order_id: 2_000_018_515_005_942,
          organization_id: "org-1",
          ml_account_id: "conta-1",
          shipping_id: 48_040_752_377,
          item_id: "MLB1382501176",
          items_in_shipment: 1,
          dimensions_raw: "4.0x19.0x26.0,710.0",
          weight_g: 710,
          volume_cm3: 1976,
          largest_side_cm: 26,
          dimensions_origin: "bmp",
          captured_at: "2026-09-24T12:00:00.000Z",
        },
        opcoes: { onConflict: "order_id" },
      },
    ]);
  });

  it("erro do banco ou exceção: registrado e engolido, nunca lançado", async () => {
    const linhas: string[] = [];
    const logger = createLogger({}, { sink: (linha) => linhas.push(linha) });

    const comErro = fakeDb(() => Promise.resolve({ error: { message: "violates check" } }));
    const comExcecao = fakeDb(() => Promise.reject(new Error("rede")));

    await expect(gravarPacoteDoEnvio(comErro.db, CONTEXTO, 1, 2, PACOTE, logger, AGORA)).resolves.toBe(false);
    await expect(gravarPacoteDoEnvio(comExcecao.db, CONTEXTO, 1, 2, PACOTE, logger, AGORA)).resolves.toBe(false);
    expect(linhas.filter((l) => l.includes("shipment_package_nao_gravado"))).toHaveLength(2);
  });
});
