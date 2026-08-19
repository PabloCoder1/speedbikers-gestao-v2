import { describe, expect, it, vi } from "vitest";

import { createLogger } from "./logger.js";
import { measure } from "./measure.js";

function captureLogger(): { lines: string[]; logger: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  const logger = createLogger({}, { sink: (line) => lines.push(line) });

  return { lines, logger };
}

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe("measure", () => {
  it("devolve o resultado da operação", async () => {
    const { logger } = captureLogger();

    await expect(measure({ operation: "leitura", logger }, () => Promise.resolve(42))).resolves.toBe(
      42,
    );
  });

  it("não loga nada quando a operação é rápida", async () => {
    const { lines, logger } = captureLogger();

    await measure({ operation: "leitura", logger }, () => Promise.resolve("ok"));

    expect(lines).toHaveLength(0);
  });

  it("loga slow_operation quando passa do limite", async () => {
    const { lines, logger } = captureLogger();

    await measure({ operation: "get_products_overview", logger, slowThresholdMs: 0 }, () =>
      Promise.resolve("ok"),
    );

    expect(lines).toHaveLength(1);
    expect(parse(lines[0] ?? "")).toMatchObject({
      severity: "WARNING",
      message: "slow_operation",
      operation: "get_products_overview",
      thresholdMs: 0,
    });
  });

  it("propaga o erro e registra operation_failed", async () => {
    const { lines, logger } = captureLogger();
    const boom = new Error("timeout");

    await expect(
      measure({ operation: "sync_orders", logger }, () => Promise.reject(boom)),
    ).rejects.toThrow("timeout");

    expect(parse(lines[0] ?? "")).toMatchObject({
      severity: "ERROR",
      message: "operation_failed",
      operation: "sync_orders",
    });
  });

  it("inclui o contexto informado", async () => {
    const { lines, logger } = captureLogger();

    await measure(
      { operation: "sync", logger, slowThresholdMs: 0, context: { account: "gmr" } },
      () => Promise.resolve(null),
    );

    expect(parse(lines[0] ?? "").account).toBe("gmr");
  });

  it("executa a operação exatamente uma vez", async () => {
    const { logger } = captureLogger();
    const run = vi.fn(() => Promise.resolve("ok"));

    await measure({ operation: "leitura", logger }, run);

    expect(run).toHaveBeenCalledTimes(1);
  });
});
