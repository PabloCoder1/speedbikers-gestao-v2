import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { purchaseOrderStatusLabel } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/server";
import { currentMembership } from "../../../lib/membership";

export const metadata = { title: "Fornecedor — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Dashboard individual do Fornecedor (D-174, trilha 5E) — construído até o
 * limite do relacionamento REAL, que é bem menor do que o item do ROADMAP
 * sugere.
 *
 * O item pede uma aba `Produtos` e avisa, no mesmo fôlego, para não fingir
 * relação fornecedor→SKU inexistente. Medido antes de escrever: essa relação
 * **não existe** — `supplier_product_links` nunca foi criada, e
 * `skus.supplier_brand` é MARCA (19 valores para 3.550 SKUs), sem FK nenhuma
 * para `suppliers`. Marca não é entidade de compra, e tratá-la como tal seria
 * exatamente o risco que o item nomeia.
 *
 * O que existe é o que foi COMPRADO: os itens dos pedidos. Isso é observação,
 * não ficção — então "Produtos" aqui é "SKUs já comprados deste fornecedor",
 * e a tela diz que não há catálogo.
 *
 * Cancelado aparece SEPARADO, nunca somado nem escondido: hoje o único pedido
 * da base está cancelado, e um total único mostraria "R$ 0,00" sem explicar
 * que houve R$ 4.644,00 pedidos e desfeitos.
 */


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
  verticalAlign: "top",
};

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

const statBox: React.CSSProperties = {
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  padding: "var(--sb-space-3)",
  minWidth: "9rem",
};

const statLabel: React.CSSProperties = {
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
};

const statValue: React.CSSProperties = { fontSize: "1.375rem", fontVariantNumeric: "tabular-nums" };

function Contato({ label, value }: { label: string; value: string | null }): ReactNode {
  if (value === null || value.trim() === "") return null;

  return (
    <span>
      <span style={{ color: "var(--sb-text-soft)" }}>{label}:</span> {value}
    </span>
  );
}

