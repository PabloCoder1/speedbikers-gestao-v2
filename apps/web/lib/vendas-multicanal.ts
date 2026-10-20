/**
 * `/vendas` com MAIS DE UM MARKETPLACE (D-440, etapa T4 da frente multicanal),
 * sobre o contrato C-53 (`get_marketplace_sales_summary` e
 * `get_marketplace_sales_daily`, D-436).
 *
 * `marketplace=ml` é a tela do Mercado Livre de sempre, com as RPCs dele.
 * `marketplace=todos` e `marketplace=shopee` são a MESMA tela com outro
 * recorte, lida do contrato multicanal — cujo TOTAL já vem somado no
 * SQL, só com o que tem a mesma semântica (`docs/METRICS.md` 5T). Aqui mora só
 * o que a tela precisa decidir: o recorte da URL, as contas que valem nele, o
 * endereço de cada troca e a forma das linhas. **Nada aqui soma.**
 */

import { shiftBusinessDate } from "@sb/domain";

import { buildFilterHref } from "./filters";
import { DEFAULT_PERIOD_DAYS } from "./period";
import type { KpiCellData } from "../components/kpi-strip";
import { formatCount, formatCurrency } from "./format";
import type { SalesMetric } from "./sales-metric";
import type { FiltroDeMarca } from "./vendas-ml-filtros";

/** O recorte de marketplace de `/vendas`. `ml` é a tela de sempre. */
export type EscopoVendas = "ml" | "todos" | "shopee";

export type EscopoMulticanal = Exclude<EscopoVendas, "ml">;

export type CodigoMarketplace = "ML" | "SHOPEE";

/** Valor desconhecido cai na tela de sempre, em silêncio — como a métrica e a conta. */
export function resolverEscopoVendas(raw: unknown): EscopoVendas {
  return raw === "todos" || raw === "shopee" ? raw : "ml";
}

/**
 * O recorte da `/vendas` (D-488, decisão do dono de 16/10, depois do Go Live):
 * SEM `marketplace` na URL, a tela abre em "Todos os marketplaces". O Mercado
 * Livre sozinho é `marketplace=ml`, explícito.
 *
 * Compatibilidade: um link ou filtro salvo de antes, sem `marketplace` mas com
 * um parâmetro que só a tela do ML entende (a conta por slug, a marca, a métrica
 * de pedidos ou de packs), continua abrindo no ML — é o que ele queria dizer.
 * `/faturamento` e `/curva-abc` não mudam: lá, sem `marketplace`, segue o ML.
 */
export function resolverEscopoDaTelaDeVendas(query: Readonly<Record<string, unknown>>): EscopoVendas {
  const pedido = query.marketplace;

  if (pedido === "ml" || pedido === "todos" || pedido === "shopee") return pedido;

  const soDoMl =
    query.account !== undefined ||
    query.marca !== undefined ||
    query.semMarca !== undefined ||
    query.metric === "pedidos" ||
    query.metric === "packs";

  return soDoMl ? "ml" : "todos";
}

/** O recorte que fica FORA da URL em cada tela: o padrão dela. */
const ESCOPO_PADRAO: Readonly<Record<TelaDoRecorte, EscopoVendas>> = { "/vendas": "todos", "/faturamento": "ml" };

/** O `p_marketplaces` do contrato: nulo seria "só ML", que é a outra tela. */
export function marketplacesDoEscopo(escopo: EscopoMulticanal): CodigoMarketplace[] {
  return escopo === "todos" ? ["ML", "SHOPEE"] : ["SHOPEE"];
}

export const ROTULO_DO_ESCOPO: Readonly<Record<EscopoVendas, string>> = {
  ml: "Mercado Livre",
  todos: "Todos os marketplaces",
  shopee: "Shopee",
};

/** Uma conta do seletor, como `marketplace_accounts` (C-52) a devolve. */
export interface ContaDoSeletor {
  readonly account_id: string;
  readonly marketplace: CodigoMarketplace;
  readonly name: string;
  readonly environment: string;
}

function cabeNoEscopo(conta: ContaDoSeletor, escopo: EscopoMulticanal): boolean {
  return escopo === "todos" || conta.marketplace === "SHOPEE";
}

/**
 * As contas da URL (`contas=<id>,<id>`) que valem: as que a pessoa alcança — a
 * lista já vem da RLS — e que cabem no recorte. Um valor só, separado por
 * vírgula, para caber num filtro salvo (que guarda um valor por parâmetro).
 * Nenhuma válida = todas (`null`). `descartadas` diz quantas do link sumiram,
 * para a tela avisar em vez de mudar o recorte calada.
 */
