/**
 * A leitura de `get_sinais_ads` (D-398): contrato conferido, rótulo e tom de
 * cada nível, e o texto de cada campanha — o que aconteceu, a possível
 * interpretação e o que vale revisar — escrito só com os números da RPC.
 *
 * **Os sinais saem do SQL.** Esta camada não decide nível nenhum; transforma
 * "cpc 0,61 → 1,01 e conversão 6,8% → 4,8%" em "o CPC subiu 66% enquanto a
 * conversão caiu 29%". As regras e os limiares estão em `docs/METRICS.md` 5M.
 *
 * **O tom é o do pedido do dono:** nunca "pause imediatamente"; "considere",
 * "vale revisar", "avaliar pausa caso o comportamento permaneça". Os dados são
 * de 7 dias — sinal para análise, não decisão automática.
 *
 * **A margem é premissa, e dita.** A API de Product Ads não diz que produtos
 * cada campanha vendeu (D-363); o lucro estimado usa a margem média da empresa
 * no mesmo período, e some quando ela não é conhecida.
 */
import type { Tom } from "../components/tone";
import { formatRoas } from "./central-indicadores";
import { LIMITES_PADRAO } from "./limites-central";
import { formatCurrency, formatPercent } from "./format";

export type NivelAds = "critico" | "abaixo_meta" | "atencao" | "escala" | "normal" | "pausada";

const NIVEIS: readonly NivelAds[] = ["critico", "abaixo_meta", "atencao", "escala", "normal", "pausada"];

export interface SinaisDaCampanha {
  readonly sem_venda: boolean;
  readonly roas_abaixo_de_1: boolean;
  readonly abaixo_da_meta: boolean;
  readonly cpc_sobe_conversao_cai: boolean;
  readonly gasto_sobe_roas_cai: boolean;
  readonly ctr_baixo: boolean;
  readonly conversao_baixa: boolean;
  readonly no_teto_acima_da_meta: boolean;
}

export interface CampanhaSinal {
  readonly ml_account_id: string;
  readonly conta: string;
  readonly campaign_id: number;
  readonly nome: string;
  readonly status: string | null;
  readonly estrategia: string | null;
  readonly orcamento: number | null;
  readonly roas_alvo: number | null;
  readonly acos_alvo: number | null;
  readonly nivel: NivelAds;
  readonly investimento: number;
  readonly receita_ads: number;
  readonly unidades: number;
  readonly cliques: number;
  readonly impressoes: number;
  readonly dias: number;
  readonly dias_no_teto: number;
  readonly roas: number | null;
  readonly acos: number | null;
  readonly ctr: number | null;
  readonly cpc: number | null;
  readonly conversao: number | null;
  readonly cpa: number | null;
  readonly ticket: number | null;
  readonly uso_orcamento: number | null;
  readonly investimento_anterior: number;
  readonly receita_ads_anterior: number;
  readonly unidades_anterior: number;
  readonly cliques_anterior: number;
  readonly roas_anterior: number | null;
  readonly cpc_anterior: number | null;
  readonly conversao_anterior: number | null;
  readonly sinais: SinaisDaCampanha;
}

export interface JanelaAds {
  readonly inicio: string | null;
  readonly fim: string | null;
  readonly anterior_inicio: string | null;
  readonly anterior_fim: string | null;
  readonly dias_pendentes: readonly string[];
}

export interface ResumoSinaisAds {
  readonly campanhas: number;
  readonly critico: number;
  readonly abaixo_meta: number;
  readonly atencao: number;
  readonly escala: number;
  readonly normal: number;
  readonly pausada: number;
  readonly investimento: number;
  readonly receita_ads: number;
  readonly roas: number | null;
  readonly investimento_anterior: number;
  readonly receita_ads_anterior: number;
  readonly roas_anterior: number | null;
}

