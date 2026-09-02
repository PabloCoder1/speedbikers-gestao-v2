import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../../components/shell";
import { formatCount } from "../../../../lib/format";
import { locationKindLabel } from "../../../../lib/labels";
import { createClient } from "../../../../lib/supabase/server";
import { AdjustmentForm } from "./adjustment-form";

export const metadata = { title: "Ajustar estoque — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

export default async function AjusteEstoquePage({
  params,
}: {
  params: Promise<{ skuId: string }>;
}): Promise<ReactNode> {
  const { skuId } = await params;

  const supabase = await createClient();

  // As duas leituras partem do MESMO `skuId` da URL — a segunda nunca
  // precisou esperar a primeira. Em paralelo desde D-195.
  //
  // O guarda continua depois, e continua correto: a RLS restringe as duas
  // leituras de forma independente, então disparar `inventory_balances` antes
  // de saber se o SKU existe não mostra nada a quem não podia ver. O preço é
  // uma consulta desperdiçada no caminho 404, que é o caminho raro.
  const [sku, balances] = await Promise.all([
    supabase.from("skus").select("id, sku, title").eq("id", skuId).maybeSingle(),
    supabase.from("inventory_balances").select("location_kind, quantity").eq("sku_id", skuId),
  ]);

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — mesmo
  // raciocínio já usado em apps/web/app/compras/[id]/page.tsx.
  if (sku.error !== null || sku.data === null) {
    notFound();
  }

  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/estoque">← Estoque</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0", fontSize: "1.375rem" }}>Ajustar {sku.data.sku}</h1>

      {sku.data.title !== null && (
        <p style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-text-soft)" }}>{sku.data.title}</p>
      )}

      {balances.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.875rem", marginBottom: "var(--sb-space-3)" }}>
          Não foi possível carregar o saldo atual: {balances.error.message}. Confira o saldo em{" "}
          <Link href="/estoque">/estoque</Link> antes de ajustar.
        </p>
      )}

      {balances.error === null && balances.data.length > 0 && (
        <ul style={{ listStyle: "none", margin: "0 0 var(--sb-space-4)", padding: 0, display: "flex", gap: "var(--sb-space-4)" }}>
          {balances.data.map((balance) => (
            <li key={balance.location_kind} style={{ fontSize: "0.875rem" }}>
              <span style={{ color: "var(--sb-text-soft)" }}>{locationKindLabel(balance.location_kind)}: </span>
              <strong>{formatCount(balance.quantity)}</strong>
            </li>
          ))}
        </ul>
      )}

      <AdjustmentForm skuId={sku.data.id} />
    </Shell>
  );
}
