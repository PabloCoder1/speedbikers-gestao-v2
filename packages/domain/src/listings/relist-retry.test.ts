import { describe, expect, it } from "vitest";

import type { RelistRetryCandidate } from "./relist-retry.js";
import {
  RELIST_USER_PRODUCT_VARIATIONS_CAUSE,
  isRelistRejectionStatus,
  isRelistRetryEligible,
  isRelistUserProductVariationsRejection,
  mentionsRelistUserProductVariationsCause,
  relistRejectionFailureReason,
} from "./relist-retry.js";

const PARENT = "MLB1476804187";

/** A mensagem REAL gravada na operação a7638dc5 (2026-09-16 18:41 UTC). */
const MENSAGEM_REAL =
  "o POST /relist falhou e não é seguro repetir: Mercado Livre respondeu 400 para POST /items/MLB1476804187/relist.";

function legado(status: number, parent = PARENT): string {
  return `o POST /relist falhou e não é seguro repetir: Mercado Livre respondeu ${String(status)} para POST /items/${parent}/relist.`;
}

function candidate(overrides: Partial<RelistRetryCandidate> = {}): RelistRetryCandidate {
  return {
    status: "RELIST_FAILED",
    parentItemId: PARENT,
    failureReason: "o Mercado Livre recusou a republicação (HTTP 400) — nenhum anúncio novo foi criado.",
    lastFailedEventReason: "POST_RECUSADO",
    ...overrides,
  };
}

describe("isRelistRetryEligible (D-364)", () => {
  it("POST_RECUSADO no último evento de falha: elegível", () => {
    expect(isRelistRetryEligible(candidate())).toBe(true);
  });

  it("POST_RECUSADO com a linha dizendo OUTRA falha não é elegível: o evento da falha nova pode não ter sido gravado", () => {
    for (const failureReason of [
      // A retomada levou 5xx, o update gravou, o insert do evento POST_FALHOU não.
      legado(503),
      "o POST /relist falhou e não é seguro repetir: Mercado Livre respondeu 503 para POST /items/MLB1476804187/relist.",
      "execução interrompida após o POST /relist ser emitido — impossível saber se o filho nasceu",
      "a resposta do relist devolveu o próprio id do pai — filho não confirmado",
      relistRejectionFailureReason(429, "x"),
      relistRejectionFailureReason(500, "x"),
      ` ${relistRejectionFailureReason(400, "x")}`,
      null,
    ]) {
      expect(isRelistRetryEligible(candidate({ lastFailedEventReason: "POST_RECUSADO", failureReason }))).toBe(false);
    }
  });

  it("a mensagem que o worker grava na recusa é a que a regra aceita", () => {
    const failureReason = relistRejectionFailureReason(400, "Validation error causas: item.variations.missing");

    expect(failureReason.startsWith("o Mercado Livre recusou a republicação (HTTP 400) — nenhum anúncio novo foi criado")).toBe(
      true,
    );
    expect(isRelistRetryEligible(candidate({ failureReason }))).toBe(true);
    expect(isRelistRetryEligible(candidate({ failureReason: relistRejectionFailureReason(422, "") }))).toBe(true);
  });

  it("legado: POST_FALHOU com a mensagem REAL do 400 do MLB1476804187 é elegível", () => {
    expect(isRelistRetryEligible(candidate({ lastFailedEventReason: "POST_FALHOU", failureReason: MENSAGEM_REAL }))).toBe(
      true,
    );
  });

  it("legado: outros 4xx de recusa também (401, 403, 404, 409, 422)", () => {
    for (const status of [401, 403, 404, 409, 422]) {
      expect(isRelistRetryEligible(candidate({ lastFailedEventReason: "POST_FALHOU", failureReason: legado(status) }))).toBe(
        true,
      );
    }
  });

  it("legado: 408, 429, 500 e 503 NÃO — o filho pode ter nascido", () => {
    for (const status of [408, 429, 500, 503]) {
      expect(isRelistRetryEligible(candidate({ lastFailedEventReason: "POST_FALHOU", failureReason: legado(status) }))).toBe(
        false,
      );
    }
  });

  it("legado: a mensagem precisa casar EXATAMENTE — e ser do POST deste pai", () => {
    for (const failureReason of [
      `${MENSAGEM_REAL} `,
      MENSAGEM_REAL.replace("o POST /relist falhou", "O POST /relist falhou"),
      "o POST /relist falhou e não é seguro repetir: fetch failed",
      "o POST /relist falhou e não é seguro repetir: Mercado Livre respondeu 400 para PUT /items/MLB1476804187.",
      legado(400, "MLB900000000"),
      null,
    ]) {
      expect(isRelistRetryEligible(candidate({ lastFailedEventReason: "POST_FALHOU", failureReason }))).toBe(false);
    }
  });

  it("EXECUCAO_INTERROMPIDA e RESPOSTA_AMBIGUA não — mesmo com a mensagem de um 400 no failure_reason", () => {
    for (const reason of ["EXECUCAO_INTERROMPIDA", "RESPOSTA_AMBIGUA", "PAI_INDISPONIVEL", null]) {
      expect(isRelistRetryEligible(candidate({ lastFailedEventReason: reason, failureReason: MENSAGEM_REAL }))).toBe(false);
    }
  });

  it("status diferente de RELIST_FAILED nunca é elegível", () => {
    for (const status of ["REQUESTED", "CLOSING", "CLOSED", "RELISTING", "RELISTED", "REMAPPED", "PREFLIGHT_FAILED"]) {
      expect(isRelistRetryEligible(candidate({ status }))).toBe(false);
      expect(
        isRelistRetryEligible(candidate({ status, lastFailedEventReason: "POST_FALHOU", failureReason: MENSAGEM_REAL })),
      ).toBe(false);
    }
  });
});

