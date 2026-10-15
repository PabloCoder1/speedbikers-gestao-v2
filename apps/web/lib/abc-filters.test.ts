import { describe, expect, it } from "vitest";

import {
  ABC_CRITERIA,
  ABC_CLASSES,
  ABC_ORDERS,
  PAGE_SIZE,
  type AbcFilters,
  buildAbcHref,
  countActiveAbcFilters,
  daysBetween,
  resolveAbcCustomRange,
  resolveAbcWindow,
  resolveAbcCriterion,
  criteriosDoEscopo,
  ordensDoEscopo,
  resolveAbcClass,
  resolveAbcFilters,
  resolveAbcPeriod,
  summarizeAbcWindow,
} from "./abc-filters";

const base: AbcFilters = {
  escopo: "ml",
  accountSlug: null,
  contas: null,
  brand: null,
  category: null,
  kind: null,
  criterion: ABC_CRITERIA[0],
  days: 90,
  custom: null,
  invalidCustom: false,
  onlyWithoutFull: false,
  abcClass: null,
  stock: null,
  movement: null,
  search: null,
  order: ABC_ORDERS[0],
  page: 1,
};

const HOJE = "2026-10-07";

describe("critério e período", () => {
  it("resolve os três critérios", () => {
    expect(resolveAbcCriterion("faturamento").key).toBe("faturamento");
    expect(resolveAbcCriterion("unidades").key).toBe("unidades");
    expect(resolveAbcCriterion("pedidos").key).toBe("pedidos");
  });

  it("critério desconhecido cai em faturamento, que era o comportamento anterior", () => {
    expect(resolveAbcCriterion("margem").key).toBe("faturamento");
    expect(resolveAbcCriterion(undefined).key).toBe("faturamento");
  });

  /**
   * Aceitar um número arbitrário deixaria a tela anunciar "últimos 4.000 dias"
   * sobre uma curva que não tem esse dado — número errado com aparência de
   * configuração.
   */
  it("período fora dos presets cai em 90", () => {
    expect(resolveAbcPeriod("30")).toBe(30);
    expect(resolveAbcPeriod("60")).toBe(60);
    expect(resolveAbcPeriod("7")).toBe(7);
    expect(resolveAbcPeriod("365")).toBe(365);
    expect(resolveAbcPeriod("4000")).toBe(90);
    expect(resolveAbcPeriod("abc")).toBe(90);
    expect(resolveAbcPeriod(undefined)).toBe(90);
  });

  /**
   * A URL antiga ligava o filtro pela mera PRESENÇA de `semFull`, então
   * `?semFull=0` ligava — o oposto do que está escrito.
   */
  it("só `semFull=1` liga o filtro", () => {
    expect(resolveAbcFilters({ semFull: "1" }).onlyWithoutFull).toBe(true);
    expect(resolveAbcFilters({ semFull: "0" }).onlyWithoutFull).toBe(false);
    expect(resolveAbcFilters({}).onlyWithoutFull).toBe(false);
  });

  it("resolve classe ABC e ignora valor desconhecido", () => {
    expect(resolveAbcClass("A")).toBe("A");
    expect(resolveAbcFilters({ classe: "B" }).abcClass).toBe("B");
    expect(resolveAbcFilters({ classe: "D" }).abcClass).toBeNull();
    expect(ABC_CLASSES).toEqual(["A", "B", "C"]);
  });

  it("cada critério carrega o ID da definição do catálogo", () => {
    const aprovados = new Set(["receita_bruta", "unidades_vendidas", "pedidos", "multicanal_compras"]);

    for (const c of ABC_CRITERIA) {
      expect(aprovados.has(c.definitionId)).toBe(true);
    }
  });
});

