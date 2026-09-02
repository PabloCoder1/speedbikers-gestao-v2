import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { createClient } from "../../../lib/supabase/server";
import { parseReplenishmentPrefill } from "./prefill";
import { PurchaseOrderForm } from "./purchase-order-form";
import type { DraftItem } from "./item-row";

export const metadata = { title: "Novo pedido de compra — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default async function NovoPedidoDeCompraPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  // A ponte cobertura→pedido (D-151): `/reposicao` manda `sku=<uuid>:<qtd>`
  // com a quantidade SUGERIDA; aqui o pedido nasce pré-carregado — SKU,
  // quantidade e custo CADASTRADO como sugestão editável (D-149). A RLS
  // limita o `.in()` à organização do usuário: id alheio simplesmente não
  // volta, e o item não aparece.
  //
  // O prefill sai da URL, não da lista de fornecedores: as duas leituras são
  // independentes e vão juntas desde D-195. Quando não há prefill — o caso
  // comum, pedido criado do zero — a segunda nem existe.
  const prefill = parseReplenishmentPrefill(query.sku);

  const [suppliers, skusResult] = await Promise.all([
    supabase.from("suppliers").select("id, name").eq("is_active", true).order("name").limit(500),
    prefill.length > 0
      ? supabase
          .from("skus")
          .select("id, sku, title, is_imported, purchase_cost")
          .in(
            "id",
            prefill.map((p) => p.skuId),
          )
      : Promise.resolve({ data: [] }),
  ]);

  const byId = new Map((skusResult.data ?? []).map((s) => [s.id, s]));

  const prefillItems: DraftItem[] = prefill.flatMap((p) => {
    const sku = byId.get(p.skuId);

    if (sku === undefined) return [];

    return [
      {
        key: `sugestao-${p.skuId}`,
        skuId: sku.id,
        skuSnapshot: sku.sku,
        titleSnapshot: sku.title,
        isImported: sku.is_imported,
        quantityOrdered: String(p.quantity),
        unitCost: sku.purchase_cost === null ? "" : String(sku.purchase_cost),
        unitCostSuggested: sku.purchase_cost !== null,
      },
    ];
  });

  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/compras">← Pedidos de Compra</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0 var(--sb-space-4)", fontSize: "1.375rem" }}>
        Novo pedido de compra
      </h1>

      {suppliers.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.875rem" }}>
          Não foi possível carregar os fornecedores: {suppliers.error.message}. A lista abaixo pode estar vazia.
        </p>
      )}

      {prefillItems.length > 0 && (
        <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          <strong>{prefillItems.length}</strong> item(ns) vindos da <Link href="/reposicao">Reposição</Link>, com a
          quantidade sugerida e o custo cadastrado — revise à vontade. O pedido nasce como <strong>rascunho</strong>{" "}
          e só vira compra com a aprovação humana do ciclo de Compras.
        </p>
      )}

      <PurchaseOrderForm
        suppliers={suppliers.data ?? []}
        {...(prefillItems.length > 0
          ? {
              initial: {
                supplierId: null,
                destinationWarehouseName: null,
                notes: null,
                expectedAt: null,
                items: prefillItems,
              },
            }
          : {})}
      />
    </Shell>
  );
}
