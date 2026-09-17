/**
 * O ALCANCE das regras de reposição (D-361) — quanto do catálogo cada regra
 * governa, e quanto fica sem sugestão de compra.
 *
 * `get_replenishment_reach` só CONTA, por marca: SKUs no cadastro, no universo
 * da reposição, com venda nos últimos 30 dias e com regra própria. Quem cruza a
 * contagem com as regras é esta função, pela mesma precedência de
 * `resolveReplenishmentPolicy` (D-144): SKU > marca > padrão da organização, e
 * SKU sem marca só alcança o padrão (D-129). Não há terceira cópia da regra de
 * precedência — há a mesma pergunta feita por grupo em vez de por SKU.
 *
 * "Coberto" quer dizer "tem política aplicável", não "tem sugestão": o SKU
 * coberto ainda pode ser recusado por estoque virtual, histórico ou amostra
 * (D-147). Por isso a tela fala em "com regra", e o número que diz quanto a
 * reposição muda HOJE é o dos que venderam nos últimos 30 dias.
 */

export interface GrupoDoAlcance {
  /** Nula = SKUs sem marca: só o padrão da organização os alcança. */
  readonly marca: string | null;
  readonly skus: number;
  readonly naReposicao: number;
  readonly comVenda30d: number;
  readonly comRegraSku: number;
  readonly comRegraSkuVenda30d: number;
}

/** O mínimo de uma regra que decide o escopo. */
export interface EscopoDaRegra {
  readonly id: string;
  readonly marca: string | null;
  readonly skuId: string | null;
}

export type Governo = "MARCA" | "PADRAO" | "NENHUMA";

export interface AlcanceDaMarca extends GrupoDoAlcance {
  /** Quem governa os SKUs do grupo que não têm regra própria. */
  readonly governo: Governo;
  /** A regra da própria marca, quando existe. */
  readonly regraId: string | null;
  /** SKUs do universo com política aplicável (inclui os de regra própria). */
  readonly cobertos: number;
  readonly cobertosComVenda: number;
}

export interface Alcance {
  /** Só as marcas com nome, na ordem de quem mais destrava. */
  readonly marcas: readonly AlcanceDaMarca[];
  /** O grupo sem marca, quando o catálogo tem SKU sem marca. */
  readonly semMarca: AlcanceDaMarca | null;
  readonly padraoId: string | null;
  readonly totais: {
    readonly naReposicao: number;
    readonly comVenda30d: number;
    readonly cobertos: number;
    readonly cobertosComVenda: number;
    /** Marcas com SKU na reposição, e quantas delas têm regra própria. */
    readonly marcasNaReposicao: number;
    readonly marcasComRegra: number;
  };
  /**
   * Regras de marca que não casam com marca nenhuma do catálogo (a marca foi
   * renomeada ou saiu). Não governam nada, e esconder isso faria a regra
   * parecer ativa.
   */
  readonly regrasOrfas: readonly string[];
}