export default async function FornecedorPage({
  params,
}: {
  params: Promise<{ supplierId: string }>;
}): Promise<ReactNode> {
  const { supplierId } = await params;
  const supabase = await createClient();

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Fornecedor</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const [overviewResult, skusResult, ordersResult] = await Promise.all([
    supabase
      .rpc("get_supplier_overview", { p_organization_id: organizationId, p_supplier_id: supplierId })
      .maybeSingle(),
    supabase.rpc("get_supplier_purchased_skus", {
      p_organization_id: organizationId,
      p_supplier_id: supplierId,
      p_limit: 50,
      p_offset: 0,
    }),
    supabase
      .from("purchase_orders")
      .select("id, order_number, status, currency, expected_at, created_at")
      .eq("supplier_id", supplierId)
      .order("created_at", { ascending: false })
      .limit(50),
  ]);

  // Sem cast: os tipos gerados de `get_supplier_overview` ja descrevem esta
  // linha exatamente (o lint reprovou a assercao por ser redundante), entao
  // a tela passa a ser checada contra o contrato do banco de verdade.
  const overview = overviewResult.data;

  // `null` aqui é "não existe" ou "a policy escondeu" — os dois viram 404,
  // mesmo raciocínio do Dashboard de SKU e do de Anúncio.
  if (overviewResult.error !== null || overview === null) {
    notFound();
  }

  const skus = skusResult.data ?? [];
  const orders = ordersResult.data ?? [];
  const secondaryError = skusResult.error ?? ordersResult.error;

  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/fornecedores">← Fornecedores</Link>
      </p>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          gap: "var(--sb-space-2)",
          margin: "var(--sb-space-2) 0 0",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>{overview.name}</h1>
        {!overview.is_active && <span style={{ fontSize: "0.8125rem", color: "var(--sb-accent-ink)" }}>inativo</span>}
      </div>

      <p
        style={{
          margin: "var(--sb-space-1) 0 var(--sb-space-3)",
          color: "var(--sb-text-soft)",
          fontSize: "0.875rem",
          display: "flex",
          flexWrap: "wrap",
          gap: "0.75rem",
        }}
      >
        <Contato label="Razão social" value={overview.legal_name} />
        <Contato label="Documento" value={overview.document} />
        <Contato label="Contato" value={overview.contact_name} />
        <Contato label="Telefone" value={overview.phone} />
        <Contato label="WhatsApp" value={overview.whatsapp} />
        <Contato label="E-mail" value={overview.email} />
        <Contato label="Site" value={overview.website} />
      </p>

      {secondaryError !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar parte do dashboard: {secondaryError.message}
        </p>
      )}

      <div style={{ display: "flex", gap: "var(--sb-space-3)", flexWrap: "wrap", marginBottom: "var(--sb-space-2)" }}>
        <div style={statBox}>
          <div style={statLabel}>Pedidos</div>
          <div style={statValue}>{formatCount(overview.orders_total)}</div>
        </div>
        <div style={statBox}>
          <div style={statLabel}>Comprado</div>
          <div style={statValue}>{formatCurrency(overview.valor_pedido)}</div>
          <div style={{ fontSize: "0.6875rem", color: "var(--sb-muted-ink)" }}>
            {formatCount(overview.unidades_pedidas)} unidade(s), sem os cancelados
          </div>
        </div>
        <div style={statBox}>
          <div style={statLabel}>Cancelado</div>
          <div style={{ ...statValue, color: overview.orders_cancelled > 0 ? "var(--sb-danger)" : undefined }}>
            {formatCurrency(overview.valor_cancelado)}
          </div>
          <div style={{ fontSize: "0.6875rem", color: "var(--sb-muted-ink)" }}>
            {formatCount(overview.orders_cancelled)} pedido(s), {formatCount(overview.unidades_canceladas)} unidade(s)
          </div>
        </div>
        <div style={statBox}>
          <div style={statLabel}>SKUs comprados</div>
          <div style={statValue}>{formatCount(overview.skus_distintos)}</div>
        </div>
      </div>

      <p style={{ margin: "0 0 var(--sb-space-4)", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
        Tudo nesta tela vem dos <strong>pedidos de compra</strong>. Não existe catálogo de produtos por fornecedor
        no sistema — a marca do SKU (
        <span style={{ fontFamily: "ui-monospace, monospace" }}>supplier_brand</span>) é um eixo separado e{" "}
        <strong>não</strong> é o mesmo que fornecedor.
        {overview.primeiro_pedido_em !== null && <> Primeiro pedido em {formatDateTime(overview.primeiro_pedido_em)}.</>}
      </p>

      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>Pedidos de compra</h2>

      {orders.length === 0 && ordersResult.error === null && (
        <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem", marginBottom: "var(--sb-space-4)" }}>
          Nenhum pedido de compra para este fornecedor.
        </p>
      )}

      {orders.length > 0 && (
        <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "34rem" }}>
            <thead>
              <tr>
                <th style={th}>Pedido</th>
                <th style={th}>Estado</th>
                <th style={th}>Previsto</th>
                <th style={th}>Criado</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td style={td}>
                    <Link href={`/compras/${order.id}`}>#{order.order_number}</Link>
                  </td>
                  <td style={td}>
                    <StatusPill code={order.status} label={purchaseOrderStatusLabel(order.status)} />
                  </td>
                  <td style={td}>{order.expected_at === null ? "—" : formatDateTime(order.expected_at)}</td>
                  <td style={td}>{formatDateTime(order.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.0625rem" }}>SKUs já comprados</h2>

      <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
        Derivado dos itens dos pedidos — é o único vínculo real entre fornecedor e produto. O custo é o do{" "}
        <strong>último pedido</strong> em que o item apareceu, nunca a média entre épocas, e não altera o custo
        cadastrado do SKU.
      </p>

      {skus.length === 0 && skusResult.error === null && (
        <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
          Nenhum item comprado deste fornecedor ainda.
        </p>
      )}

      {skus.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "44rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={{ ...th, textAlign: "right" }}>Pedidos</th>
                <th style={{ ...th, textAlign: "right" }}>Unidades</th>
                <th style={{ ...th, textAlign: "right" }}>Canceladas</th>
                <th style={{ ...th, textAlign: "right" }}>Último custo</th>
                <th style={th}>Último pedido</th>
              </tr>
            </thead>
            <tbody>
              {skus.map((row) => (
                <tr key={`${row.sku_id ?? "livre"}:${row.sku}`}>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    {/* Item digitado livre não tem vínculo — vira texto, não link morto. */}
                    {row.sku_id === null ? row.sku : <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>}
                    {row.title !== null && (
                      <div style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem", fontFamily: "inherit" }}>
                        {row.title}
                      </div>
                    )}
                  </td>
                  <td style={tdNumber}>{formatCount(row.pedidos)}</td>
                  <td style={tdNumber}>{formatCount(row.unidades_pedidas)}</td>
                  <td style={{ ...tdNumber, color: row.unidades_canceladas > 0 ? "var(--sb-danger)" : undefined }}>
                    {formatCount(row.unidades_canceladas)}
                  </td>
                  <td style={tdNumber}>{formatCurrency(row.ultimo_custo)}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    #{row.ultimo_pedido_numero} · {formatDateTime(row.ultimo_pedido_em)}
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
