/**
 * A leitura de `get_detector_frete` (D-397): contrato conferido, rótulo e tom
 * de cada nível, e o MOTIVO de cada alerta escrito a partir dos números que a
 * RPC devolveu.
 *
 * **Nada aqui calcula sinal.** Pontos, níveis e referências saem do SQL; esta
 * camada só transforma "frete_atual 24,70 e frete_antes 11,20" em "Frete 121%
 * acima do que este anúncio pagava". Um motivo só é escrito quando o sinal
 * pontuou, e com os números que o fizeram pontuar — a tela nunca afirma o que a
 * RPC não mediu. As regras e os limiares estão em `docs/METRICS.md` 5L.
 *
 * **O tom das sugestões é o do pedido do dono:** "vale conferir", "vale
 * revisar" — o detector aponta indício, não diagnostica.
 */
import type { Tom } from "../components/tone";
import { formatBusinessDate, formatCurrency, formatPercent } from "./format";

export type NivelFrete = "normal" | "atencao" | "provavel" | "forte";

export const FAIXAS_DE_PRECO = ["ate_40", "40_79", "79_120", "120_200", "200_400", "acima_400"] as const;

export type FaixaDePreco = (typeof FAIXAS_DE_PRECO)[number];

export interface SinaisDoFrete {
  readonly historico: number;
  readonly irmaos: number;
  readonly pares: number;
  readonly proporcao: number;
  readonly margem: number;
  readonly deixou_de_ser_rentavel: boolean;
  readonly prejuizo: boolean;
  readonly frete_tirou_margem: boolean;
}

export interface AlertaDeFrete {
  readonly anuncio: string;
  readonly sku_id: string | null;
  readonly sku: string | null;
  readonly titulo: string;
  readonly conta: string;
  readonly categoria: string | null;
  readonly nivel: NivelFrete;
  readonly pontos: number;
  readonly faixa: FaixaDePreco;
  readonly pedidos_atual: number;
  readonly pedidos_antes: number;
  readonly frete_atual: number;
  readonly frete_antes: number | null;
  /**
   * D-399: o frete de antes corrigido pela mudança geral da faixa — o que o
   * anúncio pagaria hoje se tivesse acompanhado a tabela. `null` num banco sem
   * a migration de D-399.
   */
  readonly frete_esperado: number | null;
  /** D-399: a mudança geral do frete na faixa (fração: 0,05 = +5%). `null` sem medida. */
  readonly variacao_geral_faixa: number | null;
  readonly preco_atual: number;
  readonly preco_antes: number | null;
  readonly razao: number;
  readonly razao_p95: number | null;
  readonly frete_irmaos: number | null;
  readonly irmaos: number | null;
  readonly frete_pares: number | null;
  readonly pares: number | null;
  readonly margem_atual: number | null;
  readonly margem_antes: number | null;
  readonly cobertos_atual: number;
  readonly cobertos_antes: number;
  readonly frete_share_atual: number;
  readonly frete_share_antes: number | null;
  readonly excesso: number | null;
  readonly mudou_em: string | null;
  readonly sinais: SinaisDoFrete;
}

export interface ResumoDoDetector {
  readonly analisados: number;
  readonly anuncios: number;
  readonly com_historico: number;
  readonly com_irmaos: number;
  readonly com_pares: number;
  readonly normal: number;
  readonly atencao: number;
  readonly provavel: number;
  readonly forte: number;
  readonly excesso_14_dias: number | null;
  readonly skus: number;
  readonly skus_com_peso: number;
}

export interface FaixaDoDetector {
  readonly faixa: FaixaDePreco;
  readonly anuncios: number;
  readonly razao_mediana: number | null;
  readonly razao_p95: number | null;
  /** D-399: a mediana da variação dos anúncios que venderam nas duas janelas. `null` sem medida. */
  readonly variacao_geral: number | null;
  readonly anuncios_comparados: number | null;
}

export interface DetectorDeFrete {
  readonly janela: { readonly inicio: string; readonly corte: string; readonly fim: string };
  readonly resumo: ResumoDoDetector;
  readonly faixas: readonly FaixaDoDetector[];
  readonly alertas: readonly AlertaDeFrete[];
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
  // O PostgREST devolve numeric de jsonb como número; string numérica só por segurança.
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);

  throw new ForaDoContrato(chave);
}

/** Campo que só existe depois de uma migration: ausente vale `null`, presente é conferido. */
function numeroOpcional(r: Registro, chave: string): number | null {
  return chave in r ? numeroOuNulo(r, chave) : null;
}

function numero(r: Registro, chave: string): number {
  const n = numeroOuNulo(r, chave);

  if (n === null) throw new ForaDoContrato(chave);

  return n;
}

