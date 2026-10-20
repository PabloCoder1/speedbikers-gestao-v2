import type { AdminClient } from "@sb/db";
import { computeShopeeStockMovements, type RecordedSale, type ShopeeSaleItem, type StockMovementDraft } from "@sb/domain";

import { CriticalWriteError } from "./assert-written.js";
import { readErpCutoffs } from "./persist-order.js";

/**
 * A venda da Shopee no estoque (D-495 b): depois de cada lote gravado pela
 * leitura de pedidos, os pedidos do lote são relidos do banco e as baixas,
 * estornos e cancelamentos saem pela regra de `computeShopeeStockMovements`.
 *
 * **Só a loja live.** A loja de teste (sandbox) nunca mexe no estoque real.
 *
 * **Idempotente pela chave.** Cada pedido é recalculado inteiro a cada leitura,
 * e o `UNIQUE` de `idempotency_key` absorve o que já foi gravado -- a mesma
 * forma da venda do ML (`page-writes.ts`). Repetir o lote não duplica nada.
 *
 * **Origem `SHOPEE_ORDER` com o `order_sn`** (combinado com o A2): a tela das
 * movimentações acha a loja e o dia do pedido por ele.
 */

export const SHOPEE_ORDER_SOURCE = "SHOPEE_ORDER";

export const MOVIMENTO_VENDA_SHOPEE = "VENDA_SHOPEE";
export const MOVIMENTO_CANCELAMENTO_SHOPEE = "CANCELAMENTO_SHOPEE";
export const MOVIMENTO_ESTORNO_ARMAZEM_SHOPEE = "ESTORNO_ARMAZEM_SHOPEE";
export const MOVIMENTO_ESTORNO_PRE_CAPTURA = "ESTORNO_PRE_CAPTURA";

export interface LojaDoEstoque {
  readonly id: string;
  readonly organization_id: string;
  readonly environment: string;
}

interface Linha {
  readonly draft: StockMovementDraft;
  readonly tipo: string;
  readonly orderSn: string;
}

function falhaDeLeitura(oQue: string, mensagem: string): Error {
  return new Error(`baixa da Shopee: falha ao ler ${oQue}: ${mensagem}`);
}

/**
 * Baixa, estorna e repõe o estoque dos pedidos `orderSns` da loja. Devolve
 * quantos movimentos foram enviados (o banco descarta os já gravados). LANÇA
 * em falha de leitura ou de gravação: a leitura do lote repete, e a chave
 * absorve o que já entrou.
 */
