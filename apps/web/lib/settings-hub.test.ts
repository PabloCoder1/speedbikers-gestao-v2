import { describe, expect, it } from "vitest";

import { describeSettings } from "./settings-hub.js";
import type { SettingsOverview } from "./settings-hub.js";

/** O estado real do Dev em 2026-09-03, medido — a base que cada teste distorce. */
function base(): SettingsOverview {
  return {
    organization_name: "Speed Bikers",
    organization_slug: "speed-bikers",
    members_total: 1,
    members_admin: 1,
    replenishment_default: 0,
    replenishment_brand: 1,
    replenishment_sku: 0,
    notification_prefs_mine: 1,
    notification_global_min_severity: "critico",
    notification_global_enabled: true,
    saved_filters_mine: 0,
    reply_templates: 0,
    knowledge_entries: 0,
    knowledge_validated: 0,
    ml_accounts_total: 4,
    ml_accounts_connected: 4,
  };
}

function section(overview: SettingsOverview | null, id: string) {
  const found = describeSettings(overview).find((s) => s.id === id);

  if (found === undefined) throw new Error(`seção ${id} não existe`);

  return found;
}

describe("describeSettings — as sete seções do item", () => {
  it("são sete, na ordem do ROADMAP, e toda seção aponta para pelo menos uma tela dona e diz quem altera", () => {
    const secoes = describeSettings(base());

    expect(secoes.map((s) => s.id)).toEqual([
      "organizacao",
      "reposicao",
      "notificacoes",
      "mercado_livre",
      "ia",
      "operacao",
      "preferencias",
    ]);

    for (const s of secoes) {
      expect(s.links.length).toBeGreaterThan(0);
      expect(s.editors.length).toBeGreaterThan(0);
    }
  });

  it("leitura que falhou vira indisponível em todas, com a frase que manda olhar a tela dona — nunca zero fingido", () => {
    for (const s of describeSettings(null)) {
      if (s.id === "ia") continue;

      expect(s.state).toBe("indisponivel");
      expect(s.summary).toContain("a tela dona mostra o estado real");
    }
  });
});

describe("Reposição (D-144: sem configuração aplicável, a sugestão recusa número)", () => {
  it("o Dev de 03/09 — uma regra por marca e nenhum padrão — é PARCIAL, e a frase diz o que fica de fora", () => {
    const r = section(base(), "reposicao");

    expect(r.state).toBe("parcial");
    expect(r.summary).toContain("sem padrão da organização");
    expect(r.summary).toContain("1 regra por marca");
    expect(r.summary).toContain("recusa número");
  });

  it("com padrão da organização é configurado; sem nada é não configurado", () => {
    const comPadrao = base();
    comPadrao.replenishment_default = 1;
    expect(section(comPadrao, "reposicao").state).toBe("configurado");

    const vazio = base();
    vazio.replenishment_brand = 0;
    expect(section(vazio, "reposicao")).toMatchObject({
      state: "nao_configurado",
      summary: "nenhuma política cadastrada — a sugestão de compra recusa número até haver uma",
    });
  });
});

describe("as outras seções", () => {
  it("Organização: nome, slug, membros e admins; quem altera diz que nome/slug não têm tela", () => {
    const o = section(base(), "organizacao");

    expect(o.state).toBe("configurado");
    expect(o.summary).toBe("Speed Bikers (speed-bikers) — 1 membro, 1 ADMIN");
    expect(o.editors).toContain("não editável na interface");
    expect(o.links).toEqual([{ label: "Usuários", href: "/usuarios" }]);
  });

  it("Notificações: a regra geral aparece com o mínimo; desligada é dita; sem preferência é não configurado", () => {
    expect(section(base(), "notificacoes").summary).toBe("1 regra sua; regra geral: mínimo critico");

    const desligada = base();
    desligada.notification_global_enabled = false;
    expect(section(desligada, "notificacoes").summary).toContain("(desligada)");

    const nenhuma = base();
    nenhuma.notification_prefs_mine = 0;
    nenhuma.notification_global_min_severity = null;
    expect(section(nenhuma, "notificacoes").state).toBe("nao_configurado");
  });

  it("Mercado Livre: todas conectadas é configurado; uma fora é PARCIAL, com a contagem; e aponta para Contas e Integrações", () => {
    expect(section(base(), "mercado_livre")).toMatchObject({ state: "configurado", summary: "4 de 4 contas conectadas" });
    expect(section(base(), "mercado_livre").links.map((l) => l.href)).toEqual(["/contas", "/integracoes"]);

    const umaFora = base();
    umaFora.ml_accounts_connected = 3;
    expect(section(umaFora, "mercado_livre")).toMatchObject({ state: "parcial", summary: "3 de 4 contas conectadas" });

    const nenhuma = base();
    nenhuma.ml_accounts_total = 0;
    nenhuma.ml_accounts_connected = 0;
    expect(section(nenhuma, "mercado_livre").state).toBe("nao_configurado");
  });

  it("IA: sempre não editável — o teto mora no deploy — e NÃO repete o custo: aponta para Integrações, que o compõe", () => {
    const i = section(base(), "ia");

    expect(i.state).toBe("nao_editavel");
    expect(i.summary).toContain("definido no deploy");
    expect(i.summary).toContain("em Integrações");
    expect(i.links.map((l) => l.href)).toEqual(["/integracoes", "/copiloto"]);
    // Mesmo sem leitura nenhuma do banco, a IA continua não editável — não é indisponível.
    expect(section(null, "ia").state).toBe("nao_editavel");
  });

  it("Operação: zero templates e zero conhecimento é não configurado; com dado, conta e distingue validadas", () => {
    expect(section(base(), "operacao").state).toBe("nao_configurado");

    const comDado = base();
    comDado.reply_templates = 3;
    comDado.knowledge_entries = 5;
    comDado.knowledge_validated = 2;
    expect(section(comDado, "operacao").summary).toBe("3 templates; 5 entradas de conhecimento (2 validada(s))");
  });

  it("Preferências: filtros salvos são do usuário, e a tela dona é Vendas", () => {
    expect(section(base(), "preferencias")).toMatchObject({ state: "nao_configurado", summary: "nenhum filtro salvo seu" });

    const comFiltros = base();
    comFiltros.saved_filters_mine = 2;
    expect(section(comFiltros, "preferencias")).toMatchObject({
      state: "configurado",
      summary: "2 filtros salvos seus em Vendas",
      links: [{ label: "Vendas", href: "/vendas" }],
    });
  });
});