function texto(r: Registro, chave: string): string {
  const v = r[chave];

  if (typeof v !== "string") throw new ForaDoContrato(chave);

  return v;
}

function textoOuNulo(r: Registro, chave: string): string | null {
  if (!(chave in r)) throw new ForaDoContrato(chave);

  const v = r[chave];

  if (v === null) return null;
  if (typeof v !== "string") throw new ForaDoContrato(chave);

  return v;
}

function booleano(r: Registro, chave: string): boolean {
  const v = r[chave];

  if (typeof v !== "boolean") throw new ForaDoContrato(chave);

  return v;
}

function nivel(r: Registro): NivelFrete {
  const v = texto(r, "nivel");

  if (v !== "normal" && v !== "atencao" && v !== "provavel" && v !== "forte") throw new ForaDoContrato("nivel");

  return v;
}

function faixa(r: Registro): FaixaDePreco {
  const v = texto(r, "faixa");

  if (!(FAIXAS_DE_PRECO as readonly string[]).includes(v)) throw new ForaDoContrato("faixa");

  return v as FaixaDePreco;
}

function lerAlerta(valor: unknown): AlertaDeFrete {
  const r = registro(valor);
  const s = registro(r.sinais);

  return {
    anuncio: texto(r, "anuncio"),
    sku_id: textoOuNulo(r, "sku_id"),
    sku: textoOuNulo(r, "sku"),
    titulo: texto(r, "titulo"),
    conta: texto(r, "conta"),
    categoria: textoOuNulo(r, "categoria"),
    nivel: nivel(r),
    pontos: numero(r, "pontos"),
    faixa: faixa(r),
    pedidos_atual: numero(r, "pedidos_atual"),
    pedidos_antes: numero(r, "pedidos_antes"),
    frete_atual: numero(r, "frete_atual"),
    frete_antes: numeroOuNulo(r, "frete_antes"),
    frete_esperado: numeroOpcional(r, "frete_esperado"),
    variacao_geral_faixa: numeroOpcional(r, "variacao_geral_faixa"),
    preco_atual: numero(r, "preco_atual"),
    preco_antes: numeroOuNulo(r, "preco_antes"),
    razao: numero(r, "razao"),
    razao_p95: numeroOuNulo(r, "razao_p95"),
    frete_irmaos: numeroOuNulo(r, "frete_irmaos"),
    irmaos: numeroOuNulo(r, "irmaos"),
    frete_pares: numeroOuNulo(r, "frete_pares"),
    pares: numeroOuNulo(r, "pares"),
    margem_atual: numeroOuNulo(r, "margem_atual"),
    margem_antes: numeroOuNulo(r, "margem_antes"),
    cobertos_atual: numero(r, "cobertos_atual"),
    cobertos_antes: numero(r, "cobertos_antes"),
    frete_share_atual: numero(r, "frete_share_atual"),
    frete_share_antes: numeroOuNulo(r, "frete_share_antes"),
    excesso: numeroOuNulo(r, "excesso"),
    mudou_em: textoOuNulo(r, "mudou_em"),
    sinais: {
      historico: numero(s, "historico"),
      irmaos: numero(s, "irmaos"),
      pares: numero(s, "pares"),
      proporcao: numero(s, "proporcao"),
      margem: numero(s, "margem"),
      deixou_de_ser_rentavel: booleano(s, "deixou_de_ser_rentavel"),
      prejuizo: booleano(s, "prejuizo"),
      frete_tirou_margem: booleano(s, "frete_tirou_margem"),
    },
  };
}

const RESUMO_NUMEROS = [
  "analisados",
  "anuncios",
  "com_historico",
  "com_irmaos",
  "com_pares",
  "normal",
  "atencao",
  "provavel",
  "forte",
  "skus",
  "skus_com_peso",
] as const;

/**
 * O detector lido, ou `null` quando a resposta não é a que esta tela conhece —
 * a tela então diz que não mostrou nada, em vez de mostrar pela metade.
 */
export function lerDetectorFrete(valor: unknown): DetectorDeFrete | null {
  try {
    const r = registro(valor);
    const j = registro(r.janela);
    const rs = registro(r.resumo);

    if (!Array.isArray(r.faixas) || !Array.isArray(r.alertas)) throw new ForaDoContrato("listas");

    const numeros: Record<string, number> = {};

    for (const chave of RESUMO_NUMEROS) numeros[chave] = numero(rs, chave);

    return {
      janela: { inicio: texto(j, "inicio"), corte: texto(j, "corte"), fim: texto(j, "fim") },
      resumo: {
        ...(numeros as Omit<ResumoDoDetector, "excesso_14_dias">),
        excesso_14_dias: numeroOuNulo(rs, "excesso_14_dias"),
      },
      faixas: r.faixas.map((f: unknown) => {
        const x = registro(f);

        return {
          faixa: faixa(x),
          anuncios: numero(x, "anuncios"),
          razao_mediana: numeroOuNulo(x, "razao_mediana"),
          razao_p95: numeroOuNulo(x, "razao_p95"),
          variacao_geral: numeroOpcional(x, "variacao_geral"),
          anuncios_comparados: numeroOpcional(x, "anuncios_comparados"),
        };
      }),
      alertas: r.alertas.map(lerAlerta),
    };
  } catch (erro) {
    if (erro instanceof ForaDoContrato) return null;

    throw erro;
  }
}

