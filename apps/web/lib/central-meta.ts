import type { Tom } from "../components/tone";
import { formatBusinessDate, formatCurrency, formatPercent } from "./format";
import { LIMITES_PADRAO } from "./limites-central";
import { rotuloDoMes } from "./metas-imposto";

/**
 * A leitura de `get_meta_do_mes` (D-395) e o que a tela diz sobre ela.
 *
 * Toda conta — realizado, ritmo ponderado pelo dia da semana, projeção nos
 * três cenários, mesmo mês do ano anterior — vem do SQL. Aqui se confere o
 * contrato (a resposta fora dele é recusada inteira, como em
 * `lib/faturamento.ts`) e se dá tom e frase a números prontos.
 */

export type SituacaoDoMes = "em_curso" | "encerrado" | "futuro";

export interface ProjecaoDoMes {
  readonly ritmo: number;
  readonly conservador: number;
  readonly otimista: number;
}

export interface AnoAnterior {
  readonly receita_mes: number | null;
  readonly receita_ate_mesmo_dia: number | null;
  readonly projecao_sazonal: number | null;
  readonly crescimento: number | null;
}

export interface FatorDoDia {
  /** ISO: 1 = segunda … 7 = domingo. */
  readonly dia_semana: number;
  readonly fator: number;
}

/** Um dia da janela de uma data comercial e o efeito medido no ano anterior (1 = dia normal). */
export interface DiaDaData {
  readonly dia: string;
  readonly fator: number;
}

/**
 * Uma data comercial que toca o mês (D-406). O efeito é medido dia a dia na
 * ocorrência do ano anterior, contra a média do mesmo dia da semana nas 4
 * semanas antes dela; sem essa ocorrência no histórico, `medido` é falso e a
 * data não pesa na projeção.
 */
export interface DataComercial {
  readonly nome: string;
  readonly data: string;
  readonly inicio: string;
  readonly fim: string;
  readonly medida_em: string;
  readonly medido: boolean;
  /** A variação média dos dias da janela contra um dia normal. */
  readonly efeito: number | null;
  /** Quanto a data muda o mês inteiro. */
  readonly efeito_no_mes: number | null;
  readonly dias: readonly DiaDaData[];
}

export interface MetaDoMes {
  readonly mes: string;
  readonly fim: string;
  readonly hoje: string;
  readonly situacao: SituacaoDoMes;
  readonly inicio_historico: string | null;
  readonly meta: number | null;
  readonly realizado: number | null;
  readonly realizado_ate_ontem: number | null;
  readonly realizado_hoje: number | null;
  readonly dias_no_mes: number;
  readonly dias_completos: number | null;
  readonly dias_restantes: number | null;
  readonly atingimento: number | null;
  readonly faltam: number | null;
  readonly esperado_ate_ontem: number | null;
  readonly diferenca_ritmo: number | null;
  readonly media_diaria: number | null;
  readonly meta_diaria_necessaria: number | null;
  readonly aumento_necessario: number | null;
  readonly perfil_semanal: boolean;
  readonly fatores: readonly FatorDoDia[];
  readonly projecao: ProjecaoDoMes | null;
  readonly ano_anterior: AnoAnterior | null;
  readonly dias_sem_venda: number;
  /** D-406. Vazio também quando o banco ainda não tem o calendário. */
  readonly datas_comerciais: readonly DataComercial[];
}

class ForaDoContrato extends Error {}

type Registro = Readonly<Record<string, unknown>>;

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

const NUMEROS_ANULAVEIS = [
  "meta",
  "realizado",
  "realizado_ate_ontem",
  "realizado_hoje",
  "dias_completos",
  "dias_restantes",
  "atingimento",
  "faltam",
  "esperado_ate_ontem",
  "diferenca_ritmo",
  "media_diaria",
  "meta_diaria_necessaria",
  "aumento_necessario",
] as const;

function lerDataComercial(valor: unknown): DataComercial {
  const d = registro(valor);

  if (typeof d.medido !== "boolean") throw new ForaDoContrato("medido");
  if (!Array.isArray(d.dias)) throw new ForaDoContrato("dias");

  return {
    nome: texto(d, "nome"),
    data: texto(d, "data"),
    inicio: texto(d, "inicio"),
    fim: texto(d, "fim"),
    medida_em: texto(d, "medida_em"),
    medido: d.medido,
    efeito: numeroOuNulo(d, "efeito"),
    efeito_no_mes: numeroOuNulo(d, "efeito_no_mes"),
    dias: d.dias.map((x: unknown) => {
      const dia = registro(x);

      return { dia: texto(dia, "dia"), fator: numero(dia, "fator") };
    }),
  };
}

