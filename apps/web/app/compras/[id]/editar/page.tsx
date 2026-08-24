import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../../components/shell";
import { createClient } from "../../../../lib/supabase/server";
import type { DraftItem } from "../../novo/item-row";
import { PurchaseOrderForm } from "../../novo/purchase-order-form";
import type { PurchaseOrderFormInitial } from "../../novo/purchase-order-form";

export const metadata = { title: "Editar pedido de compra — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Edição do rascunho — a RPC (`update_purchase_order_draft`) já existia
 * desde a criação do ciclo (2026-08-22), só faltava esta tela
 * (`docs/ROADMAP.md` Fase 4). Reaproveita `PurchaseOrderForm`/`ItemRow` de
 * `../../novo/` — mesmo formulário, agora pré-preenchido e apontando para
 * `update_purchase_order_draft` em vez de `create_purchase_order`.
 */
export default async function EditarPedidoDeCompraPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  const supabase = await createClient();

  const [order, items, suppliers] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select("id, status, supplier_id, destination_warehouse_name, notes, expected_at")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("purchase_order_items")
      .select("id, sku_id, sku_snapshot, title_snapshot, quantity_ordered, unit_cost, skus(is_imported)")
      .eq("purchase_order_id", id)
      .order("position"),
    supabase.from("suppliers").select("id, name").eq("is_active", true).order("name").limit(500),
  ]);

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — mesmo
  // raciocínio já usado em apps/web/app/compras/[id]/page.tsx.
  if (order.error !== null || order.data === null) {
    notFound();
  }

  const info = order.data;

  // Distinto de "sem itens ainda": uma falha de leitura aqui não pode virar
  // silenciosamente "formulário com um item em branco" — salvar esse
  // formulário chama update_purchase_order_draft, que SUBSTITUI todos os
  // itens do pedido, apagando os itens reais que só não foram lidos.
  if (items.error !== null) {
    return (
      <Shell>
        <p style={{ margin: 0, fontSize: "0.875rem" }}>
          <Link href={`/compras/${id}`}>← Voltar ao pedido</Link>
        </p>

        <p role="alert" style={{ marginTop: "var(--sb-space-3)", color: "var(--sb-danger)" }}>
          Não foi possível carregar os itens deste pedido: {items.error.message}. Edite novamente mais tarde — editar
          agora apagaria os itens reais.
        </p>
      </Shell>
    );
  }

  if (info.status !== "DRAFT") {
    return (
      <Shell>
        <p style={{ margin: 0, fontSize: "0.875rem" }}>
          <Link href={`/compras/${id}`}>← Voltar ao pedido</Link>
        </p>

        <p role="alert" style={{ marginTop: "var(--sb-space-3)", color: "var(--sb-danger)" }}>
          Este pedido não está mais em rascunho — não é possível editar os itens depois de aprovado.
        </p>
      </Shell>
    );
  }

  const initial: PurchaseOrderFormInitial = {
    supplierId: info.supplier_id,
    destinationWarehouseName: info.destination_warehouse_name,
    notes: info.notes,
    expectedAt: info.expected_at === null ? null : info.expected_at.slice(0, 10),
    items:
      items.data.length === 0
        ? [
            {
              key: "item-1",
              skuId: null,
              skuSnapshot: "",
              titleSnapshot: null,
              isImported: null,
              quantityOrdered: "",
              unitCost: "",
            },
          ]
        : items.data.map((item): DraftItem => ({
            key: item.id,
            skuId: item.sku_id,
            skuSnapshot: item.sku_snapshot,
            titleSnapshot: item.title_snapshot,
            isImported: item.skus?.is_imported ?? null,
            quantityOrdered: String(item.quantity_ordered),
            unitCost: item.unit_cost === null ? "" : String(item.unit_cost),
          })),
  };

  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href={`/compras/${id}`}>← Voltar ao pedido</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0 var(--sb-space-4)", fontSize: "1.375rem" }}>
        Editar pedido de compra
      </h1>

      {suppliers.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.875rem" }}>
          Não foi possível carregar os fornecedores: {suppliers.error.message}. A lista abaixo pode estar vazia.
        </p>
      )}

      <PurchaseOrderForm suppliers={suppliers.data ?? []} orderId={id} initial={initial} />
    </Shell>
  );
}
