/**
 * O anúncio excluído no Mercado Livre nas telas que leem `listings` direto
 * (D-634, sobre a D-631 do A1).
 *
 * A D-631 guarda a linha do anúncio excluído (é história de venda e de
 * vínculo) com `listings.deleted_at`, e as quatro RPCs do catálogo a escondem.
 * Quem lê a tabela direto (o detalhe do anúncio, a contagem da Home e os dois
 * diálogos de vínculo) decide aqui, por uma regra só: **excluído é
 * `deleted_at` preenchido, nunca o status.** No 404 do Mercado Livre o worker
 * grava só `deleted_at`, e o `status` fica o último visto, que pode ser
 * `active` ou `paused` (A1, 21/10).
 *
 * `deleted_at` é QUANDO A V3 VIU a exclusão, não quando ela aconteceu: um
 * anúncio apagado antes da D-631 é marcado na primeira varredura depois dela.
 * Por isso o texto diz "a V3 viu a exclusão em", e nunca "excluído em".
 */

import { formatDay } from "./format";

export const EXCLUIDO_NO_MERCADO_LIVRE = "Excluído no Mercado Livre";

export function anuncioExcluido(deletedAt: string | null | undefined): deletedAt is string {
  return typeof deletedAt === "string" && deletedAt !== "";
}

/** "a V3 viu a exclusão em 21/10/2026" — a data é a da leitura, não a do ato. */
export function quandoAV3ViuAExclusao(deletedAt: string): string {
  return `a V3 viu a exclusão em ${formatDay(deletedAt)}`;
}

/**
 * Por que o diálogo de vínculo não vincula o anúncio excluído. É a regra que
 * os diálogos já seguiam ("sem confirmar que ele existe, não vinculamos"): o
 * anúncio não existe mais no Mercado Livre.
 */
export function avisoDeVinculoDoExcluido(itemId: string, deletedAt: string): string {
  return `${itemId} foi excluído no Mercado Livre (${quandoAV3ViuAExclusao(deletedAt)}). Não vinculamos anúncio que não existe mais; a história de venda dele continua na V3.`;
}
