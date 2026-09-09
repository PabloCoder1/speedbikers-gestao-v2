import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ObjectHeader, type ObjectBadge } from "../../../components/object-header";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { ProcessSteps } from "../../../components/process-steps";
import { Shell } from "../../../components/shell";
import { TOM, tomDeStatus } from "../../../components/tone";
import { formatCurrency, formatDateTime } from "../../../lib/format";
import { purchaseOrderCostNote, summarizePurchaseOrderCost } from "../../../lib/purchase-order-cost";
import { purchaseOrderEtapas } from "../../../lib/purchase-order-steps";
import { purchaseOrderEventLabel, purchaseOrderStatusLabel, statusTone } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/server";
import { ActionsPanel } from "./actions-panel";

export const dynamic = "force-dynamic";

/**
 * Detalhe do pedido de compra: dados, itens (com nacional/importado puxado
 * do SKU) e histórico por evento (`purchase_order_events`, append-only) —
 * o item "histórico por evento" do checklist da Fase 4 é literalmente esta
 * seção.
 *
 * Migrada em D-277 (fatia D37), e o frame não desenha esta tela: o
 * `OrderDetailDrawer` do protótipo é de PEDIDO DE VENDA do Mercado Livre
 * (comprador, conta, logística, mediação), não de compra. O que ele
 * contribuiu foi a **linha do tempo** — e ela já tem forma no design system,
 * `.sb-feed-row`, a mesma da atividade recente da Home.
 */

