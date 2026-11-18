import type { ArrivalRisk, OpenPurchaseSituation } from "@sb/domain";

import { formatBusinessDate, formatCount } from "./format";

/**
 * "Pedido já feito" na reposição (D-760 a D-763): o contrato de
 * `get_open_purchases_for_skus` e as frases que a linha mostra.
 *
 * A quantidade adicional vem SEMPRE da sugestão canônica (já líquida do
 * trânsito): esta camada nunca subtrai o pedido de novo.
 */

export interface PedidoEmAberto {
  readonly skuId: string;
  readonly itemId: string;
  readonly purchaseOrderId: string;
  readonly orderNumber: number;
  readonly status: "DRAFT" | "APPROVED" | "ORDERED";
  readonly logisticsStage: string | null;
  readonly origin: "INTERNO" | "EXTERNO_MANUAL" | "PLANILHA";
  readonly externalReference: string | null;
  readonly supplierName: string | null;
  readonly quantityOrdered: number;
  readonly quantityReceived: number;
  /** Só no pedido feito: o que falta chegar. */
  readonly pendente: number | null;
  readonly expectedAt: string | null;
  readonly supplierOrderedOn: string | null;
}

type Obj = Record<string, unknown>;
const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehTexto = (v: unknown): v is string => typeof v === "string";
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const STATUS = new Set(["DRAFT", "APPROVED", "ORDERED"]);
const ORIGENS = new Set(["INTERNO", "EXTERNO_MANUAL", "PLANILHA"]);

/**
 * `null` = desconhecido (sem acesso a compras, ou resposta fora do contrato).
 * Mapa vazio = acesso e nenhum pedido em aberto.
 */
export function lerPedidosEmAberto(dado: unknown): ReadonlyMap<string, readonly PedidoEmAberto[]> | null {
  if (!Array.isArray(dado)) return null;

  const porSku = new Map<string, PedidoEmAberto[]>();

  for (const v of dado) {
    if (!ehObj(v)) return null;

    const { skuId, itemId, purchaseOrderId, orderNumber, status, origin, quantityOrdered, quantityReceived } = v;

    if (!ehTexto(skuId) || !ehTexto(itemId) || !ehTexto(purchaseOrderId) || !ehNum(orderNumber)) return null;
    if (!ehTexto(status) || !STATUS.has(status) || !ehTexto(origin) || !ORIGENS.has(origin)) return null;
    if (!ehNum(quantityOrdered) || !ehNum(quantityReceived)) return null;
    if (!textoOuNulo(v.logisticsStage) || !textoOuNulo(v.externalReference) || !textoOuNulo(v.supplierName)) return null;
    if (!textoOuNulo(v.expectedAt) || !textoOuNulo(v.supplierOrderedOn)) return null;
    if (v.pendente !== null && !ehNum(v.pendente)) return null;

    const pedido: PedidoEmAberto = {
      skuId,
      itemId,
      purchaseOrderId,
      orderNumber,
      status: status as PedidoEmAberto["status"],
      logisticsStage: v.logisticsStage,
      origin: origin as PedidoEmAberto["origin"],
      externalReference: v.externalReference,
      supplierName: v.supplierName,
      quantityOrdered,
      quantityReceived,
      pendente: v.pendente,
      expectedAt: v.expectedAt,
      supplierOrderedOn: v.supplierOrderedOn,
    };

    const lista = porSku.get(skuId) ?? [];
    lista.push(pedido);
    porSku.set(skuId, lista);
  }

  return porSku;
}

/** A previsão é a data de negócio gravada como meia-noite UTC (D-365). */
export function dataDaPrevisao(expectedAt: string | null): string | null {
  return expectedAt === null ? null : expectedAt.slice(0, 10);
}

export const ORIGEM_PEDIDO: Record<PedidoEmAberto["origin"], string> = {
  INTERNO: "pedido interno",
  EXTERNO_MANUAL: "pedido externo",
  PLANILHA: "importado de planilha",
};

