import { createLogger } from "@sb/observability";
import { TikTokShopApiError } from "@sb/tiktok-shop";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { falhaDoTikTok, lerLojaTikTokConectada, type TikTokJobDeps } from "./tiktok-comum.js";

const ORG_A = "11111111-0000-4000-8000-000000000001";
const ORG_B = "22222222-0000-4000-8000-000000000002";
const SHOP_ID = "33333333-0000-4000-8000-000000000003";

function makeLogger() {
  const lines: string[] = [];
  const logger = createLogger({ service: "worker-test" }, { sink: (line) => lines.push(line) });

  return { logger, lines };
}

function makeDb(result: { data: unknown; error: { message: string } | null }): TikTokJobDeps["db"] {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(result),
        }),
      }),
    }),
  } as unknown as TikTokJobDeps["db"];
}

describe("lerLojaTikTokConectada (D-833)", () => {
  it("recusa payload sem tiktokShopId válido com retryable=false", async () => {
    const { logger } = makeLogger();
    const res = await lerLojaTikTokConectada({ db: makeDb({ data: null, error: null }) }, { payload: {}, logger }, "ev", ORG_A);

    expect(res).toEqual({
      outcome: { status: "failed", retryable: false, reason: "payload sem tiktokShopId" },
    });
  });

  it("trata erro transitório de banco como retryable=true", async () => {
    const { logger } = makeLogger();
    const res = await lerLojaTikTokConectada(
      { db: makeDb({ data: null, error: { message: "connection reset" } }) },
      { payload: { tiktokShopId: SHOP_ID }, logger },
      "ev",
      ORG_A,
    );

    expect(res).toEqual({
      outcome: { status: "failed", retryable: true, reason: "falha ao ler a loja TikTok: connection reset" },
    });
  });

  it("encerra com done(0) quando a loja não existe ou não está CONNECTED", async () => {
    const { logger } = makeLogger();
    const ausente = await lerLojaTikTokConectada(
      { db: makeDb({ data: null, error: null }) },
      { payload: { tiktokShopId: SHOP_ID }, logger },
      "tiktok_skipped",
      ORG_A,
    );

    expect(ausente).toEqual({ outcome: { status: "done", processed: 0 } });

    const emErro = await lerLojaTikTokConectada(
      {
        db: makeDb({
          data: {
            id: SHOP_ID,
            organization_id: ORG_A,
            shop_id: "7000714532876273420",
            shop_name: "Speed Bikers",
            region: "BR",
            status: "ERROR",
          },
          error: null,
        }),
      },
      { payload: { tiktokShopId: SHOP_ID }, logger },
      "tiktok_skipped",
      ORG_A,
    );

    expect(emErro).toEqual({ outcome: { status: "done", processed: 0 } });
  });

  it("recusa loja conectada de outra organização com retryable=false", async () => {
    const { logger } = makeLogger();
    const res = await lerLojaTikTokConectada(
      {
        db: makeDb({
          data: {
            id: SHOP_ID,
            organization_id: ORG_B,
            shop_id: "7000714532876273420",
            shop_name: "Outra Loja",
            region: "BR",
            status: "CONNECTED",
          },
          error: null,
        }),
      },
      { payload: { tiktokShopId: SHOP_ID }, logger },
      "tiktok_skipped",
      ORG_A,
    );

    expect(res).toEqual({
      outcome: { status: "failed", retryable: false, reason: "loja do TikTok Shop pertence a outra organização" },
    });
  });

  it("devolve a loja quando CONNECTED e pertencente à mesma organização", async () => {
    const { logger } = makeLogger();
    const loja = {
      id: SHOP_ID,
      organization_id: ORG_A,
      shop_id: "7000714532876273420",
      shop_name: "Speed Bikers",
      region: "BR",
      status: "CONNECTED",
    };
    const res = await lerLojaTikTokConectada(
      { db: makeDb({ data: loja, error: null }) },
      { payload: { tiktokShopId: SHOP_ID }, logger },
      "tiktok_skipped",
      ORG_A,
    );

    expect(res).toEqual({ loja });
  });
});

describe("falhaDoTikTok (D-833)", () => {
  it("classifica ZodError e RangeError como retryable=false", () => {
    const parsed = z.object({ a: z.string() }).safeParse({ a: 1 });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(falhaDoTikTok(parsed.error, "padrao")).toEqual({
        status: "failed",
        retryable: false,
        reason: "resposta do TikTok Shop fora do contrato",
      });
    }

    expect(falhaDoTikTok(new RangeError("janela invertida"), "padrao")).toEqual({
      status: "failed",
      retryable: false,
      reason: "janela invertida",
    });
  });

  it("respeita errorClass de TikTokShopApiError e trata erro de rede como retryable=true", () => {
    const retryableErr = new TikTokShopApiError("rate limit", {
      status: 429,
      code: 36009002,
      requestId: "req-1",
      errorClass: "retryable",
    });
    const fatalErr = new TikTokShopApiError("scope missing", {
      status: 403,
      code: 105005,
      requestId: "req-2",
      errorClass: "not_retryable",
    });

    expect(falhaDoTikTok(retryableErr, "padrao")).toEqual({
      status: "failed",
      retryable: true,
      reason: "rate limit",
    });
    expect(falhaDoTikTok(fatalErr, "padrao")).toEqual({
      status: "failed",
      retryable: false,
      reason: "scope missing",
    });
    expect(falhaDoTikTok(new Error("ECONNRESET"), "padrao")).toEqual({
      status: "failed",
      retryable: true,
      reason: "ECONNRESET",
    });
  });
});
