/**
 * A leitura do repasse da Shopee (C-64, D-451; a tela é D-458) — sem React e
 * sem banco, para ser testável.
 *
 * O repasse é o REALIZADO ao lado do previsto: o dinheiro que a Shopee
 * liberou, pelo dia da liberação, contra o `escrow_amount` dos mesmos
 * pedidos. Não muda o recebido nem o resultado (C-58/C-61), e não se compara
 * com a receita do mesmo período — o liberado é do dia em que o dinheiro
 * saiu, não o da venda.
 *
 * As funções devolvem TOTAL (só lojas live já lidas; ausente quando não há
 * nenhuma) e uma linha por loja (nunca lida = NULO; lida sem repasse = 0).
 * **Nada é somado aqui.**
 */

import type { Database } from "@sb/db";

type Funcoes = Database["public"]["Functions"];

export type LinhaRepasse = Funcoes["get_shopee_repasse_overview"]["Returns"][number];
export type LinhaPendente = Funcoes["get_shopee_repasse_pendente"]["Returns"][number];
export type Liberacao = Funcoes["get_shopee_repasses"]["Returns"][number];

export interface Separado<T> {
  /** `null` = nenhuma loja real com os repasses lidos: não há total. */
  readonly total: T | null;
  readonly lojas: readonly T[];
}

export function separarPorNivel<T extends { readonly nivel: string }>(linhas: readonly T[] | null): Separado<T> {
  const todas = linhas ?? [];

  return {
    total: todas.find((linha) => linha.nivel === "TOTAL") ?? null,
    lojas: todas.filter((linha) => linha.nivel === "CONTA"),
  };
}

/** A loja de teste aparece na lista, marcada, e nunca no total. */
export function lojaDeTesteDoRepasse(linha: { readonly environment: string | null }): boolean {
  return linha.environment !== null && linha.environment !== "live";
}

/**
 * A ressalva da unidade (D-451): até a conferência com a Shopee, o valor de
 * cada liberação não tem a unidade confirmada, e uma diferença em TODOS os
 * pedidos é o sinal de unidade errada, não de cobrança. Aqui só se lê o
 * padrão nas contagens que o banco deu (divergentes = todos os comparáveis,
 * com pelo menos 3 para não alarmar com um pedido só); a tela diz.
 */
export function divergenciaEmTodos(linha: LinhaRepasse): boolean {
  const { pedidos_divergentes: divergentes, pedidos_com_previsto: comPrevisto } = linha;

  return divergentes !== null && comPrevisto !== null && comPrevisto >= 3 && divergentes === comPrevisto;
}