export interface SinaisAds {
  readonly janela: JanelaAds;
  readonly referencias: { readonly ctr_mediano: number | null; readonly conversao_mediana: number | null };
  readonly resumo: ResumoSinaisAds;
  readonly campanhas: readonly CampanhaSinal[];
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

function booleano(r: Registro, chave: string): boolean {
  const v = r[chave];

  if (typeof v !== "boolean") throw new ForaDoContrato(chave);

  return v;
}

function datas(valor: unknown): string[] {
  if (!Array.isArray(valor) || !valor.every((d): d is string => typeof d === "string")) throw new ForaDoContrato("datas");

  return valor;
}

const CAMPANHA_NUMEROS = [
  "campaign_id",
  "investimento",
  "receita_ads",
  "unidades",
  "cliques",
  "impressoes",
  "dias",
  "dias_no_teto",
  "investimento_anterior",
  "receita_ads_anterior",
  "unidades_anterior",
  "cliques_anterior",
] as const;

const CAMPANHA_NULOS = [
  "orcamento",
  "roas_alvo",
  "acos_alvo",
  "roas",
  "acos",
  "ctr",
  "cpc",
  "conversao",
  "cpa",
  "ticket",
  "uso_orcamento",
  "roas_anterior",
  "cpc_anterior",
  "conversao_anterior",
] as const;

const SINAIS = [
  "sem_venda",
  "roas_abaixo_de_1",
  "abaixo_da_meta",
  "cpc_sobe_conversao_cai",
  "gasto_sobe_roas_cai",
  "ctr_baixo",
  "conversao_baixa",
  "no_teto_acima_da_meta",
] as const;

function lerCampanha(valor: unknown): CampanhaSinal {
  const r = registro(valor);
  const s = registro(r.sinais);
  const nivel = texto(r, "nivel");

  if (!(NIVEIS as readonly string[]).includes(nivel)) throw new ForaDoContrato("nivel");

  const numeros: Record<string, number> = {};
  const nulos: Record<string, number | null> = {};
  const sinais: Record<string, boolean> = {};

  for (const chave of CAMPANHA_NUMEROS) numeros[chave] = numero(r, chave);
  for (const chave of CAMPANHA_NULOS) nulos[chave] = numeroOuNulo(r, chave);
  for (const chave of SINAIS) sinais[chave] = booleano(s, chave);

  return {
    ...(numeros as Pick<CampanhaSinal, (typeof CAMPANHA_NUMEROS)[number]>),
    ...(nulos as Pick<CampanhaSinal, (typeof CAMPANHA_NULOS)[number]>),
    ml_account_id: texto(r, "ml_account_id"),
    conta: texto(r, "conta"),
    nome: texto(r, "nome"),
    status: textoOuNulo(r, "status"),
    estrategia: textoOuNulo(r, "estrategia"),
    nivel: nivel as NivelAds,
    sinais: sinais as unknown as SinaisDaCampanha,
  };
}

const RESUMO_NUMEROS = [
  "campanhas",
  "critico",
  "abaixo_meta",
  "atencao",
  "escala",
  "normal",
  "pausada",
  "investimento",
  "receita_ads",
  "investimento_anterior",
  "receita_ads_anterior",
] as const;

/** Os sinais lidos, ou `null` quando a resposta não é a que esta tela conhece. */
export function lerSinaisAds(valor: unknown): SinaisAds | null {
  try {
    const r = registro(valor);
    const j = registro(r.janela);
    const ref = registro(r.referencias);
    const rs = registro(r.resumo);

    if (!Array.isArray(r.campanhas)) throw new ForaDoContrato("campanhas");

    const resumo: Record<string, number> = {};

    for (const chave of RESUMO_NUMEROS) resumo[chave] = numero(rs, chave);

    return {
      janela: {
        inicio: textoOuNulo(j, "inicio"),
        fim: textoOuNulo(j, "fim"),
        anterior_inicio: textoOuNulo(j, "anterior_inicio"),
        anterior_fim: textoOuNulo(j, "anterior_fim"),
        dias_pendentes: datas(j.dias_pendentes),
      },
      referencias: {
        ctr_mediano: numeroOuNulo(ref, "ctr_mediano"),
        conversao_mediana: numeroOuNulo(ref, "conversao_mediana"),
      },
      resumo: {
        ...(resumo as Omit<ResumoSinaisAds, "roas" | "roas_anterior">),
        roas: numeroOuNulo(rs, "roas"),
        roas_anterior: numeroOuNulo(rs, "roas_anterior"),
      },
      campanhas: r.campanhas.map(lerCampanha),
    };
  } catch (erro) {
    if (erro instanceof ForaDoContrato) return null;

    throw erro;
  }
}

// ── rótulos ────────────────────────────────────────────────────────────────

/** Os níveis do pedido do dono (🔴 crítico, 🟠 ROAS abaixo da meta, 🟡 atenção, 🟢 escala) nos tons do app. */
export const NIVEL_ADS: Record<NivelAds, { readonly rotulo: string; readonly tom: Tom }> = {
  critico: { rotulo: "Crítico", tom: "perigo" },
  abaixo_meta: { rotulo: "ROAS abaixo da meta", tom: "atencao" },
  atencao: { rotulo: "Atenção", tom: "info" },
  escala: { rotulo: "Oportunidade de escala", tom: "ok" },
  normal: { rotulo: "Normal", tom: "neutro" },
  pausada: { rotulo: "Pausada", tom: "neutro" },
};

/** Os níveis que viram cartão, na ordem da tela. */
export const NIVEIS_COM_SINAL: readonly NivelAds[] = ["critico", "abaixo_meta", "atencao", "escala"];

/** Quantas campanhas pedem revisão: crítico, abaixo da meta e atenção. Escala é oportunidade, não problema. */
export function paraRevisarAds(r: ResumoSinaisAds): number {
  return r.critico + r.abaixo_meta + r.atencao;
}

// ── margem, como premissa ──────────────────────────────────────────────────

/**
 * O que a margem média da empresa permite estimar numa campanha: o lucro depois
 * do Ads (`vendas × margem − investimento`), a margem depois do Ads
 * (`margem − ACOS`) e o ROAS de equilíbrio (`1 ÷ margem`, o ROAS abaixo do qual
 * o Ads come a margem inteira). Sem margem, nada é estimado.
 */
export interface Estimativa {
  readonly lucro: number | null;
  readonly margemAposAds: number | null;
}

export function estimar(c: Pick<CampanhaSinal, "receita_ads" | "investimento" | "acos">, margem: number | null): Estimativa {
  if (margem === null) return { lucro: null, margemAposAds: null };

  return {
    lucro: c.receita_ads * margem - c.investimento,
    margemAposAds: c.acos === null ? null : margem - c.acos,
  };
}

export function roasDeEquilibrio(margem: number | null): number | null {
  return margem === null || margem <= 0 ? null : 1 / margem;
}


// ── texto ──────────────────────────────────────────────────────────────────

const INTEIRO = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 0 });

