/**
 * A leitura dos Ads CPC da loja Shopee (C-63, D-449; a tela é D-456) — sem
 * React e sem banco, para ser testável.
 *
 * `get_shopee_ads_overview` devolve uma linha TOTAL (só lojas live com Ads já
 * lidos; ausente quando não há nenhuma) e uma CONTA por loja visível. Ads
 * nunca lidos = tudo NULO; loja lida sem anúncio = 0. `get_shopee_ads_daily`
 * devolve um dia por linha, só lojas live. **Nada é somado aqui**: TOTAL,
 * ROAS, ACOS e TACoS vêm do SQL, sobre as somas.
 *
 * É o **Ads CPC da loja, não o total de Ads**: os anúncios GMV Max de loja
 * podem ficar de fora (a documentação não diz). Por isso a tela não desconta
 * nada disso do resultado da venda, e não soma com o Mercado Ads (D-449).
 */

import type { Database } from "@sb/db";

export type LinhaAdsShopee = Database["public"]["Functions"]["get_shopee_ads_overview"]["Returns"][number];
export type DiaAdsShopee = Database["public"]["Functions"]["get_shopee_ads_daily"]["Returns"][number];

export interface AdsShopee {
  /** `null` = nenhuma loja live com Ads já lidos: não há total a mostrar. */
  readonly total: LinhaAdsShopee | null;
  readonly lojas: readonly LinhaAdsShopee[];
}

export function separarAdsShopee(linhas: readonly LinhaAdsShopee[] | null): AdsShopee {
  const todas = linhas ?? [];

  return {
    total: todas.find((linha) => linha.nivel === "TOTAL") ?? null,
    lojas: todas.filter((linha) => linha.nivel === "CONTA"),
  };
}

/** A loja de teste nunca entra no total (D-449), mas aparece na lista, marcada. */
export function lojaAdsDeTeste(linha: LinhaAdsShopee): boolean {
  return linha.environment !== null && linha.environment !== "live";
}

export type EstadoAdsLoja = "nao_lido" | "sem_anuncio" | "com_anuncio";

/**
 * O que a linha da loja diz. Ads nunca lidos vêm com o investimento NULO —
 * "não sabemos", e não "não anunciou"; lida e com 0 é "sem anúncio no
 * período" (dentro da leitura, dia sem linha é dia sem anúncio).
 */
export function estadoAdsLoja(linha: LinhaAdsShopee): EstadoAdsLoja {
  if (linha.investimento === null) return "nao_lido";

  return linha.investimento > 0 || (linha.receita_ads ?? 0) > 0 || (linha.cliques ?? 0) > 0
    ? "com_anuncio"
    : "sem_anuncio";
}

/** Um dia das barras: os dois valores conhecidos. */
export interface DiaDasBarrasAds {
  readonly dia: string;
  readonly investimento: number;
  readonly receita_ads: number;
}

/**
 * Os dias que viram barra. Um dia com o investimento ou as vendas NULOS (a
 * Shopee não mandou o campo) não vira barra de zero: fica de fora e é
 * contado, para a tela dizer.
 *
 * Desde D-455 o ROAS e o ACOS do SQL só usam os dias com os dois campos, e a
 * conta dos dias fora da razão vem do banco (`diasForaDaRazao`). Esta contagem
 * fica só para as barras.
 */
/**
 * OS DIAS FORA DA RAZÃO (D-455, D-466). O ROAS e o ACOS só usam os dias com o
 * gasto E as vendas informados pela Shopee; o investimento e as vendas com Ads
 * continuam somando todos os dias lidos. Então o ROAS pode não ser a razão dos
 * dois cartões ao lado, e a tela diz por quê, com a conta do SQL.
 *
 * `null` = nada a dizer: todos os dias com os dois campos, loja nunca lida
 * (nulo), ou a função de antes da migration (chave ausente). Zero nunca vira
 * texto.
 */
export function diasForaDaRazao(linha: Pick<LinhaAdsShopee, "dias_sem_gasto" | "dias_sem_venda">): string | null {
  const semGasto = linha.dias_sem_gasto ?? null;
  const semVenda = linha.dias_sem_venda ?? null;
  const dias = (n: number): string => `${String(n)} ${n === 1 ? "dia" : "dias"}`;
  const partes: string[] = [];

  if (semGasto !== null && semGasto > 0) partes.push(`${dias(semGasto)} sem o gasto`);
  if (semVenda !== null && semVenda > 0) partes.push(`${dias(semVenda)} sem as vendas`);

  return partes.length === 0 ? null : `fora da razão: ${partes.join(" e ")}`;
}

export function diasDasBarras(dias: readonly DiaAdsShopee[] | null): {
  readonly barras: readonly DiaDasBarrasAds[];
  readonly semGasto: number;
  readonly semVenda: number;
} {
  const barras: DiaDasBarrasAds[] = [];
  let semGasto = 0;
  let semVenda = 0;

  for (const dia of dias ?? []) {
    if (dia.investimento === null) semGasto += 1;
    if (dia.receita_ads === null) semVenda += 1;
    if (dia.investimento !== null && dia.receita_ads !== null) {
      barras.push({ dia: dia.dia, investimento: dia.investimento, receita_ads: dia.receita_ads });
    }
  }

  return { barras, semGasto, semVenda };
}
