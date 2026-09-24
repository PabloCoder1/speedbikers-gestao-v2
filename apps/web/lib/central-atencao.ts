/**
 * "O que precisa da sua atenção" (D-400) — a central de alertas da Central do
 * negócio: uma lista curta, do mais grave para a oportunidade, que junta os
 * sinais que as outras leituras já calcularam.
 *
 * **Nada é detectado aqui.** Cada item é uma CONTAGEM que outra RPC já devolveu
 * — campanhas por nível (`get_sinais_ads`, D-398), anúncios por nível
 * (`get_detector_frete`, D-397/D-399), produtos com margem negativa ou abaixo
 * de 10% (`get_faturamento.por_sku`, D-356), o ritmo da meta
 * (`get_meta_do_mes`, D-395) e a margem geral contra o período anterior (a
 * mesma regra de comparação dos indicadores, 5I). Esta camada decide só o
 * nível do item na lista e a frase, e aponta para a tela que mostra o recorte.
 *
 * **Os quatro níveis do pedido do dono:** crítico (🔴), atenção (🟠),
 * otimização (🟡) e oportunidade de escala (🟢). Item sem contagem não entra —
 * a lista nunca diz "0 campanhas críticas".
 *
 * **O que não está aqui é da Visão Geral:** estoque, atendimento, mediações e
 * a fila de ações moram na home, que é a atenção da operação. A central cuida
 * do dinheiro: margem, frete, Ads e meta.
 */
import type { Tom } from "../components/tone";
import { ritmoDaMeta, type MetaDoMes } from "./central-meta";
import type { Indicador } from "./central-indicadores";
import type { DetectorDeFrete } from "./detector-frete";
import type { ProdutosDoFaturamento } from "./faturamento";
import { formatCount, formatCurrency } from "./format";
import type { SinaisAds } from "./sinais-ads";

export type Severidade = "critico" | "atencao" | "otimizacao" | "oportunidade";

export const ORDEM_DAS_SEVERIDADES: readonly Severidade[] = ["critico", "atencao", "otimizacao", "oportunidade"];

export const SEVERIDADE: Record<Severidade, { readonly rotulo: string; readonly tom: Tom }> = {
  critico: { rotulo: "Crítico", tom: "perigo" },
  atencao: { rotulo: "Atenção", tom: "atencao" },
  otimizacao: { rotulo: "Otimização", tom: "info" },
  oportunidade: { rotulo: "Escala", tom: "ok" },
};

/** "3 alertas críticos", "7 itens que precisam de atenção"… — o cabeçalho da central de alertas. */
export function rotuloDaContagem(severidade: Severidade, n: number): string {
  const um = n === 1;

  switch (severidade) {
    case "critico":
      return `${formatCount(n)} ${um ? "alerta crítico" : "alertas críticos"}`;
    case "atencao":
      return `${formatCount(n)} ${um ? "item que precisa" : "itens que precisam"} de atenção`;
    case "otimizacao":
      return `${formatCount(n)} ${um ? "oportunidade" : "oportunidades"} de otimização`;
    case "oportunidade":
      return `${formatCount(n)} ${um ? "oportunidade" : "oportunidades"} de escala`;
  }
}

export type Categoria = "Ads" | "Frete" | "Produtos" | "Margem" | "Meta";

export interface ItemDeAtencao {
  readonly severidade: Severidade;
  readonly categoria: Categoria;
  /** Quantos itens o alerta representa — o que soma no cabeçalho. */
  readonly quantidade: number;
  readonly texto: string;
  readonly href: string;
}

export interface EntradaDaAtencao {
  /** `null` = a leitura falhou ou o banco ainda não tem a função: o item some, não vira zero. */
  readonly sinaisAds: SinaisAds | null;
  readonly detector: DetectorDeFrete | null;
  readonly produtos: ProdutosDoFaturamento | null;
  /** O indicador de margem da central (`montarIndicadores`), com a variação já julgada. */
  readonly margem: Indicador | null;
  readonly meta: MetaDoMes | null;
  /** "nos últimos 30 dias", "em setembro até ontem"… — como a central chama o período. */
  readonly periodo: string;
  /** O `/faturamento` do mesmo período e conta, onde está a lista de menor margem. */
  /** O ranking de produtos (D-402) no recorte da central; o item acrescenta a ordem. */
  readonly hrefRanking: string;
}

function plural(n: number, um: string, varios: string): string {
  return `${formatCount(n)} ${n === 1 ? um : varios}`;
}

/** A lista, do mais grave para a oportunidade; dentro do nível, o que tem mais itens primeiro. */
/** A mesma lista do ranking, noutra ordem: "prejuizo" são os de margem negativa, "menor_margem" começa por eles. */
function comOrdem(href: string, ordem: "prejuizo" | "menor_margem"): string {
  return `${href}${href.includes("?") ? "&" : "?"}ordem=${ordem}`;
}

