import { describe, expect, it } from "vitest";

import { avisoDe, describeSettings, quemAltera, zonaDe } from "./settings-hub.js";
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
    expect(r.summary).toContain("Sem padrão da organização");
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
      summary: "Nenhuma política cadastrada — a sugestão de compra recusa número até haver uma.",
    });
  });
});

describe("as outras seções", () => {
  it("Organização: nome, slug, membros e admins; quem altera diz que nome/slug não têm tela", () => {
    const o = section(base(), "organizacao");

    expect(o.state).toBe("configurado");
    expect(o.summary).toBe("Speed Bikers (speed-bikers) — 1 membro, 1 ADMIN.");
    expect(o.editors).toContain("não editável na interface");
    expect(o.links).toEqual([{ label: "Usuários", href: "/usuarios" }]);
  });

  it("Notificações: a regra geral aparece com o mínimo; desligada é dita; sem preferência é não configurado", () => {
    expect(section(base(), "notificacoes").summary).toBe("1 regra sua; regra geral: mínimo Crítico.");

    const desligada = base();
    desligada.notification_global_enabled = false;
    expect(section(desligada, "notificacoes").summary).toContain("(desligada)");

    const nenhuma = base();
    nenhuma.notification_prefs_mine = 0;
    nenhuma.notification_global_min_severity = null;
    expect(section(nenhuma, "notificacoes").state).toBe("nao_configurado");
  });

  it("Mercado Livre: todas conectadas é configurado; uma fora é PARCIAL, com a contagem; e aponta para Contas e Integrações", () => {
    expect(section(base(), "mercado_livre")).toMatchObject({ state: "configurado", summary: "4 de 4 contas conectadas." });
    expect(section(base(), "mercado_livre").links.map((l) => l.href)).toEqual(["/contas", "/integracoes"]);

    const umaFora = base();
    umaFora.ml_accounts_connected = 3;
    expect(section(umaFora, "mercado_livre")).toMatchObject({ state: "parcial", summary: "3 de 4 contas conectadas." });

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
    expect(section(comDado, "operacao").summary).toBe("3 templates; 5 entradas de conhecimento (2 validadas).");
  });

  it("Preferências: filtros salvos são do usuário, e as telas donas são DUAS — sem dizer 'em Vendas'", () => {
    expect(section(base(), "preferencias")).toMatchObject({ state: "nao_configurado", summary: "Nenhum filtro salvo seu." });

    const comFiltros = base();
    comFiltros.saved_filters_mine = 2;

    /*
      `saved_filters_mine` conta sem filtrar `screen`, e `SavedFilters` está
      montado em /vendas E em /anúncios: "2 filtros salvos seus em Vendas"
      ficaria falso no primeiro filtro salvo do outro lado. Com zero filtros o
      defeito dorme — este caso é o despertador.
    */
    expect(section(comFiltros, "preferencias")).toMatchObject({
      state: "configurado",
      summary: "2 filtros salvos seus.",
      links: [
        { label: "Vendas", href: "/vendas" },
        { label: "Anúncios", href: "/anuncios" },
      ],
    });
    expect(section(comFiltros, "preferencias").summary).not.toContain("em Vendas");
  });
});

describe("zonaDe — a tela agrupa por PRESENÇA de configuração, e só por isso", () => {
  it("o que ainda não tem configuração abre a tela; o que tem vem depois; o que não pôde ser lido fecha", () => {
    expect(zonaDe("parcial")).toBe(1);
    expect(zonaDe("nao_configurado")).toBe(1);

    /*
      `nao_editavel` na zona 2 é afirmação de conteúdo, não arredondamento: o
      teto de IA EXISTE, definido no deploy. Onde se altera é assunto da
      pílula do cartão, e as duas frases se somam em vez de se contradizer.
    */
    expect(zonaDe("configurado")).toBe(2);
    expect(zonaDe("nao_editavel")).toBe(2);

    expect(zonaDe("indisponivel")).toBe(3);
  });

  it("na leitura que falhou são SEIS na zona 3 e a IA continua na 2 — é por isso que 'Indisponíveis: 7' seria errado", () => {
    const zonas = describeSettings(null).map((s) => zonaDe(s.state));

    expect(zonas.filter((z) => z === 3)).toHaveLength(6);
    expect(zonas.filter((z) => z === 2)).toHaveLength(1);
    expect(zonaDe(section(null, "ia").state)).toBe(2);
  });
});