function lerNumero(valor: unknown): number {
  const n = typeof valor === "number" ? valor : typeof valor === "string" ? Number(valor) : Number.NaN;

  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Lê as linhas da RPC. `bigint` chega como número pelo PostgREST; a guarda de
 * string existe porque o `pg` do teste de integração o entrega como texto.
 */
export function lerGruposDoAlcance(linhas: readonly Record<string, unknown>[]): GrupoDoAlcance[] {
  return linhas.map((linha) => ({
    marca: typeof linha.supplier_brand === "string" ? linha.supplier_brand : null,
    skus: lerNumero(linha.skus),
    naReposicao: lerNumero(linha.skus_na_reposicao),
    comVenda30d: lerNumero(linha.skus_com_venda_30d),
    comRegraSku: lerNumero(linha.skus_com_regra_sku),
    comRegraSkuVenda30d: lerNumero(linha.skus_com_regra_sku_venda_30d),
  }));
}

export function calcularAlcance(grupos: readonly GrupoDoAlcance[], regras: readonly EscopoDaRegra[]): Alcance {
  const padrao = regras.find((r) => r.marca === null && r.skuId === null) ?? null;
  const porMarca = new Map(
    regras.flatMap((r) => (r.marca === null || r.skuId !== null ? [] : [[r.marca, r.id] as const])),
  );

  const avaliados = grupos.map((grupo): AlcanceDaMarca => {
    const regraId = grupo.marca === null ? null : (porMarca.get(grupo.marca) ?? null);
    const governo: Governo = regraId !== null ? "MARCA" : padrao !== null ? "PADRAO" : "NENHUMA";

    // Sem regra de marca nem padrão, só os SKUs de regra própria ficam cobertos.
    const tudo = governo !== "NENHUMA";

    return {
      ...grupo,
      governo,
      regraId,
      cobertos: tudo ? grupo.naReposicao : Math.min(grupo.comRegraSku, grupo.naReposicao),
      cobertosComVenda: tudo ? grupo.comVenda30d : Math.min(grupo.comRegraSkuVenda30d, grupo.comVenda30d),
    };
  });

  const marcas = avaliados
    .filter((g) => g.marca !== null)
    // Quem mais destrava primeiro: venda recente, depois tamanho, depois nome.
    .sort(
      (a, b) =>
        b.comVenda30d - a.comVenda30d ||
        b.naReposicao - a.naReposicao ||
        (a.marca ?? "").localeCompare(b.marca ?? "", "pt-BR"),
    );

  const semMarca = avaliados.find((g) => g.marca === null) ?? null;
  const marcasDoCatalogo = new Set(grupos.map((g) => g.marca).filter((m) => m !== null));

  const somar = (campo: "naReposicao" | "comVenda30d" | "cobertos" | "cobertosComVenda"): number =>
    avaliados.reduce((total, g) => total + g[campo], 0);

  const comSku = marcas.filter((m) => m.naReposicao > 0);

  return {
    marcas,
    semMarca,
    padraoId: padrao?.id ?? null,
    totais: {
      naReposicao: somar("naReposicao"),
      comVenda30d: somar("comVenda30d"),
      cobertos: somar("cobertos"),
      cobertosComVenda: somar("cobertosComVenda"),
      marcasNaReposicao: comSku.length,
      marcasComRegra: comSku.filter((m) => m.governo === "MARCA").length,
    },
    regrasOrfas: [...porMarca.keys()].filter((marca) => !marcasDoCatalogo.has(marca)).sort((a, b) => a.localeCompare(b, "pt-BR")),
  };
}

/**
 * Quantos SKUs do universo uma regra NOVA passaria a cobrir — o "isto destrava
 * N" da gaveta, antes de salvar.
 *
 * Para uma marca: os SKUs dela que hoje não têm política (governo NENHUMA). Se
 * o padrão já existe, a marca já está coberta, e a regra só muda os NÚMEROS da
 * política, não o alcance — a resposta é zero novos, e a tela diz isso.
 *
 * Para o padrão: todo grupo sem regra de marca, inclusive o sem marca.
 */
export function novosCobertos(
  alcance: Alcance,
  escopo: { readonly tipo: "PADRAO" } | { readonly tipo: "MARCA"; readonly marca: string },
): { skus: number; comVenda: number } {
  const grupos = [...alcance.marcas, ...(alcance.semMarca === null ? [] : [alcance.semMarca])];

  const alvo =
    escopo.tipo === "PADRAO"
      ? grupos.filter((g) => g.governo === "NENHUMA")
      : grupos.filter((g) => g.marca === escopo.marca && g.governo === "NENHUMA");

  return {
    skus: alvo.reduce((total, g) => total + (g.naReposicao - g.cobertos), 0),
    comVenda: alvo.reduce((total, g) => total + (g.comVenda30d - g.cobertosComVenda), 0),
  };
}

/**
 * Quantos SKUs uma regra EXISTENTE governa — e para onde eles vão se ela for
 * removida. É a frase de consequência da remoção: "N SKUs passam a usar o
 * padrão" ou "N SKUs ficam sem sugestão".
 */
export function governadosPelaRegra(
  alcance: Alcance,
  escopo: { readonly tipo: "PADRAO" } | { readonly tipo: "MARCA"; readonly marca: string },
): { skus: number; comVenda: number; destinoSemEla: "PADRAO" | "NENHUMA" } {
  const grupos = [...alcance.marcas, ...(alcance.semMarca === null ? [] : [alcance.semMarca])];

  if (escopo.tipo === "PADRAO") {
    const governados = grupos.filter((g) => g.governo === "PADRAO");

    return {
      skus: governados.reduce((total, g) => total + g.naReposicao - g.comRegraSku, 0),
      comVenda: governados.reduce((total, g) => total + g.comVenda30d - g.comRegraSkuVenda30d, 0),
      destinoSemEla: "NENHUMA",
    };
  }

  const grupo = grupos.find((g) => g.marca === escopo.marca && g.governo === "MARCA");

  return {
    skus: grupo === undefined ? 0 : grupo.naReposicao - grupo.comRegraSku,
    comVenda: grupo === undefined ? 0 : grupo.comVenda30d - grupo.comRegraSkuVenda30d,
    destinoSemEla: alcance.padraoId === null ? "NENHUMA" : "PADRAO",
  };
}
