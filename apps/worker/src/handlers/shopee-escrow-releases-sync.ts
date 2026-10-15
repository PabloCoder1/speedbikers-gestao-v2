import { ESCROW_LIST_WINDOW_S, getEscrowListPage, isEscrowListEmpty, shopeeEpochToIso, type ShopeeEscrowRelease } from "@sb/shopee";

import type { JobOutcome } from "../job-outcome.js";
import type { HandlerContext, JobHandler } from "../router.js";
import { asJson } from "./domain-events.js";
import { falhaDaShopee, lerLojaConectada, type ShopeeJobDeps } from "./shopee-comum.js";
import { ensureShopeeAccessToken } from "./shopee-token.js";

/**
 * `shopee.escrow-releases.sync` (D-451) — os repasses de UMA loja Shopee: os
 * pedidos cujo escrow foi liberado numa janela de até 15 dias de
 * `escrow_release_time` por execução (`get_escrow_list`), como
 * `shopee.returns.sync` (D-447):
 *
 * - a janela parte do marco da loja (`escrow_releases_synced_until`) com 10
 *   minutos de sobreposição; sem marco, a primeira leitura começa 90 dias
 *   atrás e anda em janelas de 15 dias, cada uma enfileirando a seguinte;
 * - a janela inteira grava numa transação com a cobertura
 *   (`shopee_upsert_escrow_releases`): o marco só avança junto com as
 *   liberações, e nunca recua;
 * - "nada liberado" (`isEscrowListEmpty`) é janela vazia.
 *
 * Enfileirada por `shopee.orders.sync` quando os pedidos alcançam agora.
 */

const SOBREPOSICAO_S = 10 * 60;
const PRIMEIRA_LEITURA_S = 90 * 24 * 3600;
/** Teto de páginas de 100 por janela: 10 mil pedidos liberados em 15 dias passaria de qualquer loja da casa. */
const MAX_PAGINAS = 100;

/** A janela passou do teto, ou a paginação repetiu: repetir não resolve (D-432). */
class ListagemDefinitiva extends Error {}

export type ShopeeEscrowReleasesSyncDeps = ShopeeJobDeps;

export function createShopeeEscrowReleasesSyncHandler(deps: ShopeeEscrowReleasesSyncDeps): JobHandler {
  return async (envelope, context: HandlerContext): Promise<JobOutcome> => {
    const aberta = await lerLojaConectada(deps, context, "shopee_escrow_releases_sync_skipped");

    if ("outcome" in aberta) return aberta.outcome;

    const { loja } = aberta;
    // O marco dos repasses, lido à parte: `lerLojaConectada` só lê colunas
    // de antes da D-428.
    const marcoLido = await deps.db.from("shopee_shops").select("escrow_releases_synced_until").eq("id", loja.id).maybeSingle();

    if (marcoLido.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao ler o marco dos repasses: ${marcoLido.error.message}` };
    }

    const now = deps.now?.() ?? new Date();
    const token = await ensureShopeeAccessToken(deps, { id: loja.id, shopId: loja.shop_id }, now);

    if (!token.ok) {
      return { status: "failed", retryable: token.retryable, reason: token.reason };
    }

    const shop = { accessToken: token.accessToken, shopId: loja.shop_id };
    const agoraS = Math.floor(now.getTime() / 1000);
    const marco = marcoLido.data?.escrow_releases_synced_until ?? null;
    const marcoS = marco === null ? null : Math.floor(new Date(marco).getTime() / 1000);
    const deS = marcoS === null ? agoraS - PRIMEIRA_LEITURA_S : Math.max(marcoS - SOBREPOSICAO_S, 0);
    const ateS = Math.min(deS + ESCROW_LIST_WINDOW_S, agoraS);

    let repasses: ShopeeEscrowRelease[];

    try {
      repasses = await listarJanela(deps, shop, deS, ateS);
    } catch (error) {
      if (error instanceof ListagemDefinitiva) {
        return { status: "failed", retryable: false, reason: error.message };
      }

      return falhaDaShopee(error, "erro desconhecido ao ler repasses da Shopee");
    }

    const gravado = await deps.db.rpc("shopee_upsert_escrow_releases", {
      p_shopee_shop_id: loja.id,
      p_repasses: asJson(
        repasses.map((r) => ({
          order_sn: r.order_sn,
          released_at: shopeeEpochToIso(r.escrow_release_time),
          payout_amount: r.payout_amount ?? null,
        })),
      ),
      p_from: new Date(deS * 1000).toISOString(),
      p_until: new Date(ateS * 1000).toISOString(),
      p_synced_at: now.toISOString(),
    });

    if (gravado.error !== null) {
      return { status: "failed", retryable: true, reason: `falha ao gravar repasses: ${gravado.error.message}` };
    }

    const temMais = ateS < agoraS;

    if (temMais) {
      await deps.enqueuer.enqueue({
        jobType: "shopee.escrow-releases.sync",
        organizationId: loja.organization_id,
        dedupeKey: `shopee-escrow-releases:${loja.id}:${String(ateS)}`,
        queue: "backfill",
        payload: { shopeeShopId: loja.id },
      });
    }

    context.logger.info("shopee_escrow_releases_sync_done", {
      shopee_shop_id: loja.id,
      shop_id: loja.shop_id,
      de: new Date(deS * 1000).toISOString(),
      ate: new Date(ateS * 1000).toISOString(),
      repasses_listados: repasses.length,
      repasses_gravados: gravado.data,
      tem_mais: temMais,
    });

    return { status: "done", processed: gravado.data };
  };
}

/**
 * Todas as liberações da janela, página a página a partir de 1 (a
 * referência). Uma página que só repete liberações já vistas enquanto a
 * Shopee diz que há mais é paginação fora do esperado — a tarefa para com o
 * motivo, em vez de girar em falso. "Nada liberado" encerra a lista.
 */
async function listarJanela(
  deps: ShopeeEscrowReleasesSyncDeps,
  shop: { accessToken: string; shopId: number },
  deS: number,
  ateS: number,
): Promise<ShopeeEscrowRelease[]> {
  const vistas = new Map<string, ShopeeEscrowRelease>();

  for (let pagina = 1; pagina <= MAX_PAGINAS; pagina += 1) {
    let resposta;

    try {
      resposta = await getEscrowListPage(deps.client, shop, { releaseTimeFrom: deS, releaseTimeTo: ateS, pageNo: pagina });
    } catch (error) {
      if (isEscrowListEmpty(error)) return [...vistas.values()];

      throw error;
    }

    let novas = 0;

    for (const repasse of resposta.releases) {
      const chave = `${repasse.order_sn}:${String(repasse.escrow_release_time)}`;

      if (!vistas.has(chave)) novas += 1;

      vistas.set(chave, repasse);
    }

    if (!resposta.more) return [...vistas.values()];

    if (novas === 0) {
      throw new ListagemDefinitiva(`a página ${String(pagina)} de repasses só repetiu as anteriores; paginação fora do esperado`);
    }
  }

  throw new ListagemDefinitiva(`a janela passou de ${String(MAX_PAGINAS)} páginas de repasses; reduza a janela`);
}