describe("marca vinda da URL (D-235)", () => {
  it("lê `marca`, apara espaço e trata vazio como ausência", () => {
    expect(resolveAbcFilters({ marca: "OFF RACER" }).brand).toBe("OFF RACER");
    expect(resolveAbcFilters({ marca: "  RT  " }).brand).toBe("RT");
    expect(resolveAbcFilters({ marca: "" }).brand).toBeNull();
    expect(resolveAbcFilters({ marca: "   " }).brand).toBeNull();
    expect(resolveAbcFilters({}).brand).toBeNull();
  });

  it("marca desconhecida NÃO cai num default — vai ao banco e a curva volta vazia", () => {
    // Diferente de critério e período, onde o default é o comportamento certo.
    // Aqui "não existe SKU dessa marca" é uma resposta legítima, e inventar
    // "todas" faria a tela mostrar a curva inteira dizendo que é de uma marca.
    expect(resolveAbcFilters({ marca: "MARCA-QUE-NAO-EXISTE" }).brand).toBe("MARCA-QUE-NAO-EXISTE");
  });

  it("array na URL (`?marca=a&marca=b`) é ignorado, não concatenado", () => {
    expect(resolveAbcFilters({ marca: ["OFF RACER", "RT"] }).brand).toBeNull();
  });
});

describe("buildAbcHref", () => {
  it("defaults ficam fora da URL", () => {
    expect(buildAbcHref(base, {})).toBe("/curva-abc");
  });

  it("preserva as outras dimensões ao trocar uma", () => {
    const atual = { ...base, accountSlug: "sbmotos", onlyWithoutFull: true };

    expect(buildAbcHref(atual, { days: 30 })).toBe("/curva-abc?conta=sbmotos&dias=30&semFull=1");
  });

  it("marca entra na URL como `marca` e convive com a conta (D-235)", () => {
    // Conta e marca são recortes INDEPENDENTES e componíveis: o item pede os
    // dois, e a curva é recalculada dentro da interseção.
    const atual = { ...base, accountSlug: "sbmotos", brand: "OFF RACER" };

    expect(buildAbcHref(atual, {})).toBe("/curva-abc?conta=sbmotos&marca=OFF+RACER");
    expect(buildAbcHref(atual, { brand: null })).toBe("/curva-abc?conta=sbmotos");
  });

  it("classe entra na URL e troca de classe volta para a página 1", () => {
    expect(buildAbcHref(base, { abcClass: "B" })).toBe("/curva-abc?classe=B");
    expect(buildAbcHref({ ...base, abcClass: "A", page: 4 }, { abcClass: "C" })).toBe("/curva-abc?classe=C");
  });

  it("trocar de marca volta para a página 1", () => {
    expect(buildAbcHref({ ...base, brand: "RT", page: 4 }, { brand: "NAVETEC" })).toBe("/curva-abc?marca=NAVETEC");
  });

  it("trocar filtro volta para a página 1", () => {
    expect(buildAbcHref({ ...base, page: 5 }, { days: 30 })).not.toContain("pagina");
  });

  it("navegar entre páginas preserva a página pedida", () => {
    expect(buildAbcHref({ ...base, page: 2 }, { page: 3 })).toBe("/curva-abc?pagina=3");
  });
});

describe("summarizeAbcWindow", () => {
  /** Os números reais medidos em 2026-08-29, antes e depois do filtro "sem Full". */
  it("descreve a curva inteira, não a página", () => {
    const r = summarizeAbcWindow(1, 1492, PAGE_SIZE);

    expect(r.label).toContain("1.492");
    expect(r.totalPages).toBe(30);
  });

  it("última página parcial mostra o intervalo real", () => {
    expect(summarizeAbcWindow(30, 1492, 42).label).toContain("1.451 a 1.492");
  });

  it("uma página só não vira ruído de intervalo", () => {
    expect(summarizeAbcWindow(1, 40, 40).label).toBe("40 SKUs na curva.");
  });

  it("zero é resultado, não erro", () => {
    expect(summarizeAbcWindow(1, 0, 0).totalPages).toBe(0);
  });
});

