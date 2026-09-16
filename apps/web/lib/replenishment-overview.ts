/**
 * A leitura de `get_replenishment_overview` (D-358): contrato conferido e as
 * peças puras da tela `/reposicao` — sem React e sem banco, para ser testável.
 *
 * A RPC devolve `jsonb`, que o gerador declara como `Json`. Um `as` aceitaria
 * qualquer coisa, e um campo renomeado no SQL chegaria como `undefined` e sairia
 * "—" na tela, que se lê como "não observado" (D-131). Aqui cada campo é
 * conferido, e uma resposta fora do contrato é recusada INTEIRA — o mesmo
 * desenho de `lib/faturamento.ts`.
 *
 * Nada aqui soma: contagem, unidades e investimento vêm do SQL.
 */

import type { SkuReplenishmentRow } from "@sb/domain";

export interface LinhaReposicao extends SkuReplenishmentRow {
  readonly purchase_cost: number | null;
  readonly abc_class: string | null;
  readonly coverage_days: number | null;
  readonly state: string | null;
  readonly suggested_quantity: number | null;
}

export interface AgregadoReposicao {
  readonly skus: number;
  readonly unidades: number;
  readonly investimento: number;
  /** SKUs com sugestão positiva e custo nulo/zero — fora do investimento, nunca somados como zero. */
  readonly sem_custo: number;
}

export interface ContagemEstado extends AgregadoReposicao {
  readonly state: string;
}

export interface VisaoReposicao {
  readonly total: number;
  readonly contagens: readonly ContagemEstado[];
  readonly totais: AgregadoReposicao;
  readonly comprarAgora: AgregadoReposicao;
  readonly linhas: readonly LinhaReposicao[];
  readonly vendasCalculadasEm: string | null;
  readonly fullCapturadoEm: string | null;
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

function lerAgregado(v: unknown): AgregadoReposicao | null {
  if (!ehObj(v)) return null;

  const { skus, unidades, investimento, sem_custo } = v;

  if (!ehNum(skus) || !ehNum(unidades) || !ehNum(investimento) || !ehNum(sem_custo)) return null;

  return { skus, unidades, investimento, sem_custo };
}

const NUMERICOS = [
  "local_quantity",
  "full_quantity",
  "transito",
  "reservado",
  "units_15d",
  "units_30d",
  "units_60d",
  "units_90d",
  "history_days_90",
] as const;

function lerLinha(v: unknown): LinhaReposicao | null {
  if (!ehObj(v)) return null;

  if (typeof v.sku_id !== "string" || typeof v.sku !== "string" || typeof v.stock_is_virtual !== "boolean") return null;
  if (!textoOuNulo(v.title) || !textoOuNulo(v.supplier_brand) || !textoOuNulo(v.abc_class) || !textoOuNulo(v.state)) {
    return null;
  }
  if (!numOuNulo(v.purchase_cost) || !numOuNulo(v.coverage_days) || !numOuNulo(v.suggested_quantity)) return null;

  const numeros: Partial<Record<(typeof NUMERICOS)[number], number>> = {};

  for (const campo of NUMERICOS) {
    const valor = v[campo];

    if (!ehNum(valor)) return null;
    numeros[campo] = valor;
  }

  return {
    sku_id: v.sku_id,
    sku: v.sku,
    title: v.title,
    supplier_brand: v.supplier_brand,
    stock_is_virtual: v.stock_is_virtual,
    purchase_cost: v.purchase_cost,
    abc_class: v.abc_class,
    coverage_days: v.coverage_days,
    state: v.state,
    suggested_quantity: v.suggested_quantity,
    ...(numeros as Record<(typeof NUMERICOS)[number], number>),
  };
}

/** `null` = resposta fora do contrato. A tela recusa em vez de mostrar pedaço. */
export function lerVisaoReposicao(dado: unknown): VisaoReposicao | null {
  if (!ehObj(dado) || !ehNum(dado.total)) return null;
  if (!Array.isArray(dado.contagens) || !Array.isArray(dado.linhas)) return null;
  if (!textoOuNulo(dado.vendas_calculadas_em) || !textoOuNulo(dado.full_capturado_em)) return null;

  const totais = lerAgregado(dado.totais);
  const comprarAgora = lerAgregado(dado.comprar_agora);

  if (totais === null || comprarAgora === null) return null;

  const contagens: ContagemEstado[] = [];

  for (const item of dado.contagens) {
    const agregado = lerAgregado(item);

    if (agregado === null || !ehObj(item) || typeof item.state !== "string") return null;
    contagens.push({ state: item.state, ...agregado });
  }

  const linhas: LinhaReposicao[] = [];

  for (const item of dado.linhas) {
    const linha = lerLinha(item);

    if (linha === null) return null;
    linhas.push(linha);
  }

  return {
    total: dado.total,
    contagens,
    totais,
    comprarAgora,
    linhas,
    vendasCalculadasEm: dado.vendas_calculadas_em,
    fullCapturadoEm: dado.full_capturado_em,
  };
}

/**
 * Posição da cobertura na régua da política, em % de uma barra que vai de 0 ao
 * dobro da janela de demanda (a janela fica no meio, onde o olho procura
 * "adequado"). `null` quando não há cobertura ou janela: a barra some em vez de
 * desenhar zero.
 */
export function posicaoCobertura(coberturaDias: number | null, janelaDias: number | null): number | null {
  if (coberturaDias === null || janelaDias === null || janelaDias <= 0) return null;

  return Math.min(100, Math.max(0, (coberturaDias / (janelaDias * 2)) * 100));
}

/** "há 3 h", "há 2 dias" — idade de uma leitura, para o selo de frescor. */
export function idadeDaLeitura(instante: string | null, agora: Date): { texto: string; velha: boolean } | null {
  if (instante === null) return null;

  const horas = Math.max(0, (agora.getTime() - new Date(instante).getTime()) / 3_600_000);
  // Um dia e duas horas de folga: vendas e Full se renovam todo dia, então
  // passar disso quer dizer que o recálculo ou a captura pararam.
  const velha = horas > 26;

  if (horas < 1) return { texto: `há ${String(Math.max(1, Math.round(horas * 60)))} min`, velha };
  if (horas < 48) return { texto: `há ${String(Math.floor(horas))} h`, velha };

  return { texto: `há ${String(Math.floor(horas / 24))} dias`, velha };
}
