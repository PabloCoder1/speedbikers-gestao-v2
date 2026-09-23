import type { Tom } from "../components/tone";
import { formatCurrency, formatPercent } from "./format";
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
export function situacaoDaMeta(m: MetaDoMes): LeituraDaMeta {
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

  const ritmo = ritmoDaMeta(m);

  return ritmo === null
    ? { tom: "neutro", rotulo: "sem projeção", frase: "Sem histórico suficiente para projetar o mês." }
    : { tom: ritmo.tom, rotulo: ritmo.tom === "ok" ? "acima do ritmo" : "abaixo do ritmo", frase: `${ritmo.texto}.` };
}

/**
 * "R$ 18.500,00 acima do ritmo necessário" ou "abaixo", contra o esperado
 * até ontem ponderado pelo dia da semana. Abaixo até 5% do esperado é
 * atenção; mais que isso, perigo. `null` no dia 1 (nada completo ainda) e
 * sem meta.
 */
export function ritmoDaMeta(m: MetaDoMes): { tom: Tom; texto: string } | null {
  if (m.situacao !== "em_curso" || m.diferenca_ritmo === null || m.esperado_ate_ontem === null) return null;
  if (m.dias_completos === null || m.dias_completos === 0) return null;

  if (m.diferenca_ritmo >= 0) {
    return { tom: "ok", texto: `${formatCurrency(m.diferenca_ritmo)} acima do ritmo necessário` };
  }

  const relativa = m.esperado_ate_ontem > 0 ? -m.diferenca_ritmo / m.esperado_ate_ontem : 1;

  return {
    tom: relativa <= 0.05 ? "atencao" : "perigo",
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
