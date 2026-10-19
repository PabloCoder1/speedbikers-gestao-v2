/**
 * A FAIXA DE `/contas` COM AS CONTAS DO MERCADO LIVRE E AS LOJAS SHOPEE (D-600).
 *
 * A tela se chama "Contas e lojas" desde a T1 (D-431), mas a faixa contava só as
 * contas do Mercado Livre: com duas lojas live desde o Go Live de 16/10, "Contas
 * cadastradas: 4" escondia metade dos canais. Aqui as quatro células contam os
 * dois, com a divisão dita ao lado do número.
 *
 * Os estados não são os mesmos nos dois canais (C-52): o ML tem PENDING,
 * CONNECTED, REVOKED e ERROR; a loja Shopee só existe depois de autorizada, e é
 * CONNECTED ou ERROR -- mas tem um vencimento (`auth_expires_at`, até 365 dias),
 * e a leitura para quando ele passa. Por isso a loja conectada com a autorização
 * vencendo também "requer atenção": ela está conectada E precisa de alguém.
 *
 * Contar linhas que a tela já lista não é agregar métrica: são os mesmos cartões
 * e a mesma tabela, contados. Lista que não carregou não vira zero (D-067).
 */

import type { KpiCellData } from "../components/kpi-strip";
import { formatCount } from "./format";

export interface ContaMlDaFaixa {
  readonly status: string;
}

export interface LojaShopeeDaFaixa {
  readonly status: string;
  readonly environment: string;
  readonly auth_expires_at: string | null;
}

/** A autorização da Shopee que vence nestes dias já pede a reautorização. */
export const DIAS_DE_AVISO_DA_AUTORIZACAO = 7;

const DIA_MS = 86_400_000;

/** Vence em até `DIAS_DE_AVISO_DA_AUTORIZACAO` dias, ou já venceu. Sem data, não se sabe: não avisa. */
export function autorizacaoVencendo(loja: LojaShopeeDaFaixa, agora: Date): boolean {
  if (loja.auth_expires_at === null) return false;

  const vence = Date.parse(loja.auth_expires_at);

  return Number.isFinite(vence) && vence - agora.getTime() <= DIAS_DE_AVISO_DA_AUTORIZACAO * DIA_MS;
}

/** A loja que precisa de alguém: com erro, ou conectada com a autorização vencendo. */
export function lojaRequerAtencao(loja: LojaShopeeDaFaixa, agora: Date): boolean {
  return loja.status !== "CONNECTED" || autorizacaoVencendo(loja, agora);
}

/** "3 do Mercado Livre · 2 da Shopee (1 de teste)", ou o aviso de que as lojas não carregaram. */
function divisao(ml: number, shopee: number | null, testes: number): string {
  if (shopee === null) return `${formatCount(ml)} do Mercado Livre · as lojas Shopee não carregaram`;

  const teste = testes === 0 ? "" : ` (${formatCount(testes)} de teste)`;

  return `${formatCount(ml)} do Mercado Livre · ${formatCount(shopee)} da Shopee${teste}`;
}

/**
 * As quatro células. `lojas` nulo = a leitura das lojas falhou: o número é só o
 * do ML, e a ressalva diz isso -- nunca "0 da Shopee".
 */
export function celulasDeContasELojas(
  contas: readonly ContaMlDaFaixa[],
  lojas: readonly LojaShopeeDaFaixa[] | null,
  agora: Date,
): KpiCellData[] {
  const doMl = (estados: readonly string[]): number => contas.filter((c) => estados.includes(c.status)).length;
  const daShopee = (teste: (l: LojaShopeeDaFaixa) => boolean): number | null => (lojas === null ? null : lojas.filter(teste).length);
  const testes = daShopee((l) => l.environment !== "live") ?? 0;
  const soma = (ml: number, shopee: number | null): string => formatCount(ml + (shopee ?? 0));

  const conectadasMl = doMl(["CONNECTED"]);
  const conectadasShopee = daShopee((l) => l.status === "CONNECTED");
  const atencaoMl = doMl(["ERROR", "REVOKED"]);
  const atencaoShopee = daShopee((l) => lojaRequerAtencao(l, agora));

  return [
    {
      label: "Contas e lojas cadastradas",
      formula: "Contas do Mercado Livre e lojas Shopee visíveis para esta organização, as de teste inclusive.",
      value: soma(contas.length, lojas?.length ?? null),
      previous: null,
      ressalva: divisao(contas.length, lojas?.length ?? null, testes),
      tom: "neutro",
    },
    {
      label: "Conectadas",
      formula: "Contas com autorização CONNECTED registrada e lojas Shopee conectadas.",
      value: soma(conectadasMl, conectadasShopee),
      previous: null,
      ressalva: divisao(conectadasMl, conectadasShopee, 0),
      tom: "neutro",
    },
    {
      label: "Aguardando conexão",
      formula: "Contas do Mercado Livre que ainda precisam concluir o OAuth. A loja Shopee só aparece aqui depois de autorizada.",
      value: formatCount(doMl(["PENDING"])),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Requerem atenção",
      formula: `Contas em ERROR ou REVOKED, lojas Shopee com erro e lojas com a autorização vencendo em até ${String(DIAS_DE_AVISO_DA_AUTORIZACAO)} dias (estas também contam como conectadas).`,
      value: soma(atencaoMl, atencaoShopee),
      previous: null,
      ressalva: divisao(atencaoMl, atencaoShopee, 0),
      tom: "neutro",
    },
  ];
}
