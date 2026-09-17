/**
 * A leitura de `get_purchase_orders_overview` (D-365) e as peças puras da tela
 * `/compras` — sem React e sem banco, para ser testável.
 *
 * Mesmo desenho de `lib/replenishment-overview.ts`: a RPC devolve `jsonb`, cada
 * campo é conferido, e uma resposta fora do contrato é recusada INTEIRA. Um
 * campo renomeado no SQL não pode chegar como `undefined` e sair "—", que se lê
 * como "não observado" (D-131).
 *
 * Nada aqui soma: contagem, unidades e valor vêm do SQL.
 */

import type { Tom } from "../components/tone";

export interface LinhaCompra {
  readonly id: string;
  readonly order_number: number;
  readonly status: string;
  readonly supplier_id: string | null;
  readonly supplier_name: string | null;
  readonly destination_warehouse_name: string | null;
  readonly created_at: string;
  readonly created_by_name: string | null;
  readonly approved_at: string | null;
  readonly ordered_at: string | null;
  readonly received_at: string | null;
  readonly cancelled_at: string | null;
  /** Data de negócio `AAAA-MM-DD` — nunca passar por `new Date` (D-365). */
  readonly previsao: string | null;
  /** Dias da data de hoje (São Paulo) até a previsão; negativo = passou. `null` sem previsão ou na leitura antiga. */
  readonly dias_para_previsao: number | null;
  readonly atrasado: boolean;
  readonly itens: number;
  /** `null` só na leitura antiga (`get_purchase_orders` não traz unidades). */
  readonly unidades: number | null;
  readonly sem_custo: number;
  /** D-254: 0 sem item (zero sabido), `null` quando nenhum item tem custo. */
  readonly valor: number | null;
}

export interface AgregadoCompra {
  readonly pedidos: number;
  /** `null` quando nenhum pedido do grupo tem valor conhecido — nunca R$ 0,00. */
  readonly valor: number | null;
  readonly unidades: number;
  /** Pedidos com algum item sem custo: o valor do grupo é parcial. */
  readonly sem_custo: number;
}

export interface ContagemCompra {
  readonly status: string;
  readonly pedidos: number;
  readonly valor: number | null;
  readonly sem_custo: number;
}

