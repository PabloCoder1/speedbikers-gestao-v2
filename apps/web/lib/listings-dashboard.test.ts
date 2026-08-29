import { describe, expect, it } from "vitest";

import {
  PAGE_SIZE,
  linkStateBadge,
  resolveLinkStateFilter,
  resolvePage,
  resolveStatusFilter,
  summarizeWindow,
} from "./listings-dashboard";

describe("resolução de filtros da URL", () => {
  it("aceita os três estados de vínculo e ignora o resto", () => {
    expect(resolveLinkStateFilter("unlinked")).toBe("unlinked");
    expect(resolveLinkStateFilter("linked")).toBe("linked");
    expect(resolveLinkStateFilter("all")).toBe("all");
    expect(resolveLinkStateFilter("sem_vinculo")).toBe("all");
    expect(resolveLinkStateFilter(undefined)).toBe("all");
    expect(resolveLinkStateFilter(["unlinked"])).toBe("all");
  });

  /**
   * Um status arbitrário viajaria até `where l.status = p_status` e devolveria
   * zero linhas, que a tela mostraria como "nenhum anúncio corresponde" —
   * indistinguível de um filtro legítimo sem resultado.
   */
  it("status fora da lista fechada vira 'sem filtro', nunca vai ao banco", () => {
    expect(resolveStatusFilter("active")).toBe("active");
    expect(resolveStatusFilter("closed")).toBe("closed");
    expect(resolveStatusFilter("qualquer_coisa")).toBeNull();
    expect(resolveStatusFilter("")).toBeNull();
    expect(resolveStatusFilter(42)).toBeNull();
  });

  it("página tem piso 1 — nada de offset negativo nem 'Página -3'", () => {
    expect(resolvePage("3")).toBe(3);
    expect(resolvePage("1")).toBe(1);
    expect(resolvePage("0")).toBe(1);
    expect(resolvePage("-5")).toBe(1);
    expect(resolvePage("abc")).toBe(1);
    expect(resolvePage(undefined)).toBe(1);
  });
});

describe("summarizeWindow — a frase que impede o defeito de D-138 de voltar", () => {
  /**
   * O caso real que motivou a fatia: 5.085 anúncios, tela mostrando 50.
   * A versão anterior mostrava 1.000 de 5.085 e não dizia NADA — não havia
   * como distinguir "estes são todos" de "estes são os primeiros".
   */
  it("diz o total real, não o tamanho da página", () => {
    const resumo = summarizeWindow(1, 5085, PAGE_SIZE);

    expect(resumo.label).toContain("5.085");
    expect(resumo.label).toContain("1 a 50");
    expect(resumo.totalPages).toBe(102);
  });

  it("página do meio calcula o intervalo certo", () => {
    const resumo = summarizeWindow(3, 5085, PAGE_SIZE);

    expect(resumo.label).toContain("101 a 150");
  });

  it("última página parcial mostra o intervalo real, não o tamanho cheio", () => {
    // 904 sem vínculo (o número de D-122): 18 páginas cheias + 4 na última.
    const resumo = summarizeWindow(19, 904, 4);

    expect(resumo.totalPages).toBe(19);
    expect(resumo.label).toContain("901 a 904");
  });

  it("uma página só não vira ruído de intervalo", () => {
    const resumo = summarizeWindow(1, 12, 12);

    expect(resumo.totalPages).toBe(1);
    expect(resumo.label).toBe("12 anúncios.");
  });

  it("zero é um resultado, não um erro", () => {
    const resumo = summarizeWindow(1, 0, 0);

    expect(resumo.totalPages).toBe(0);
    expect(resumo.label).toContain("Nenhum anúncio");
  });
});

describe("linkStateBadge — os dois casos que a tela antiga confundia", () => {
  /**
   * D-122 mediu: dos 1.917 anúncios com `sku_id` nulo, 1.013 têm vínculo POR
   * VARIAÇÃO e só 904 não têm vínculo nenhum. A tela antiga mostrava "—" nos
   * dois, dobrando o tamanho aparente da fila de trabalho.
   */
  it("vínculo por variação NÃO é pendência e não usa a cor de alerta", () => {
    const badge = linkStateBadge("linked_variation");

    expect(badge.label).toBe("por variação");
    expect(badge.tone).not.toContain("danger");
    expect(badge.hint).toContain("Não está pendente");
  });

  it("sem vínculo nenhum é pendência e aparece em alerta", () => {
    const badge = linkStateBadge("unlinked");

    expect(badge.label).toBe("sem vínculo");
    expect(badge.tone).toContain("danger");
  });

  it("os dois estados produzem rótulos DIFERENTES — era esse o defeito", () => {
    expect(linkStateBadge("linked_variation").label).not.toBe(linkStateBadge("unlinked").label);
  });
});
