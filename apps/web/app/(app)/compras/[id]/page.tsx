import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ObjectHeader, type ObjectBadge } from "../../../../components/object-header";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../../../components/estado-da-tela";
import { PageTitle } from "../../../../components/page-title";
import { Panel } from "../../../../components/panel";
import { ProcessSteps } from "../../../../components/process-steps";
import { Voltar } from "../../../../components/voltar";
import { TOM, tomDeStatus } from "../../../../components/tone";
import { formatBusinessDate, formatCount, formatCurrency, formatDateTime } from "../../../../lib/format";
import { purchaseOrderCostNote, summarizePurchaseOrderCost } from "../../../../lib/purchase-order-cost";
import { purchaseOrderEtapas } from "../../../../lib/purchase-order-steps";
import { LOGISTICS_STAGE, purchaseOrderEventLabel, purchaseOrderStatusLabel, statusTone } from "../../../../lib/labels";
import { rotuloMotivoManter, rotuloRecomendacao } from "../../../../lib/purchase-fit-vocabulary";
import { podeOperarCompras } from "../../../../lib/purchase-order-permission";
import { currentMembership } from "../../../../lib/request-membership";
import { createClient } from "../../../../lib/supabase/server";
import { ActionsPanel } from "./actions-panel";
import { ExportActions } from "./export-actions";
import { CustosDoPedido, EtapaLogistica, RecebimentoParcial } from "./operacao-pedido";
import { PrevisaoEReferencia } from "./previsao-e-referencia";