export function montarAtencao(e: EntradaDaAtencao): ItemDeAtencao[] {
  const itens: ItemDeAtencao[] = [];
  const ads = e.sinaisAds?.resumo ?? null;
  const frete = e.detector?.resumo ?? null;

  if (ads !== null && ads.critico > 0) {
    itens.push({
      severidade: "critico",
      categoria: "Ads",
      quantidade: ads.critico,
      texto: `${plural(ads.critico, "campanha gastou", "campanhas gastaram")} sem vender ou com ROAS abaixo de 1 na última semana consolidada.`,
      href: "/central/ads?nivel=critico",
    });
  }

  if (e.produtos !== null && e.produtos.skusMargemNegativa > 0) {
    itens.push({
      severidade: "critico",
      categoria: "Produtos",
      quantidade: e.produtos.skusMargemNegativa,
      texto: `${plural(e.produtos.skusMargemNegativa, "produto vendeu", "produtos venderam")} com margem negativa ${e.periodo}.`,
      href: comOrdem(e.hrefRanking, "prejuizo"),
    });
  }

  if (frete !== null && frete.forte > 0) {
    itens.push({
      severidade: "critico",
      categoria: "Frete",
      quantidade: frete.forte,
      texto: `${plural(frete.forte, "anúncio tem", "anúncios têm")} forte indício de frete cadastrado errado.`,
      href: "/central/frete?nivel=forte",
    });
  }

  if (frete !== null && frete.provavel > 0) {
    const excesso =
      frete.excesso_14_dias !== null && frete.excesso_14_dias > 0
        ? ` — nos que pedem revisão, cerca de ${formatCurrency(frete.excesso_14_dias)} de frete a mais em 14 dias`
        : "";

    itens.push({
      severidade: "atencao",
      categoria: "Frete",
      quantidade: frete.provavel,
      texto: `${plural(frete.provavel, "anúncio tem", "anúncios têm")} provável problema de frete${excesso}.`,
      href: "/central/frete?nivel=provavel",
    });
  }

  if (ads !== null && ads.abaixo_meta > 0) {
    itens.push({
      severidade: "atencao",
      categoria: "Ads",
      quantidade: ads.abaixo_meta,
      texto: `${plural(ads.abaixo_meta, "campanha está", "campanhas estão")} com ROAS abaixo de 80% da própria meta.`,
      href: "/central/ads?nivel=abaixo_meta",
    });
  }

  const margem = e.margem;

  if (
    margem !== null &&
    margem.variacao !== null &&
    margem.variacao.relevante &&
    margem.variacao.tom === "perigo" &&
    margem.valor !== null
  ) {
    itens.push({
      severidade: "atencao",
      categoria: "Margem",
      quantidade: 1,
      texto: `A margem sobre a venda caiu ${pontos(margem.variacao.diferenca)} contra o período anterior ${e.periodo}.`,
      href: "#resumo-do-periodo",
    });
  }

  const ritmo = e.meta === null ? null : ritmoDaMeta(e.meta);

  if (ritmo !== null && (ritmo.tom === "perigo" || ritmo.tom === "atencao")) {
    itens.push({
      severidade: ritmo.tom === "perigo" ? "atencao" : "otimizacao",
      categoria: "Meta",
      quantidade: 1,
      texto: `A meta do mês está ${ritmo.texto}.`,
      href: "#meta-e-projecao",
    });
  }

  if (ads !== null && ads.atencao > 0) {
    itens.push({
      severidade: "otimizacao",
      categoria: "Ads",
      quantidade: ads.atencao,
      texto: `${plural(ads.atencao, "campanha tem", "campanhas têm")} CPC subindo com conversão caindo, ou gasto subindo com ROAS caindo.`,
      href: "/central/ads?nivel=atencao",
    });
  }

  if (frete !== null && frete.atencao > 0) {
    itens.push({
      severidade: "otimizacao",
      categoria: "Frete",
      quantidade: frete.atencao,
      texto: `${plural(frete.atencao, "anúncio tem", "anúncios têm")} frete que merece uma olhada.`,
      href: "/central/frete?nivel=atencao",
    });
  }

  if (e.produtos !== null) {
    const apertados = e.produtos.skusAbaixoDaMargem - e.produtos.skusMargemNegativa;

    if (apertados > 0) {
      itens.push({
        severidade: "otimizacao",
        categoria: "Produtos",
        quantidade: apertados,
        texto: `${plural(apertados, "produto vendeu", "produtos venderam")} com margem entre 0% e 10% ${e.periodo}.`,
        href: comOrdem(e.hrefRanking, "menor_margem"),
      });
    }
  }

  if (ads !== null && ads.escala > 0) {
    itens.push({
      severidade: "oportunidade",
      categoria: "Ads",
      quantidade: ads.escala,
      texto: `${plural(ads.escala, "campanha tem", "campanhas têm")} espaço para escalar: acima da meta e no teto do orçamento.`,
      href: "/central/ads?nivel=escala",
    });
  }

  const ordem = (s: Severidade): number => ORDEM_DAS_SEVERIDADES.indexOf(s);

  return itens
    .map((item, indice) => ({ item, indice }))
    .sort((a, b) => ordem(a.item.severidade) - ordem(b.item.severidade) || b.item.quantidade - a.item.quantidade || a.indice - b.indice)
    .map(({ item }) => item);
}

/** Quantos itens em cada nível — a soma das quantidades, para o cabeçalho. */
export function contarPorSeveridade(itens: readonly ItemDeAtencao[]): Record<Severidade, number> {
  const contagem: Record<Severidade, number> = { critico: 0, atencao: 0, otimizacao: 0, oportunidade: 0 };

  for (const item of itens) contagem[item.severidade] += item.quantidade;

  return contagem;
}

const PONTOS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Diferença de fração em pontos percentuais: 0,037 → "3,7 p.p.". */
function pontos(diferenca: number): string {
  return `${PONTOS.format(Math.abs(diferenca) * 100)} p.p.`;
}