export function resolverContas(
  raw: unknown,
  contas: readonly ContaDoSeletor[],
  escopo: EscopoMulticanal,
): { selecionadas: ContaDoSeletor[] | null; descartadas: number } {
  if (typeof raw !== "string" || raw.trim() === "") return { selecionadas: null, descartadas: 0 };

  const pedidas = [...new Set(raw.split(",").map((id) => id.trim()).filter((id) => id !== ""))];
  const validas = contas.filter((conta) => pedidas.includes(conta.account_id) && cabeNoEscopo(conta, escopo));

  return {
    selecionadas: validas.length === 0 ? null : validas,
    descartadas: pedidas.length - validas.length,
  };
}

/** Liga ou desliga uma conta do recorte; a última desligada volta para "todas". */
export function alternarConta(
  selecionadas: readonly ContaDoSeletor[] | null,
  conta: ContaDoSeletor,
): ContaDoSeletor[] | null {
  const atuais = selecionadas ?? [];
  const proximas = atuais.some((c) => c.account_id === conta.account_id)
    ? atuais.filter((c) => c.account_id !== conta.account_id)
    : [...atuais, conta];

  return proximas.length === 0 ? null : proximas;
}

export type Periodo = { days: number } | { from: string; to: string };

export interface RecorteDeVendas {
  readonly escopo: EscopoVendas;
  readonly periodo: Periodo;
  /** Só existe fora do ML: na tela de sempre a conta é `account=<slug>`. */
  readonly contas: readonly ContaDoSeletor[] | null;
  readonly metrica: string;
  /**
   * A marca do recorte (D-622, sobre o C-72): os MESMOS parâmetros da tela do
   * ML (`marca=` e `semMarca=1`, D-237), para a troca de marketplace levar a
   * marca junto. Só `/vendas` a conhece; ausente é "todas as marcas".
   */
  readonly marca?: FiltroDeMarca;
}

const TODAS_AS_MARCAS: FiltroDeMarca = { kind: "todas" };

/** Há recorte de marca: compras, ticket, recebido e cancelamento não se aplicam (C-72, D-237). */
export function sobMarca(recorte: Pick<RecorteDeVendas, "marca">): boolean {
  return recorte.marca !== undefined && recorte.marca.kind !== "todas";
}

const METRICA_PADRAO = "faturamento";

/** As telas que têm o recorte de marketplace com "Todos" (D-440, D-442). */
export type TelaDoRecorte = "/vendas" | "/faturamento";

/**
 * O endereço de `/vendas` com um recorte trocado. Trocar de marketplace leva
 * o período e só as contas que cabem no destino (a regra de D-431); a tela do
 * ML não recebe `contas` — lá a conta é outra coisa (`account=<slug>`). O que é
 * padrão fica fora da URL, como no resto da tela.
 */
export function hrefDeVendas(atual: RecorteDeVendas, troca: Partial<RecorteDeVendas> = {}): string {
  return hrefDoRecorte("/vendas", atual, troca);
}

/**
 * O mesmo endereço para qualquer tela com o recorte (`hrefDeVendas` é este,
 * em `/vendas`). `/faturamento` usa os mesmos nomes de parâmetro — trocar de
 * tela leva marketplace, período e contas junto.
 */
export function hrefDoRecorte(
  tela: TelaDoRecorte,
  atual: RecorteDeVendas,
  troca: Partial<RecorteDeVendas> = {},
): string {
  const escopo = troca.escopo ?? atual.escopo;
  const periodo = troca.periodo ?? atual.periodo;
  const metrica = troca.metrica ?? atual.metrica;
  const contasBase = troca.contas === undefined ? atual.contas : troca.contas;
  const contas =
    escopo === "ml" || contasBase === null ? null : contasBase.filter((conta) => cabeNoEscopo(conta, escopo));
  // A marca vale nos três recortes de `/vendas` (a tela do ML lê os mesmos nomes); o `/faturamento` não a tem.
  const marca = tela === "/vendas" ? (troca.marca ?? atual.marca ?? TODAS_AS_MARCAS) : TODAS_AS_MARCAS;

  return buildFilterHref(
    tela,
    {
      marketplace: escopo === ESCOPO_PADRAO[tela] ? null : escopo,
      ...("from" in periodo
        ? { from: periodo.from, to: periodo.to }
        : { days: periodo.days === DEFAULT_PERIOD_DAYS ? null : String(periodo.days) }),
      contas: contas === null || contas.length === 0 ? null : contas.map((conta) => conta.account_id).join(","),
      marca: marca.kind === "marca" ? marca.value : null,
      semMarca: marca.kind === "sem_marca" ? "1" : null,
      // A métrica do ML (`pedidos`, `packs`) não existe no consolidado, e a
      // daqui (`compras`) não existe no ML: a troca de tela volta ao padrão.
      metric: escopo === atual.escopo && metrica !== METRICA_PADRAO ? metrica : null,
    },
    1,
  );
}