/** D-760: de onde o pedido veio. */
const ORIGEM: Record<string, string> = {
  INTERNO: "Criado no sistema",
  EXTERNO_MANUAL: "Pedido externo (já feito)",
  PLANILHA: "Importado de planilha",
};

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
  // D-722/D-725: decisões da revisão, custos adicionais e o custo de chegada
  // partem do mesmo `id` — juntas com as outras, sem fila.
  const [membership, order, items, events, decisoes, custos, chegada] = await Promise.all([
    currentMembership(),
    supabase
      .from("purchase_orders")
      .select(
        "id, order_number, status, destination_warehouse_name, currency, notes, expected_at, approved_at, ordered_at, received_at, cancelled_at, cancel_reason, created_at, supplier_id, logistics_stage, logistics_stage_at, is_import, exchange_rate, origin, external_reference, supplier_ordered_on, suppliers(name)",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("purchase_order_items")
      .select(
        "id, position, sku_id, sku_snapshot, title_snapshot, quantity_ordered, quantity_received, unit_cost, recommended_quantity, review_recommendation, review_decision, review_reason, review_note, skus(is_imported)",
      )
      .eq("purchase_order_id", id)
      .order("position"),
    supabase
      .from("purchase_order_events")
      .select("id, event_type, metadata, occurred_at, autor:profiles(full_name)")
      .eq("purchase_order_id", id)
      .order("occurred_at", { ascending: false }),
    supabase
      .from("purchase_order_review_decisions")
      .select("id, sku_snapshot, recommendation, decision, quantity_before, quantity_after, recommended_quantity, reason, note, decided_at")
      .eq("purchase_order_id", id)
      .order("decided_at", { ascending: false })
      .limit(500),
    supabase
      .from("purchase_order_costs")
      .select("id, kind, description, amount, currency, exchange_rate, status")
      .eq("purchase_order_id", id)
      .order("created_at")
      .limit(200),
    supabase.rpc("get_purchase_order_landed_cost", { p_purchase_order_id: id }),
  ]);

  // `null` aqui pode ser "não existe" ou "a policy escondeu" — a tela
  // responde igual nos dois casos, mesmo raciocínio já usado em
  // apps/web/app/(app)/importacoes/[id]/page.tsx.
  // FALHA DE LEITURA não é "não existe" (D-067; /notas-fiscais/[id] corrigiu o
  // mesmo defeito depois de um incidente real): um erro transitório virava 404
  // e a pessoa concluía que o pedido tinha sumido (lote 4 do pente fino, 18/09).
  if (order.error !== null) {
    return (
      <>
        <PageTitle
          eyebrow="ESTOQUE / OPERAÇÃO"
          title="Pedido de compra"
          aside={<Voltar href="/compras" rotulo="Pedidos de compra" />}
          compacto
        />
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar este pedido agora."
          descricao="O pedido não foi alterado. Tente de novo em instantes."
          acao={{ href: `/compras/${id}`, rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      </>
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

  // D-724: quanto já chegou. "Pedido feito" não é "mercadoria disponível".
  const totalPedido = items.error !== null ? null : items.data.reduce((s, i) => s + i.quantity_ordered, 0);
  const totalRecebido = items.error !== null ? null : items.data.reduce((s, i) => s + i.quantity_received, 0);
  const recebimento =
    totalPedido === null || totalRecebido === null || (info.status !== "ORDERED" && info.status !== "RECEIVED" && totalRecebido === 0)
      ? null
      : `${formatCount(totalRecebido)} de ${formatCount(totalPedido)} un`;
  const chegadaLida = chegada.error === null && typeof chegada.data === "object" && chegada.data !== null ? (chegada.data as Record<string, unknown>) : null;
  const custosLinhas = (custos.data ?? []).map((c) => ({
    id: c.id,
    kind: c.kind,
    description: c.description,
    amount: c.amount,
    currency: c.currency,
    exchangeRate: c.exchange_rate,
    status: c.status,
  }));
  const mostrarCustos = info.is_import || info.currency !== "BRL" || custosLinhas.length > 0;

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
    // D-760: origem e referência externa. A data do pedido no fornecedor é a
    // informada; sem ela, "—" (nunca a data do registro no lugar).
    ["Origem", ORIGEM[info.origin] ?? info.origin],
    ...(info.external_reference === null ? [] : ([["Referência", info.external_reference]] as const)),
    ...(info.origin === "INTERNO"
      ? []
      : ([["Pedido feito em", info.supplier_ordered_on === null ? "—" : formatBusinessDate(info.supplier_ordered_on)]] as const)),
    // A previsão é data de negócio gravada como meia-noite UTC: `formatDateTime`
    // a mostrava como a véspera às 21h (D-365).
    ["Previsão", info.expected_at === null ? "—" : formatBusinessDate(info.expected_at.slice(0, 10))],
    ["Itens", items.error !== null ? "—" : String(items.data.length)],
    ...(info.logistics_stage === null
      ? []
      : ([["Etapa", LOGISTICS_STAGE[info.logistics_stage] ?? info.logistics_stage]] as const)),
    ...(recebimento === null ? [] : ([["Recebido", recebimento]] as const)),
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
    <>
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
        <p role="status" className="sb-pod-cancelled">
          <strong>Cancelado:</strong> {info.cancel_reason}
        </p>
      )}

      {/* Aprovar, marcar enviado, receber e cancelar passam todos por
          `check_purchase_order_writer` (ADMIN/GESTOR). Os outros papéis veem o
          pedido e a trilha, sem botão que o banco vai recusar (lote 1, 18/09). */}
      {podeOperar ? (
        <>
          <ActionsPanel purchaseOrderId={info.id} status={info.status} expectedAt={info.expected_at} />
          <div className="sb-pod-operacoes">
            <EtapaLogistica purchaseOrderId={info.id} status={info.status} etapa={info.logistics_stage} />
            {info.status !== "RECEIVED" && info.status !== "CANCELLED" && (
              <PrevisaoEReferencia
                purchaseOrderId={info.id}
                expectedAt={info.expected_at}
                externalReference={info.external_reference}
              />
            )}
            {info.status === "ORDERED" && items.error === null && (
              <RecebimentoParcial
                purchaseOrderId={info.id}
                itens={items.data.map((i) => ({ id: i.id, sku: i.sku_snapshot, pedido: i.quantity_ordered, recebido: i.quantity_received }))}
              />
            )}
          </div>
        </>
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
            <EstadoDaTela
              tipo="erro"
              titulo="Não foi possível carregar os itens agora"
              acao={{ href: `/compras/${id}`, rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
            />
          )}

          {items.error === null && items.data.length === 0 && (
            <EstadoDaTela tipo="vazio" titulo="Nenhum item neste pedido ainda" />
          )}

          {items.error === null && items.data.length > 0 && (
            <div className="sb-pod-table-wrap">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Origem (cadastro)</th>
                    <th className="sb-num">Quantidade</th>
                    {(info.status === "ORDERED" || info.status === "RECEIVED") && <th className="sb-num">Recebido</th>}
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
                        {/* D-722: a recomendação de quando o item foi salvo e a decisão do comprador. */}
                        {item.review_recommendation !== null && (
                          <span className="sb-pod-item-title">
                            sistema: {rotuloRecomendacao(item.review_recommendation).toLowerCase()}
                            {item.recommended_quantity !== null && ` (${formatCount(item.recommended_quantity)} un)`}
                            {item.review_decision !== null && ` · decisão: ${item.review_decision === "MANTER" ? "manter" : "reduzir"}`}
                            {item.review_reason !== null &&
                              ` — ${rotuloMotivoManter(item.review_reason).toLowerCase()}`}
                          </span>
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
                      {(info.status === "ORDERED" || info.status === "RECEIVED") && (
                        <td className="sb-num">{formatCount(item.quantity_received)}</td>
                      )}
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

      {mostrarCustos ? (
        <div className="sb-pod-section">
          <Panel
            title="Custos e importação"
            subtitle="Frete, seguro, tributos e despesas de chegada, estimados e realizados em separado. O custo de chegada rateia os adicionais pelo valor de cada item."
          >
            {chegadaLida !== null && (
              <dl className="sb-fact-grid sb-pod-chegada">
                <div>
                  <dt>Produtos (R$)</dt>
                  <dd>{typeof chegadaLida.produtos_brl === "number" ? formatCurrency(chegadaLida.produtos_brl) : "—"}</dd>
                </div>
                <div>
                  <dt>Adicionais estimados</dt>
                  <dd>{typeof chegadaLida.adicionais_estimados_brl === "number" ? formatCurrency(chegadaLida.adicionais_estimados_brl) : "—"}</dd>
                </div>
                <div>
                  <dt>Adicionais realizados</dt>
                  <dd>{typeof chegadaLida.adicionais_realizados_brl === "number" ? formatCurrency(chegadaLida.adicionais_realizados_brl) : "—"}</dd>
                </div>
                <div>
                  <dt>Câmbio do pedido</dt>
                  <dd>{info.currency === "BRL" ? "BRL" : info.exchange_rate === null ? "pendente" : `${info.currency} ${String(info.exchange_rate)}`}</dd>
                </div>
              </dl>
            )}
            {chegadaLida !== null &&
              (chegadaLida.cambio_pendente === true || (typeof chegadaLida.itens_sem_custo === "number" && chegadaLida.itens_sem_custo > 0)) && (
                <p className="sb-pco-aviso">
                  Pendente para o custo de chegada:
                  {chegadaLida.cambio_pendente === true && " câmbio"}
                  {chegadaLida.cambio_pendente === true && typeof chegadaLida.itens_sem_custo === "number" && chegadaLida.itens_sem_custo > 0 && " e"}
                  {typeof chegadaLida.itens_sem_custo === "number" && chegadaLida.itens_sem_custo > 0 && ` ${formatCount(chegadaLida.itens_sem_custo)} item(ns) sem custo`}
                  . Sem eles o valor fica desconhecido — nunca convertido a 1 nem somado como zero. NCM, tributos e medidas só entram quando informados.
                </p>
              )}
            <CustosDoPedido purchaseOrderId={info.id} custos={custosLinhas} podeEditar={podeOperar && info.status !== "CANCELLED"} />
          </Panel>
        </div>
      ) : (
        podeOperar &&
        info.status !== "CANCELLED" && (
          <details className="sb-rep-metodo sb-pod-section">
            <summary>Custos adicionais (frete, seguro, tributos, desembaraço)</summary>
            <div>
              <CustosDoPedido purchaseOrderId={info.id} custos={[]} podeEditar />
            </div>
          </details>
        )
      )}

      {decisoes.error === null && decisoes.data.length > 0 && (
        <div className="sb-pod-section">
          <Panel
            title="Decisões da revisão"
            subtitle="O que o sistema recomendou e o que foi decidido, inclusive os itens retirados. Retirar do pedido não mexe no catálogo nem no estoque."
          >
            <table className="sb-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Recomendação</th>
                  <th>Decisão</th>
                  <th className="sb-num">De → para</th>
                  <th>Motivo</th>
                  <th>Quando</th>
                </tr>
              </thead>
              <tbody>
                {decisoes.data.map((d) => (
                  <tr key={d.id}>
                    <td className="sb-mono">{d.sku_snapshot}</td>
                    <td>{rotuloRecomendacao(d.recommendation)}</td>
                    <td>{d.decision === "MANTER" ? "Manter" : d.decision === "REDUZIR" ? "Reduzir" : "Retirar"}</td>
                    <td className="sb-num">
                      {formatCount(d.quantity_before)} → {formatCount(d.quantity_after)}
                    </td>
                    <td>
                      {d.reason === null ? "—" : rotuloMotivoManter(d.reason)}
                      {d.note !== null && <span className="sb-pod-item-title">{d.note}</span>}
                    </td>
                    <td>{formatDateTime(d.decided_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        </div>
      )}

      <div className="sb-pod-section">
        <Panel title="Histórico" subtitle="Cada mudança de etapa, com quem fez e quando. O histórico nunca é reescrito.">
          {events.error !== null && (
            <EstadoDaTela
              tipo="erro"
              titulo="Não foi possível carregar o histórico agora"
              acao={{ href: `/compras/${id}`, rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
            />
          )}

          {events.error === null && events.data.length === 0 && (
            <EstadoDaTela tipo="vazio" titulo="Sem eventos ainda" />
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
    </>
  );
}
