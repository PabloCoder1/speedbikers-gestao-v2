/**
 * A leitura de `get_ads_overview` (D-363): contrato conferido e o tom de cada
 * campanha — sem React e sem banco, para ser testável.
 *
 * Mesmo desenho de `lib/faturamento.ts` e `lib/replenishment-overview.ts`: a
 * RPC devolve `jsonb`, e uma resposta fora do contrato é recusada INTEIRA em
 * vez de virar "—" que parece "não observado". Nada é somado aqui.
 */

import type { Tom } from "../components/tone";

export interface ResumoAds {
  readonly investimento: number;
  readonly receita_ads: number;
  readonly receita_direta: number;
  readonly receita_indireta: number;
  readonly cliques: number;
  readonly impressoes: number;
  readonly unidades: number;
  readonly campanhas_com_metrica: number;
  readonly acos: number | null;
  readonly roas: number | null;
  readonly ctr: number | null;
  readonly cpc: number | null;
  readonly receita_bruta: number;
  readonly tacos: number | null;
}

export interface CampanhaAds {
  readonly ml_account_id: string;
  readonly conta: string;
  readonly campaign_id: number;
  readonly nome: string;
  readonly status: string | null;
  readonly estrategia: string | null;
  readonly orcamento: number | null;
  readonly roas_alvo: number | null;
  readonly investimento: number;
  readonly receita_ads: number;
  readonly receita_direta: number;
  readonly receita_indireta: number;
  readonly cliques: number;
  readonly impressoes: number;
  readonly unidades: number;
  readonly acos: number | null;
  readonly roas: number | null;
}

export interface DiaAds {
  readonly dia: string;
  readonly investimento: number;
  readonly receita_ads: number;
}

export type EstadoAdsConta = "habilitado" | "nao_habilitado" | "nao_verificado";

export interface ContaAds {
  readonly ml_account_id: string;
  readonly conta: string;
  readonly ads: EstadoAdsConta;
  readonly verificado_em: string | null;
}

export interface VisaoAds {
  readonly resumo: ResumoAds;
  readonly campanhas: readonly CampanhaAds[];
  readonly diario: readonly DiaAds[];
  readonly contas: readonly ContaAds[];
  readonly sincronizadoEm: string | null;
  /**
   * D-398: dias fechados que o Mercado Livre publicou com gasto e sem venda
   * atribuída — a venda chega na regravação seguinte. ROAS, ACOS e vendas com
   * Ads desses dias ainda não valem. Vazio num banco sem a migration de D-398.
   */
  readonly diasPendentes: readonly string[];
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

function temCampos(
  v: unknown,
  numeros: readonly string[],
  nulos: readonly string[],
  textos: readonly string[] = [],
  textosNulos: readonly string[] = [],
): v is Obj {
  return (
    ehObj(v) &&
    numeros.every((c) => ehNum(v[c])) &&
    nulos.every((c) => numOuNulo(v[c])) &&
    textos.every((c) => typeof v[c] === "string") &&
    textosNulos.every((c) => textoOuNulo(v[c]))
  );
}

const RESUMO_NUMEROS = [
  "investimento",
  "receita_ads",
  "receita_direta",
  "receita_indireta",
  "cliques",
  "impressoes",
  "unidades",
  "campanhas_com_metrica",
  "receita_bruta",
] as const;
const RESUMO_NULOS = ["acos", "roas", "ctr", "cpc", "tacos"] as const;

const CAMPANHA_NUMEROS = [
  "campaign_id",
  "investimento",
  "receita_ads",
  "receita_direta",
  "receita_indireta",
  "cliques",
  "impressoes",
  "unidades",
] as const;
const CAMPANHA_NULOS = ["orcamento", "roas_alvo", "acos", "roas"] as const;

/** `null` = resposta fora do contrato. */
export function lerVisaoAds(dado: unknown): VisaoAds | null {
  if (!ehObj(dado)) return null;
  if (!Array.isArray(dado.campanhas) || !Array.isArray(dado.diario) || !Array.isArray(dado.contas)) return null;
  if (!textoOuNulo(dado.sincronizado_em)) return null;

  if (!temCampos(dado.resumo, RESUMO_NUMEROS, RESUMO_NULOS)) return null;

  const resumo = dado.resumo as unknown as ResumoAds;

  const campanhas: CampanhaAds[] = [];

  for (const item of dado.campanhas) {
    if (!temCampos(item, CAMPANHA_NUMEROS, CAMPANHA_NULOS, ["ml_account_id", "conta", "nome"], ["status", "estrategia"])) {
      return null;
    }
    campanhas.push(item as unknown as CampanhaAds);
  }

  const diario: DiaAds[] = [];

  for (const item of dado.diario) {
    if (!temCampos(item, ["investimento", "receita_ads"], [], ["dia"])) return null;
    diario.push(item as unknown as DiaAds);
  }

  const contas: ContaAds[] = [];

  for (const item of dado.contas) {
    if (!temCampos(item, [], [], ["ml_account_id", "conta", "ads"], ["verificado_em"])) return null;
    if (!["habilitado", "nao_habilitado", "nao_verificado"].includes(item.ads as string)) return null;
    contas.push(item as unknown as ContaAds);
  }

  // Opcional: a web chega à produção antes de a migration de D-398 passar pelo workflow.
  const pendentes = dado.dias_pendentes ?? [];

  if (!Array.isArray(pendentes) || !pendentes.every((d): d is string => typeof d === "string")) return null;

  return { resumo, campanhas, diario, contas, sincronizadoEm: dado.sincronizado_em, diasPendentes: pendentes };
}

/**
 * O tom do ROAS de uma campanha, contra o ponto de equilíbrio (1) e o ROAS alvo
 * que a própria campanha tem configurado no Product Ads:
 *
 * - **perigo** abaixo de 1 — cada real investido volta menos de um real em venda;
 * - **atenção** abaixo do ROAS alvo configurado na campanha;
 * - **ok** no alvo ou acima (ou acima de 1, quando não há alvo);
 * - **neutro** sem investimento (ROAS indefinido).
 *
 * ROAS é receita sobre investimento, não lucro: um ROAS de 3 com margem de 20%
 * ainda perde dinheiro. A tela diz isso ao lado.
 */
export function tomDoRoas(roas: number | null, alvo: number | null): Tom {
  if (roas === null) return "neutro";
  if (roas < 1) return "perigo";
  if (alvo !== null && alvo > 0 && roas < alvo) return "atencao";

  return "ok";
}

/** Campanhas que pedem atenção: ROAS abaixo de 1 ou abaixo do alvo. Classificação, não soma. */
export function campanhasEmAlerta(campanhas: readonly CampanhaAds[]): number {
  return campanhas.filter((c) => {
    const tom = tomDoRoas(c.roas, c.roas_alvo);

    return tom === "perigo" || tom === "atencao";
  }).length;
}

/** Rótulo do status da campanha como o vendedor fala. */
export function rotuloStatusCampanha(status: string | null): { label: string; tom: Tom } {
  if (status === "active") return { label: "ativa", tom: "ok" };
  if (status === "paused") return { label: "pausada", tom: "neutro" };

  return { label: status ?? "sem status", tom: "neutro" };
}

/** Rótulo da estratégia do Product Ads. */
export function rotuloEstrategia(estrategia: string | null): string | null {
  switch (estrategia) {
    case "PROFITABILITY":
      return "rentabilidade";
    case "INCREASE":
      return "crescimento";
    case "VISIBILITY":
      return "visibilidade";
    case null:
      return null;
    default:
      return estrategia.toLowerCase();
  }
}