export async function baixarVendasDaShopee(
  db: AdminClient,
  loja: LojaDoEstoque,
  orderSns: readonly string[],
): Promise<number> {
  if (loja.environment !== "live" || orderSns.length === 0) return 0;

  const sns = [...new Set(orderSns)];

  const pedidos = await db
    .from("shopee_orders")
    .select("order_sn, order_status, paid_at, shopee_updated_at, fulfillment_flag")
    .eq("shopee_shop_id", loja.id)
    .in("order_sn", sns);

  if (pedidos.error !== null) throw falhaDeLeitura("os pedidos", pedidos.error.message);

  const itens = await db
    .from("shopee_order_items")
    .select("order_sn, position, quantity, sku_id")
    .eq("shopee_shop_id", loja.id)
    .in("order_sn", sns);

  if (itens.error !== null) throw falhaDeLeitura("os itens", itens.error.message);

  const skuIds = [...new Set(itens.data.map((i) => i.sku_id).filter((s): s is string => s !== null))];
  const skus = new Map<string, { kind: "PRODUTO" | "KIT"; components: { componentSkuId: string; quantity: number }[] }>();

  if (skuIds.length > 0) {
    const lidos = await db
      .from("skus")
      .select("id, kind, sku_components!sku_components_kit_sku_id_fkey(component_sku_id, quantity)")
      .in("id", skuIds);

    if (lidos.error !== null) throw falhaDeLeitura("os SKUs", lidos.error.message);

    for (const sku of lidos.data) {
      skus.set(sku.id, {
        kind: sku.kind === "KIT" ? "KIT" : "PRODUTO",
        components: sku.sku_components.map((c) => ({ componentSkuId: c.component_sku_id, quantity: c.quantity })),
      });
    }

    for (const id of skuIds) {
      // Cair em PRODUTO baixaria a linha do kit em vez dos componentes, e o
      // ledger não desfaz (a mesma guarda do ML, `linkResolvido`).
      if (!skus.has(id)) throw new Error(`baixa da Shopee: o SKU ${id} do item não foi lido`);
    }
  }

  const gravadas = await db
    .from("stock_movements")
    .select("idempotency_key, sku_id, qty_delta, occurred_at, created_at")
    .eq("organization_id", loja.organization_id)
    .eq("source_type", SHOPEE_ORDER_SOURCE)
    .eq("movement_type", MOVIMENTO_VENDA_SHOPEE)
    .in("source_id", sns);

  if (gravadas.error !== null) throw falhaDeLeitura("as vendas gravadas", gravadas.error.message);

  const vendasGravadas = new Map<string, RecordedSale>(
    gravadas.data.map((m) => [
      m.idempotency_key,
      { skuId: m.sku_id, qtyDelta: m.qty_delta, occurredAt: new Date(m.occurred_at), recordedAt: new Date(m.created_at) },
    ]),
  );

  // O corte de todo SKU que uma linha pode baixar: o do item, o dos componentes
  // e o das vendas já gravadas.
  const comCorte = new Set<string>(vendasGravadas.size > 0 ? [...vendasGravadas.values()].map((v) => v.skuId) : []);

  for (const id of skuIds) {
    const sku = skus.get(id);

    if (sku?.kind === "KIT") {
      for (const c of sku.components) comCorte.add(c.componentSkuId);
    } else {
      comCorte.add(id);
    }
  }

  const cortes = await readErpCutoffs(db, loja.organization_id, [...comCorte]);
  const cutoffFor = (skuId: string) => {
    if (!cortes.has(skuId)) throw new Error(`baixa da Shopee: o corte do SKU ${skuId} não foi lido`);

    return cortes.get(skuId) ?? null;
  };

  const itensPorPedido = new Map<string, ShopeeSaleItem[]>();

  for (const item of itens.data) {
    const sku = item.sku_id === null ? undefined : skus.get(item.sku_id);
    const lista = itensPorPedido.get(item.order_sn) ?? [];

    lista.push({
      position: item.position,
      quantity: item.quantity,
      skuId: item.sku_id,
      skuKind: sku?.kind ?? null,
      components: sku?.components ?? [],
    });
    itensPorPedido.set(item.order_sn, lista);
  }

  const linhas: Linha[] = [];

  for (const pedido of pedidos.data) {
    const m = computeShopeeStockMovements(
      {
        shopId: loja.id,
        orderSn: pedido.order_sn,
        status: pedido.order_status,
        paidAt: pedido.paid_at === null ? null : new Date(pedido.paid_at),
        updatedAt: new Date(pedido.shopee_updated_at),
        fulfillmentFlag: pedido.fulfillment_flag,
        items: itensPorPedido.get(pedido.order_sn) ?? [],
      },
      { cutoffFor, recordedSale: (key) => vendasGravadas.get(key) },
    );

    for (const draft of m.vendas) linhas.push({ draft, tipo: MOVIMENTO_VENDA_SHOPEE, orderSn: pedido.order_sn });
    for (const draft of m.estornosPreCaptura) linhas.push({ draft, tipo: MOVIMENTO_ESTORNO_PRE_CAPTURA, orderSn: pedido.order_sn });
    for (const draft of m.estornosArmazem) linhas.push({ draft, tipo: MOVIMENTO_ESTORNO_ARMAZEM_SHOPEE, orderSn: pedido.order_sn });
    for (const draft of m.cancelamentos) linhas.push({ draft, tipo: MOVIMENTO_CANCELAMENTO_SHOPEE, orderSn: pedido.order_sn });
  }

  if (linhas.length === 0) return 0;

  // Por SKU, como o lote do ML (`ordenaPorSku`): o gatilho do saldo trava a
  // linha de `inventory_balances` de cada SKU sempre na mesma ordem.
  const ordenadas = [...linhas].sort((a, b) =>
    a.draft.skuId === b.draft.skuId
      ? a.draft.idempotencyKey.localeCompare(b.draft.idempotencyKey)
      : a.draft.skuId.localeCompare(b.draft.skuId),
  );

  const resultado = await db.from("stock_movements").upsert(
    ordenadas.map(({ draft, tipo, orderSn }) => ({
      organization_id: loja.organization_id,
      sku_id: draft.skuId,
      location_kind: draft.locationKind ?? "LOCAL",
      qty_delta: draft.qtyDelta,
      movement_type: tipo,
      source_type: SHOPEE_ORDER_SOURCE,
      source_id: orderSn,
      idempotency_key: draft.idempotencyKey,
      occurred_at: draft.occurredAt.toISOString(),
    })),
    // DO NOTHING, nunca DO UPDATE: o ledger é append-only (D-019).
    { onConflict: "idempotency_key", ignoreDuplicates: true },
  );

  if (resultado.error !== null && resultado.error.code !== "23505") {
    throw new CriticalWriteError(
      `stock_movements.upsert da Shopee (${String(ordenadas.length)} movimentos)`,
      resultado.error.message,
      resultado.error.code,
    );
  }

  return ordenadas.length;
}
