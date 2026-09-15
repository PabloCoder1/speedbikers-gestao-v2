import { describe, expect, it } from "vitest";

import {
  MEMBER_STATUSES,
  buildMemberHref,
  matchesMemberFilters,
  memberStatusLabel,
  memberStatusTone,
  resolveMemberFilters,
  resolveMemberStatus,
  summarizeMemberWindow,
  type MemberFilters,
} from "./member-filters";

const base: MemberFilters = { status: null, search: null };

describe("status do membro", () => {
  it("resolve os três estados que o dado sustenta", () => {
    for (const estado of MEMBER_STATUSES) {
      expect(resolveMemberStatus(estado)).toBe(estado);
    }

    expect(MEMBER_STATUSES).toEqual(["ativo", "pendente", "suspenso"]);
  });

  /**
   * "Suspenso" entrou em D-354, quando a suspensão pela `api` virou fonte.
   * "Inativo" continua sem fonte — ir ao recorte com ele devolveria zero
   * linhas, que se lê como "não há ninguém assim" em vez de "esse estado não
   * existe" (D-242).
   */
  it("estado sem fonte vira nulo, e não recorte vazio", () => {
    expect(resolveMemberStatus("inativo")).toBeNull();
    expect(resolveMemberStatus("bloqueado")).toBeNull();
    expect(resolveMemberStatus("ATIVO")).toBeNull();
    expect(resolveMemberStatus(undefined)).toBeNull();
  });

  it("os rótulos", () => {
    expect(memberStatusLabel("ativo")).toBe("Ativo");
    expect(memberStatusLabel("pendente")).toBe("Convite pendente");
    expect(memberStatusLabel("suspenso")).toBe("Suspenso");
  });

  /** Suspenso é ato deliberado de um ADMIN: atenção, não perigo. */
  it("o tom de cada selo", () => {
    expect(memberStatusTone("ativo")).toBe("ok");
    expect(memberStatusTone("pendente")).toBe("neutro");
    expect(memberStatusTone("suspenso")).toBe("atencao");
  });
});

describe("leitura da URL", () => {
  it("lê estado e busca, e descarta só-espaço", () => {
    expect(resolveMemberFilters({ estado: "pendente", busca: "  carla " })).toEqual({
      status: "pendente",
      search: "carla",
    });

    expect(resolveMemberFilters({ estado: "suspenso" })).toEqual({ status: "suspenso", search: null });
    expect(resolveMemberFilters({ busca: "   " })).toEqual({ status: null, search: null });
  });
});

describe("href", () => {
  it("“todos” é a ausência do parâmetro", () => {
    expect(buildMemberHref({ status: "pendente", search: null }, { status: null })).toBe("/usuarios");
  });

  /** Trocar o status PRESERVA a busca: o inverso zeraria o recorte do vizinho. */
  it("um filtro não apaga o outro", () => {
    expect(buildMemberHref({ status: null, search: "rafael" }, { status: "ativo" })).toBe(
      "/usuarios?estado=ativo&busca=rafael",
    );
  });
});

describe("o recorte", () => {
  const carla = { nome: "Carla Nogueira", email: "carla@speedbikers.com.br", status: "ativo" } as const;
  const thiago = { nome: null, email: "thiago@speedbikers.com.br", status: "pendente" } as const;
  const bianca = { nome: "Bianca Sato", email: "bianca@speedbikers.com.br", status: "suspenso" } as const;

  it("sem filtro, todo mundo casa", () => {
    expect(matchesMemberFilters(carla, base)).toBe(true);
    expect(matchesMemberFilters(thiago, base)).toBe(true);
    expect(matchesMemberFilters(bianca, base)).toBe(true);
  });

  it("a busca casa pelo nome e pelo e-mail, sem caixa", () => {
    expect(matchesMemberFilters(carla, { ...base, search: "NOGUEIRA" })).toBe(true);
    expect(matchesMemberFilters(carla, { ...base, search: "carla@" })).toBe(true);
    expect(matchesMemberFilters(carla, { ...base, search: "rafael" })).toBe(false);
  });

  /**
   * Quem foi convidado antes de D-354 pode estar sem nome, e o e-mail é a única
   * coisa pela qual ele pode ser achado.
   */
  it("quem não tem nome ainda é achado pelo e-mail", () => {
    expect(matchesMemberFilters(thiago, { ...base, search: "thiago" })).toBe(true);
  });

  it("o status recorta, e soma com a busca", () => {
    expect(matchesMemberFilters(thiago, { ...base, status: "pendente" })).toBe(true);
    expect(matchesMemberFilters(carla, { ...base, status: "pendente" })).toBe(false);
    expect(matchesMemberFilters(bianca, { ...base, status: "suspenso" })).toBe(true);
    expect(matchesMemberFilters(bianca, { ...base, status: "ativo" })).toBe(false);
    expect(matchesMemberFilters(thiago, { status: "pendente", search: "carla" })).toBe(false);
  });
});

describe("a janela dita em palavras", () => {
  it("sem filtro, diz quantas pessoas há", () => {
    expect(summarizeMemberWindow(3, 3, base)).toBe("3 pessoas nesta organização.");
    expect(summarizeMemberWindow(1, 1, base)).toBe("1 pessoa nesta organização.");
  });

  /*
    O defeito que esta frase impede: filtrar 18 para 3 e a tela mostrar três
    linhas sem dizer que quinze foram escondidas.
  */
  it("com filtro, diz o recorte E o total", () => {
    expect(summarizeMemberWindow(18, 3, { status: "pendente", search: null })).toBe(
      "3 de 18 pessoas, por status convite pendente.",
    );

    expect(summarizeMemberWindow(18, 1, { status: "ativo", search: "carla" })).toBe(
      "1 de 18 pessoas, por status ativo e busca “carla”.",
    );

    expect(summarizeMemberWindow(18, 2, { status: "suspenso", search: null })).toBe(
      "2 de 18 pessoas, por status suspenso.",
    );
  });

  it("zero com filtro não se confunde com organização vazia", () => {
    expect(summarizeMemberWindow(18, 0, { ...base, search: "zzz" })).toBe(
      "Nenhuma das 18 pessoas casa com busca “zzz”.",
    );
  });
});
