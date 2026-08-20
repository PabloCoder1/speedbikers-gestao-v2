import { cell } from "./normalize.js";

/**
 * Classificação da referência de anúncio exportada pelo UpSeller.
 *
 * É a regra mais delicada da importação. A exportação mistura DOIS tipos de
 * identificador na mesma coluna, e a documentação oficial do Mercado Livre
 * (ver `docs/MERCADO_LIVRE.md` secao 2.1) deixa claro que não são a mesma coisa:
 *
 *   item_id         `MLB` + dígitos    o anúncio no marketplace
 *   variation_id    só dígitos         variação dentro do anúncio
 *   user_product_id `MLBU` + dígitos   produto do catálogo DO VENDEDOR,
 *                                      que pode estar em vários itens
 *
 * Medido nos 20.650 vínculos de Mercado Livre:
 *
 *   MLB  + variação numérica     13.299   anúncio com variação
 *   MLB  + variante = anúncio     3.579   anúncio SEM variação
 *   MLBU + variante = anúncio     3.772   não é anúncio
 *
 * Tratar as três formas como iguais produziria vínculo errado em 36% das
 * linhas.
 */

export type ListingRef =
  | { kind: "ITEM"; itemId: string; variationId: string | null }
  | { kind: "USER_PRODUCT"; userProductId: string }
  | { kind: "INVALID"; reason: string };

const ITEM_ID = /^MLB\d+$/;
const USER_PRODUCT_ID = /^MLBU\d+$/;
const VARIATION_ID = /^\d+$/;

export function classifyListingRef(rawListing: unknown, rawVariation: unknown): ListingRef {
  const listing = cell(rawListing);

  if (listing === null) {
    return { kind: "INVALID", reason: "sem identificador de anúncio" };
  }

  // A ordem importa: `MLBU` também casa com o prefixo `MLB`, então o teste do
  // user product vem primeiro.
  if (USER_PRODUCT_ID.test(listing)) {
    return { kind: "USER_PRODUCT", userProductId: listing };
  }

  if (!ITEM_ID.test(listing)) {
    return { kind: "INVALID", reason: `identificador não reconhecido: ${listing}` };
  }

  const variation = cell(rawVariation);

  // O ERP repete o id do anúncio quando não há variação. "Anúncio inteiro" é
  // semanticamente diferente de "variação X", então isso vira NULL.
  if (variation === null || variation === listing) {
    return { kind: "ITEM", itemId: listing, variationId: null };
  }

  if (!VARIATION_ID.test(variation)) {
    return { kind: "INVALID", reason: `variação não numérica: ${variation}` };
  }

  return { kind: "ITEM", itemId: listing, variationId: variation };
}

/**
 * Canal, extraído do nome da loja.
 *
 * Medido: 9 lojas em 5 marketplaces. `mercado-ML- Speedbikers (loja 1)`,
 * `shopee-Sbmotos`, `kwai-SpeedBikers`, `temu-Speed Bikers`, `tiktok-...`.
 *
 * A D-037 restringe a V3 ao Mercado Livre; esta função é o filtro que aplica
 * a decisão na importação, em vez de deixá-la implícita numa condição solta.
 */
export function isMercadoLivreStore(rawStore: unknown): boolean {
  return cell(rawStore)?.toLowerCase().startsWith("mercado-ml") ?? false;
}

/**
 * Rótulo da loja, sem o prefixo do marketplace.
 *
 * `mercado-ML- Speedbikers (loja 1)` -> `Speedbikers (loja 1)`
 */
export function storeLabel(rawStore: unknown): string | null {
  const store = cell(rawStore);

  if (store === null) {
    return null;
  }

  const separator = store.indexOf("-");
  const label = separator >= 0 ? store.slice(separator + 1) : store;

  return label.replace(/^[\s-]+/, "").trim() || null;
}

/**
 * Slug técnico da loja, usado como nome de conta e da fila
 * `ml-sync-<slug>` no Cloud Tasks (D-036).
 *
 * O charset precisa casar com a constraint de `ml_accounts.slug`, que por sua
 * vez casa com o que o Cloud Tasks aceita em nome de fila.
 */
export function storeSlug(rawStore: unknown): string | null {
  const label = storeLabel(rawStore);

  if (label === null) {
    return null;
  }

  const slug = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  return slug.length > 0 ? slug : null;
}
