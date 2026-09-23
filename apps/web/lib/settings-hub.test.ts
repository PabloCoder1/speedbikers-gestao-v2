import { describe, expect, it } from "vitest";

import { avisoDe, describeSettings, incluiPara, placarDe, quemAltera, vereditoDe, zonaDe } from "./settings-hub.js";
import type { SettingsOverview } from "./settings-hub.js";

/** Os cinco papéis de `organization_members.role` (migration de identidade). */
const PAPEIS = ["ADMIN", "GESTOR", "ANALISTA", "OPERADOR", "VISUALIZADOR"] as const;

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

  it("organização que a RLS esconde (nome NULL e contagens zero) é leitura ausente: indisponível, e SEM o aviso de 'nenhum ADMIN'", () => {
    /*
      É o contrato de `get_settings_overview` para organização alheia: nome
      NULL e zeros, não erro. `members_admin` zero ali é "não sei", e o cartão
      "Indisponível" dizia "Nenhum ADMIN na organização" — alarme feito de
      "não sei" (D-067). E os outros zeros também são "não sei": cinco áreas
      "não configuradas" seriam o banco escondendo a resposta.
    */
    const escondida: SettingsOverview = {
      organization_name: null,
      organization_slug: null,
      members_total: 0,
      members_admin: 0,
      replenishment_default: 0,
      replenishment_brand: 0,
      replenishment_sku: 0,
      notification_prefs_mine: 0,
      notification_global_min_severity: null,
      notification_global_enabled: null,
      saved_filters_mine: 0,
      reply_templates: 0,
      knowledge_entries: 0,
      knowledge_validated: 0,
      ml_accounts_total: 0,
      ml_accounts_connected: 0,
    };

    for (const papel of [null, ...PAPEIS]) {
      const secoes = describeSettings(escondida, papel);

      expect(secoes.find((s) => s.id === "organizacao")?.state).toBe("indisponivel");
      expect(secoes.filter((s) => s.aviso !== null)).toEqual([]);

      // A mesma forma da leitura que falhou: seis indisponíveis e a IA.
      expect(secoes.map((s) => s.state)).toEqual(describeSettings(null).map((s) => s.state));
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

  it("a âncora de 'Primeiros passos' só vai no link quando a tela dona a desenha: sem regra nenhuma", () => {
    /*
      `reposicao/configuracoes/page.tsx` só renderiza a seção de id
      `cfg-comeco-titulo` com `regras.length === 0`. Com padrão ou com regra
      por marca — produção desde 22/09 — o fragmento apontava para o nada.
    */
    const vazio = base();
    vazio.replenishment_brand = 0;
    expect(section(vazio, "reposicao").links).toEqual([
      { label: "Configuração de reposição", href: "/reposicao/configuracoes#cfg-comeco-titulo" },
    ]);

    const comPadrao = base();
    comPadrao.replenishment_default = 1;

    for (const overview of [base(), comPadrao, null]) {
      expect(section(overview, "reposicao").links).toEqual([
        { label: "Configuração de reposição", href: "/reposicao/configuracoes" },
      ]);
    }
  });
});

describe("as outras seções", () => {
  it("Organização: nome, slug, membros e admins; quem altera diz que o nome não tem tela", () => {
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

describe("placarDe e vereditoDe — um placar só, dito na faixa e no subtítulo com as mesmas palavras", () => {
  /** Monta a leitura que produz exatamente `sem` áreas não configuradas e `parciais` parciais. */
  function leitura(sem: 0 | 1 | 2, parciais: 0 | 1 | 2): SettingsOverview {
    const o = base();

    // Ponto de partida sem nenhuma área na zona 1: tudo configurado.
    o.replenishment_default = 1;
    o.reply_templates = 1;
    o.saved_filters_mine = 1;

    // Não configuradas: Operação e Preferências, nesta ordem.
    if (sem >= 1) o.reply_templates = 0;
    if (sem >= 2) o.saved_filters_mine = 0;

    // Parciais: Mercado Livre (uma conta fora) e Reposição (só regra por marca).
    if (parciais >= 1) o.ml_accounts_connected = 3;
    if (parciais >= 2) o.replenishment_default = 0;

    return o;
  }

  it("zero, um e N sem configuração: a frase concorda em número e o placar diz os mesmos números", () => {
    expect(vereditoDe(describeSettings(leitura(0, 0)), false)).toBe("As 7 áreas têm configuração.");
    expect(vereditoDe(describeSettings(leitura(1, 0)), false)).toBe("1 das 7 áreas ainda não tem configuração.");
    expect(vereditoDe(describeSettings(leitura(2, 0)), false)).toBe("2 das 7 áreas ainda não têm configuração.");

    expect(placarDe(describeSettings(leitura(2, 0)), false)).toEqual({
      secoes: 7,
      configuradas: 4,
      parciais: 0,
      naoConfiguradas: 2,
      naoEditaveis: 1,
      indisponiveis: 0,
    });
  });

  it("área PARCIAL não é contada como 'sem configuração' — era o subtítulo discordando da célula 'Parciais'", () => {
    /*
      O defeito: com uma conta ML fora e Reposição só com regra por marca, o
      subtítulo dizia "3 das 7 áreas ainda não têm configuração" e a faixa,
      logo abaixo, "Não configuradas 1" e "Parciais 2". As duas áreas TÊM
      configuração.
    */
    expect(vereditoDe(describeSettings(leitura(0, 1)), false)).toBe("1 das 7 áreas tem configuração parcial.");
    expect(vereditoDe(describeSettings(leitura(0, 2)), false)).toBe("2 das 7 áreas têm configuração parcial.");
    expect(vereditoDe(describeSettings(leitura(1, 2)), false)).toBe(
      "1 das 7 áreas ainda não tem configuração e 2 têm configuração parcial.",
    );
    expect(vereditoDe(describeSettings(leitura(2, 1)), false)).toBe(
      "2 das 7 áreas ainda não têm configuração e 1 tem configuração parcial.",
    );
  });

  it("os números do veredito são os da faixa, em toda combinação — dois placares não têm como discordar", () => {
    for (const sem of [0, 1, 2] as const) {
      for (const parciais of [0, 1, 2] as const) {
        const secoes = describeSettings(leitura(sem, parciais));
        const placar = placarDe(secoes, false);
        const veredito = vereditoDe(secoes, false) ?? "";

        expect(placar.naoConfiguradas).toBe(sem);
        expect(placar.parciais).toBe(parciais);

        // A zona 1 é a soma das duas: é ela que o rótulo "FALTA CONFIGURAR" abriga.
        expect(secoes.filter((s) => zonaDe(s.state) === 1)).toHaveLength(sem + parciais);

        if (sem > 0) expect(veredito).toContain(`${String(sem)} das 7 áreas ainda não`);
        if (parciais > 0) expect(veredito).toMatch(new RegExp(`\\b${String(parciais)} (das 7 áreas )?(tem|têm) configuração parcial`));
        if (sem === 0) expect(veredito).not.toContain("ainda não");
        if (parciais === 0) expect(veredito).not.toContain("parcial");
      }
    }
  });

  it("sem leitura: nenhum veredito, e as três partes que dependem dela são null — '—' na tela, nunca zero", () => {
    const secoes = describeSettings(null);

    expect(vereditoDe(secoes, true)).toBeNull();

    // 7 / 1 / 6: o total e as duas partes que continuam SABIDAS.
    expect(placarDe(secoes, true)).toEqual({
      secoes: 7,
      configuradas: null,
      parciais: null,
      naoConfiguradas: null,
      naoEditaveis: 1,
      indisponiveis: 6,
    });
  });

  it("qualquer área indisponível derruba o veredito, mesmo sem erro de leitura", () => {
    /*
      `maybeSingle()` sobre zero linhas devolve `data` nulo SEM erro: sem esta
      regra, seis áreas na zona "NÃO FOI POSSÍVEL LER" e o subtítulo dizendo
      "As 7 áreas têm configuração".
    */
    expect(vereditoDe(describeSettings(null), false)).toBeNull();
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

    expect(quemAltera(organizacao, "ADMIN")).toBe(
      "Você é ADMIN — pode alterar. Vale para membros e papéis: o nome da organização não se edita na interface.",
    );
    expect(quemAltera(organizacao, "ANALISTA")).toBe(
      "Você é ANALISTA — peça a um ADMIN. Vale para membros e papéis: o nome da organização não se edita na interface.",
    );

    // Dois papéis na policy: a frase lista os dois, para a pessoa saber a
    // quem recorrer sem abrir a tela dona para descobrir.
    expect(quemAltera(reposicao, "GESTOR")).toBe("Você é GESTOR — pode alterar.");
    expect(quemAltera(reposicao, "OPERADOR")).toBe("Você é OPERADOR — peça a um ADMIN ou GESTOR.");
  });

  it("a segunda cláusula da policy vai junto: o ANALISTA pode SUGERIR conhecimento, e o ADMIN não edita o nome", () => {
    /*
      `knowledge_entries_insert_member` deixa qualquer membro inserir (como
      SUGERIDO), e `organizations` não tem policy de escrita. A frase em
      segunda pessoa dizia só a metade que cabe em `editorRoles`: "Você é
      ANALISTA — peça a um ADMIN ou GESTOR." para quem pode sugerir, e "Você é
      ADMIN — pode alterar." sobre um cartão que começa pelo nome que ninguém
      edita.
    */
    const operacao = section(base(), "operacao");

    expect(quemAltera(operacao, "ANALISTA")).toBe(
      "Você é ANALISTA — peça a um ADMIN ou GESTOR. Qualquer membro pode sugerir uma entrada de conhecimento.",
    );
    expect(quemAltera(operacao, "GESTOR")).toBe(
      "Você é GESTOR — pode alterar. Qualquer membro pode sugerir uma entrada de conhecimento.",
    );
    expect(quemAltera(section(base(), "organizacao"), "ADMIN")).toContain("o nome da organização não se edita na interface");
  });

  it("'self' concorda com o objeto da área, e 'none' diz que o caminho não existe na interface", () => {
    expect(quemAltera(section(base(), "notificacoes"), "ANALISTA")).toBe("Só você altera as suas.");
    expect(quemAltera(section(base(), "preferencias"), "ANALISTA")).toBe("Só você altera os seus.");

    // Papel nenhum muda isto: o teto de IA mora no deploy, fora do produto.
    expect(quemAltera(section(base(), "ia"), "ADMIN")).toBe("Ninguém pela interface — o teto é definido no deploy.");
  });

  it("sem papel conhecido a resposta volta à prosa impessoal das policies — e ela é texto de operador", () => {
    /*
      É o que a tela imprime no ramo em que a associação não pôde ser lida.
      Quem guarda a POLICY é o teste de integração de D-233, que lê
      `pg_policy` e afirma os fatos; ele não compara estas frases. Por isso
      elas podem (e devem) falar a língua do operador: sem número de decisão,
      sem nome de coluna.
    */
    for (const s of describeSettings(null)) {
      expect(quemAltera(s, null)).toBe(s.editors);
      expect(s.editors).not.toMatch(/D-\d/);
      expect(s.editors).not.toContain("slug");
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

      /*
        A SEGUNDA cláusula também: toda prosa com algo depois de ";" ou de
        ". " diz uma coisa que a lista de papéis não diz ("qualquer membro
        sugere", "o nome não se edita"), e a frase em segunda pessoa só a
        carrega se houver `ressalvaQuem`. Comparar só os tokens ADMIN/GESTOR
        deixava essa metade sumir com o teste verde.
      */
      const temSegundaClausula = /;|\.\s+\S/.test(s.editors);

      expect(s.ressalvaQuem !== null, s.id).toBe(temSegundaClausula);
    }
  });

  it("com papel conhecido, a ressalva aparece para TODO papel — não é privilégio de quem altera", () => {
    for (const s of describeSettings(base())) {
      if (s.ressalvaQuem === null) continue;

      for (const papel of PAPEIS) {
        expect(quemAltera(s, papel), `${s.id}/${papel}`).toContain(s.ressalvaQuem);
      }
    }
  });
});

describe("incluiPara — 'Inclui:' só ensina o que quem olha vai achar na tela dona", () => {
  it("ADMIN e papel desconhecido veem todos os termos; os outros papéis não veem o que a tela dona esconde deles", () => {
    const organizacao = section(base(), "organizacao");
    const mercadoLivre = section(base(), "mercado_livre");
    const termos = (s: typeof organizacao, papel: string | null): string[] => incluiPara(s, papel).map((t) => t.termo);

    expect(termos(organizacao, "ADMIN")).toEqual(["Gerenciar acessos", "Convites pendentes", "Histórico de acesso"]);
    expect(termos(organizacao, null)).toEqual(["Gerenciar acessos", "Convites pendentes", "Histórico de acesso"]);

    // `isAdmin` em /usuarios esconde a célula "Convites pendentes" e o painel
    // "Histórico de acesso"; `ehAdmin` em /contas esconde "Conectar conta".
    expect(termos(organizacao, "ANALISTA")).toEqual(["Gerenciar acessos"]);
    expect(termos(mercadoLivre, "GESTOR")).toEqual(["Contas cadastradas"]);
    expect(termos(mercadoLivre, "ADMIN")).toEqual(["Contas cadastradas", "Conectar conta"]);
  });

  it("para nenhum papel a linha 'Inclui:' sai vazia", () => {
    for (const s of describeSettings(base())) {
      for (const papel of [null, ...PAPEIS]) {
        expect(incluiPara(s, papel).length, `${s.id}/${String(papel)}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("avisoDe — consequência medida, e toda frase termina na ação que a resolve", () => {
  it("nenhum ADMIN: a frase não se contradiz — sem ADMIN, nenhuma tela designa um, e ela diz onde se conserta", () => {
    /*
      Inalcançável pela interface (`guard_last_admin`, D-175). A frase de
      antes dizia "ninguém altera membros" e, na mesma linha, "um ADMIN
      precisa ser designado em Usuários" — onde ninguém consegue designá-lo.
    */
    const o = base();
    o.members_total = 3;
    o.members_admin = 0;

    expect(avisoDe(o, "organizacao")).toBe(
      "Nenhum ADMIN na organização: ninguém altera membros nem contas do Mercado Livre, e nenhuma tela consegue designar um — o conserto é direto no banco.",
    );
  });

  it("um ADMIN só, com mais gente na organização: é ponto único de falha, e a frase diz o que fazer", () => {
    const o = base();
    o.members_total = 4;
    o.members_admin = 1;

    expect(avisoDe(o, "organizacao")).toBe(
      "Só uma pessoa é ADMIN. Se ela perder o acesso, ninguém altera membros nem contas do Mercado Livre — promova um segundo ADMIN em Usuários.",
    );
  });

  it("as frases de ADMIN não dizem 'reposição': GESTOR também escreve nela, e a RPC não conta GESTOR", () => {
    /*
      As policies `replenishment_settings_{insert,update,delete}_admin` usam
      `has_org_role(…, ARRAY['ADMIN','GESTOR'])`, e o seed do e2e tem
      exatamente um ADMIN e um GESTOR: "ninguém altera … nem reposição" era
      falso ali, com o cartão Reposição dizendo ao GESTOR "pode alterar".
    */
    for (const admins of [0, 1]) {
      const o = base();
      o.members_total = 4;
      o.members_admin = admins;

      for (const papel of [null, ...PAPEIS]) {
        expect(avisoDe(o, "organizacao", papel)).not.toContain("reposição");
      }
    }

    expect(section(base(), "reposicao").editorRoles).toEqual(["ADMIN", "GESTOR"]);
  });

  it("quem não pode agir recebe o PEDIDO, não a ação: 'peça a um ADMIN que…'", () => {
    /*
      Os 3 ANALISTA de produção liam "promova um segundo ADMIN em Usuários"
      logo acima de "Quem altera: Você é ANALISTA — peça a um ADMIN.".
      Quem pode agir é o `editorRoles` da própria seção.
    */
    const adminUnico = base();
    adminUnico.members_total = 4;

    expect(avisoDe(adminUnico, "organizacao", "ADMIN")).toMatch(/— promova um segundo ADMIN em Usuários\.$/);
    expect(avisoDe(adminUnico, "organizacao", "ANALISTA")).toMatch(
      /— peça a um ADMIN que promova um segundo ADMIN em Usuários\.$/,
    );
    // GESTOR também não promove: organization_members é só ADMIN.
    expect(avisoDe(adminUnico, "organizacao", "GESTOR")).toMatch(/peça a um ADMIN que promova/);

    const contaFora = base();
    contaFora.ml_accounts_connected = 3;

    expect(avisoDe(contaFora, "mercado_livre", "ADMIN")).toMatch(/— reconecte a conta em Contas ML\.$/);
    expect(avisoDe(contaFora, "mercado_livre", "GESTOR")).toMatch(/— peça a um ADMIN que reconecte a conta em Contas ML\.$/);

    const semValidada = base();
    semValidada.knowledge_entries = 5;

    // Validar é ADMIN ou GESTOR (`canManage` em /atendimento/conhecimento).
    expect(avisoDe(semValidada, "operacao", "GESTOR")).toMatch(/— revise as entradas na Base de conhecimento\.$/);
    expect(avisoDe(semValidada, "operacao", "ANALISTA")).toMatch(
      /— peça a um ADMIN ou GESTOR que revise as entradas na Base de conhecimento\.$/,
    );

    // A regra geral de notificação é de quem olha: todo papel a liga sozinho.
    const desligada = base();
    desligada.notification_global_enabled = false;

    for (const papel of PAPEIS) {
      expect(avisoDe(desligada, "notificacoes", papel)).toMatch(/— ligue-a em Preferências de notificação\.$/);
    }
  });

  it("o papel chega ao aviso pela describeSettings — e muda só o FIM da frase", () => {
    const o = base();
    o.members_total = 4;

    const doAdmin = describeSettings(o, "ADMIN").find((s) => s.id === "organizacao")?.aviso ?? "";
    const doAnalista = describeSettings(o, "ANALISTA").find((s) => s.id === "organizacao")?.aviso ?? "";

    expect(doAdmin).toContain("promova um segundo ADMIN em Usuários");
    expect(doAnalista).toContain("peça a um ADMIN que promova");
    expect(doAdmin.split(" — ")[0]).toBe(doAnalista.split(" — ")[0]);
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

  it("base sem nenhuma entrada VALIDADO: o Copiloto só usa o que está validado, e a saída é a base, não a fila de sugeridas", () => {
    /*
      A RPC conta TODAS as entradas e, à parte, só as VALIDADO: três entradas
      recusadas ou arquivadas dão a mesma leitura que três sugeridas. Mandar
      "validar em Revisão pendente" abria, nesse caso, uma fila vazia — a
      frase não pode prometer que há SUGERIDO sem um campo que o diga.
    */
    const o = base();
    o.knowledge_entries = 5;
    o.knowledge_validated = 0;

    expect(avisoDe(o, "operacao")).toBe(
      "Nenhuma entrada validada: o Copiloto só usa o que está VALIDADO, então a base ainda não chega nele — revise as entradas na Base de conhecimento.",
    );
    expect(section(o, "operacao").links.map((l) => l.label)).toContain("Base de conhecimento");

    // Uma validada já chega ao Copiloto: o aviso é sobre a base INTEIRA fora.
    o.knowledge_validated = 1;
    expect(avisoDe(o, "operacao")).toBeNull();

    // Base vazia é "não configurado", e isso o resumo já diz: não é consequência.
    expect(avisoDe(base(), "operacao")).toBeNull();
  });

  it("sem leitura não há aviso: 'não sei' não vira alerta (D-067)", () => {
    expect(avisoDe(null, "organizacao")).toBeNull();

    for (const papel of [null, ...PAPEIS]) {
      for (const s of describeSettings(null, papel)) {
        expect(s.aviso).toBeNull();
      }
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
