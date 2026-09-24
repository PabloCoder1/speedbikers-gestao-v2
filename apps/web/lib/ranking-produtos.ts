/**
 * A leitura de `get_ranking_produtos` (D-402): contrato conferido, as ordens
 * do ranking e as frases do resumo, escritas só com os números da RPC.
 *
 * **O cálculo é do SQL.** Esta camada não soma nem ordena: escolhe a ordem pela
 * URL, confere o formato e transforma "52 de 1.188" em frase. As regras e os
 * mínimos estão em `docs/METRICS.md` 5N.
 *
 * **Ads por produto não existe.** A API de Product Ads não diz que produtos
 * cada campanha vendeu, e a de anúncio foi desligada (D-363): o ranking não
 * tem "maior gasto com Ads", e a tela diz por quê.
 */
import { formatCount, formatCurrency, formatPercent } from "./format";

export type OrdemRanking =
  | "receita"
  | "lucro"
  | "margem"
  | "menor_margem"
  | "volume"
  | "frete"
  | "prejuizo"
  | "crescimento"
  | "queda_margem";

export interface DefinicaoDaOrdem {
  readonly id: OrdemRanking;
  readonly rotulo: string;
  /** O que a lista mostra e quem entra nela. */
  readonly descricao: string;
}

/** Na ordem das abas. Os mínimos repetem METRICS 5N. */
export const ORDENS_RANKING: readonly DefinicaoDaOrdem[] = [
  { id: "receita", rotulo: "Maior faturamento", descricao: "Receita bruta do período, da maior para a menor." },
  {
    id: "lucro",
    rotulo: "Maior lucro",
    descricao: "Resultado da venda (receita − comissão − frete − custo) nos pedidos cobertos.",
  },
  {
    id: "margem",
    rotulo: "Maior margem",
    descricao: "Resultado ÷ receita nos pedidos cobertos; só produtos com 3 pedidos cobertos ou mais.",
  },
  {
    id: "menor_margem",
    rotulo: "Menor margem",
    descricao: "A menor margem primeiro, com qualquer número de pedidos: uma venda no prejuízo já importa.",
  },
  { id: "volume", rotulo: "Maior volume", descricao: "Unidades vendidas no período." },
  { id: "frete", rotulo: "Maior frete", descricao: "Frete pago pelo vendedor nos pedidos cobertos." },
  { id: "prejuizo", rotulo: "No prejuízo", descricao: "Produtos com resultado negativo no período, do maior prejuízo ao menor." },
  {
    id: "crescimento",
    rotulo: "Crescimento",
    descricao: "Receita contra o período anterior; só produtos com 5 pedidos ou mais nos dois.",
  },
  {
    id: "queda_margem",
    rotulo: "Queda de margem",
    descricao: "Margem contra o período anterior, a maior queda primeiro; só produtos com 5 pedidos cobertos nos dois.",
  },
];

export const ORDEM_PADRAO: OrdemRanking = "receita";

export const POR_PAGINA = 50;

export function ordemDaUrl(valor: unknown): OrdemRanking {
  return ORDENS_RANKING.find((o) => o.id === valor)?.id ?? ORDEM_PADRAO;
}

export function definicaoDaOrdem(ordem: OrdemRanking): DefinicaoDaOrdem {
  const definicao = ORDENS_RANKING.find((o) => o.id === ordem);

  if (definicao === undefined) throw new Error(`ordem sem definição: ${ordem}`);

  return definicao;
}

/** A página pedida na URL, de 1 em diante. */
export function paginaDaUrl(valor: unknown): number {
  const n = typeof valor === "string" && /^\d{1,4}$/.test(valor) ? Number(valor) : 1;

  return n >= 1 ? n : 1;
}

export interface ProdutoDoRanking {
  readonly sku_id: string;
  readonly sku: string;
  readonly title: string | null;
  readonly unidades: number;
  readonly pedidos: number;
  readonly receita_bruta: number;
  readonly taxas_ml: number | null;
  readonly pedidos_cobertos: number;
  readonly receita_coberta: number | null;
  readonly frete_vendedor: number | null;
  readonly custo_produtos: number | null;
  readonly resultado_venda: number | null;
  readonly margem_venda: number | null;
  readonly imposto: number | null;
  readonly resultado_apos_imposto: number | null;
  readonly margem_apos_imposto: number | null;
  readonly custo_atual: boolean;
  readonly pedidos_anterior: number;
  readonly receita_anterior: number | null;
  readonly margem_anterior: number | null;
  readonly variacao_receita: number | null;
  readonly variacao_margem: number | null;
  readonly frete_sobre_receita: number | null;
}