describe("quemAltera — a pergunta do operador é 'EU posso?'", () => {
  it("com o papel na mão a resposta é em segunda pessoa, e separa quem altera de quem precisa pedir", () => {
    const organizacao = section(base(), "organizacao");
    const reposicao = section(base(), "reposicao");

    expect(quemAltera(organizacao, "ADMIN")).toBe("Você é ADMIN — pode alterar.");
    expect(quemAltera(organizacao, "ANALISTA")).toBe("Você é ANALISTA — peça a um ADMIN.");

    // Dois papéis na policy: a frase lista os dois, para a pessoa saber a
    // quem recorrer sem abrir a tela dona para descobrir.
    expect(quemAltera(reposicao, "GESTOR")).toBe("Você é GESTOR — pode alterar.");
    expect(quemAltera(reposicao, "OPERADOR")).toBe("Você é OPERADOR — peça a um ADMIN ou GESTOR.");
  });

  it("'self' concorda com o objeto da área, e 'none' diz que o caminho não existe na interface", () => {
    expect(quemAltera(section(base(), "notificacoes"), "ANALISTA")).toBe("Só você altera as suas.");
    expect(quemAltera(section(base(), "preferencias"), "ANALISTA")).toBe("Só você altera os seus.");

    // Papel nenhum muda isto: o teto de IA mora no deploy, fora do produto.
    expect(quemAltera(section(base(), "ia"), "ADMIN")).toBe("Ninguém pela interface — o teto é definido no deploy.");
  });

  it("sem papel conhecido a resposta volta à prosa das policies, VERBATIM", () => {
    /*
      É o que a tela imprime no ramo em que a associação não pôde ser lida —
      e é a prosa que o teste de integração de D-233 confere contra
      `pg_policy`. Parafraseá-la aqui tiraria a guarda do lugar.
    */
    for (const s of describeSettings(null)) {
      expect(quemAltera(s, null)).toBe(s.editors);
    }
  });

  it("os papéis em DADO e a prosa das policies dizem a mesma coisa — divergir em silêncio é o defeito", () => {
    for (const s of describeSettings(base())) {
      if (s.editorRoles === "self") {
        expect(s.editors).toContain("Cada usuário edita só");
        continue;
      }

      if (s.editorRoles === "none") {
        expect(s.editors).toContain("Ninguém pela interface");
        continue;
      }

      for (const papel of ["ADMIN", "GESTOR"]) {
        expect(s.editors.includes(papel)).toBe(s.editorRoles.includes(papel));
      }
    }
  });
});