/**
 * As três métricas que o consolidado plota, com os ids de `docs/METRICS.md`
 * 5T. "Pedidos" não está aqui de propósito: o pedido do ML é uma linha de item
 * e o da Shopee é um carrinho — o comparável é a COMPRA.
 */
const FATURAMENTO: SalesMetric = {
  key: "faturamento",
  definitionId: "multicanal_receita_bruta",
  label: "Faturamento",
  heading: "Receita bruta por dia",
  field: "gross_revenue",
  format: "currency",
};

export const METRICAS_MULTICANAL: readonly SalesMetric[] = [
  FATURAMENTO,
  {
    key: "unidades",
    definitionId: "multicanal_unidades",
    label: "Unidades",
    heading: "Unidades vendidas por dia",
    field: "units_sold",
    format: "count",
  },
  {
    key: "compras",
    definitionId: "multicanal_compras",
    label: "Compras",
    heading: "Compras por dia — o pack do Mercado Livre e o pedido da Shopee",
    field: "purchases_count",
    format: "count",
  },
];

export function resolverMetricaMulticanal(raw: unknown, comMarca = false): SalesMetric {
  return metricasDoRecorte(comMarca).find((metrica) => metrica.key === raw) ?? FATURAMENTO;
}

/**
 * As métricas que o gráfico oferece. Sob marca, a compra sai (D-622): o pack e
 * o pedido atravessam produtos, e a série dela vem NULA do C-72 — oferecer a
 * opção desenharia um gráfico vazio.
 */
export function metricasDoRecorte(comMarca: boolean): readonly SalesMetric[] {
  return comMarca ? METRICAS_MULTICANAL.filter((metrica) => metrica.field !== "purchases_count") : METRICAS_MULTICANAL;
}

/** Uma linha de `get_marketplace_sales_summary`. */
export interface LinhaDeVendas {
  readonly nivel: "TOTAL" | "MARKETPLACE" | "CONTA";
  readonly marketplace: CodigoMarketplace | null;
  readonly account_id: string | null;
  readonly account_name: string | null;
  readonly environment: string | null;
  readonly compras: number | null;
  readonly unidades: number | null;
  readonly receita_bruta: number | null;
  readonly pedidos_sem_receita: number | null;
  readonly ticket_medio: number | null;
  readonly pedidos_ml: number | null;
  readonly recebido: number | null;
  readonly pedidos_sem_recebido: number | null;
  readonly ultima_atualizacao: string | null;
}

export interface GrupoDeMarketplace {
  readonly marketplace: CodigoMarketplace;
  /** A soma do marketplace; ausente quando nada dele é somável (só loja de teste, ou nunca lida). */
  readonly soma: LinhaDeVendas | null;
  readonly contas: LinhaDeVendas[];
}

/**
 * As linhas do contrato na forma da tabela: o TOTAL e, por marketplace (ML
 * primeiro), a soma dele e as contas. É só ARRUMAÇÃO — cada número já veio
 * somado do SQL.
 */
export function agruparLinhas(linhas: readonly LinhaDeVendas[]): {
  total: LinhaDeVendas | null;
  grupos: GrupoDeMarketplace[];
} {
  const total = linhas.find((linha) => linha.nivel === "TOTAL") ?? null;
  const grupos = (["ML", "SHOPEE"] as const)
    .map((marketplace) => ({
      marketplace,
      soma: linhas.find((linha) => linha.nivel === "MARKETPLACE" && linha.marketplace === marketplace) ?? null,
      contas: linhas.filter((linha) => linha.nivel === "CONTA" && linha.marketplace === marketplace),
    }))
    .filter((grupo) => grupo.soma !== null || grupo.contas.length > 0);

  return { total, grupos };
}

/** Uma linha de `get_marketplace_sales_daily`. `marketplace` nulo = o total do dia. */
export interface DiaDeVendas {
  readonly dia: string;
  readonly marketplace: CodigoMarketplace | null;
  /** NULA sob recorte de marca (C-72): o pack e o pedido atravessam produtos. */
  readonly compras: number | null;
  readonly unidades: number;
  readonly receita_bruta: number | null;
  readonly pedidos_sem_receita: number;
}

/** O ponto que o gráfico de `/vendas` desenha (`app/(app)/vendas/sales-chart.tsx`). */
export interface PontoDoGrafico {
  readonly metric_date: string;
  readonly gross_revenue: number;
  readonly units_sold: number;
  readonly orders_count: number;
  readonly purchases_count: number | null;
}

/**
 * A série do TOTAL na forma do gráfico. Dia cuja receita é DESCONHECIDA (só
 * pedidos Shopee sem o financeiro, D-430) fica FORA da linha de faturamento e
 * é contado — desenhá-lo como zero afirmaria um dia sem venda. Nas outras
 * métricas ele entra: unidades e compras são conhecidas.
 */