export interface ResumoDoRanking {
  readonly skus_com_venda: number;
  readonly receita_bruta: number | null;
  readonly receita_bruta_anterior: number | null;
  readonly skus_cobertos: number;
  readonly resultado_venda: number | null;
  readonly skus_prejuizo: number;
  readonly prejuizo: number | null;
  readonly skus_margem_abaixo_10: number;
  readonly skus_comparaveis: number;
  readonly skus_crescendo: number;
  readonly skus_margem_comparavel: number;
  readonly skus_queda_margem: number;
  readonly skus_metade_do_resultado: number | null;
}

export interface RankingDeProdutos {
  readonly periodo: {
    readonly inicio: string;
    readonly fim: string;
    readonly anterior_inicio: string;
    readonly anterior_fim: string;
  };
  readonly ordem: OrdemRanking;
  readonly resumo: ResumoDoRanking;
  readonly total: number;
  readonly itens: readonly ProdutoDoRanking[];
}

// ── contrato ───────────────────────────────────────────────────────────────

class ForaDoContrato extends Error {}

type Registro = Record<string, unknown>;

function registro(valor: unknown): Registro {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) throw new ForaDoContrato("objeto");

  return valor as Registro;
}

function numeroOuNulo(r: Registro, chave: string): number | null {
  if (!(chave in r)) throw new ForaDoContrato(chave);

  const v = r[chave];

  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);

  throw new ForaDoContrato(chave);
}

function numero(r: Registro, chave: string): number {
  const n = numeroOuNulo(r, chave);

  if (n === null) throw new ForaDoContrato(chave);

  return n;
}

function textoOuNulo(r: Registro, chave: string): string | null {
  if (!(chave in r)) throw new ForaDoContrato(chave);

  const v = r[chave];

  if (v === null) return null;
  if (typeof v !== "string") throw new ForaDoContrato(chave);

  return v;
}

function texto(r: Registro, chave: string): string {
  const v = textoOuNulo(r, chave);

  if (v === null) throw new ForaDoContrato(chave);

  return v;
}

const ITEM_NUMEROS = ["unidades", "pedidos", "receita_bruta", "pedidos_cobertos", "pedidos_anterior"] as const;

// `taxas_ml` é NULL quando um pedido do SKU chegou sem `sale_fee` — como em get_faturamento.
const ITEM_NULOS = [
  "taxas_ml",
  "receita_coberta",
  "frete_vendedor",
  "custo_produtos",
  "resultado_venda",
  "margem_venda",
  "imposto",
  "resultado_apos_imposto",
  "margem_apos_imposto",
  "receita_anterior",
  "margem_anterior",
  "variacao_receita",
  "variacao_margem",
  "frete_sobre_receita",
] as const;

function lerItem(valor: unknown): ProdutoDoRanking {
  const r = registro(valor);
  const campos: Record<string, number | null> = {};

  for (const chave of ITEM_NUMEROS) campos[chave] = numero(r, chave);
  for (const chave of ITEM_NULOS) campos[chave] = numeroOuNulo(r, chave);

  if (typeof r.custo_atual !== "boolean") throw new ForaDoContrato("custo_atual");

  return {
    ...(campos as Omit<ProdutoDoRanking, "sku_id" | "sku" | "title" | "custo_atual">),
    sku_id: texto(r, "sku_id"),
    sku: texto(r, "sku"),
    title: textoOuNulo(r, "title"),
    custo_atual: r.custo_atual,
  };
}

const RESUMO_NUMEROS = [
  "skus_com_venda",
  "skus_cobertos",
  "skus_prejuizo",
  "skus_margem_abaixo_10",
  "skus_comparaveis",
  "skus_crescendo",
  "skus_margem_comparavel",
  "skus_queda_margem",
] as const;

const RESUMO_NULOS = [
  "receita_bruta",
  "receita_bruta_anterior",
  "resultado_venda",
  "prejuizo",
  "skus_metade_do_resultado",
] as const;

/** O ranking lido, ou `null` quando a resposta não é a que esta tela conhece. */
export function lerRankingProdutos(valor: unknown): RankingDeProdutos | null {
  try {
    const r = registro(valor);
    const p = registro(r.periodo);
    const rs = registro(r.resumo);

    if (!Array.isArray(r.itens)) throw new ForaDoContrato("itens");

    const ordem = ORDENS_RANKING.find((o) => o.id === r.ordem)?.id;

    if (ordem === undefined) throw new ForaDoContrato("ordem");

    const resumo: Record<string, number | null> = {};

    for (const chave of RESUMO_NUMEROS) resumo[chave] = numero(rs, chave);
    for (const chave of RESUMO_NULOS) resumo[chave] = numeroOuNulo(rs, chave);

    return {
      periodo: {
        inicio: texto(p, "inicio"),
        fim: texto(p, "fim"),
        anterior_inicio: texto(p, "anterior_inicio"),
        anterior_fim: texto(p, "anterior_fim"),
      },
      ordem,
      resumo: resumo as unknown as ResumoDoRanking,
      total: numero(r, "total"),
      itens: r.itens.map(lerItem),
    };
  } catch (erro) {
    if (erro instanceof ForaDoContrato) return null;

    throw erro;
  }
}

