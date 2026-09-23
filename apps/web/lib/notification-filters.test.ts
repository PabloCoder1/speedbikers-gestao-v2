import { describe, expect, it } from "vitest";

import {
  buildNotificationHref,
  countNotificationFilters,
  describeNotificationRecorte,
  notificationFamilyPattern,
  notificationFamilyPrefix,
  resolveNotificationFamily,
  resolveNotificationFilters,
  resolveNotificationSeverity,
  type NotificationFilters,
} from "./notification-filters";

/**
 * Os filtros da Central de Notificações (D-290, ampliados em D-393).
 *
 * Eram duas dimensões e são cinco. O que estes casos protegem:
 *
 *  1. **lista fechada em toda dimensão de vocabulário** — `?severidade=xpto`
 *     tem de virar "todas", nunca um filtro que devolve vazio para sempre. E a
 *     Server Action lê os MESMOS validadores, onde o mesmo silêncio
 *     transformaria "marcar as críticas" em "marcar tudo";
 *  2. **o default fica fora da URL** — `/notificacoes` limpo continua sendo
 *     `/notificacoes`, e é isso que faz o "Limpar filtros" ter para onde ir;
 *  3. **trocar o recorte volta à página 1** (D-138/D-139) — manter o offset ao
 *     mudar o CONJUNTO mostraria uma página vazia que se lê como "não há".
 */

const LIMPOS: NotificationFilters = {
  state: "todas",
  severity: null,
  family: null,
  account: null,
  page: 1,
};

const CONTA = "3e04a628-37eb-400f-bd75-881b1b554e9c";

describe("resolveNotificationFilters", () => {
  it("só `nao-lidas` liga o recorte; o resto cai em `todas`", () => {
    expect(resolveNotificationFilters({ estado: "nao-lidas" })).toEqual({ ...LIMPOS, state: "nao-lidas" });

    for (const estado of ["lidas", "NAO-LIDAS", "", "sim"]) {
      expect(resolveNotificationFilters({ estado }).state).toBe("todas");
    }
  });

  it("severidade e tipo vêm de lista fechada; fora dela é `null`, nunca o valor cru", () => {
    expect(resolveNotificationFilters({ severidade: "critico" }).severity).toBe("critico");
    expect(resolveNotificationFilters({ tipo: "stock" }).family).toBe("stock");

    for (const severidade of ["CRITICO", "urgente", "", "critico ", "alta"]) {
      expect(resolveNotificationFilters({ severidade }).severity).toBeNull();
    }

    for (const tipo of ["listing.price.changed", "anuncio", "", "LISTING"]) {
      expect(resolveNotificationFilters({ tipo }).family).toBeNull();
    }
  });

  it("conta é validada por FORMATO — a policy faz o resto", () => {
    expect(resolveNotificationFilters({ conta: CONTA }).account).toBe(CONTA);

    for (const conta of ["1", "", "não-é-uuid", "3e04a628-37eb-400f-bd75"]) {
      expect(resolveNotificationFilters({ conta }).account).toBeNull();
    }
  });

  it("página inválida cai em 1 — `offset` negativo seria erro do Postgres", () => {
    for (const pagina of ["0", "-2", "abc", ""]) {
      expect(resolveNotificationFilters({ pagina }).page).toBe(1);
    }

    expect(resolveNotificationFilters({ pagina: "4" }).page).toBe(4);
  });
});

describe("os validadores que a Server Action reusa", () => {
  it("aceitam só o vocabulário, e `undefined` não é valor", () => {
    expect(resolveNotificationSeverity("importante")).toBe("importante");
    expect(resolveNotificationSeverity("importantíssimo")).toBeNull();
    expect(resolveNotificationSeverity(undefined)).toBeNull();
    expect(resolveNotificationSeverity(7)).toBeNull();

    expect(resolveNotificationFamily("order")).toBe("order");
    expect(resolveNotificationFamily("order.cancelled")).toBeNull();
    expect(resolveNotificationFamily(null)).toBeNull();
  });
});

describe("o prefixo e o padrão da família", () => {
  it("o prefixo termina no ponto; o padrão acrescenta o curinga", () => {
    expect(notificationFamilyPrefix("listing")).toBe("listing.");
    expect(notificationFamilyPattern("listing")).toBe("listing.%");
  });
});

describe("buildNotificationHref", () => {
  it("`todas` é o default e fica fora da URL", () => {
    expect(buildNotificationHref(LIMPOS, {})).toBe("/notificacoes");
    expect(buildNotificationHref(LIMPOS, { state: "nao-lidas" })).toBe("/notificacoes?estado=nao-lidas");
  });

  it("as dimensões se preservam entre si", () => {
    const atual: NotificationFilters = { ...LIMPOS, state: "nao-lidas", severity: "critico" };

    expect(buildNotificationHref(atual, { family: "stock" })).toBe(
      "/notificacoes?estado=nao-lidas&severidade=critico&tipo=stock",
    );
    expect(buildNotificationHref(atual, { severity: null })).toBe("/notificacoes?estado=nao-lidas");
  });

  it("trocar o recorte volta à página 1", () => {
    const atual: NotificationFilters = { ...LIMPOS, page: 7 };

    expect(buildNotificationHref(atual, { state: "nao-lidas" })).toBe("/notificacoes?estado=nao-lidas");
  });

  it("a página preserva o recorte, e só sobrevive quando é pedida", () => {
    const atual: NotificationFilters = { ...LIMPOS, state: "nao-lidas", page: 3 };

    expect(buildNotificationHref(atual, { page: 4 })).toBe("/notificacoes?estado=nao-lidas&pagina=4");
    expect(buildNotificationHref(atual, { page: 1 })).toBe("/notificacoes?estado=nao-lidas");
    expect(buildNotificationHref(atual, {})).toBe("/notificacoes?estado=nao-lidas");
  });
});

describe("countNotificationFilters e describeNotificationRecorte", () => {
  it("contam e nomeiam o que está recortando", () => {
    expect(countNotificationFilters(LIMPOS)).toBe(0);
    expect(describeNotificationRecorte(LIMPOS, null)).toBe("toda a Central");

    const recortado: NotificationFilters = {
      ...LIMPOS,
      state: "nao-lidas",
      severity: "critico",
      family: "stock",
      account: CONTA,
    };

    expect(countNotificationFilters(recortado)).toBe(4);
    expect(describeNotificationRecorte(recortado, "SbMotos")).toBe("crítico · estoque · SbMotos");
  });
});