describe("avisoDe — consequência medida, e toda frase termina na ação que a resolve", () => {
  it("nenhum ADMIN: ninguém altera nada, e a saída é designar um em Usuários", () => {
    const o = base();
    o.members_total = 3;
    o.members_admin = 0;

    expect(avisoDe(o, "organizacao")).toBe(
      "Nenhum ADMIN na organização: ninguém altera membros, contas do Mercado Livre nem reposição. Um ADMIN precisa ser designado em Usuários.",
    );
  });

  it("um ADMIN só, com mais gente na organização: é ponto único de falha, e a frase diz o que fazer", () => {
    const o = base();
    o.members_total = 4;
    o.members_admin = 1;

    expect(avisoDe(o, "organizacao")).toBe(
      "Só uma pessoa é ADMIN. Se ela perder o acesso, ninguém altera membros, contas do Mercado Livre nem reposição — promova um segundo ADMIN em Usuários.",
    );
  });

  it("um ADMIN numa organização de uma pessoa só NÃO é risco: é o dono, e aviso sem ação vira mobília", () => {
    expect(base().members_total).toBe(1);
    expect(avisoDe(base(), "organizacao")).toBeNull();
  });

  it("com o segundo ADMIN o aviso SOME — o alerta não vaza para o estado saudável", () => {
    const o = base();
    o.members_total = 4;
    o.members_admin = 2;

    expect(avisoDe(o, "organizacao")).toBeNull();
  });

  it("conta do Mercado Livre desconectada: o que ela traria deixa de chegar", () => {
    const o = base();
    o.ml_accounts_connected = 3;

    expect(avisoDe(o, "mercado_livre")).toBe(
      "Conta desconectada não sincroniza: pedidos, perguntas e mensagens novos dela não chegam — reconecte a conta em Contas ML.",
    );

    // Todas conectadas: não há consequência a dizer.
    expect(avisoDe(base(), "mercado_livre")).toBeNull();
  });

  it("regra geral de notificação desligada: nenhum alerta sai por ela", () => {
    const o = base();
    o.notification_global_enabled = false;

    expect(avisoDe(o, "notificacoes")).toBe(
      "A sua regra geral está desligada: nenhum alerta sai por ela — ligue-a em Preferências de notificação.",
    );

    expect(avisoDe(base(), "notificacoes")).toBeNull();
  });

  it("base de conhecimento inteira em SUGERIDO: o Copiloto só usa o que está VALIDADO", () => {
    const o = base();
    o.knowledge_entries = 5;
    o.knowledge_validated = 0;

    expect(avisoDe(o, "operacao")).toBe(
      "Nenhuma entrada validada: o Copiloto só usa o que está VALIDADO, então a base ainda não chega nele — valide as entradas em Revisão pendente.",
    );

    // Uma validada já chega ao Copiloto: o aviso é sobre a base INTEIRA fora.
    o.knowledge_validated = 1;
    expect(avisoDe(o, "operacao")).toBeNull();

    // Base vazia é "não configurado", e isso o resumo já diz: não é consequência.
    expect(avisoDe(base(), "operacao")).toBeNull();
  });

  it("sem leitura não há aviso: 'não sei' não vira alerta (D-067)", () => {
    expect(avisoDe(null, "organizacao")).toBeNull();

    for (const s of describeSettings(null)) {
      expect(s.aviso).toBeNull();
    }
  });

  it("o aviso chega ao cartão pela describeSettings, na seção certa e em nenhuma outra", () => {
    const o = base();
    o.members_total = 4;

    const comAviso = describeSettings(o).filter((s) => s.aviso !== null);

    expect(comAviso.map((s) => s.id)).toEqual(["organizacao"]);
    expect(comAviso[0]?.aviso).toContain("promova um segundo ADMIN em Usuários");
  });
});

describe("inclui — o que a área abrange, no vocabulário da tela dona", () => {
  /*
    Quem confere o CONTEÚDO — que a string existe, caractere a caractere, no
    arquivo declarado — é `scripts/check-settings-vocabulary.mjs`, a cada CI.
    O que se guarda aqui é que a linha "Inclui:" nunca sai vazia na tela.
  */
  it("toda área tem pelo menos um termo, e nenhum termo ou arquivo vem vazio", () => {
    for (const s of describeSettings(base())) {
      expect(s.inclui.length).toBeGreaterThan(0);

      for (const { termo, arquivo } of s.inclui) {
        expect(termo.trim()).not.toBe("");
        expect(arquivo.trim()).not.toBe("");
      }
    }
  });

  it("a leitura que falhou não apaga o vocabulário: as sete continuam dizendo o que abrangem", () => {
    for (const s of describeSettings(null)) {
      expect(s.inclui.length).toBeGreaterThan(0);
    }
  });
});
