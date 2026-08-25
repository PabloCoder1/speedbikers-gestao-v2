/**
 * Qual referência de produto mostrar na linha da Caixa de Entrada (D-090).
 *
 * Um atendimento pode ter VÁRIOS vínculos — D-084 decidiu `support_case_links`
 * muitos-para-muitos justamente para não escolher um "SKU principal"
 * arbitrário no banco. Mas uma LINHA de tabela precisa de um texto só, e essa
 * escolha é de apresentação, não de modelo: fica aqui, pura e testável, em vez
 * de espalhada dentro do JSX.
 *
 * A ordem de preferência segue quanto a referência ajuda quem está atendendo:
 *
 * 1. **SKU** — é a entidade central do sistema (D-004) e o que a pessoa
 *    reconhece;
 * 2. **anúncio já resolvido localmente** (`listings`) — traz o título real do
 *    produto junto;
 * 3. **`item_id` externo** — o fallback que D-086 sempre preserva quando o
 *    anúncio ainda não existe em `listings`. É menos legível que o título,
 *    mas é infinitamente melhor que linha em branco;
 * 4. **pedido**, quando for o único vínculo (conversa pós-venda sem anúncio
 *    resolvido).
 *
 * `null` significa "nenhum vínculo utilizável" — a tela mostra um traço, e
 * isso é informação verdadeira, não erro.
 */

export interface SupportCaseLinkRow {
  order_id: number | null;
  sku_id: string | null;
  listing_id: string | null;
  external_entity_kind: string | null;
  external_entity_id: string | null;
  skus: { sku: string } | null;
  listings: { item_id: string; title: string | null } | null;
}

export interface SupportCaseReference {
  /** Texto curto e identificável: o SKU, o MLB ou o número do pedido. */
  code: string;
  /** Título do produto quando conhecido. Nunca inventado a partir do código. */
  title: string | null;
  kind: "SKU" | "LISTING" | "ORDER";
  /** Rota de destino, só quando ela existe de verdade hoje. */
  href: string | null;
}

export function resolveSupportCaseReference(
  links: SupportCaseLinkRow[] | null | undefined,
): SupportCaseReference | null {
  if (links === null || links === undefined || links.length === 0) {
    return null;
  }

  const withSku = links.find((link) => link.sku_id !== null && link.skus !== null);

  if (withSku?.skus != null && withSku.sku_id !== null) {
    return {
      code: withSku.skus.sku,
      title: withSku.listings?.title ?? null,
      kind: "SKU",
      // `/skus/[skuId]` existe desde a Fase 5B — é o único destino real aqui.
      href: `/skus/${withSku.sku_id}`,
    };
  }

  const withListing = links.find((link) => link.listing_id !== null && link.listings !== null);

  if (withListing?.listings != null) {
    return {
      code: withListing.listings.item_id,
      title: withListing.listings.title,
      kind: "LISTING",
      // Anúncio não tem página de detalhe própria (só a lista `/anuncios`) —
      // não inventar rota que não existe, mesmo critério de D-074.
      href: null,
    };
  }

  const externalListing = links.find(
    (link) => link.external_entity_kind === "LISTING" && link.external_entity_id !== null,
  );

  if (externalListing?.external_entity_id != null) {
    return {
      code: externalListing.external_entity_id,
      title: null,
      kind: "LISTING",
      href: null,
    };
  }

  const withOrder = links.find((link) => link.order_id !== null);

  if (withOrder?.order_id != null) {
    return { code: String(withOrder.order_id), title: null, kind: "ORDER", href: null };
  }

  return null;
}
