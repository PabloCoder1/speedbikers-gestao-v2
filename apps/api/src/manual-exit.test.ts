import { createLogger } from "@sb/observability";
import { describe, expect, it } from "vitest";

import { bancoFalso, type ConsultaFalsa, type Resposta } from "./banco-falso.test.js";
import {
  OBSERVACAO_MAX,
  linhasDaSaidaManual,
  manualExitSchema,
  motivoDaSaidaManual,
  registerManualExit,
  type ManualExitDeps,
  type ManualExitInput,
} from "./manual-exit.js";

const CALLER = { userId: "user-1", organizationId: "org-1", role: "GESTOR" as const };
const SAIDA = "0b6f1c8e-2d4a-4f7b-9a1e-3c5d7e9f1a2b";
const SKU_A = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
const SKU_B = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";

function entrada(over: Partial<ManualExitInput> = {}): ManualExitInput {
  return {
    requestId: SAIDA,
    tipo: "PERDAS",
    observacao: "caixa molhada",
    itens: [
      { skuId: SKU_A, quantidade: 3 },
      { skuId: SKU_B, quantidade: 2 },
    ],
    ...over,
  };
}

function deps(responder: (consulta: ConsultaFalsa) => Resposta): {
  deps: ManualExitDeps;
  consultas: ConsultaFalsa[];
} {
  const { db, consultas } = bancoFalso(responder);

  return {
    consultas,
    deps: {
      db: db as ManualExitDeps["db"],
      logger: createLogger({}, { sink: () => undefined }),
      now: () => new Date("2026-11-19T12:00:00.000Z"),
    },
  };
}

const skusDaOrganizacao = (consulta: ConsultaFalsa): Resposta =>
  consulta.tabela === "skus" ? { data: [{ id: SKU_A }, { id: SKU_B }] } : { data: null };

describe("motivoDaSaidaManual", () => {
  it("junta o prefixo, o tipo e a observação limpa", () => {
    expect(motivoDaSaidaManual("PERDAS", "  caixa   molhada ")).toBe("Saída manual · Perdas · caixa molhada");
    expect(motivoDaSaidaManual("TRANSFERENCIAS", "")).toBe("Saída manual · Transferências");
  });

  it("cabe no limite de 500 do `reason` com a observação no máximo", () => {
    expect(motivoDaSaidaManual("TRANSFERENCIAS", "x".repeat(OBSERVACAO_MAX)).length).toBeLessThanOrEqual(500);
  });
});

describe("manualExitSchema", () => {
  it("recusa quantidade zero, fracionada e lista vazia", () => {
    expect(manualExitSchema.safeParse(entrada({ itens: [{ skuId: SKU_A, quantidade: 0 }] })).success).toBe(false);
    expect(manualExitSchema.safeParse(entrada({ itens: [{ skuId: SKU_A, quantidade: 1.5 }] })).success).toBe(false);
    expect(manualExitSchema.safeParse(entrada({ itens: [] })).success).toBe(false);
    expect(manualExitSchema.safeParse(entrada()).success).toBe(true);
  });
});

describe("linhasDaSaidaManual", () => {
  it("cada SKU vira um AJUSTE_MANUAL negativo na loja, com autor, motivo e chave por saída e SKU", () => {
    const [linha] = linhasDaSaidaManual(CALLER, entrada(), new Date("2026-11-19T12:00:00.000Z"));

    expect(linha).toEqual({
      organization_id: "org-1",
      sku_id: SKU_A,
      location_kind: "LOCAL",
      qty_delta: -3,
      movement_type: "AJUSTE_MANUAL",
      reason: "Saída manual · Perdas · caixa molhada",
      created_by: "user-1",
      source_type: "SAIDA_MANUAL",
      source_id: SAIDA,
      idempotency_key: `saida-manual:${SAIDA}:${SKU_A}`,
      occurred_at: "2026-11-19T12:00:00.000Z",
    });
  });
});

describe("registerManualExit", () => {
  it("grava as linhas num único upsert que ignora duplicadas", async () => {
    const ctx = deps(skusDaOrganizacao);

    const outcome = await registerManualExit(ctx.deps, CALLER, entrada());

    expect(outcome).toEqual({ status: "applied", requestId: SAIDA, itens: 2, unidades: 5 });

    const escritas = ctx.consultas.filter((consulta) => consulta.operacao === "upsert");

    expect(escritas).toHaveLength(1);
    expect(escritas[0]?.tabela).toBe("stock_movements");
    expect(escritas[0]?.valores).toHaveLength(2);
    expect(escritas[0]?.opcoes).toEqual({ onConflict: "idempotency_key", ignoreDuplicates: true });
  });

  it("confere a organização do SKU: um SKU de fora recusa a saída inteira, sem gravar nada", async () => {
    const ctx = deps((consulta) => (consulta.tabela === "skus" ? { data: [{ id: SKU_A }] } : { data: null }));

    const outcome = await registerManualExit(ctx.deps, CALLER, entrada());

    expect(outcome.status).toBe("rejected");
    expect(ctx.consultas.some((consulta) => consulta.operacao === "upsert")).toBe(false);
    expect(ctx.consultas[0]?.filtros).toContainEqual(["eq", "organization_id", "org-1"]);
  });

  it("o mesmo SKU duas vezes é recusado antes de ler o banco", async () => {
    const ctx = deps(skusDaOrganizacao);

    const outcome = await registerManualExit(
      ctx.deps,
      CALLER,
      entrada({
        itens: [
          { skuId: SKU_A, quantidade: 1 },
          { skuId: SKU_A, quantidade: 2 },
        ],
      }),
    );

    expect(outcome.status).toBe("rejected");
    expect(ctx.consultas).toHaveLength(0);
  });

  it("falha de gravação vira `failed`, não sucesso", async () => {
    const ctx = deps((consulta) =>
      consulta.tabela === "skus" ? skusDaOrganizacao(consulta) : { error: { message: "boom" } },
    );

    expect((await registerManualExit(ctx.deps, CALLER, entrada())).status).toBe("failed");
  });
});
