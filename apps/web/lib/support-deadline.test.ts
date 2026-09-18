import { describe, expect, it } from "vitest";

import { describeDeadline } from "./support-deadline";

const AGORA = new Date("2026-09-18T15:00:00Z");

describe("describeDeadline", () => {
  it("vencido é perigo, com há quanto tempo", () => {
    expect(describeDeadline("2026-09-18T12:00:00Z", AGORA)).toEqual({ tone: "perigo", relative: "vencido há 3 h" });
    expect(describeDeadline("2026-09-16T15:00:00Z", AGORA)).toEqual({ tone: "perigo", relative: "vencido há 2 dias" });
  });

  it("nas próximas 24 h é atenção, com quanto falta", () => {
    expect(describeDeadline("2026-09-18T15:40:00Z", AGORA)).toEqual({ tone: "atencao", relative: "vence em 40 min" });
    expect(describeDeadline("2026-09-19T10:00:00Z", AGORA)).toEqual({ tone: "atencao", relative: "vence em 19 h" });
  });

  it("além de 24 h a data basta", () => {
    expect(describeDeadline("2026-09-21T15:00:00Z", AGORA)).toEqual({ tone: "neutro", relative: null });
  });
});
