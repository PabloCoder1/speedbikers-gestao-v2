import type { RelistSellerUserProducts } from "@sb/domain";
import { hasRelistVariations, hasUserProductVariations } from "@sb/domain";
import type { MercadoLivreClient } from "@sb/mercado-livre";
import { fetchIsUserProductSeller } from "@sb/mercado-livre";
import type { Logger } from "@sb/observability";

/**
 * O modelo da CONTA para a regra de D-369, lido AO VIVO na tag
 * `user_product_seller` de `GET /users/me`, com o token da conta do anúncio.
 *
 * A chamada só sai quando decide alguma coisa:
 *
 * - item SEM variações: a regra não se aplica — `undefined`, nenhuma chamada;
 * - variação com `user_product_id`: o bloqueio já está decidido pelo item —
 *   `undefined`, nenhuma chamada;
 * - senão, a tag decide: `true`/`false`. Qualquer falha na leitura (HTTP,
 *   forma, rede) vira `null`, e o preflight reprova com
 *   `USER_PRODUCT_NAO_VERIFICADO`: sem confirmar a conta, o anúncio não é
 *   fechado. Diferente do Full (D-360), falha passageira NÃO relança — a regra
 *   pedida é bloquear, e o bloqueio não fecha nada.
 */
export async function readRelistSellerUserProducts(params: {
  mercadoLivre: MercadoLivreClient;
  accessToken: string;
  rawItem: unknown;
  logger: Logger;
  logFields: Record<string, string>;
}): Promise<RelistSellerUserProducts | undefined> {
  if (!hasRelistVariations(params.rawItem) || hasUserProductVariations(params.rawItem)) {
    return undefined;
  }

  try {
    return await fetchIsUserProductSeller({ client: params.mercadoLivre, accessToken: params.accessToken });
  } catch (error) {
    params.logger.warn("relist_seller_model_unreadable", {
      ...params.logFields,
      reason: error instanceof Error ? error.message : "falha desconhecida ao ler /users/me",
    });

    return null;
  }
}

/** Como o log mostra a leitura: o valor lido, ou `nao_consultado` quando a chamada não saiu. */
export function describeSellerUserProducts(value: RelistSellerUserProducts | undefined): boolean | string | null {
  return value === undefined ? "nao_consultado" : value;
}