/** `null` = resposta fora do contrato. */
export function lerMetaDoMes(valor: unknown): MetaDoMes | null {
  try {
    const r = registro(valor);
    const situacao = texto(r, "situacao");

    if (situacao !== "em_curso" && situacao !== "encerrado" && situacao !== "futuro") throw new ForaDoContrato("situacao");
    if (typeof r.perfil_semanal !== "boolean") throw new ForaDoContrato("perfil_semanal");
    if (!Array.isArray(r.fatores)) throw new ForaDoContrato("fatores");

    const anulaveis: Record<string, number | null> = {};

    for (const chave of NUMEROS_ANULAVEIS) anulaveis[chave] = numeroOuNulo(r, chave);

    const projecao =
      r.projecao === null
        ? null
        : ((p: Registro): ProjecaoDoMes => ({
            ritmo: numero(p, "ritmo"),
            conservador: numero(p, "conservador"),
            otimista: numero(p, "otimista"),
          }))(registro(r.projecao));

    const anoAnterior =
      r.ano_anterior === null
        ? null
        : ((a: Registro): AnoAnterior => ({
            receita_mes: numeroOuNulo(a, "receita_mes"),
            receita_ate_mesmo_dia: numeroOuNulo(a, "receita_ate_mesmo_dia"),
            projecao_sazonal: numeroOuNulo(a, "projecao_sazonal"),
            crescimento: numeroOuNulo(a, "crescimento"),
          }))(registro(r.ano_anterior));

    return {
      mes: texto(r, "mes"),
      fim: texto(r, "fim"),
      hoje: texto(r, "hoje"),
      situacao,
      inicio_historico: textoOuNulo(r, "inicio_historico"),
      ...(anulaveis as Pick<MetaDoMes, (typeof NUMEROS_ANULAVEIS)[number]>),
      dias_no_mes: numero(r, "dias_no_mes"),
      perfil_semanal: r.perfil_semanal,
      fatores: r.fatores.map((f: unknown) => {
        const x = registro(f);

        return { dia_semana: numero(x, "dia_semana"), fator: numero(x, "fator") };
      }),
      projecao,
      ano_anterior: anoAnterior,
      dias_sem_venda: numero(r, "dias_sem_venda"),
      // Ausente = banco anterior a D-406 (a web chega antes da migration): lista vazia.
      datas_comerciais:
        "datas_comerciais" in r
          ? (() => {
              if (!Array.isArray(r.datas_comerciais)) throw new ForaDoContrato("datas_comerciais");

              return r.datas_comerciais.map(lerDataComercial);
            })()
          : [],
    };
  } catch (erro) {
    if (erro instanceof ForaDoContrato) return null;

    throw erro;
  }
}

export interface LeituraDaMeta {
  readonly tom: Tom;
  readonly rotulo: string;
  readonly frase: string;
}

/**
 * O veredito do mês, sempre com o número que o sustenta.
 *
 * - **encerrado**: atingida ou não, pelo realizado;
 * - **em curso com projeção**: no caminho quando o ritmo atual fecha acima da
 *   meta; em risco quando só o cenário otimista fecha; improvável quando nem
 *   o otimista fecha;
 * - **em curso sem projeção** (histórico curto): pelo ritmo contra o esperado;
 * - **sem meta**: a projeção continua valendo, e a tela diz que falta a meta.
 */
export function situacaoDaMeta(m: MetaDoMes, atrasoDaMeta: number = LIMITES_PADRAO.atrasoDaMeta): LeituraDaMeta {
  const nome = rotuloDoMes(m.mes);

  if (m.situacao === "futuro") {
    return { tom: "neutro", rotulo: "ainda não começou", frase: `${nome} ainda não começou.` };
  }

  if (m.meta === null) {
    return {
      tom: "info",
      rotulo: "sem meta",
      frase:
        m.projecao === null
          ? `${nome} não tem meta cadastrada.`
          : `${nome} não tem meta cadastrada; no ritmo atual o mês fecha em ${formatCurrency(m.projecao.ritmo)}.`,
    };
  }

  if (m.situacao === "encerrado") {
    const atingiu = (m.realizado ?? 0) >= m.meta;

    return {
      tom: atingiu ? "ok" : "perigo",
      rotulo: atingiu ? "meta atingida" : "meta não atingida",
      frase: `${nome} fechou em ${formatCurrency(m.realizado)}, ${formatPercent(m.atingimento)} da meta de ${formatCurrency(m.meta)}.`,
    };
  }

  const p = m.projecao;

  if (p !== null) {
    const diferenca = p.ritmo - m.meta;

    if (p.ritmo >= m.meta) {
      return {
        tom: "ok",
        rotulo: "no caminho",
        frase: `No ritmo atual o mês fecha em ${formatCurrency(p.ritmo)}, ${formatCurrency(diferenca)} acima da meta.`,
      };
    }

    if (p.otimista >= m.meta) {
      return {
        tom: "atencao",
        rotulo: "meta em risco",
        frase: `No ritmo atual o mês fecha em ${formatCurrency(p.ritmo)}, ${formatCurrency(-diferenca)} abaixo da meta; só o cenário otimista a alcança.`,
      };
    }

    return {
      tom: "perigo",
      rotulo: "meta improvável",
      frase: `Nem o cenário otimista (${formatCurrency(p.otimista)}) alcança a meta de ${formatCurrency(m.meta)}.`,
    };
  }

  const ritmo = ritmoDaMeta(m, atrasoDaMeta);

  return ritmo === null
    ? { tom: "neutro", rotulo: "sem projeção", frase: "Sem histórico suficiente para projetar o mês." }
    : { tom: ritmo.tom, rotulo: ritmo.tom === "ok" ? "acima do ritmo" : "abaixo do ritmo", frase: `${ritmo.texto}.` };
}