function relativo(atual: number, anterior: number): string {
  return INTEIRO.format(Math.abs(atual / anterior - 1));
}

export interface LeituraDaCampanha {
  /** O que aconteceu, com os números. Um item por sinal. */
  readonly motivos: readonly string[];
  /** A possível causa, quando os números sustentam uma. */
  readonly interpretacao: string | null;
  /** O que vale revisar, no tom do pedido. */
  readonly sugestao: string;
}

/**
 * O texto de uma campanha com sinal. `margem` é a margem média da empresa no
 * período (ou `null`); `ref` são as medianas da semana; `margemBaixa`, a
 * margem depois do Ads abaixo da qual escalar não é recomendado (D-408).
 */
export function lerCampanhaSinal(
  c: CampanhaSinal,
  ref: SinaisAds["referencias"],
  margem: number | null,
  margemBaixa: number = LIMITES_PADRAO.margemAposAdsBaixa,
): LeituraDaCampanha {
  const s = c.sinais;
  const motivos: string[] = [];

  if (s.sem_venda) {
    motivos.push(
      `Gastou ${formatCurrency(c.investimento)} em 7 dias sem nenhuma venda atribuída pelo Mercado Livre ` +
        `(${String(c.cliques)} cliques).`,
    );
  }

  if (s.roas_abaixo_de_1 && c.roas !== null) {
    motivos.push(
      `ROAS ${formatRoas(c.roas)}: o Ads custou ${formatCurrency(c.investimento)} e vendeu ` +
        `${formatCurrency(c.receita_ads)} — gastou mais do que vendeu.`,
    );
  }

  if (s.abaixo_da_meta && c.roas !== null && c.roas_alvo !== null) {
    motivos.push(
      `ROAS ${formatRoas(c.roas)} contra a meta de ${formatRoas(c.roas_alvo)} da campanha ` +
        `(${relativo(c.roas, c.roas_alvo)} abaixo), com ${formatCurrency(c.investimento)} investidos.`,
    );
  }

  if (s.cpc_sobe_conversao_cai && c.cpc !== null && c.cpc_anterior !== null && c.conversao !== null && c.conversao_anterior !== null) {
    motivos.push(
      `O CPC subiu ${relativo(c.cpc, c.cpc_anterior)} (de ${formatCurrency(c.cpc_anterior)} para ${formatCurrency(c.cpc)}) ` +
        `enquanto a conversão caiu ${relativo(c.conversao, c.conversao_anterior)} ` +
        `(de ${formatPercent(c.conversao_anterior)} para ${formatPercent(c.conversao)} dos cliques).`,
    );
  }

  if (s.gasto_sobe_roas_cai && c.roas !== null && c.roas_anterior !== null) {
    motivos.push(
      `O gasto subiu ${relativo(c.investimento, c.investimento_anterior)} ` +
        `(de ${formatCurrency(c.investimento_anterior)} para ${formatCurrency(c.investimento)}) e o ROAS caiu ` +
        `${relativo(c.roas, c.roas_anterior)} (de ${formatRoas(c.roas_anterior)} para ${formatRoas(c.roas)}).`,
    );
  }

  if (c.nivel === "escala" && c.roas !== null && c.roas_alvo !== null) {
    const vendas =
      c.receita_ads_anterior > 0 && c.receita_ads > c.receita_ads_anterior
        ? `, com as vendas com Ads ${relativo(c.receita_ads, c.receita_ads_anterior)} acima da semana anterior`
        : "";

    motivos.push(
      `ROAS ${formatRoas(c.roas)} acima da meta de ${formatRoas(c.roas_alvo)}, usando ` +
        `${formatPercent(c.uso_orcamento)} do orçamento diário (${String(c.dias_no_teto)} de 7 dias no teto)${vendas}.`,
    );
  }

  return { motivos, interpretacao: interpretar(c, ref), sugestao: sugerir(c, margem, margemBaixa) };
}

