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

import { LIMIAR_ATRASO_H, lojaDeTeste } from "./saude-loja-shopee";

export interface LinhaReposicao extends SkuReplenishmentRow {
  readonly purchase_cost: number | null;
  readonly abc_class: string | null;
  readonly coverage_days: number | null;
  readonly state: string | null;
  readonly suggested_quantity: number | null;
  /**
   * A parte da Shopee em `units_30d`/`units_90d` (C-65, D-464), que já a somam.
   * Nulo = a organização não tem loja Shopee em produção com pedidos lidos e a
   * demanda é só a do ML; 0 = há loja e o SKU não vendeu nela.
   */
  readonly units_30d_shopee: number | null;
  readonly units_90d_shopee: number | null;
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

  /*
    C-65 (D-464). Chave AUSENTE é a função de antes da migration — a demanda
    ainda é só a do ML, o mesmo que nulo. Chave presente com outra coisa que
    número ou nulo continua fora do contrato.
  */
  const shopee30 = v.units_30d_shopee ?? null;
  const shopee90 = v.units_90d_shopee ?? null;

  if (!numOuNulo(shopee30) || !numOuNulo(shopee90)) return null;

  return {
    units_30d_shopee: shopee30,
    units_90d_shopee: shopee90,
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

/**
 * A SHOPEE NA DEMANDA (C-65, D-464). O sinal é a PRÓPRIA resposta da RPC, não
 * uma regra refeita aqui: o SQL devolve a parte da Shopee nula para a
 * organização inteira quando não há loja em produção com pedidos lidos, e
 * número quando há. Ler a regra da C-52 mentiria entre a publicação da web e a
 * migration de produção, quando a loja existe e a conta ainda não a soma.
 * Página sem linha (filtro vazio) não diz nada.
 */
export type DemandaShopee = "inclui" | "fora" | "sem-linhas";

export function demandaDaShopee(linhas: readonly LinhaReposicao[]): DemandaShopee {
  if (linhas.length === 0) return "sem-linhas";

  return linhas.some((linha) => linha.units_30d_shopee !== null) ? "inclui" : "fora";
}

/** A loja como a C-52 a entrega, só o que o selo usa. */
export interface LojaDaDemanda {
  readonly environment: string | null;
  /** A última leitura de pedidos que TERMINOU. */
  readonly orders_synced_at: string | null;
}

export interface SeloShopee {
  readonly texto: string;
  /** Pede atenção: leitura atrasada, ou loja lida que a conta não soma. */
  readonly alerta: boolean;
  readonly titulo: string;
}

/**
 * O selo da Shopee em "Dados usados". `lojas` nulo = a leitura da C-52 falhou:
 * o selo ainda diz se a Shopee entra, sem inventar frescor. A idade é a da loja
 * mais atrasada, com o limiar do vigia (D-435): é a mesma loja que o sino avisa.
 * `null` = nada a dizer (sem linha, ou organização sem loja Shopee).
 */
export function seloDaShopee(
  demanda: DemandaShopee,
  lojas: readonly LojaDaDemanda[] | null,
  agora: Date,
): SeloShopee | null {
  if (demanda === "sem-linhas") return null;

  const lidas = (lojas ?? [])
    .flatMap((loja) => (!lojaDeTeste(loja) && loja.orders_synced_at !== null ? [loja.orders_synced_at] : []))
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  if (demanda === "inclui") {
    const maisAntiga = lidas[0];

    if (maisAntiga === undefined) {
      return {
        texto: lojas === null ? "Shopee na demanda · frescor não lido" : "Shopee na demanda",
        alerta: false,
        titulo: "A venda soma o Mercado Livre e as lojas Shopee em produção.",
      };
    }

    const horas = (agora.getTime() - new Date(maisAntiga).getTime()) / 3_600_000;
    const idade = idadeDaLeitura(maisAntiga, agora)?.texto ?? "";

    return {
      texto:
        lidas.length === 1
          ? `Shopee na demanda · pedidos lidos ${idade}`
          : `Shopee na demanda · ${String(lidas.length)} lojas, a mais atrasada lida ${idade}`,
      alerta: horas > LIMIAR_ATRASO_H,
      titulo: `A venda soma o Mercado Livre e as lojas Shopee em produção. A partir de ${String(LIMIAR_ATRASO_H)} h sem leitura de pedidos, a venda recente da Shopee pode estar faltando.`,
    };
  }

  if (lojas === null) {
    return { texto: "Shopee fora da demanda", alerta: false, titulo: "A venda é só a do Mercado Livre." };
  }

  if (lojas.length === 0) return null;

  // Loja em produção já lida e a conta sem ela: a migration ainda não chegou.
  if (lidas.length > 0) {
    return {
      texto: "Shopee fora da demanda · a conta ainda não a soma",
      alerta: true,
      titulo:
        "Há loja Shopee em produção com pedidos lidos, mas a conta desta tela ainda é só a do Mercado Livre: a cobertura sai alta demais e a sugestão baixa demais para quem vende na Shopee.",
    };
  }

  return {
    texto: "Shopee fora da demanda · nenhuma loja em produção lida",
    alerta: false,
    titulo:
      "A venda é só a do Mercado Livre: a Shopee entra quando houver loja em produção com pedidos lidos. Loja de teste fica fora.",
  };
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