// ── o que os números dizem ─────────────────────────────────────────────────

const INTEIRO = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 0 });
const UMA_CASA = new Intl.NumberFormat("pt-BR", { style: "percent", minimumFractionDigits: 1, maximumFractionDigits: 1 });
const PONTOS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "+20%", "−35%": variação relativa com sinal, sem casa decimal. */
export function formatVariacao(fracao: number | null): string {
  if (fracao === null) return "—";

  const texto = INTEIRO.format(Math.abs(fracao));

  if (Math.round(fracao * 100) === 0) return texto;

  return fracao > 0 ? `+${texto}` : `−${texto}`;
}

/** "−4,0 p.p.": diferença de margem com sinal. */
export function formatPontos(fracao: number | null): string {
  if (fracao === null) return "—";

  const texto = `${PONTOS.format(Math.abs(fracao) * 100)} p.p.`;

  if (Math.round(fracao * 1000) === 0) return texto;

  return fracao > 0 ? `+${texto}` : `−${texto}`;
}

function plural(n: number, um: string, varios: string): string {
  return `${formatCount(n)} ${n === 1 ? um : varios}`;
}

export interface FraseDoRanking {
  readonly texto: string;
  /** A aba que abre a lista da frase. */
  readonly ordem: OrdemRanking;
}

/**
 * As frases do resumo, na ordem do que pede ação: prejuízo, queda de margem,
 * concentração e crescimento. Contagem zero não vira frase; número ausente
 * (NULL) também não.
 */
export function frasesDoRanking(r: ResumoDoRanking): FraseDoRanking[] {
  const frases: FraseDoRanking[] = [];

  if (r.skus_prejuizo > 0 && r.prejuizo !== null) {
    frases.push({
      texto: `${plural(r.skus_prejuizo, "produto vendeu", "produtos venderam")} com prejuízo: ${formatCurrency(r.prejuizo)} de resultado somado.`,
      ordem: "prejuizo",
    });
  }

  if (r.skus_queda_margem > 0) {
    frases.push({
      texto: `${plural(r.skus_queda_margem, "produto perdeu", "produtos perderam")} 5 p.p. de margem ou mais contra o período anterior (de ${formatCount(r.skus_margem_comparavel)} comparáveis).`,
      ordem: "queda_margem",
    });
  }

  if (r.skus_metade_do_resultado !== null && r.resultado_venda !== null) {
    const parcela = r.skus_com_venda > 0 ? r.skus_metade_do_resultado / r.skus_com_venda : null;

    frases.push({
      texto: `${plural(r.skus_metade_do_resultado, "produto faz", "produtos fazem")} metade dos ${formatCurrency(r.resultado_venda)} de resultado das vendas${
        parcela === null ? "" : ` — ${UMA_CASA.format(parcela)} dos ${formatCount(r.skus_com_venda)} vendidos`
      }.`,
      ordem: "lucro",
    });
  }

  if (r.skus_crescendo > 0) {
    const geral =
      r.receita_bruta !== null && r.receita_bruta_anterior !== null && r.receita_bruta_anterior > 0
        ? r.receita_bruta / r.receita_bruta_anterior - 1
        : null;

    frases.push({
      texto: `${plural(r.skus_crescendo, "produto cresceu", "produtos cresceram")} 30% ou mais em receita, de ${formatCount(r.skus_comparaveis)} comparáveis${
        geral === null ? "" : `; a receita de todos os produtos variou ${formatVariacao(geral)}`
      }.`,
      ordem: "crescimento",
    });
  }

  return frases;
}

/** A coluna que a ordem destaca, para a tela saber qual número pôr em evidência. */
export function valorDaOrdem(ordem: OrdemRanking, p: ProdutoDoRanking): string {
  switch (ordem) {
    case "receita":
      return formatCurrency(p.receita_bruta);
    case "lucro":
    case "prejuizo":
      return formatCurrency(p.resultado_venda);
    case "margem":
    case "menor_margem":
      return formatPercent(p.margem_venda);
    case "volume":
      return formatCount(p.unidades);
    case "frete":
      return formatCurrency(p.frete_vendedor);
    case "crescimento":
      return formatVariacao(p.variacao_receita);
    case "queda_margem":
      return formatPontos(p.variacao_margem);
  }
}