// ── rótulos ────────────────────────────────────────────────────────────────

/**
 * Os quatro níveis do pedido do dono (🟢 normal, 🟡 atenção, 🟠 provável
 * problema, 🔴 forte indício) nos tons que o app tem: o tom é só a cor, o
 * rótulo escrito é o que diz o nível.
 */
export const NIVEL: Record<NivelFrete, { readonly rotulo: string; readonly tom: Tom }> = {
  normal: { rotulo: "Normal", tom: "ok" },
  atencao: { rotulo: "Atenção", tom: "info" },
  provavel: { rotulo: "Provável problema", tom: "atencao" },
  forte: { rotulo: "Forte indício", tom: "perigo" },
};

export const ROTULO_DA_FAIXA: Record<FaixaDePreco, string> = {
  ate_40: "até R$ 40",
  "40_79": "de R$ 40 a R$ 79",
  "79_120": "de R$ 79 a R$ 120",
  "120_200": "de R$ 120 a R$ 200",
  "200_400": "de R$ 200 a R$ 400",
  acima_400: "acima de R$ 400",
};

// ── motivos ────────────────────────────────────────────────────────────────

const INTEIRO = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 0 });
const PONTOS = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** "121%": a distância relativa, arredondada — "121,4% acima" dá precisão que o sinal não tem. */
function acima(atual: number, referencia: number): string {
  return INTEIRO.format(atual / referencia - 1);
}

function pp(fracao: number): string {
  return `${PONTOS.format(Math.abs(fracao) * 100)} p.p.`;
}

function outros(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : `${String(n)} ${plural}`;
}

export type Sinal = "historico" | "irmaos" | "pares" | "proporcao" | "margem";

export interface Motivo {
  readonly sinal: Sinal;
  readonly pontos: number;
  readonly texto: string;
}

/**
 * Por que o anúncio foi apontado — uma frase por sinal que pontuou, na ordem
 * da evidência mais direta (o próprio anúncio, o mesmo produto, a categoria,
 * a proporção, a margem). Os dias da janela vêm da RPC.
 */
export function motivosDoAlerta(a: AlertaDeFrete, janela: DetectorDeFrete["janela"]): Motivo[] {
  const motivos: Motivo[] = [];
  const diasAntes = diasEntre(janela.inicio, janela.corte);

  if (a.sinais.historico > 0 && a.frete_antes !== null && a.frete_antes > 0) {
    const geral = a.variacao_geral_faixa;
    const esperado = a.frete_esperado;
    // D-399: com mudança geral medida na faixa, o motivo compara com o esperado
    // e diz quanto foi a tabela; sem ela (ou num banco anterior), com o de antes.
    const corrigido = geral !== null && esperado !== null && esperado > 0 && Math.abs(geral) >= 0.005;
    const desde = a.mudou_em === null ? "" : ` A mudança aparece a partir de ${formatBusinessDate(a.mudou_em)}.`;

    motivos.push({
      sinal: "historico",
      pontos: a.sinais.historico,
      texto: corrigido
        ? `Frete ${acima(a.frete_atual, esperado)} acima do esperado: ${formatCurrency(a.frete_atual)} nos últimos 14 dias ` +
          `contra ${formatCurrency(a.frete_antes)} nos ${String(diasAntes)} dias anteriores, que com a ` +
          `${geral > 0 ? "alta" : "queda"} geral de ${formatPercent(Math.abs(geral))} da faixa seriam ` +
          `${formatCurrency(esperado)}.${desde}`
        : `Frete ${acima(a.frete_atual, a.frete_antes)} acima do que este anúncio pagava: ` +
          `${formatCurrency(a.frete_atual)} nos últimos 14 dias contra ${formatCurrency(a.frete_antes)} ` +
          `nos ${String(diasAntes)} dias anteriores, na mesma faixa de preço.${desde}`,
    });
  }

  if (a.sinais.irmaos > 0 && a.frete_irmaos !== null && a.frete_irmaos > 0 && a.irmaos !== null) {
    motivos.push({
      sinal: "irmaos",
      pontos: a.sinais.irmaos,
      texto:
        `Frete ${acima(a.frete_atual, a.frete_irmaos)} acima de ` +
        `${outros(a.irmaos, "outro anúncio", "outros anúncios")} do mesmo produto na mesma faixa de preço ` +
        `(${formatCurrency(a.frete_irmaos)}${a.irmaos > 1 ? " de mediana" : ""}). ` +
        "O mesmo produto com frete diferente costuma vir de medida ou peso cadastrado diferente no anúncio.",
    });
  }

  if (a.sinais.pares > 0 && a.frete_pares !== null && a.frete_pares > 0 && a.pares !== null) {
    motivos.push({
      sinal: "pares",
      pontos: a.sinais.pares,
      texto:
        `Frete ${acima(a.frete_atual, a.frete_pares)} acima da mediana de ${String(a.pares)} produtos ` +
        `da mesma categoria do Mercado Livre${a.categoria === null ? "" : ` (${a.categoria})`} ` +
        `e da mesma faixa de preço (${formatCurrency(a.frete_pares)}).`,
    });
  }

  if (a.sinais.proporcao > 0 && a.razao_p95 !== null) {
    motivos.push({
      sinal: "proporcao",
      pontos: a.sinais.proporcao,
      texto:
        `O frete é ${formatPercent(a.razao)} do preço (${formatCurrency(a.frete_atual)} sobre ` +
        `${formatCurrency(a.preco_atual)}). Na faixa ${ROTULO_DA_FAIXA[a.faixa]}, 95% dos anúncios ` +
        `ficam em até ${formatPercent(a.razao_p95)}.`,
    });
  }

  if (a.sinais.margem > 0) {
    motivos.push({ sinal: "margem", pontos: a.sinais.margem, texto: textoDaMargem(a) });
  }

  return motivos;
}

