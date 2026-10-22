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
 * D-652 (C-86): a loja do TikTok Shop entra como o terceiro canal, com a mesma
 * forma da Shopee -- só existe depois de autorizada, CONNECTED ou ERROR, e o
 * `auth_expires_at` é o fim do refresh token. O canal chega com uma migration
 * (`20261022170000`): antes dela a tabela não existe, e o TikTok fica fora da
 * divisão em vez de virar "0" (é um canal que este banco ainda não tem).
 *
 * Contar linhas que a tela já lista não é agregar métrica: são os mesmos cartões
 * e a mesma tabela, contados. Lista que não carregou não vira zero (D-067).
 */

import type { KpiCellData } from "../components/kpi-strip";
import { formatCount } from "./format";

export interface ContaMlDaFaixa {
  readonly status: string;
}

/** A loja só existe depois de autorizada: CONNECTED ou ERROR, com o vencimento da autorização. */
export interface LojaDaFaixa {
  readonly status: string;
  readonly auth_expires_at: string | null;
}

export interface LojaShopeeDaFaixa extends LojaDaFaixa {
  readonly environment: string;
}

export type LojaTiktokDaFaixa = LojaDaFaixa;

/**
 * As lojas do TikTok Shop (D-652): lidas (zero é fato), a leitura falhou (a
 * ressalva diz, nunca "0"), ou a tabela ainda não existe neste banco (o canal
 * fica fora da divisão).
 */
export type LojasTiktokDaFaixa =
  | { readonly estado: "lidas"; readonly lojas: readonly LojaTiktokDaFaixa[] }
  | { readonly estado: "falhou" }
  | { readonly estado: "ausente" };

/** A autorização que vence nestes dias já pede a reautorização. */
export const DIAS_DE_AVISO_DA_AUTORIZACAO = 7;

const DIA_MS = 86_400_000;

/** Vence em até `DIAS_DE_AVISO_DA_AUTORIZACAO` dias, ou já venceu. Sem data, não se sabe: não avisa. */
export function autorizacaoVencendo(loja: Pick<LojaDaFaixa, "auth_expires_at">, agora: Date): boolean {
  if (loja.auth_expires_at === null) return false;

  const vence = Date.parse(loja.auth_expires_at);

  return Number.isFinite(vence) && vence - agora.getTime() <= DIAS_DE_AVISO_DA_AUTORIZACAO * DIA_MS;
}

/** A loja que precisa de alguém: com erro, ou conectada com a autorização vencendo. */
export function lojaRequerAtencao(loja: LojaDaFaixa, agora: Date): boolean {
  return loja.status !== "CONNECTED" || autorizacaoVencendo(loja, agora);
}

/** O pedaço do TikTok Shop na divisão: nada sem a tabela, a ressalva se falhou, o número se leu. */
function parteDoTiktok(tiktok: number | null | undefined): string {
  if (tiktok === undefined) return "";
  if (tiktok === null) return " · as lojas do TikTok Shop não carregaram";

  return ` · ${formatCount(tiktok)} do TikTok Shop`;
}

/** "3 do Mercado Livre · 2 da Shopee (1 de teste) · 1 do TikTok Shop", ou o aviso de que as lojas não carregaram. */
function divisao(ml: number, shopee: number | null, testes: number, tiktok: number | null | undefined): string {
  if (shopee === null) return `${formatCount(ml)} do Mercado Livre · as lojas Shopee não carregaram${parteDoTiktok(tiktok)}`;

  const teste = testes === 0 ? "" : ` (${formatCount(testes)} de teste)`;

  return `${formatCount(ml)} do Mercado Livre · ${formatCount(shopee)} da Shopee${teste}${parteDoTiktok(tiktok)}`;
}

/**
 * As quatro células. `lojas` nulo = a leitura das lojas Shopee falhou: o número
 * é só do que carregou, e a ressalva diz isso -- nunca "0 da Shopee". O mesmo
 * vale para o TikTok Shop (`tiktok`), que sem a tabela fica fora da conta.
 */
export function celulasDeContasELojas(
  contas: readonly ContaMlDaFaixa[],
  lojas: readonly LojaShopeeDaFaixa[] | null,
  agora: Date,
  tiktok: LojasTiktokDaFaixa = { estado: "ausente" },
): KpiCellData[] {
  const doMl = (estados: readonly string[]): number => contas.filter((c) => estados.includes(c.status)).length;
  const daShopee = (teste: (l: LojaShopeeDaFaixa) => boolean): number | null => (lojas === null ? null : lojas.filter(teste).length);
  const doTiktok = (teste: (l: LojaTiktokDaFaixa) => boolean): number | null | undefined =>
    tiktok.estado === "lidas" ? tiktok.lojas.filter(teste).length : tiktok.estado === "falhou" ? null : undefined;
  const testes = daShopee((l) => l.environment !== "live") ?? 0;
  const soma = (ml: number, shopee: number | null, tk: number | null | undefined): string => formatCount(ml + (shopee ?? 0) + (tk ?? 0));

  const conectadasMl = doMl(["CONNECTED"]);
  const conectadasShopee = daShopee((l) => l.status === "CONNECTED");
  const conectadasTiktok = doTiktok((l) => l.status === "CONNECTED");
  const atencaoMl = doMl(["ERROR", "REVOKED"]);
  const atencaoShopee = daShopee((l) => lojaRequerAtencao(l, agora));
  const atencaoTiktok = doTiktok((l) => lojaRequerAtencao(l, agora));
  const cadastradasTiktok = doTiktok(() => true);

  return [
    {
      label: "Contas e lojas cadastradas",
      formula: "Contas do Mercado Livre, lojas Shopee e lojas do TikTok Shop visíveis para esta organização, as de teste inclusive.",
      value: soma(contas.length, lojas?.length ?? null, cadastradasTiktok),
      previous: null,
      ressalva: divisao(contas.length, lojas?.length ?? null, testes, cadastradasTiktok),
      tom: "neutro",
    },
    {
      label: "Conectadas",
      formula: "Contas com autorização CONNECTED registrada e lojas Shopee e do TikTok Shop conectadas.",
      value: soma(conectadasMl, conectadasShopee, conectadasTiktok),
      previous: null,
      ressalva: divisao(conectadasMl, conectadasShopee, 0, conectadasTiktok),
      tom: "neutro",
    },
    {
      label: "Aguardando conexão",
      formula: "Contas do Mercado Livre que ainda precisam concluir o OAuth. A loja Shopee e a do TikTok Shop só aparecem aqui depois de autorizadas.",
      value: formatCount(doMl(["PENDING"])),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Requerem atenção",
      formula: `Contas em ERROR ou REVOKED, lojas com erro e lojas com a autorização vencendo em até ${String(DIAS_DE_AVISO_DA_AUTORIZACAO)} dias (estas também contam como conectadas).`,
      value: soma(atencaoMl, atencaoShopee, atencaoTiktok),
      previous: null,
      ressalva: divisao(atencaoMl, atencaoShopee, 0, atencaoTiktok),
      tom: "neutro",
    },
  ];
}
