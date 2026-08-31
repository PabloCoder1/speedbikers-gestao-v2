import { describe, expect, it } from "vitest";

import { actionShortcuts } from "./action-shortcuts";

const SKU_ID = "11111111-2222-4333-8444-555555555501";

describe("actionShortcuts", () => {
  it("venda anômala com SKU: dashboard, diagnóstico, anúncios e reposição — todos para telas que existem", () => {
    expect(actionShortcuts({ kind: "venda_anomala", skuId: SKU_ID, sku: "3001-9243" })).toEqual([
      { label: "Dashboard do SKU", href: `/skus/${SKU_ID}` },
      { label: "Diagnóstico do SKU", href: `/skus/${SKU_ID}?aba=diagnostico` },
      { label: "Anúncios do SKU", href: "/anuncios?busca=3001-9243" },
      { label: "Reposição", href: "/reposicao?busca=3001-9243" },
    ]);
  });

  /**
   * A aba de diagnóstico depende do ID, não do código do SKU: uma ação com
   * `sku` preenchido e `skuId` nulo não pode gerar `/skus/?aba=diagnostico`
   * — link morto é o que este módulo existe para impedir.
   */
  it("venda anômala sem ID de SKU: busca por código ainda existe, atalho de aba não é inventado", () => {
    const shortcuts = actionShortcuts({ kind: "venda_anomala", skuId: null, sku: "3001-9243" });

    expect(shortcuts.some((s) => s.href.startsWith("/skus/"))).toBe(false);
    expect(shortcuts).toContainEqual({ label: "Anúncios do SKU", href: "/anuncios?busca=3001-9243" });
  });

  /**
   * `/atendimento` NÃO tem filtro por SKU — o atalho leva à Caixa inteira em
   * vez de fingir um filtro que a interface não oferece (a queixa literal do
   * item do ROADMAP).
   */
  it("reclamações recorrentes: Caixa de Entrada SEM filtro fingido", () => {
    const shortcuts = actionShortcuts({ kind: "reclamacoes_recorrentes", skuId: SKU_ID, sku: "X" });

    expect(shortcuts).toContainEqual({ label: "Caixa de Entrada", href: "/atendimento" });
    expect(shortcuts.some((s) => s.href.includes("atendimento?"))).toBe(false);
  });

  it("SKU com caracteres reservados é escapado na busca", () => {
    const shortcuts = actionShortcuts({ kind: "venda_anomala", skuId: SKU_ID, sku: "A&B #1" });

    // Por rótulo, não por índice: a lista cresce, e um teste que depende da
    // posição quebra sem que nada de errado tenha acontecido.
    expect(shortcuts.find((s) => s.label === "Anúncios do SKU")?.href).toBe("/anuncios?busca=A%26B%20%231");
  });

  it("ação sem SKU vinculado: nenhum link morto", () => {
    expect(actionShortcuts({ kind: "venda_anomala", skuId: null, sku: null })).toEqual([]);
  });

  it("kind desconhecido degrada para os atalhos genéricos do SKU", () => {
    expect(actionShortcuts({ kind: "novo_kind_do_worker", skuId: SKU_ID, sku: "X" })).toEqual([
      { label: "Dashboard do SKU", href: `/skus/${SKU_ID}` },
    ]);
  });
});
