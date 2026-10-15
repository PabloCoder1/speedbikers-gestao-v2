/**
 * A leitura das devoluções da Shopee (C-62, D-447; a tela é D-460) — sem React
 * e sem banco, para ser testável.
 *
 * `get_shopee_returns_summary` devolve um TOTAL (só lojas live com as
 * devoluções já lidas; ausente quando não há nenhuma) e uma linha por loja
 * (nunca lida = NULO; lida sem devolução = 0), com `por_situacao` em jsonb.
 * `get_shopee_returns` devolve uma linha por devolução, com os itens em
 * jsonb. **Nada é somado aqui.**
 *
 * Duas regras do contrato que a tela segue à risca:
 * - a SITUAÇÃO vem como a Shopee manda (REQUESTED, ACCEPTED, CLOSED…): a
 *   documentação não diz em qual delas o reembolso foi pago, então a tela não
 *   traduz nem chama o valor de "reembolsado" — é o "valor de reembolso
 *   informado";
 * - nada do comprador existe aqui (o banco não guarda).
 */

import type { Database } from "@sb/db";

type Funcoes = Database["public"]["Functions"];

export type LinhaResumoDevolucoes = Funcoes["get_shopee_returns_summary"]["Returns"][number];
export type LinhaDevolucao = Funcoes["get_shopee_returns"]["Returns"][number];

export interface ResumoDevolucoes {
  /** `null` = nenhuma loja real com as devoluções lidas: não há total. */
  readonly total: LinhaResumoDevolucoes | null;
  readonly lojas: readonly LinhaResumoDevolucoes[];
}

export function separarResumoDevolucoes(linhas: readonly LinhaResumoDevolucoes[] | null): ResumoDevolucoes {
  const todas = linhas ?? [];

  return {
    total: todas.find((linha) => linha.nivel === "TOTAL") ?? null,
    lojas: todas.filter((linha) => linha.nivel === "CONTA"),
  };
}

/** A loja de teste aparece na lista, marcada, e nunca no total. */
export function lojaDeTesteDasDevolucoes(linha: { readonly environment: string | null }): boolean {
  return linha.environment !== null && linha.environment !== "live";
}

export interface Situacao {
  /** O código como a Shopee manda — nunca traduzido. */
  readonly situacao: string;
  readonly devolucoes: number;
  /** `null` = nenhuma devolução da situação veio com o valor informado. */
  readonly valorReembolso: number | null;
  readonly unidades: number;
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * `por_situacao` (`{SITUACAO: {devolucoes, valor_reembolso, unidades}}`) como
 * lista, da situação com mais devoluções para a com menos. `null` = nulo no
 * banco (loja nunca lida) OU fora do contrato — a tela não mostra pedaço.
 */
export function lerPorSituacao(dado: unknown): readonly Situacao[] | null {
  if (!ehObj(dado)) return null;

  const saida: Situacao[] = [];

  for (const [situacao, valor] of Object.entries(dado)) {
    if (!ehObj(valor) || !ehNum(valor.devolucoes) || !ehNum(valor.unidades)) return null;
    if (valor.valor_reembolso !== null && !ehNum(valor.valor_reembolso)) return null;

    saida.push({
      situacao,
      devolucoes: valor.devolucoes,
      valorReembolso: valor.valor_reembolso,
      unidades: valor.unidades,
    });
  }

  return saida.sort((a, b) => b.devolucoes - a.devolucoes || a.situacao.localeCompare(b.situacao));
}

export interface ItemDevolvido {
  readonly nome: string | null;
  readonly quantidade: number | null;
  readonly skuId: string | null;
  readonly sku: string | null;
}

/** Os itens de uma devolução (jsonb). Fora do contrato = `null`, e a linha diz que não foram lidos. */
export function lerItensDevolvidos(dado: unknown): readonly ItemDevolvido[] | null {
  if (!Array.isArray(dado)) return null;

  const saida: ItemDevolvido[] = [];

  for (const item of dado) {
    if (!ehObj(item)) return null;

    const { nome, quantidade, sku_id: skuId, sku } = item;

    if (nome !== null && typeof nome !== "string") return null;
    if (quantidade !== null && !ehNum(quantidade)) return null;
    if (skuId !== null && typeof skuId !== "string") return null;
    if (sku !== null && typeof sku !== "string") return null;

    saida.push({ nome, quantidade, skuId, sku });
  }

  return saida;
}

/**
 * O que a devolução pede, nas palavras da tela. Os dois valores do contrato
 * (`RETURN_REFUND`, `REFUND`); qualquer outro aparece como veio.
 */
export function rotuloDaSolucao(solucao: string | null): string | null {
  if (solucao === null) return null;
  if (solucao === "RETURN_REFUND") return "devolução e reembolso";
  if (solucao === "REFUND") return "só reembolso";

  return solucao;
}
