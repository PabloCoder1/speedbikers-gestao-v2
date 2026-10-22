/**
 * Uma linha de `get_price_changes` com a Shopee (C-81 do A1, D-640): o que a
 * `/precos`, a planilha dela e a aba Preços do SKU mostram de cada mudança.
 *
 * A linha da Shopee usa as MESMAS colunas da do ML, com outro vocabulário:
 * `item_id` é o item da Shopee (não um MLB), `status` é o `item_status` da
 * Shopee (NORMAL, UNLIST…), `ml_account_id` é nulo e `account_label` é o nome
 * da loja. Quem decide pela coluna `marketplace` é este módulo, uma vez só —
 * três consumidores que lessem a linha cada um do seu jeito mandariam o item da
 * Shopee para `/anuncios/<id>`, a tela do ML, que daria 404.
 */

import { listingStatusLabel } from "./labels";
import { MARKETPLACE_ROTULO } from "./marketplace";
import { shopeeItemStatus } from "./shopee-listings";

export interface LinhaDeMudancaDePreco {
  readonly marketplace: string;
  readonly item_id: string;
  readonly status: string | null;
  readonly shopee_shop_id: string | null;
  readonly model_name: string | null;
  readonly account_label: string;
}

export interface AnuncioDaMudanca {
  /** Para onde o identificador leva; `null` quando não há destino seguro. */
  readonly href: string | null;
  /** O status no vocabulário da tela; `null` sem status lido. */
  readonly status: string | null;
  /** A variação da Shopee (`model_name`); `null` no item sem variação e no ML. */
  readonly variacao: string | null;
  /** De onde é a mudança: a conta do ML, ou "Shopee · <loja>". */
  readonly origem: string;
}

export function ehDaShopee(linha: Pick<LinhaDeMudancaDePreco, "marketplace">): boolean {
  return linha.marketplace === "shopee";
}

export function anuncioDaMudanca(linha: LinhaDeMudancaDePreco): AnuncioDaMudanca {
  if (ehDaShopee(linha)) {
    return {
      // O atalho das ações da Shopee (D-626): a lista da loja, buscada pelo item.
      href:
        linha.shopee_shop_id === null
          ? null
          : `/anuncios/shopee?${new URLSearchParams({ loja: linha.shopee_shop_id, q: linha.item_id }).toString()}`,
      status: linha.status === null ? null : shopeeItemStatus(linha.status).rotulo,
      variacao: linha.model_name !== null && linha.model_name.trim() !== "" ? linha.model_name.trim() : null,
      origem: `${MARKETPLACE_ROTULO.shopee} · ${linha.account_label}`,
    };
  }

  return {
    href: `/anuncios/${linha.item_id}`,
    status: linha.status === null ? null : listingStatusLabel(linha.status),
    variacao: null,
    origem: linha.account_label,
  };
}
