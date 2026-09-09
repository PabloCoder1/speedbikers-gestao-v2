import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ObjectHeader, type ObjectBadge } from "../../../components/object-header";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
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
 *
 * ---------------------------------------------------------------------------
 * Migrada em D-277 (fatia D37) contra o `SupplierDetailDrawer` do frame
 * ---------------------------------------------------------------------------
 *
 * O frame desenha esta tela como GAVETA de 600px com cinco abas, três delas
 * marcadas "em construção" no próprio protótipo. Gavetas seguem adiadas nesta
 * frente; o que transferiu foi a composição: cabeçalho de entidade, o "Resumo
 * de Pedidos" em cartões, e as duas tabelas.
 *
 * **O resumo do frame tem três estados; o sistema mede CINCO** — e as cinco
 * contagens já vinham de `get_supplier_overview` (`orders_draft`,
 * `orders_approved`, `orders_ordered`, `orders_received`, `orders_cancelled`)
 * sem que a tela mostrasse nenhuma delas. Colapsar rascunho, aprovado e
 * enviado num "Em Aberto" esconderia exatamente a diferença que decide o que
 * fazer com o pedido. Mesma classe de D-250 e D-265.
 */

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
        <PageTitle eyebrow="ESTOQUE / OPERAÇÃO" title="Fornecedor" compacto />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
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

  const badges: readonly ObjectBadge[] = [
    overview.is_active ? { label: "Ativo", tom: "ok" } : { label: "Inativo", tom: "atencao" },
  ];

  const contatos: readonly (readonly [string, string | null])[] = [
    ["Razão social", overview.legal_name],
    ["Documento", overview.document],
    ["Contato", overview.contact_name],
    ["Telefone", overview.phone],
    ["WhatsApp", overview.whatsapp],
    ["E-mail", overview.email],
    ["Site", overview.website],
  ];

  // As CINCO contagens de estado que a RPC já devolvia e a tela não mostrava.
  // Não são links: `/compras` filtra por estado, mas não por fornecedor, então
  // "#{n} aprovados" levaria à lista de TODOS os fornecedores — um cartão
  // prometendo um recorte e entregando outro (a armadilha de D-250). A lista
  // que eles resumem está três linhas abaixo, nesta mesma tela.
  const estados: readonly (readonly [string, number])[] = [
    ["Rascunho", overview.orders_draft],
    ["Aprovado", overview.orders_approved],
    ["Pedido enviado", overview.orders_ordered],
    ["Recebido", overview.orders_received],
    ["Cancelado", overview.orders_cancelled],
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Fornecedores"
        subtitle={<Link href="/fornecedores">← Voltar aos fornecedores</Link>}
        compacto
      />

      <ObjectHeader
        identificador="FORNECEDOR"
        titulo={overview.name}
        badges={badges}
        meta={
          overview.ultimo_pedido_em === null
            ? "Nenhum pedido registrado"
            : `Último pedido em ${formatDateTime(overview.ultimo_pedido_em)}`
        }
      >
        <p
          style={{
            margin: 0,
            color: "var(--sb-text-soft)",
            fontSize: "0.8125rem",
            display: "flex",
            flexWrap: "wrap",
            gap: "0.75rem",
          }}
        >
          {contatos.map(([label, value]) => (
            <Contato key={label} label={label} value={value} />
          ))}
        </p>
      </ObjectHeader>

      {secondaryError !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)", marginTop: "var(--sb-space-3)" }}>
          Não foi possível carregar parte do dashboard: {secondaryError.message}
        </p>
      )}

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel
          title="Resumo de pedidos"
          subtitle={`${formatCount(overview.orders_total)} pedido(s) no total — as cinco parcelas fecham com ele.`}
        >
          <div
            className="sb-state-cards"
            style={{
              // Cinco cartoes: 5 -> 3+2 -> 2+2+1. O degrau padrao (4) deixaria
              // 4+1, com um orfao -- visto na tela a 1150px.
              ["--sb-state-cols" as string]: "5",
              ["--sb-state-cols-md" as string]: "3",
              margin: "var(--sb-space-3)",
            }}
          >
            {estados.map(([label, quantidade]) => (
              <div key={label} className="sb-state-card">
                <span>{label}</span>
                <strong>{formatCount(quantidade)}</strong>
              </div>
            ))}
          </div>
        </Panel>
      </div>

      <div className="sb-stat-grid" style={{ ["--sb-stat-cols" as string]: "3", marginTop: "var(--sb-space-3)" }}>
        <div className="sb-stat">
          <span className="sb-stat-label">Comprado</span>
          {/*
            `formatCurrency(null)` é "—", e desde D-258 o NULO chega de
            verdade: `valor_pedido` deixou de usar `coalesce(sum, 0)`, que
            transformava custo DESCONHECIDO em R$ 0,00 — lido como "comprou
            nada" em vez de "não sei quanto".
          */}
          <b className="sb-stat-value">{formatCurrency(overview.valor_pedido)}</b>
          <span className="sb-stat-note">
            {formatCount(overview.unidades_pedidas)} unidade(s), sem os cancelados
            {overview.itens_sem_custo > 0 && (
              <span style={{ display: "block", color: "var(--sb-accent-ink)" }}>
                {formatCount(overview.itens_sem_custo)} item(ns) sem custo — o valor é parcial
              </span>
            )}
          </span>
        </div>

        <div
          className="sb-stat"
          {...(overview.orders_cancelled > 0
            ? {
                style: {
                  ["--sb-tone" as string]: "var(--sb-danger-soft)",
                  ["--sb-tone-ink" as string]: "var(--sb-danger-ink)",
                },
              }
            : {})}
        >
          <span className="sb-stat-label">Cancelado</span>
          <b className="sb-stat-value">{formatCurrency(overview.valor_cancelado)}</b>
          <span className="sb-stat-note">
            {formatCount(overview.orders_cancelled)} pedido(s), {formatCount(overview.unidades_canceladas)}{" "}
            unidade(s)
            {overview.itens_cancelados_sem_custo > 0 && (
              <span style={{ display: "block", color: "var(--sb-accent-ink)" }}>
                {formatCount(overview.itens_cancelados_sem_custo)} item(ns) sem custo
              </span>
            )}
          </span>
        </div>

        <div className="sb-stat">
          <span className="sb-stat-label">SKUs comprados</span>
          <b className="sb-stat-value">{formatCount(overview.skus_distintos)}</b>
          <span className="sb-stat-note">
            distintos nos itens dos pedidos
            {overview.primeiro_pedido_em !== null && (
              <span style={{ display: "block" }}>
                primeiro pedido em {formatDateTime(overview.primeiro_pedido_em)}
              </span>
            )}
          </span>
        </div>
      </div>

      <p style={{ margin: "var(--sb-space-3) 0", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
        Tudo nesta tela vem dos <strong>pedidos de compra</strong>. Não existe catálogo de produtos por fornecedor
        no sistema — a marca do SKU (<span className="sb-mono">supplier_brand</span>) é um eixo separado e{" "}
        <strong>não</strong> é o mesmo que fornecedor.
      </p>

      <Panel title="Pedidos de compra" subtitle="Os 50 mais recentes, do último para o primeiro.">
        {orders.length === 0 && ordersResult.error === null && (
          <p className="sb-empty">Nenhum pedido de compra para este fornecedor.</p>
        )}

        {orders.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="sb-table">
              <thead>
                <tr>
                  <th>Pedido</th>
                  <th>Estado</th>
                  <th>Previsto</th>
                  <th>Criado</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td className="sb-mono">
                      <Link href={`/compras/${order.id}`}>#{order.order_number}</Link>
                    </td>
                    <td>
                      <StatusPill code={order.status} label={purchaseOrderStatusLabel(order.status)} />
                    </td>
                    <td>{order.expected_at === null ? "—" : formatDateTime(order.expected_at)}</td>
                    <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(order.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel
          title="SKUs já comprados"
          subtitle="Derivado dos itens dos pedidos — é o único vínculo real entre fornecedor e produto. O custo é o do último pedido em que o item apareceu, nunca a média entre épocas, e não altera o custo cadastrado do SKU."
        >
          {skus.length === 0 && skusResult.error === null && (
            <p className="sb-empty">Nenhum item comprado deste fornecedor ainda.</p>
          )}

          {skus.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th className="sb-num">Pedidos</th>
                    <th className="sb-num">Unidades</th>
                    <th className="sb-num">Canceladas</th>
                    <th className="sb-num">Último custo</th>
                    <th>Último pedido</th>
                  </tr>
                </thead>
                <tbody>
                  {skus.map((row) => (
                    <tr key={`${row.sku_id ?? "livre"}:${row.sku}`}>
                      <td className="sb-mono">
                        {/* Item digitado livre não tem vínculo — vira texto, não link morto. */}
                        {row.sku_id === null ? row.sku : <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>}
                        {row.title !== null && (
                          <div
                            style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem", fontFamily: "inherit" }}
                          >
                            {row.title}
                          </div>
                        )}
                      </td>
                      <td className="sb-num">{formatCount(row.pedidos)}</td>
                      <td className="sb-num">{formatCount(row.unidades_pedidas)}</td>
                      <td
                        className="sb-num"
                        {...(row.unidades_canceladas > 0 ? { style: { color: "var(--sb-danger)" } } : {})}
                      >
                        {formatCount(row.unidades_canceladas)}
                      </td>
                      <td className="sb-num">{formatCurrency(row.ultimo_custo)}</td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        #{row.ultimo_pedido_numero} · {formatDateTime(row.ultimo_pedido_em)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