export interface VisaoCompras {
  readonly total: number;
  readonly contagens: readonly ContagemCompra[];
  readonly emAberto: AgregadoCompra;
  readonly atrasados: AgregadoCompra & { readonly maiorAtrasoDias: number };
  readonly chegando: AgregadoCompra;
  readonly recebidos: AgregadoCompra;
  readonly linhas: readonly LinhaCompra[];
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const numOuNulo = (v: unknown): v is number | null => v === null || ehNum(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

function lerAgregado(v: unknown): AgregadoCompra | null {
  if (!ehObj(v)) return null;

  const { pedidos, valor, unidades, sem_custo } = v;

  if (!ehNum(pedidos) || !numOuNulo(valor) || !ehNum(unidades) || !ehNum(sem_custo)) return null;

  return { pedidos, valor, unidades, sem_custo };
}

const TEXTOS_OU_NULOS = [
  "supplier_id",
  "supplier_name",
  "destination_warehouse_name",
  "created_by_name",
  "approved_at",
  "ordered_at",
  "received_at",
  "cancelled_at",
  "previsao",
] as const;

function lerLinha(v: unknown): LinhaCompra | null {
  if (!ehObj(v)) return null;

  if (typeof v.id !== "string" || typeof v.status !== "string" || typeof v.created_at !== "string") return null;
  if (!ehNum(v.order_number) || typeof v.atrasado !== "boolean") return null;
  if (!ehNum(v.itens) || !ehNum(v.unidades) || !ehNum(v.sem_custo)) return null;
  if (!numOuNulo(v.valor) || !numOuNulo(v.dias_para_previsao)) return null;

  const textos: Partial<Record<(typeof TEXTOS_OU_NULOS)[number], string | null>> = {};

  for (const campo of TEXTOS_OU_NULOS) {
    const valor = v[campo];

    if (!textoOuNulo(valor)) return null;
    textos[campo] = valor;
  }

  return {
    id: v.id,
    order_number: v.order_number,
    status: v.status,
    created_at: v.created_at,
    dias_para_previsao: v.dias_para_previsao,
    atrasado: v.atrasado,
    itens: v.itens,
    unidades: v.unidades,
    sem_custo: v.sem_custo,
    valor: v.valor,
    ...(textos as Record<(typeof TEXTOS_OU_NULOS)[number], string | null>),
  };
}

/** `null` = resposta fora do contrato. A tela recusa em vez de mostrar pedaço. */
export function lerVisaoCompras(dado: unknown): VisaoCompras | null {
  if (!ehObj(dado) || !ehNum(dado.total)) return null;
  if (!Array.isArray(dado.contagens) || !Array.isArray(dado.linhas)) return null;

  const emAberto = lerAgregado(dado.em_aberto);
  const atrasados = lerAgregado(dado.atrasados);
  const chegando = lerAgregado(dado.chegando);
  const recebidos = lerAgregado(dado.recebidos);

  if (emAberto === null || atrasados === null || chegando === null || recebidos === null) return null;
  if (!ehObj(dado.atrasados) || !ehNum(dado.atrasados.maior_atraso_dias)) return null;

  const contagens: ContagemCompra[] = [];

  for (const item of dado.contagens) {
    if (!ehObj(item) || typeof item.status !== "string") return null;
    if (!ehNum(item.pedidos) || !numOuNulo(item.valor) || !ehNum(item.sem_custo)) return null;

    contagens.push({ status: item.status, pedidos: item.pedidos, valor: item.valor, sem_custo: item.sem_custo });
  }

  const linhas: LinhaCompra[] = [];

  for (const item of dado.linhas) {
    const linha = lerLinha(item);

    if (linha === null) return null;
    linhas.push(linha);
  }

  return {
    total: dado.total,
    contagens,
    emAberto,
    atrasados: { ...atrasados, maiorAtrasoDias: dado.atrasados.maior_atraso_dias },
    chegando,
    recebidos,
    linhas,
  };
}

/** Linha de `get_purchase_orders` (D-255), a leitura que a tela usa enquanto a D-365 não chegou ao banco. */
export interface LinhaLegado {
  id: string;
  order_number: number;
  status: string;
  supplier_name: string | null;
  destination_warehouse_name: string | null;
  expected_at: string | null;
  created_at: string;
  created_by_name: string | null;
  items_count: number;
  items_missing_cost: number;
  estimated_value: number | null;
}

/**
 * A leitura antiga na forma nova. O que ela não sabe fica nulo, nunca inventado:
 * sem unidades, sem carimbos e sem "dias até a previsão" — o selo de atraso não
 * aparece em vez de aparecer errado. A previsão é a data de negócio, cortada do
 * instante como a edição já faz.
 */
export function linhaDoLegado(row: LinhaLegado): LinhaCompra {
  return {
    id: row.id,
    order_number: row.order_number,
    status: row.status,
    supplier_id: null,
    supplier_name: row.supplier_name,
    destination_warehouse_name: row.destination_warehouse_name,
    created_at: row.created_at,
    created_by_name: row.created_by_name,
    approved_at: null,
    ordered_at: null,
    received_at: null,
    cancelled_at: null,
    previsao: row.expected_at === null ? null : row.expected_at.slice(0, 10),
    dias_para_previsao: null,
    atrasado: false,
    itens: row.items_count,
    unidades: null,
    sem_custo: row.items_missing_cost,
    valor: row.estimated_value,
  };
}

export interface Passo {
  readonly texto: string;
  readonly tom: Tom;
}

/**
 * O que o pedido espera de quem opera — a pergunta que a fila responde sem
 * abrir o pedido. Só fatos da linha: fornecedor ausente e custo faltando
 * travam a aprovação na prática (o PDF sai sem valor), então o rascunho diz o
 * que falta antes de dizer "aprovar".
 */
export function proximoPasso(linha: LinhaCompra): Passo | null {
  switch (linha.status) {
    case "DRAFT": {
      const faltas: string[] = [];

      if (linha.supplier_name === null) faltas.push("fornecedor");
      if (linha.itens === 0) faltas.push("itens");
      else if (linha.sem_custo > 0) faltas.push("custo");

      return faltas.length > 0
        ? { texto: `Completar ${faltas.join(" e ")}`, tom: "atencao" }
        : { texto: "Aprovar", tom: "info" };
    }
    case "APPROVED":
      return { texto: "Enviar ao fornecedor", tom: linha.atrasado ? "perigo" : "info" };
    case "ORDERED":
      return { texto: "Conferir recebimento", tom: linha.atrasado ? "perigo" : "info" };
    default:
      return null;
  }
}

/**
 * A previsão lida por quem opera: "em 3 dias", "hoje", "atrasado 5 dias". Só
 * pedidos em andamento ganham tom; recebido e cancelado mostram a data seca,
 * porque a previsão já não decide nada.
 */
export function leituraPrevisao(linha: LinhaCompra): { data: string; nota: string | null; tom: Tom | null } | null {
  if (linha.previsao === null) return null;

  const [ano, mes, dia] = linha.previsao.split("-");
  const data = `${dia ?? ""}/${mes ?? ""}/${ano ?? ""}`;
  const emAndamento = linha.status === "APPROVED" || linha.status === "ORDERED";
  const dias = linha.dias_para_previsao;

  if (!emAndamento || dias === null) return { data, nota: null, tom: null };

  if (dias < 0) {
    const atraso = -dias;

    return { data, nota: `atrasado ${String(atraso)} ${atraso === 1 ? "dia" : "dias"}`, tom: "perigo" };
  }

  if (dias === 0) return { data, nota: "chega hoje", tom: "atencao" };
  if (dias <= 7) return { data, nota: `em ${String(dias)} ${dias === 1 ? "dia" : "dias"}`, tom: "atencao" };

  return { data, nota: `em ${String(dias)} dias`, tom: "neutro" };
}

/**
 * Onde o pedido está no ciclo de quatro etapas (rascunho, aprovado, enviado,
 * recebido), para a régua da linha. Cancelado não é quinta etapa (D-277): a
 * régua para onde ele parou, e a tela pinta de perigo.
 */
export function etapaDoPedido(linha: LinhaCompra): { feitas: number; cancelado: boolean } {
  switch (linha.status) {
    case "DRAFT":
      return { feitas: 1, cancelado: false };
    case "APPROVED":
      return { feitas: 2, cancelado: false };
    case "ORDERED":
      return { feitas: 3, cancelado: false };
    case "RECEIVED":
      return { feitas: 4, cancelado: false };
    default: {
      // Os carimbos dizem até onde o cancelado chegou; na leitura antiga não há
      // carimbo, e a régua fica no rascunho.
      const feitas = linha.ordered_at !== null ? 3 : linha.approved_at !== null ? 2 : 1;

      return { feitas, cancelado: true };
    }
  }
}