/** A situação do pedido do jeito que o comprador fala (D-763). */
export function situacaoDoPedido(p: PedidoEmAberto, etapas: Readonly<Record<string, string>>): string {
  if (p.status !== "ORDERED") return "Planejado";
  if (p.quantityReceived > 0) return "Recebido em parte";
  if (p.logisticsStage !== null) return etapas[p.logisticsStage] ?? p.logisticsStage;

  return "Pedido realizado";
}

export interface ResumoPedidoJaFeito {
  readonly titulo: string;
  readonly detalhe: string | null;
  readonly tom: "ok" | "atencao" | "perigo" | "info" | "neutro";
}

/**
 * A frase da linha: "1.000 un já pedidas. Necessidade adicional: 200 un." ou
 * "Reposição já encomendada…". O risco até a chegada NUNCA some quando a
 * reposição está coberta: é ele que diz que comprar não é ter.
 */
export function resumoPedidoJaFeito(input: {
  situacao: OpenPurchaseSituation;
  risco: ArrivalRisk | null;
  pendente: number | null;
  planejada: number | null;
  sugestao: number | null;
}): ResumoPedidoJaFeito | null {
  const { situacao, risco, pendente, planejada, sugestao } = input;

  if (situacao === "DESCONHECIDA" || situacao === "SEM_PEDIDO") return null;

  if (situacao === "PLANEJADO") {
    return {
      titulo: `${formatCount(planejada ?? 0)} un em pedido planejado`,
      detalhe: "Ainda não foi comprado: a necessidade continua inteira.",
      tom: "neutro",
    };
  }

  const pedidas = `${formatCount(pendente ?? 0)} un já pedidas`;
  const titulo =
    situacao === "ENCOMENDADO_COMPLEMENTAR"
      ? `${pedidas}. Necessidade adicional: ${formatCount(sugestao ?? 0)} un.`
      : situacao === "ENCOMENDADO_COBRE"
        ? "Reposição já encomendada. Nenhuma nova compra necessária por enquanto."
        : `${pedidas}. Sem sugestão para dizer se falta mais.`;

  return { titulo, detalhe: risco === null ? null : textoDoRisco(risco), tom: tomDoRisco(risco, situacao) };
}

export function textoDoRisco(r: ArrivalRisk): string {
  const cobre =
    r.coverageWithoutTransitDays === null
      ? null
      : `o estoque sem o trânsito cobre ${formatCount(Math.floor(r.coverageWithoutTransitDays))} dia(s)`;

  switch (r.kind) {
    case "ATRASADO":
      return `Pedido atrasado${r.daysUntilArrival === null ? "" : ` (previsão vencida há ${formatCount(-r.daysUntilArrival)} dia(s))`}${cobre === null ? "" : `; ${cobre}`}.`;
    case "RUPTURA_ANTES_DA_CHEGADA":
      return `Risco de ruptura até a chegada: ${cobre ?? "sem base"} e a chegada prevista é em ${formatCount(r.daysUntilArrival ?? 0)} dia(s).`;
    case "CHEGA_A_TEMPO":
      return `Chega a tempo: ${cobre ?? ""} e a chegada prevista é em ${formatCount(r.daysUntilArrival ?? 0)} dia(s).`;
    case "SEM_PREVISAO":
      return `Sem previsão de chegada: não dá para dizer se o estoque aguenta${cobre === null ? "" : ` (${cobre})`}.`;
    case "INDETERMINADO":
      return "Sem venda recente ou com estoque virtual: não há como projetar a ruptura até a chegada.";
  }
}

function tomDoRisco(r: ArrivalRisk | null, situacao: OpenPurchaseSituation): ResumoPedidoJaFeito["tom"] {
  if (r?.kind === "ATRASADO" || r?.kind === "RUPTURA_ANTES_DA_CHEGADA") return "perigo";
  if (r?.kind === "SEM_PREVISAO") return "atencao";
  if (situacao === "ENCOMENDADO_COMPLEMENTAR") return "atencao";

  return "ok";
}

export function previsaoTexto(expectedAt: string | null): string {
  const d = dataDaPrevisao(expectedAt);

  return d === null ? "sem previsão" : formatBusinessDate(d);
}
