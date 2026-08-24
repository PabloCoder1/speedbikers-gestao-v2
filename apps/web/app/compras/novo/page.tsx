import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { createClient } from "../../../lib/supabase/server";
import { PurchaseOrderForm } from "./purchase-order-form";

export const metadata = { title: "Novo pedido de compra — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default async function NovoPedidoDeCompraPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const suppliers = await supabase
    .from("suppliers")
    .select("id, name")
    .eq("is_active", true)
    .order("name")
    .limit(500);

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

      <PurchaseOrderForm suppliers={suppliers.data ?? []} />
    </Shell>
  );
}
