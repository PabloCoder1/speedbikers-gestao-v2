/*
 * Parsing puro de `resource` por tópico de notificação do Mercado
 * Livre. Extraído de ingest-mercado-livre-notification.ts (que tem
 * `import "server-only"` e por isso não pode ser importado por
 * testes) para o mesmo motivo de sweepTargets ter seu próprio
 * arquivo: viabilizar teste unitário direto.
 */
export function resourceTarget(topic: string, resource: string) {
  if (topic === "fbm_stock_operations") {
    const match = resource.match(/^\/stock\/fulfillment\/operations\/([^/?#]+)$/);
    if (!match) return null;
    try {
      const operationId = decodeURIComponent(match[1]).trim();
      return operationId
        ? { itemId: null, offerId: null, operationId, orderId: null }
        : null;
    } catch {
      return null;
    }
  }

  if (topic === "items_prices") {
    const match = resource.match(/^\/items\/(MLB[0-9]+)$/);
    return match
      ? { itemId: match[1], offerId: null, operationId: null, orderId: null }
      : null;
  }

  if (topic === "orders_v2") {
    // Extracted as a string deliberately — external order IDs must
    // never round-trip through JS number, same reasoning as
    // application_id/seller_id being read as raw digits in
    // ingest-mercado-livre-notification.ts.
    const match = resource.match(/^\/orders\/([^/?#]+)$/);
    if (!match) return null;
    try {
      const orderId = decodeURIComponent(match[1]).trim();
      return orderId
        ? { itemId: null, offerId: null, operationId: null, orderId }
        : null;
    } catch {
      return null;
    }
  }

  const match = resource.match(
    /^\/seller-promotions\/offers\/([^/?#]+)$/,
  );
  if (!match) return null;
  let offerId: string;
  try {
    offerId = decodeURIComponent(match[1]).trim();
  } catch {
    return null;
  }
  if (!offerId) return null;
  const itemHint = offerId.match(/^OFFER-(MLB[0-9]+)-/i)?.[1]?.toUpperCase() ?? null;
  return { itemId: itemHint, offerId, operationId: null, orderId: null };
}