/**
 * "R$ 18.500,00 acima do ritmo necessário" ou "abaixo", contra o esperado
 * até ontem ponderado pelo dia da semana. Abaixo até `atrasoDaMeta` do
 * esperado (5% por padrão, da organização desde D-408) é atenção; mais que
 * isso, perigo. `null` no dia 1 (nada completo ainda) e sem meta.
 */
export function ritmoDaMeta(
  m: MetaDoMes,
  atrasoDaMeta: number = LIMITES_PADRAO.atrasoDaMeta,
): { tom: Tom; texto: string } | null {
  if (m.situacao !== "em_curso" || m.diferenca_ritmo === null || m.esperado_ate_ontem === null) return null;
  if (m.dias_completos === null || m.dias_completos === 0) return null;

  if (m.diferenca_ritmo >= 0) {
    return { tom: "ok", texto: `${formatCurrency(m.diferenca_ritmo)} acima do ritmo necessário` };
  }

  const relativa = m.esperado_ate_ontem > 0 ? -m.diferenca_ritmo / m.esperado_ate_ontem : 1;

  return {
    tom: relativa <= atrasoDaMeta ? "atencao" : "perigo",
    texto: `${formatCurrency(-m.diferenca_ritmo)} abaixo do ritmo necessário`,
  };
}

const DIA_DA_SEMANA: Readonly<Record<number, string>> = {
  1: "seg",
  2: "ter",
  3: "qua",
  4: "qui",
  5: "sex",
  6: "sáb",
  7: "dom",
};

export function rotuloDoDiaDaSemana(isodow: number): string {
  return DIA_DA_SEMANA[isodow] ?? String(isodow);
}

const INTEIRO = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 0 });

/** "25/11" de "2022-11-25". */
function diaEMes(data: string): string {
  return formatBusinessDate(data).slice(0, 5);
}

function contraDiaNormal(fracao: number): string {
  if (Math.round(fracao * 100) === 0) return "como um dia normal";

  return `${INTEIRO.format(Math.abs(fracao))} ${fracao > 0 ? "acima" : "abaixo"} de um dia normal`;
}

/**
 * A frase de uma data comercial (D-406), só com os números medidos: a janela
 * contra um dia normal, o dia de maior efeito (para cima ou para baixo) e quanto
 * a data muda o mês. Sem medição, diz por quê e que a projeção não a considera.
 */
export function fraseDaDataComercial(d: DataComercial): string {
  const quando = `${d.nome} (${diaEMes(d.data)})`;
  const anoMedido = d.medida_em.slice(0, 4);

  if (!d.medido) {
    return `${quando}: a de ${anoMedido} (${diaEMes(d.medida_em)}) ficou fora do histórico — sem efeito medido, a projeção não a considera.`;
  }

  const janela = `a janela de ${diaEMes(d.inicio)} a ${diaEMes(d.fim)}`;
  const efeito = d.efeito === null ? "sem efeito calculado" : `vende ${contraDiaNormal(d.efeito)}`;
  let frase = `${quando}: medida na de ${anoMedido}, ${janela} ${efeito}`;

  const pico = d.dias.reduce<DiaDaData | null>(
    (maior, dia) => (maior === null || Math.abs(dia.fator - 1) > Math.abs(maior.fator - 1) ? dia : maior),
    null,
  );

  if (pico !== null && Math.abs(pico.fator - 1) >= 0.1) {
    const variacao = INTEIRO.format(Math.abs(pico.fator - 1));

    frase +=
      pico.fator > 1
        ? `, com pico de +${variacao} em ${diaEMes(pico.dia)}`
        : `, com o pior dia a −${variacao} em ${diaEMes(pico.dia)}`;
  }

  if (d.efeito_no_mes !== null && Math.round(d.efeito_no_mes * 100) !== 0) {
    const noMes = INTEIRO.format(Math.abs(d.efeito_no_mes));

    frase += d.efeito_no_mes > 0 ? ` — soma cerca de ${noMes} ao mês` : ` — tira cerca de ${noMes} do mês`;
  }

  return `${frase}.`;
}
