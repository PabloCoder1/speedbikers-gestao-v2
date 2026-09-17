/**
 * Corpo do `POST /items/{id}/relist` (D-364) — montado a partir do pai AO
 * VIVO, já validado pelo worker.
 *
 * A doc oficial tem DOIS contratos (`docs/MERCADO_LIVRE.md` secao 2.16, lida
 * de novo em 2026-09-17):
 *
 * - **sem variações:** `{ price, quantity, listing_type_id }` — o corpo que
 *   republicou os dois primeiros anúncios reais;
 * - **com variações:** `{ listing_type_id, variations: [{ id, price, quantity }] }`
 *   — as variações que se quer manter, cada uma com o PRÓPRIO preço e a
 *   quantidade disponível, e nada de `price`/`quantity` na raiz. Os ids de
 *   variação são renovados no filho.
 *
 * O incidente que trouxe esta função: em 2026-09-16 o MLB1476804187 (10
 * variações) foi fechado e o POST saiu com o corpo SEM variação. O Mercado
 * Livre respondeu 400, e o anúncio ficou fora do ar sem filho.
 *
 * **Sem estoque não há corpo** (`null`): variação sem estoque fica fora; se
 * NENHUMA tem, ou se o anúncio sem variação está zerado, não há o que
 * republicar e o POST não sai. O preflight bloqueia o mesmo caso ANTES de
 * fechar o pai (`VARIACOES_SEM_ESTOQUE`/`SEM_ESTOQUE`, `relist-preflight.ts`),
 * pelo mesmo predicado.
 */

export interface RelistParentVariation {
  /** Número ou texto só de dígitos, dentro do inteiro seguro — o worker valida. */
  readonly id: number | string;
  readonly price: number;
  readonly available_quantity: number;
}

/** Os campos do pai que o corpo herda — lidos do item AO VIVO. */
export interface RelistParentForBody {
  readonly price: number;
  readonly available_quantity: number;
  readonly listing_type_id: string;
  readonly variations: readonly RelistParentVariation[];
}

export interface RelistBodyVariation {
  readonly id: number;
  readonly price: number;
  readonly quantity: number;
}

export interface RelistBodyWithoutVariations {
  readonly price: number;
  readonly quantity: number;
  readonly listing_type_id: string;
}

export interface RelistBodyWithVariations {
  readonly listing_type_id: string;
  readonly variations: readonly RelistBodyVariation[];
}

export type RelistBody = RelistBodyWithoutVariations | RelistBodyWithVariations;

/** Estoque que a republicação pode levar: inteiro maior que zero. */
export function hasRelistStock(quantity: number): boolean {
  return Number.isInteger(quantity) && quantity > 0;
}

/**
 * O corpo do relist para este pai, ou `null` quando não há estoque para
 * republicar — e aí o POST não pode sair.
 */
export function buildRelistBody(parent: RelistParentForBody): RelistBody | null {
  if (parent.variations.length === 0) {
    if (!hasRelistStock(parent.available_quantity)) {
      return null;
    }

    return {
      price: parent.price,
      quantity: parent.available_quantity,
      listing_type_id: parent.listing_type_id,
    };
  }

  const variations = parent.variations
    .filter((variation) => hasRelistStock(variation.available_quantity))
    .map((variation) => ({
      id: Number(variation.id),
      price: variation.price,
      quantity: variation.available_quantity,
    }));

  if (variations.length === 0) {
    return null;
  }

  return { listing_type_id: parent.listing_type_id, variations };
}