function interpretar(c: CampanhaSinal, ref: SinaisAds["referencias"]): string | null {
  const s = c.sinais;
  const problema = c.nivel === "critico" || c.nivel === "abaixo_meta";

  if (problema && s.ctr_baixo && c.ctr !== null && ref.ctr_mediano !== null) {
    return (
      `CTR de ${formatPercent(c.ctr)} contra ${formatPercent(ref.ctr_mediano)} da mediana das suas campanhas: ` +
      "o anúncio aparece, mas atrai pouco clique — o criativo ou a oferta pode estar pouco atrativo."
    );
  }

  if (problema && s.conversao_baixa && c.conversao !== null && ref.conversao_mediana !== null) {
    return (
      `Conversão de ${formatPercent(c.conversao)} dos cliques contra ${formatPercent(ref.conversao_mediana)} da mediana ` +
      "das suas campanhas: o anúncio chama atenção, mas a página ou o produto não converte."
    );
  }

  if (s.gasto_sobe_roas_cai) return "Mais gasto trazendo retorno menor: pode ser saturação, CPC em alta ou queda de conversão.";

  if (s.cpc_sobe_conversao_cai) return "O clique ficou mais caro e menos eficiente: concorrência no leilão ou perda de atratividade da oferta.";

  return null;
}

function sugerir(c: CampanhaSinal, margem: number | null, margemBaixa: number): string {
  const s = c.sinais;

  if (c.nivel === "critico") {
    return s.sem_venda
      ? "Considere reduzir o orçamento e investigar preço, frete, estoque e a página do produto. Avaliar pausa caso o comportamento permaneça."
      : "Considere reduzir o orçamento e revisar a rentabilidade dos produtos anunciados antes de continuar. Avaliar pausa caso o comportamento permaneça.";
  }

  if (c.nivel === "abaixo_meta") {
    if (s.ctr_baixo) return "Vale testar nova imagem e outro título, revisar o preço e comparar a oferta com a dos concorrentes.";

    if (s.conversao_baixa) {
      return "Vale revisar preço, frete, prazo de entrega, avaliações, reputação, descrição, fotos, estoque e concorrência.";
    }

    return "Vale revisar segmentação, termos de busca, criativos e a rentabilidade dos produtos anunciados antes de aumentar o orçamento.";
  }

  if (c.nivel === "atencao") {
    return s.gasto_sobe_roas_cai
      ? "Evitar escalar por enquanto. Vale investigar saturação, aumento do CPC, queda de conversão ou mudança de concorrência."
      : "A campanha apresenta sinais que justificam análise antes de continuar escalando: vale olhar a concorrência e a página do produto.";
  }

  if (c.nivel === "escala") {
    const { margemAposAds } = estimar(c, margem);

    if (margemAposAds !== null && margemAposAds < margemBaixa) {
      return (
        `Apesar do bom retorno publicitário, a margem estimada depois do Ads é de ${formatPercent(margemAposAds)}. ` +
        "Não aumentar o orçamento antes de revisar custos, preço, frete e comissão."
      );
    }

    return margem === null
      ? "Campanha potencialmente escalável. Avaliar aumento gradual de orçamento — a margem do período não é conhecida, então o lucro não foi estimado."
      : "Campanha potencialmente escalável. Avaliar aumento gradual de orçamento.";
  }

  return "";
}