export function pontosDoTotal(
  dias: readonly DiaDeVendas[],
  metrica: SalesMetric,
): { pontos: PontoDoGrafico[]; diasSemReceita: number } {
  const totais = dias.filter((dia) => dia.marketplace === null);
  const semReceita = totais.filter((dia) => dia.receita_bruta === null);
  const usados = metrica.field === "gross_revenue" ? totais.filter((dia) => dia.receita_bruta !== null) : totais;

  return {
    pontos: usados.map((dia) => ({
      metric_date: dia.dia,
      gross_revenue: dia.receita_bruta ?? 0,
      units_sold: dia.unidades,
      // O "pedido" não é métrica do consolidado; o campo existe pela forma do ponto.
      orders_count: 0,
      purchases_count: dia.compras,
    })),
    diasSemReceita: metrica.field === "gross_revenue" ? semReceita.length : 0,
  };
}

/** Quantos dias a Shopee guarda de histórico (a primeira leitura, D-426). */
export const HISTORICO_SHOPEE_DIAS = 90;

/**
 * O período começa antes do histórico da Shopee? Comparar com um período
 * anterior mais velho que isso faria a Shopee parecer ter crescido do nada
 * (risco T-R2) — a tela diz.
 */
export function antesDoHistoricoShopee(dataInicial: string, hoje: string): boolean {
  return dataInicial < shiftBusinessDate(hoje, -HISTORICO_SHOPEE_DIAS);
}

/** Por que a compra, o ticket, o recebido e o cancelamento são "—" sob marca (C-72, D-237). */
export const NAO_SE_APLICA_SOB_MARCA = "não se aplica sob recorte de marca: o pack e o pedido atravessam produtos";

/** O número formatado, ou "—" quando ele não existe (nunca zero no lugar de ausência). */
export function valorOuTraco(valor: number | null, formatar: (n: number) => string): string {
  return valor === null ? "—" : formatar(valor);
}

/**
 * As quatro células da faixa consolidada (`docs/METRICS.md` 5T): receita bruta,
 * compras, unidades e ticket médio, com o anterior ao lado. É a faixa do "Todos"
 * de `/vendas` e, desde a D-488, a da Home — a mesma função, para as duas telas
 * dizerem o mesmo número com a mesma fórmula. Sem nada somável (só loja de teste,
 * ou nenhuma lida), o "—" diz por quê.
 */
export function celulasDaFaixaMulticanal(
  total: LinhaDeVendas | null,
  totalAnterior: LinhaDeVendas | null,
  comMarca = false,
): KpiCellData[] {
  const anteriorTem = totalAnterior !== null;
  // D-622: sob marca, a compra e o ticket vêm NULOS do C-72, e a célula diz por quê.
  const naoSeAplica = comMarca ? { ressalva: NAO_SE_APLICA_SOB_MARCA } : {};

  return [
    {
      metricId: "multicanal_receita_bruta",
      label: "Receita bruta",
      formula:
        "Produtos com o desconto do vendedor, sem frete, nos dois marketplaces; pedido Shopee de receita desconhecida fica fora",
      value: valorOuTraco(total?.receita_bruta ?? null, formatCurrency),
      previous: anteriorTem ? valorOuTraco(totalAnterior.receita_bruta, formatCurrency) : null,
      ...((total?.pedidos_sem_receita ?? 0) > 0
        ? { ressalva: `${formatCount(total?.pedidos_sem_receita ?? 0)} pedidos Shopee sem receita conhecida, fora da soma` }
        : {}),
    },
    {
      metricId: "multicanal_compras",
      label: "Compras",
      formula: "O pack do Mercado Livre e o pedido da Shopee — a compra do cliente nos dois",
      value: valorOuTraco(total?.compras ?? null, formatCount),
      previous: anteriorTem ? valorOuTraco(totalAnterior.compras, formatCount) : null,
      ...naoSeAplica,
    },
    {
      metricId: "multicanal_unidades",
      label: "Unidades vendidas",
      formula: "Unidades do Mercado Livre e da Shopee",
      value: valorOuTraco(total?.unidades ?? null, formatCount),
      previous: anteriorTem ? valorOuTraco(totalAnterior.unidades, formatCount) : null,
    },
    {
      metricId: "multicanal_ticket_medio",
      label: "Ticket médio",
      formula: "receita bruta ÷ compras de receita conhecida, recalculado sobre a soma — nunca média de médias",
      value: valorOuTraco(total?.ticket_medio ?? null, formatCurrency),
      previous: anteriorTem ? valorOuTraco(totalAnterior.ticket_medio, formatCurrency) : null,
      ...naoSeAplica,
    },
  ].map((celula) => (total === null ? { ...celula, ressalva: "nenhuma conta com venda somável neste recorte" } : celula));
}