describe("recortes e filtros novos (D-424)", () => {
  it("categoria, tipo, estoque, movimento, busca e ordem vêm da URL; valor desconhecido é ignorado", () => {
    const f = resolveAbcFilters(
      { categoria: " MANETE ", tipo: "kit", estoque: "sem_local", movimento: "caiu", busca: " 20017 ", ordem: "queda" },
      HOJE,
    );

    expect(f.category).toBe("MANETE");
    expect(f.kind?.value).toBe("KIT");
    expect(f.stock?.key).toBe("sem_local");
    expect(f.movement?.key).toBe("caiu");
    expect(f.search).toBe("20017");
    expect(f.order.key).toBe("queda");

    const ruim = resolveAbcFilters({ tipo: "servico", estoque: "x", movimento: "y", ordem: "z" }, HOJE);

    expect(ruim.kind).toBeNull();
    expect(ruim.stock).toBeNull();
    expect(ruim.movement).toBeNull();
    expect(ruim.order.key).toBe("curva");
  });

  it("a busca é cortada em 80 caracteres", () => {
    expect(resolveAbcFilters({ busca: "x".repeat(200) }, HOJE).search).toHaveLength(80);
  });

  it("os filtros novos entram na URL e voltam iguais", () => {
    const f = resolveAbcFilters(
      { categoria: "MANETE", tipo: "produto", estoque: "sem_estoque", movimento: "novo", busca: "bau", ordem: "cobertura" },
      HOJE,
    );
    const href = buildAbcHref(f, {});

    expect(href).toBe(
      "/curva-abc?categoria=MANETE&tipo=produto&estoque=sem_estoque&movimento=novo&busca=bau&ordem=cobertura",
    );
    expect(resolveAbcFilters(Object.fromEntries(new URL(href, "http://x").searchParams), HOJE)).toEqual(f);
  });

  it("conta quantos filtros fora do padrão estão ligados", () => {
    expect(countActiveAbcFilters(base)).toBe(0);
    expect(countActiveAbcFilters({ ...base, category: "MANETE", search: "bau", days: 30 })).toBe(3);
  });
});

describe("período personalizado e de comparação (D-424)", () => {
  it("aceita `de`/`ate` válidos e o personalizado vence `dias`", () => {
    const f = resolveAbcFilters({ de: "2026-01-01", ate: "2026-03-31", dias: "30" }, HOJE);

    expect(f.custom).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    expect(f.invalidCustom).toBe(false);
    expect(buildAbcHref(f, {})).toBe("/curva-abc?de=2026-01-01&ate=2026-03-31");
  });

  it("recusa invertido, futuro, formato ruim, só um lado e mais de dois anos", () => {
    expect(resolveAbcCustomRange({ de: "2026-03-01", ate: "2026-01-01" }, HOJE).invalid).toBe(true);
    expect(resolveAbcCustomRange({ de: "2026-10-01", ate: "2026-10-08" }, HOJE).invalid).toBe(true);
    expect(resolveAbcCustomRange({ de: "01/01/2026", ate: "2026-02-01" }, HOJE).invalid).toBe(true);
    expect(resolveAbcCustomRange({ de: "2026-01-01" }, HOJE).invalid).toBe(true);
    expect(resolveAbcCustomRange({ de: "2024-01-01", ate: "2026-01-01" }, HOJE).invalid).toBe(true);
    expect(resolveAbcCustomRange({}, HOJE)).toEqual({ custom: null, invalid: false });
  });

  it("escolher um preset descarta o personalizado", () => {
    const f = resolveAbcFilters({ de: "2026-01-01", ate: "2026-03-31" }, HOJE);

    expect(buildAbcHref(f, { days: 30 })).toBe("/curva-abc?dias=30");
  });

  it("a comparação é o período anterior de mesmo tamanho, colado no início", () => {
    expect(resolveAbcWindow(base, HOJE)).toEqual({
      from: "2026-07-10",
      to: HOJE,
      prevFrom: "2026-04-11",
      prevTo: "2026-07-09",
      dayCount: 90,
    });

    const custom = resolveAbcWindow({ ...base, custom: { from: "2026-03-01", to: "2026-03-31" } }, HOJE);

    expect(custom).toMatchObject({ from: "2026-03-01", to: "2026-03-31", prevFrom: "2026-01-29", prevTo: "2026-02-28" });
    expect(daysBetween(custom.prevFrom, custom.prevTo)).toBe(custom.dayCount);
  });
});

