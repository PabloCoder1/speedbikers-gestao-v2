import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ObjectHeader, type ObjectBadge } from "../../../components/object-header";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { ProcessSteps } from "../../../components/process-steps";
import { Shell } from "../../../components/shell";
import { Voltar } from "../../../components/voltar";
import { TOM, tomDeStatus } from "../../../components/tone";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { purchaseOrderCostNote, summarizePurchaseOrderCost } from "../../../lib/purchase-order-cost";
import { purchaseOrderEtapas } from "../../../lib/purchase-order-steps";
import { purchaseOrderEventLabel, purchaseOrderStatusLabel, statusTone } from "../../../lib/labels";
import { podeOperarCompras } from "../../../lib/purchase-order-permission";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import { ActionsPanel } from "./actions-panel";
import { ExportActions } from "./export-actions";

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
  const [membership, order, items, events] = await Promise.all([
    currentMembership(),
    supabase
      .from("purchase_orders")
      .select(
        "id, order_number, status, destination_warehouse_name, currency, notes, expected_at, approved_at, ordered_at, received_at, cancelled_at, cancel_reason, created_at, supplier_id, suppliers(name)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("purchase_order_items")
      .select("id, position, sku_id, sku_snapshot, title_snapshot, quantity_ordered, unit_cost, skus(is_imported)")
      .eq("purchase_order_id", id)
      .order("position"),
    supabase
      .from("purchase_order_events")
      .select("id, event_type, metadata, occurred_at, autor:profiles(full_name)")
      .eq("purchase_order_id", id)
      .order("occurred_at", { ascending: false }),
  ]);

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — a tela
  // responde igual nos dois casos, mesmo raciocínio já usado em
  // apps/web/app/importacoes/[id]/page.tsx.
  // FALHA DE LEITURA não é "não existe" (D-067; /notas-fiscais/[id] corrigiu o
  // mesmo defeito depois de um incidente real): um erro transitório virava 404
  // e a pessoa concluía que o pedido tinha sumido (lote 4 do pente fino, 18/09).
  if (order.error !== null) {
    return (
      <Shell>
        <PageTitle
          eyebrow="ESTOQUE / OPERAÇÃO"
          title="Pedido de compra"
          aside={<Voltar href="/compras" rotulo="Pedidos de compra" />}
          compacto
        />
        <div role="alert" className="sb-pod-state">
          <strong>Não foi possível carregar este pedido agora.</strong>
          <span>O pedido não foi alterado. Tente de novo em instantes.</span>
          <Link className="sb-button" href={`/compras/${id}`}>
            Tentar de novo
          </Link>
        </div>
      </Shell>
    );
  }

  if (order.data === null) {
    notFound();
  }

  const info = order.data;
  const podeOperar = podeOperarCompras(membership.role);

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
    // A previsão é data de negócio gravada como meia-noite UTC: `formatDateTime`
    // a mostrava como a véspera às 21h (D-365).
    ["Previsão", info.expected_at === null ? "—" : formatBusinessDate(info.expected_at.slice(0, 10))],
    ["Itens", items.error !== null ? "—" : String(items.data.length)],
    [
      "Valor estimado",
      <>
        {formatCurrency(cost.total)}
        {costNote !== null && (
          <span className="sb-pod-cost-note">{costNote}</span>
        )}
      </>,
    ],
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / OPERAÇÃO"
        title="Pedido de compra"
        aside={<Voltar href="/compras" rotulo="Pedidos de compra" />}
        compacto
      />

      <ObjectHeader
        identificador={`PEDIDO #${String(info.order_number)}`}
        titulo={info.suppliers?.name ?? "Fornecedor não informado"}
        badges={badges}
        meta={`Criado em ${formatDateTime(info.created_at)}`}
        acoes={
          <>
            {info.supplier_id !== null && (
              <Link className="sb-button" href={`/fornecedores/${info.supplier_id}`}>
                Ver fornecedor
              </Link>
            )}
            {info.status === "DRAFT" && podeOperar && (
              <Link className="sb-button" href={`/compras/${info.id}/editar`}>
                Editar
              </Link>
            )}

            <ExportActions purchaseOrderId={info.id} />
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
        <p className="sb-pod-notes">
          <span>OBSERVAÇÃO</span>
          {info.notes}
        </p>
      )}

      <div className="sb-pod-section">
        {/*
          O ciclo é explícito no banco, e cada etapa concluída mostra QUANDO:
          as quatro `CHECK` de coerência de `purchase_orders` impedem estado sem
          data, então a nota não é adivinhação (D-277).
        */}
        <ProcessSteps etapas={etapas} rotulo="Etapas deste pedido de compra" />
      </div>

      {info.status === "CANCELLED" && info.cancel_reason !== null && (
        <p role="alert" className="sb-pod-cancelled">
          <strong>Cancelado:</strong> {info.cancel_reason}
        </p>
      )}

      {/* Aprovar, marcar enviado, receber e cancelar passam todos por
          `check_purchase_order_writer` (ADMIN/GESTOR). Os outros papéis veem o
          pedido e a trilha, sem botão que o banco vai recusar (lote 1, 18/09). */}
      {podeOperar ? (
        <ActionsPanel purchaseOrderId={info.id} status={info.status} expectedAt={info.expected_at} />
      ) : (
        <p className="sb-note">
          <span>SOMENTE LEITURA</span>
          Aprovar, receber ou cancelar pedidos de compra é feito por ADMIN ou GESTOR.
        </p>
      )}

      <div className="sb-pod-section">
        {/*
          O subtítulo dizia "SKU, origem e custo TRAVADOS no momento do pedido",
          e a origem não é: ela vem do cadastro atual (`skus.is_imported`) —
          `purchase_order_items` não guarda origem. A frase agora diz o que é
          gravado e o que é lido na hora (lote 4 do pente fino, 18/09). A nota
          interna sobre o "layout provisório" da exportação saiu da tela.
        */}
        <Panel
          title="Itens do pedido"
          subtitle="SKU, quantidade e custo ficam gravados no pedido — o preço de hoje não reescreve o de ontem. A origem é a do cadastro atual do SKU."
        >
          {items.error !== null && (
            <p role="alert" className="sb-pod-error">
              Não foi possível carregar os itens agora. Tente recarregar a página.
            </p>
          )}

          {items.error === null && items.data.length === 0 && (
            <p className="sb-empty">Nenhum item neste pedido ainda.</p>
          )}

          {items.error === null && items.data.length > 0 && (
            <div className="sb-pod-table-wrap">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Origem (cadastro)</th>
                    <th className="sb-num">Quantidade</th>
                    <th className="sb-num">Custo unitário</th>
                    <th className="sb-num">Subtotal</th>
                  </tr>
                </thead>

                <tbody>
                  {items.data.map((item) => (
                    <tr key={item.id}>
                      <td className="sb-mono">
                        {/* O SKU abre o dashboard dele (lote 3 do pente fino); item de
                            texto livre, sem SKU cadastrado, continua texto. */}
                        {item.sku_id === null ? item.sku_snapshot : <Link href={`/skus/${item.sku_id}`}>{item.sku_snapshot}</Link>}
                        {item.title_snapshot !== null && (
                          <span className="sb-pod-item-title">{item.title_snapshot}</span>
                        )}
                      </td>
                      <td>
                        {item.skus?.is_imported === true
                          ? "Importado"
                          : item.skus?.is_imported === false
                            ? "Nacional"
                            : "—"}
                      </td>
                      <td className="sb-num">{formatCount(item.quantity_ordered)}</td>
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

      <div className="sb-pod-section">
        <Panel title="Histórico" subtitle="Cada mudança de etapa, com quem fez e quando. O histórico nunca é reescrito.">
          {events.error !== null && (
            <p role="alert" className="sb-pod-error">
              Não foi possível carregar o histórico agora. Tente recarregar a página.
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

                <span className="sb-pod-event">
                  <b>{purchaseOrderEventLabel(event.event_type)}</b>
                  <small>
                    {formatDateTime(event.occurred_at)}
                    {/* `actor_user_id` existia e a tela não dizia quem fez (lote 4). */}
                    {event.autor?.full_name != null && ` · ${event.autor.full_name}`}
                  </small>
                </span>
              </div>
            ))}
        </Panel>
      </div>
    </Shell>
  );
}