export default async function PedidoDeCompraPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  const supabase = await createClient();

  // As TRÊS leituras partem do mesmo `id` da URL (D-197). Havia um
  // `Promise.all` aqui, e ele escondia o problema: o par itens/eventos já ia
  // junto, mas o par inteiro esperava o cabeçalho do pedido — que nenhum dos
  // dois usa. Duas latências em fila onde uma resolve.
  //
  // O guarda `check:waterfalls` (D-195) não via isto: ele checava dependência
  // das leituras SOLTAS e tratava o `Promise.all` só como marco, sem nunca
  // perguntar se o próprio bloco dependia da leitura anterior. Foi esta tela
  // que mostrou o furo, e o guarda foi corrigido na mesma fatia.
  //
  // O guarda de 404 continua abaixo, e continua correto: a RLS restringe as
  // três leituras de forma independente, então disparar itens e eventos antes
  // de saber se o pedido existe não mostra nada a quem não podia ver. O preço
  // são duas consultas desperdiçadas no caminho 404, que é o caminho raro.
  const [order, items, events] = await Promise.all([
    supabase
      .from("purchase_orders")
      .select(
        "id, order_number, status, destination_warehouse_name, currency, notes, expected_at, approved_at, ordered_at, received_at, cancelled_at, cancel_reason, created_at, suppliers(name)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("purchase_order_items")
      .select("id, position, sku_snapshot, title_snapshot, quantity_ordered, unit_cost, skus(is_imported)")
      .eq("purchase_order_id", id)
      .order("position"),
    supabase
      .from("purchase_order_events")
      .select("id, event_type, metadata, occurred_at")
      .eq("purchase_order_id", id)
      .order("occurred_at", { ascending: false }),
  ]);

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — a tela
  // responde igual nos dois casos, mesmo raciocínio já usado em
  // apps/web/app/importacoes/[id]/page.tsx.
  if (order.error !== null || order.data === null) {
    notFound();
  }

  const info = order.data;

  // Duas ausências distintas, e nenhuma delas é zero: falha de LEITURA e custo
  // não preenchido. O porquê e os casos estão em `lib/purchase-order-cost.ts`,
  // com teste. Somar em JavaScript aqui não é a agregação que `AGENTS.md`
  // proíbe: os itens já foram lidos para a tabela abaixo, então não há leitura
  // acrescentada — é a mesma linha, contada uma vez.
  const cost = summarizePurchaseOrderCost(items.error !== null ? null : items.data);
  const costNote = purchaseOrderCostNote(cost);

  const etapas = purchaseOrderEtapas({
    status: info.status,
    approvedAt: info.approved_at,
    orderedAt: info.ordered_at,
    receivedAt: info.received_at,
    cancelledAt: info.cancelled_at,
  });

  const badges: readonly ObjectBadge[] = [
    { label: purchaseOrderStatusLabel(info.status), tom: tomDeStatus(statusTone(info.status)) },
  ];

  // Os fatos do pedido. "Valor estimado" carrega a ressalva AO LADO do número,
  // nunca só no `title` (`docs/METRICS.md` 5C.2): um total que soma parte dos
  // itens precisa dizer que é parcial na mesma linha em que se apresenta.
  const fatos: readonly (readonly [string, ReactNode])[] = [
    ["Destino", info.destination_warehouse_name ?? "—"],
    ["Previsão", info.expected_at === null ? "—" : formatDateTime(info.expected_at)],
    ["Itens", items.error !== null ? "—" : String(items.data.length)],
    [
      "Valor estimado",
      <>
        {formatCurrency(cost.total)}
        {costNote !== null && (
          <span style={{ display: "block", fontSize: "0.6875rem", color: "var(--sb-accent-ink)" }}>
            {costNote}
          </span>
        )}
      </>,
    ],
  ];

  const acaoStyle: React.CSSProperties = { textDecoration: "none" };

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Pedidos de Compra"
        subtitle={<Link href="/compras">← Voltar aos pedidos de compra</Link>}
        compacto
      />

      <ObjectHeader
        identificador={`PEDIDO #${String(info.order_number)}`}
        titulo={info.suppliers?.name ?? "Fornecedor não informado"}
        badges={badges}
        meta={`Criado em ${formatDateTime(info.created_at)}`}
        acoes={
          <>
            {info.status === "DRAFT" && (
              <Link className="sb-button" href={`/compras/${info.id}/editar`} style={acaoStyle}>
                Editar
              </Link>
            )}

            <a className="sb-button" href={`/compras/${info.id}/export/xlsx`} style={acaoStyle}>
              Exportar Excel
            </a>
            <a className="sb-button" href={`/compras/${info.id}/export/pdf`} style={acaoStyle}>
              Exportar PDF
            </a>
          </>
        }
      >
        <dl className="sb-fact-grid">
          {fatos.map(([rotulo, valor]) => (
            <div key={rotulo}>
              <dt>{rotulo}</dt>
              <dd>{valor}</dd>
            </div>
          ))}
        </dl>
      </ObjectHeader>

      {/*
        A observação escrita por quem criou o pedido. Ela chegou a ocupar o
        subtítulo do painel de itens nesta migração, e a tela renderizada mostrou
        o erro: texto livre do usuário no lugar onde o painel explica o que a
        tabela é. São coisas diferentes, e a nota é sobre o PEDIDO.
      */}
      {info.notes !== null && (
        <p
          style={{
            margin: "var(--sb-space-3) 0 0",
            fontSize: "0.8125rem",
            color: "var(--sb-text-soft)",
          }}
        >
          {info.notes}
        </p>
      )}

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        {/*
          O ciclo é explícito no banco, e cada etapa concluída mostra QUANDO:
          as quatro `CHECK` de coerência de `purchase_orders` impedem estado sem
          data, então a nota não é adivinhação (D-277).
        */}
        <ProcessSteps etapas={etapas} rotulo="Etapas deste pedido de compra" />
      </div>

      {info.status === "CANCELLED" && info.cancel_reason !== null && (
        <p
          role="alert"
          style={{
            ...TOM.perigo,
            margin: "0 0 var(--sb-space-3)",
            padding: "var(--sb-space-3)",
            borderRadius: "var(--sb-radius)",
            fontSize: "0.8125rem",
            lineHeight: 1.5,
          }}
        >
          Cancelado: {info.cancel_reason}
        </p>
      )}

      <ActionsPanel purchaseOrderId={info.id} status={info.status} expectedAt={info.expected_at} />

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel
          title="Itens do pedido"
          subtitle="SKU, origem e custo travados no momento do pedido — o preço de hoje não reescreve o de ontem."
          aside={
            <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
              A exportação usa um layout provisório — será ajustado quando o modelo de referência oficial chegar.
            </span>
          }
        >
          {items.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar os itens: {items.error.message}
            </p>
          )}

          {items.error === null && items.data.length === 0 && (
            <p className="sb-empty">Nenhum item neste pedido ainda.</p>
          )}

          {items.error === null && items.data.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Origem</th>
                    <th className="sb-num">Quantidade</th>
                    <th className="sb-num">Custo unitário</th>
                    <th className="sb-num">Subtotal</th>
                  </tr>
                </thead>

                <tbody>
                  {items.data.map((item) => (
                    <tr key={item.id}>
                      <td className="sb-mono">
                        {item.sku_snapshot}
                        {item.title_snapshot !== null && (
                          <div
                            style={{
                              fontFamily: "inherit",
                              color: "var(--sb-text-soft)",
                              fontSize: "0.75rem",
                            }}
                          >
                            {item.title_snapshot}
                          </div>
                        )}
                      </td>
                      <td>
                        {item.skus?.is_imported === true
                          ? "Importado"
                          : item.skus?.is_imported === false
                            ? "Nacional"
                            : "—"}
                      </td>
                      <td className="sb-num">{item.quantity_ordered}</td>
                      <td className="sb-num">
                        {item.unit_cost === null ? "—" : formatCurrency(item.unit_cost)}
                      </td>
                      <td className="sb-num">
                        {item.unit_cost === null ? "—" : formatCurrency(item.quantity_ordered * item.unit_cost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel title="Histórico" subtitle="Append-only: uma linha por transição, nunca reescrita.">
          {events.error !== null && (
            <p role="alert" style={{ color: "var(--sb-danger)" }}>
              Não foi possível carregar o histórico: {events.error.message}
            </p>
          )}

          {events.error === null && events.data.length === 0 && (
            <p className="sb-empty">Sem eventos ainda.</p>
          )}

          {/*
            A linha do tempo do frame, na forma que o design system já tem
            (`.sb-feed-row`, a mesma da atividade recente da Home). O ponto
            recebe o tom do evento — cancelamento não se lê igual a aprovação.
          */}
          {events.error === null &&
            events.data.map((event) => (
              <div key={event.id} className="sb-feed-row">
                <span
                  className="sb-feed-dot"
                  style={{ ["--sb-tone" as string]: TOM[tomDeStatus(statusTone(event.event_type))].color }}
                />

                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{purchaseOrderEventLabel(event.event_type)}</b>
                  <small>{formatDateTime(event.occurred_at)}</small>
                </span>
              </div>
            ))}
        </Panel>
      </div>
    </Shell>
  );
}