function textoDaMargem(a: AlertaDeFrete): string {
  const frases: string[] = [];

  if (a.sinais.deixou_de_ser_rentavel && a.margem_antes !== null && a.margem_atual !== null && a.frete_share_antes !== null) {
    return (
      `Deixou de dar resultado: a margem foi de ${formatPercent(a.margem_antes)} para ` +
      `${formatPercent(a.margem_atual)}, e o frete passou de ${formatPercent(a.frete_share_antes)} para ` +
      `${formatPercent(a.frete_share_atual)} do preço — o frete explica pelo menos metade da queda.`
    );
  }

  if (a.sinais.prejuizo && a.margem_atual !== null) {
    frases.push(
      `Vende no prejuízo: margem de ${formatPercent(a.margem_atual)} nos ${String(a.cobertos_atual)} pedidos ` +
        `com custo conhecido, com o frete levando ${formatPercent(a.frete_share_atual)} do preço.`,
    );
  }

  if (a.sinais.frete_tirou_margem && a.frete_share_antes !== null) {
    const margens =
      a.margem_antes !== null && a.margem_atual !== null && a.cobertos_antes >= 5 && a.cobertos_atual >= 3
        ? `; a margem foi de ${formatPercent(a.margem_antes)} para ${formatPercent(a.margem_atual)}`
        : "";

    frases.push(
      `O frete passou de ${formatPercent(a.frete_share_antes)} para ${formatPercent(a.frete_share_atual)} ` +
        `do preço (+${pp(a.frete_share_atual - a.frete_share_antes)})${margens}.`,
    );
  }

  return frases.join(" ");
}

/**
 * O que vale olhar primeiro. Quando a evidência é de frete diferente para o
 * mesmo tipo de produto, a suspeita é o cadastro de medidas; quando só a
 * proporção ou a margem pesam, é o preço ou a forma de envio.
 */
export function sugestaoDoAlerta(a: AlertaDeFrete): string {
  if (a.sinais.irmaos > 0) {
    return "Vale conferir as medidas e o peso da embalagem neste anúncio e compará-los com os do anúncio do mesmo produto que paga menos.";
  }

  if (a.sinais.historico > 0 || a.sinais.pares > 0) {
    return "Vale conferir se as medidas ou o peso da embalagem cadastrados no anúncio mudaram ou estão maiores que os do produto.";
  }

  return "Vale revisar o preço ou a forma de envio: o frete pesa demais sobre o valor desta venda.";
}

/** Dias entre duas datas de negócio (`YYYY-MM-DD`), sem passar por fuso. */
export function diasEntre(inicio: string, fim: string): number {
  return Math.round((Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${inicio}T00:00:00Z`)) / 86_400_000);
}

/** Quantos alertas pedem revisão (provável ou forte) — o número que a central mostra primeiro. */
export function paraRevisar(r: ResumoDoDetector): number {
  return r.provavel + r.forte;
}
