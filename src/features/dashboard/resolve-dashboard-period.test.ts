import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveDashboardPeriod } from "@/features/dashboard/resolve-dashboard-period";

const BASE = { today: "2026-08-18", thirtyDaysAgo: "2026-07-19" };

test("preset de 7 dias cobre hoje mais os seis anteriores", () => {
  const period = resolveDashboardPeriod({
    ...BASE,
    periodDays: 7,
    dateFrom: null,
    dateTo: null,
  });
  assert.equal(period.from, "2026-08-12");
  assert.equal(period.to, "2026-08-18");
  assert.equal(period.days, 7);
  assert.equal(period.custom, false);
});

test("intervalo personalizado tem prioridade sobre o preset", () => {
  const period = resolveDashboardPeriod({
    ...BASE,
    periodDays: 30,
    dateFrom: "2026-08-13",
    dateTo: "2026-08-18",
  });
  assert.equal(period.custom, true, "o preset nao pode sobrepor a escolha do usuario");
  assert.equal(period.from, "2026-08-13");
  assert.equal(period.to, "2026-08-18");
  assert.equal(period.days, 6);
});

test("intervalo personalizado inteiramente no passado e respeitado", () => {
  const period = resolveDashboardPeriod({
    ...BASE,
    periodDays: 30,
    dateFrom: "2026-06-01",
    dateTo: "2026-06-30",
  });
  assert.equal(period.custom, true);
  assert.equal(period.from, "2026-06-01");
  assert.equal(period.to, "2026-06-30");
  assert.equal(period.days, 30);
  assert.equal(
    period.rangeStart,
    "2026-06-01",
    "a leitura precisa recuar ate o inicio do periodo escolhido",
  );
});

test("periodo dentro dos 30 dias mantem a leitura dos cards", () => {
  const period = resolveDashboardPeriod({
    ...BASE,
    periodDays: 7,
    dateFrom: null,
    dateTo: null,
  });
  assert.equal(
    period.rangeStart,
    "2026-07-19",
    "os cards de 30 dias continuam precisando da janela inteira",
  );
});

test("data final no futuro e cortada em hoje", () => {
  const period = resolveDashboardPeriod({
    ...BASE,
    periodDays: 30,
    dateFrom: "2026-08-10",
    dateTo: "2026-12-31",
  });
  assert.equal(period.to, "2026-08-18", "nao existe metrica de dia futuro");
  assert.equal(period.from, "2026-08-10");
});

test("intervalo que comeca no futuro nao vira personalizado", () => {
  const period = resolveDashboardPeriod({
    ...BASE,
    periodDays: 30,
    dateFrom: "2026-09-01",
    dateTo: "2026-09-30",
  });
  assert.equal(period.custom, false, "cairia num grafico vazio sem explicacao");
  assert.equal(period.days, 30);
});

test("intervalo invertido cai no preset", () => {
  const period = resolveDashboardPeriod({
    ...BASE,
    periodDays: 30,
    dateFrom: "2026-08-18",
    dateTo: "2026-08-01",
  });
  assert.equal(period.custom, false);
});

test("data malformada cai no preset", () => {
  for (const [from, to] of [
    ["18/08/2026", "2026-08-18"],
    ["2026-08-13", ""],
    ["", ""],
    ["2026-8-13", "2026-08-18"],
  ]) {
    const period = resolveDashboardPeriod({
      ...BASE,
      periodDays: 30,
      dateFrom: from,
      dateTo: to,
    });
    assert.equal(period.custom, false, `${from} .. ${to}`);
  }
});

test("um unico dia e um periodo valido", () => {
  const period = resolveDashboardPeriod({
    ...BASE,
    periodDays: 30,
    dateFrom: "2026-08-15",
    dateTo: "2026-08-15",
  });
  assert.equal(period.custom, true);
  assert.equal(period.days, 1);
  assert.equal(period.from, "2026-08-15");
  assert.equal(period.to, "2026-08-15");
});
