import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount } from "../../lib/format";

import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Estoque — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/compras/page.tsx.
export const dynamic = "force-dynamic";

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

interface SkuBalance {
  skuId: string;
  sku: string;
  title: string | null;
  local: number;
  reservado: number;
  transito: number;
}

/**
 * Quantas linhas a tela mostra por vez. O conjunto real passa de 2.500 e o
 * teto do PostgREST é 1.000 — pedir "tudo" nunca trouxe tudo (D-131).
 */
const PAGE_SIZE = 200;

export default async function EstoquePage(): Promise<ReactNode> {
  const supabase = await createClient();

  const membership = await supabase.from("organization_members").select("organization_id").limit(1);
  const organizationId = membership.data?.[0]?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Estoque</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  // O pivô, a ordenação e a contagem vêm do Postgres (D-131). A versão
  // anterior lia `inventory_balances` direto com
  // `.order("quantity", { ascending: false })` e sem `.range()`: o `order by`
  // não servia para exibir nada — a tela reordenava por SKU em JavaScript
  // logo abaixo — e só decidia QUAIS 1.000 das 2.524 linhas sobreviviam ao
  // teto do PostgREST, pelo pior critério possível. Das 1.645 linhas com
  // saldo negativo, ~1.524 ficavam invisíveis enquanto os saldos inflados
  // ocupavam a tela.
  const { data, error } = await supabase
    .rpc("get_stock_balances", { p_organization_id: organizationId })
    .range(0, PAGE_SIZE - 1);

  const rows = data ?? [];

  const balances: SkuBalance[] = rows.map((row) => ({
    skuId: row.sku_id,
    sku: row.sku,
    title: row.title,
    local: row.local_quantity,
    reservado: row.reservado,
    transito: row.transito,
  }));

  const totalCount = rows[0]?.total_count ?? balances.length;

  return (
    <Shell>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sb-space-3)",
          marginBottom: "var(--sb-space-4)",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>Estoque</h1>
      </div>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Saldo por SKU, recomputado do ledger (<code>stock_movements</code>). Local é o estoque físico; reservado vem
        da reconciliação contra o UpSeller; em trânsito, do ciclo de pedidos de compra.
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && balances.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum SKU com movimento de estoque ainda.</p>
      )}

      {error === null && totalCount > balances.length && (
        <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          Mostrando <strong>{formatCount(balances.length)}</strong> de <strong>{formatCount(totalCount)}</strong>{" "}
          SKUs, em ordem de SKU.
        </p>
      )}

      {error === null && balances.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "40rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Local</th>
                <th style={th}>Reservado</th>
                <th style={th}>Em trânsito</th>
                <th style={th}></th>
                <th style={th}></th>
              </tr>
            </thead>

            <tbody>
              {balances.map((balance) => (
                <tr key={balance.skuId}>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    {balance.sku}
                    {balance.title !== null && (
                      <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                        {balance.title}
                      </div>
                    )}
                  </td>
                  <td style={tdNumber}>{formatCount(balance.local)}</td>
                  <td style={tdNumber}>{formatCount(balance.reservado)}</td>
                  <td style={tdNumber}>{formatCount(balance.transito)}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <Link href={`/skus/${balance.skuId}`}>Detalhes</Link>
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <Link href={`/estoque/${balance.skuId}/ajuste`}>Ajustar</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
