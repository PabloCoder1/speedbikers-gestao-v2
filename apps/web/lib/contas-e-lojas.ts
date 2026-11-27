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

export interface LojaTikTokDaFaixa {
  readonly status: string;
  readonly auth_expires_at: string | null;
}

/** A autorização da Shopee que vence nestes dias já pede a reautorização. */
const DIAS_DE_AVISO_DA_AUTORIZACAO = 7;

/** No TikTok Shop, o aviso oficial de vencimento começa 30 dias antes (`docs/TIKTOK_SHOP.md` §4). */
const DIAS_DE_AVISO_TIKTOK = 30;

const DIA_MS = 86_400_000;

/** Vence em até `DIAS_DE_AVISO_DA_AUTORIZACAO` dias, ou já venceu. Sem data, não se sabe: não avisa. */
export function autorizacaoVencendo(loja: LojaShopeeDaFaixa, agora: Date): boolean {
  if (loja.auth_expires_at === null) return false;

  const vence = Date.parse(loja.auth_expires_at);

  return Number.isFinite(vence) && vence - agora.getTime() <= DIAS_DE_AVISO_DA_AUTORIZACAO * DIA_MS;
}

/** Vence em até `DIAS_DE_AVISO_TIKTOK` dias, ou já venceu. Sem data ou inválida, não avisa. */
export function autorizacaoTikTokVencendo(loja: LojaTikTokDaFaixa, agora: Date): boolean {
  if (loja.auth_expires_at === null) return false;

  const vence = Date.parse(loja.auth_expires_at);

  return Number.isFinite(vence) && vence - agora.getTime() <= DIAS_DE_AVISO_TIKTOK * DIA_MS;
}

/** A loja que precisa de alguém: com erro, ou conectada com a autorização vencendo. */
export function lojaRequerAtencao(loja: LojaShopeeDaFaixa, agora: Date): boolean {
  return loja.status !== "CONNECTED" || autorizacaoVencendo(loja, agora);
}

/** Loja TikTok Shop com erro ou com autorização vencendo em até 30 dias. */
export function lojaTikTokRequerAtencao(loja: LojaTikTokDaFaixa, agora: Date): boolean {
  return loja.status !== "CONNECTED" || autorizacaoTikTokVencendo(loja, agora);
}

/** Tabela `tiktok_shops` ainda ausente num ambiente que recebeu a web antes da migration. */
export function isTikTokSchemaMissing(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

export function rotuloTipoVendedorTikTok(sellerType: string | null): string {
  if (sellerType === "LOCAL") return "Nacional";
  if (sellerType === "CROSS_BORDER") return "Internacional";

  return "—";
}

/** "3 do Mercado Livre · 2 da Shopee (1 de teste) · 1 do TikTok Shop", ou aviso de falha de leitura. */
function divisao(
  ml: number,
  shopee: number | null,
  testes: number,
  tiktok: number | null | undefined,
  exibirTikTok: boolean,
): string {
  const parteShopee =
    shopee === null
      ? "as lojas Shopee não carregaram"
      : `${formatCount(shopee)} da Shopee${testes === 0 ? "" : ` (${formatCount(testes)} de teste)`}`;

  if (!exibirTikTok) {
    return `${formatCount(ml)} do Mercado Livre · ${parteShopee}`;
  }

  const parteTikTok =
    tiktok === null ? "as lojas TikTok não carregaram" : `${formatCount(tiktok ?? 0)} do TikTok Shop`;

  return `${formatCount(ml)} do Mercado Livre · ${parteShopee} · ${parteTikTok}`;
}

/**
 * As quatro células. `lojas` ou `lojasTikTok` nulo = a leitura falhou: o
 * número não inventa zero, e a ressalva diz qual canal não carregou.
 */
export function celulasDeContasELojas(
  contas: readonly ContaMlDaFaixa[],
  lojas: readonly LojaShopeeDaFaixa[] | null,
  agora: Date,
  lojasTikTok?: readonly LojaTikTokDaFaixa[] | null,
): KpiCellData[] {
  const doMl = (estados: readonly string[]): number => contas.filter((c) => estados.includes(c.status)).length;
  const daShopee = (teste: (l: LojaShopeeDaFaixa) => boolean): number | null => (lojas === null ? null : lojas.filter(teste).length);
  const doTikTok = (teste: (l: LojaTikTokDaFaixa) => boolean): number | null =>
    lojasTikTok === undefined ? 0 : lojasTikTok === null ? null : lojasTikTok.filter(teste).length;
  const exibirTikTok = lojasTikTok === null || (lojasTikTok !== undefined && lojasTikTok.length > 0);
  const testes = daShopee((l) => l.environment !== "live") ?? 0;
  const soma = (ml: number, shopee: number | null, tiktok: number | null): string =>
    formatCount(ml + (shopee ?? 0) + (tiktok ?? 0));

  const conectadasMl = doMl(["CONNECTED"]);
  const conectadasShopee = daShopee((l) => l.status === "CONNECTED");
  const conectadasTikTok = doTikTok((l) => l.status === "CONNECTED");
  const atencaoMl = doMl(["ERROR", "REVOKED"]);
  const atencaoShopee = daShopee((l) => lojaRequerAtencao(l, agora));
  const atencaoTikTok = doTikTok((l) => lojaTikTokRequerAtencao(l, agora));

  return [
    {
      label: "Contas e lojas cadastradas",
      formula: "Contas do Mercado Livre e lojas Shopee/TikTok Shop visíveis para esta organização, as de teste inclusive.",
      value: soma(contas.length, lojas?.length ?? null, lojasTikTok === undefined ? 0 : (lojasTikTok?.length ?? null)),
      previous: null,
      ressalva: divisao(
        contas.length,
        lojas?.length ?? null,
        testes,
        lojasTikTok === undefined ? undefined : (lojasTikTok?.length ?? null),
        exibirTikTok,
      ),
      tom: "neutro",
    },
    {
      label: "Conectadas",
      formula: "Contas com autorização CONNECTED registrada e lojas Shopee/TikTok Shop conectadas.",
      value: soma(conectadasMl, conectadasShopee, conectadasTikTok),
      previous: null,
      ressalva: divisao(conectadasMl, conectadasShopee, 0, conectadasTikTok, exibirTikTok),
      tom: "neutro",
    },
    {
      label: "Aguardando conexão",
      formula: "Contas do Mercado Livre que ainda precisam concluir o OAuth. Lojas Shopee e TikTok Shop só aparecem depois de autorizadas.",
      value: formatCount(doMl(["PENDING"])),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Requerem atenção",
      formula: `Contas em ERROR ou REVOKED, lojas com erro e lojas com a autorização vencendo (7 dias na Shopee, 30 dias no TikTok Shop).`,
      value: soma(atencaoMl, atencaoShopee, atencaoTikTok),
      previous: null,
      ressalva: divisao(atencaoMl, atencaoShopee, 0, atencaoTikTok, exibirTikTok),
      tom: "neutro",
    },
  ];
}