describe("recorte de marketplace (D-448, sobre o C-60)", () => {
  it("sem `marketplace` é a curva de sempre; desconhecido cai nela em silêncio", () => {
    expect(resolveAbcFilters({}).escopo).toBe("ml");
    expect(resolveAbcFilters({ marketplace: "amazon" }).escopo).toBe("ml");
    expect(resolveAbcFilters({ marketplace: "todos" }).escopo).toBe("todos");
    expect(resolveAbcFilters({ marketplace: "shopee" }).escopo).toBe("shopee");
  });

  it("a conta do ML é slug só no ML; fora dele, as contas vêm por id num valor só, sem repetição", () => {
    expect(resolveAbcFilters({ conta: "loja-1" }).accountSlug).toBe("loja-1");
    expect(resolveAbcFilters({ marketplace: "todos", conta: "loja-1" }).accountSlug).toBeNull();
    expect(resolveAbcFilters({ marketplace: "todos", contas: "a, b,a,," }).contas).toEqual(["a", "b"]);
    expect(resolveAbcFilters({ contas: "a" }).contas).toBeNull();
    expect(resolveAbcFilters({ marketplace: "shopee", contas: " , " }).contas).toBeNull();
  });

  it("'Pedidos' não existe fora do ML: o link antigo vira 'Compras', e a ordem por pedidos ou cobertura também se ajusta", () => {
    expect(criteriosDoEscopo("ml").map((c) => c.key)).toEqual(["faturamento", "unidades", "pedidos", "compras"]);
    expect(criteriosDoEscopo("todos").map((c) => c.key)).toEqual(["faturamento", "unidades", "compras"]);
    expect(resolveAbcFilters({ marketplace: "todos", criterio: "pedidos" }).criterion.key).toBe("compras");
    expect(resolveAbcFilters({ criterio: "pedidos" }).criterion.key).toBe("pedidos");

    expect(ordensDoEscopo("shopee").map((o) => o.key)).not.toContain("cobertura");
    expect(resolveAbcFilters({ marketplace: "shopee", ordem: "pedidos" }).order.key).toBe("compras");
    expect(resolveAbcFilters({ marketplace: "shopee", ordem: "cobertura" }).order.key).toBe("curva");
  });

  it("'sem Full' não existe na Shopee: a função o recusa sem o ML no recorte", () => {
    expect(resolveAbcFilters({ marketplace: "shopee", semFull: "1" }).onlyWithoutFull).toBe(false);
    expect(resolveAbcFilters({ marketplace: "todos", semFull: "1" }).onlyWithoutFull).toBe(true);
  });

  it("trocar de marketplace leva período e recortes, deixa a conta, e troca o que não existe do outro lado", () => {
    const ml: AbcFilters = {
      ...base,
      accountSlug: "loja-1",
      brand: "Shimano",
      criterion: ABC_CRITERIA[2],
      days: 30,
      onlyWithoutFull: true,
      order: ABC_ORDERS.find((o) => o.key === "cobertura") ?? ABC_ORDERS[0],
    };

    expect(buildAbcHref(ml, { escopo: "todos" })).toBe(
      "/curva-abc?marketplace=todos&marca=Shimano&criterio=compras&dias=30&semFull=1",
    );
    expect(buildAbcHref(ml, { escopo: "shopee" })).toBe("/curva-abc?marketplace=shopee&marca=Shimano&criterio=compras&dias=30");

    const todos: AbcFilters = { ...base, escopo: "todos", contas: ["a", "b"], criterion: ABC_CRITERIA[3] };

    expect(buildAbcHref(todos, {})).toBe("/curva-abc?marketplace=todos&contas=a%2Cb&criterio=compras");
    expect(buildAbcHref(todos, { escopo: "ml" })).toBe("/curva-abc?criterio=compras");
  });

  it("o recorte de marketplace e as contas contam como filtro ativo", () => {
    expect(countActiveAbcFilters({ ...base, escopo: "todos" })).toBe(1);
    expect(countActiveAbcFilters({ ...base, escopo: "shopee", contas: ["a"] })).toBe(2);
  });
});