/** O `failure_reason` REAL da operação a7638dc5 depois da retomada de 2026-09-17 13:36 UTC. */
const RECUSA_USER_PRODUCT_REAL =
  "o Mercado Livre recusou a republicação (HTTP 400) — nenhum anúncio novo foi criado. Resposta: Validation error (validation_error) causas: item.variations.relist.invalid: Relist item with variations are not allowed for user product seller";

describe("recusa por variações em conta de user products (D-369)", () => {
  it("a recusa REAL da a7638dc5 (item.variations.relist.invalid) NÃO é elegível — outra tentativa traria outro 400", () => {
    expect(RECUSA_USER_PRODUCT_REAL).toBe(
      relistRejectionFailureReason(
        400,
        `Validation error (validation_error) causas: ${RELIST_USER_PRODUCT_VARIATIONS_CAUSE}: Relist item with variations are not allowed for user product seller`,
      ),
    );
    expect(isRelistUserProductVariationsRejection(RECUSA_USER_PRODUCT_REAL)).toBe(true);
    expect(isRelistRetryEligible(candidate({ failureReason: RECUSA_USER_PRODUCT_REAL }))).toBe(false);
    // Entre outras causas, também.
    expect(
      isRelistRetryEligible(
        candidate({ failureReason: relistRejectionFailureReason(422, "x causas: item.price.invalid: y; item.variations.relist.invalid: z") }),
      ),
    ).toBe(false);
  });

  it("outras recusas 4xx continuam elegíveis — inclusive causas parecidas que não são a de D-369", () => {
    for (const failureReason of [
      relistRejectionFailureReason(400, "Validation error causas: item.variations.missing: Item with variations must be relisted with variations"),
      relistRejectionFailureReason(422, "Validation error causas: item.listing_type_id.invalid: x"),
      relistRejectionFailureReason(403, "forbidden"),
      relistRejectionFailureReason(400, "causas: item.variations.relist.invalid_quantity: x"),
      relistRejectionFailureReason(400, "causas: xitem.variations.relist.invalid: x"),
      relistRejectionFailureReason(400, "causas: item.variations.relist.invalid.quantity: x"),
      relistRejectionFailureReason(400, "causas: item.variations.relist.invalid.2: x"),
    ]) {
      expect(isRelistUserProductVariationsRejection(failureReason)).toBe(false);
      expect(isRelistRetryEligible(candidate({ failureReason }))).toBe(true);
    }
  });

  it("R2: o código seguido do ponto que fecha a frase continua reconhecido — o ponto final não é sufixo de outro código", () => {
    for (const resumo of [
      "Relist refused: item.variations.relist.invalid.",
      "Relist refused (item.variations.relist.invalid.)",
      "causas: item.variations.relist.invalid. Relist item with variations are not allowed",
    ]) {
      const failureReason = relistRejectionFailureReason(400, resumo);

      expect(mentionsRelistUserProductVariationsCause(resumo)).toBe(true);
      expect(isRelistUserProductVariationsRejection(failureReason)).toBe(true);
      expect(isRelistRetryEligible(candidate({ failureReason }))).toBe(false);
    }
  });

  it("R2: mentionsRelistUserProductVariationsCause é a mesma regra de código inteiro, em qualquer texto", () => {
    expect(mentionsRelistUserProductVariationsCause(RELIST_USER_PRODUCT_VARIATIONS_CAUSE)).toBe(true);
    expect(mentionsRelistUserProductVariationsCause(`{"code":"${RELIST_USER_PRODUCT_VARIATIONS_CAUSE}"}`)).toBe(true);

    for (const texto of [
      "item.variations.relist.invalid_quantity",
      "item.variations.relist.invalid.quantity",
      "xitem.variations.relist.invalid",
      "a.item.variations.relist.invalid",
      "item.variations.relist.invali",
      "",
    ]) {
      expect(mentionsRelistUserProductVariationsCause(texto)).toBe(false);
    }
  });

  it("só vale para a recusa gravada: a causa fora da mensagem de recusa não é reconhecida", () => {
    for (const failureReason of [
      `o POST /relist falhou e não é seguro repetir: ${RELIST_USER_PRODUCT_VARIATIONS_CAUSE}`,
      ` ${RECUSA_USER_PRODUCT_REAL}`,
      RELIST_USER_PRODUCT_VARIATIONS_CAUSE,
      null,
    ]) {
      expect(isRelistUserProductVariationsRejection(failureReason)).toBe(false);
    }
  });
});

describe("isRelistRejectionStatus (D-364)", () => {
  it("4xx é recusa, menos 408 e 429; o resto não é", () => {
    expect([400, 401, 403, 404, 409, 422, 499].every(isRelistRejectionStatus)).toBe(true);
    expect([408, 429, 399, 500, 502, 503, 0, 400.5].some(isRelistRejectionStatus)).toBe(false);
  });
});
