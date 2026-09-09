import { describe, expect, it } from "vitest";

import { buildNotificationHref, resolveNotificationFilters, type NotificationFilters } from "./notification-filters";

/**
 * Os filtros da Central de Notificações (D-290).
 *
 * Duas dimensões só, e as duas com regra: `estado` é conjunto fechado de dois
 * valores (default fora da URL) e `pagina` obedece ao reset de D-138/D-139 —
 * trocar o recorte na página 7 e manter o offset mostraria uma página vazia
 * que se lê como "não há não lidas".
 */

const LIMPOS: NotificationFilters = { state: "todas", page: 1 };

describe("resolveNotificationFilters", () => {
  it("só `nao-lidas` liga o recorte; o resto cai em `todas`", () => {
    expect(resolveNotificationFilters({ estado: "nao-lidas" })).toEqual({ state: "nao-lidas", page: 1 });

    for (const estado of ["lidas", "NAO-LIDAS", "", "sim"]) {
      expect(resolveNotificationFilters({ estado }).state).toBe("todas");
    }
  });

  it("página inválida cai em 1 — `offset` negativo seria erro do Postgres", () => {
    for (const pagina of ["0", "-2", "abc", ""]) {
      expect(resolveNotificationFilters({ pagina }).page).toBe(1);
    }

    expect(resolveNotificationFilters({ pagina: "4" }).page).toBe(4);
  });
});

describe("buildNotificationHref", () => {
  it("`todas` é o default e fica fora da URL", () => {
    expect(buildNotificationHref(LIMPOS, {})).toBe("/notificacoes");
    expect(buildNotificationHref(LIMPOS, { state: "nao-lidas" })).toBe("/notificacoes?estado=nao-lidas");
  });

  it("trocar o recorte volta à página 1", () => {
    const atual: NotificationFilters = { state: "todas", page: 7 };

    expect(buildNotificationHref(atual, { state: "nao-lidas" })).toBe("/notificacoes?estado=nao-lidas");
  });

  it("a página preserva o recorte, e só sobrevive quando é pedida", () => {
    const atual: NotificationFilters = { state: "nao-lidas", page: 3 };

    expect(buildNotificationHref(atual, { page: 4 })).toBe("/notificacoes?estado=nao-lidas&pagina=4");
    expect(buildNotificationHref(atual, { page: 1 })).toBe("/notificacoes?estado=nao-lidas");
    expect(buildNotificationHref(atual, {})).toBe("/notificacoes?estado=nao-lidas");
  });
});
