"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";

import { DetailRow, Drawer } from "../../components/drawer";
import { TOM, tomDeStatus } from "../../components/tone";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { eventTypeLabel, orderStatusLabel, statusTone } from "../../lib/labels";

import { inspecionarPedido, type OrderInspection } from "./pedido";

/**
 * A gaveta "Detalhe de Pedido" do frame (D39 — a quinta das cinco).
 *
 * O frame a dispara do Atendimento, e é lá que ela entra: `/atendimento/[caseId]`
 * mostrava o número do pedido como texto morto, porque **não existe página de
 * pedido de venda na V3**. Esta gaveta é a primeira superfície a responder "o
 * que foi comprado?" sem sair do produto — e por isso ela é a única das cinco
 * sem rodapé de "abrir página completa": não há página para abrir.
 *
 * O que o frame promete e o esquema não tem (nome do comprador, logística,
 * timeline da transportadora) está registrado em `pedido.ts`, junto da leitura.
 */
export function GavetaPedido({ orderId }: { orderId: number }): ReactNode {
  const [aberta, setAberta] = useState(false);
  const [retrato, setRetrato] = useState<OrderInspection | null>(null);
  const [lendo, startTransition] = useTransition();

  function abrir(): void {
    setAberta(true);
    setRetrato(null);

    startTransition(() => {
      void (async () => {
        setRetrato(await inspecionarPedido(orderId));
      })();
    });
  }

  return (
    <>
      <button type="button" className="sb-text-button" onClick={abrir}>
        Ver pedido
      </button>

      {aberta && (
        <Drawer
          eyebrow="Detalhe de pedido"
          label={`Detalhe do pedido ${String(orderId)}`}
          onClose={() => {
            setAberta(false);
          }}
        >
          <span className="sb-object-id">Pedido</span>
          <h3
            className="sb-mono"
            style={{ margin: "0.25rem 0 0.5rem", fontSize: "0.875rem", color: "var(--sb-primary)" }}
          >
            {orderId}
          </h3>

          {retrato === null || lendo ? (
            <p style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>Lendo o pedido…</p>
          ) : retrato.error !== null ? (
            <p role="alert" className="sb-note sb-note-perigo" style={{ fontSize: "0.6875rem" }}>
              {retrato.error}
            </p>
          ) : (
            <Retrato retrato={retrato} />
          )}
        </Drawer>
      )}
    </>
  );
}

function Retrato({ retrato }: { retrato: OrderInspection }): ReactNode {
  return (
    <>
      <div style={{ display: "flex", gap: "var(--sb-space-1)", flexWrap: "wrap" }}>
        {retrato.status !== null && (
          <span className="sb-status" style={TOM[tomDeStatus(statusTone(retrato.status))]}>
            {orderStatusLabel(retrato.status)}
          </span>
        )}
        {retrato.accountLabel !== null && (
          <span className="sb-status" style={TOM.info}>
            {retrato.accountLabel}
          </span>
        )}
      </div>

      <div style={{ marginTop: "var(--sb-space-3)" }}>
        <DetailRow
          label="Comprado em"
          value={retrato.dateCreated === null ? "—" : formatDateTime(retrato.dateCreated)}
          note={
            retrato.dateClosed === null
              ? "ainda aberto no Mercado Livre"
              : `fechado em ${formatDateTime(retrato.dateClosed)}`
          }
        />
        <DetailRow
          label="Valor total"
          value={formatCurrency(retrato.totalAmount)}
          note={
            // Pago menor que total é fato do pedido, não erro de leitura — e
            // dizer os dois é a única forma de a diferença aparecer.
            retrato.paidAmount === null
              ? "valor pago não informado pelo Mercado Livre"
              : `pago ${formatCurrency(retrato.paidAmount)}`
          }
        />
        <DetailRow
          label="Frete e desconto do vendedor"
          value={
            retrato.temFinanceiro
              ? `${formatCurrency(retrato.sellerShippingCost)} · ${formatCurrency(retrato.sellerDiscount)}`
              : "—"
          }
          note={
            retrato.temFinanceiro
              ? "o que o vendedor pagou de frete e concedeu de desconto"
              : "a varredura financeira ainda não passou por este pedido"
          }
        />
        {retrato.statusDetail !== null && (
          <DetailRow label="Detalhe do estado" value={retrato.statusDetail} />
        )}
        {retrato.cancelReason !== null && (
          <DetailRow label="Motivo do cancelamento" value={retrato.cancelReason} />
        )}
        {retrato.packId !== null && (
          <DetailRow
            label="Pack"
            value={<span className="sb-mono">{retrato.packId}</span>}
            note="compra com mais de um pedido do mesmo comprador"
          />
        )}
        <DetailRow
          label="Comprador"
          value={
            retrato.buyerId === null ? "—" : <span className="sb-mono">{retrato.buyerId}</span>
          }
          note="o identificador do Mercado Livre — o esquema não guarda nome"
        />
      </div>

      <h4 className="sb-section-label" style={{ marginTop: "var(--sb-space-3)" }}>
        Itens do pedido
      </h4>

      {retrato.itens.length === 0 ? (
        /*
          Pedido pago SEM item é estado conhecido e medido: dois pedidos assim
          existem no Dev, com o movimento de estoque gravado e nenhuma linha
          (D-208). A gaveta diz isso em vez de mostrar uma lista vazia que se
          leria como "não comprou nada".
        */
        <p className="sb-empty">
          Este pedido não tem itens gravados. Não quer dizer compra vazia: quer dizer que a leitura dos
          itens não chegou — o que o Mercado Livre sabe, o banco não tem.
        </p>
      ) : (
        retrato.itens.map((item) => (
          <DetailRow
            key={item.id}
            label={`${formatCount(item.quantity)}×`}
            value={
              item.skuId === null || item.sku === null ? (
                item.title
              ) : (
                <Link href={`/skus/${item.skuId}`}>{item.title}</Link>
              )
            }
            note={`${formatCurrency(item.unitPrice)} un · ${
              item.sku ?? item.sellerSku ?? "sem SKU vinculado"
            }`}
          />
        ))
      )}

      <h4 className="sb-section-label" style={{ marginTop: "var(--sb-space-3)" }}>
        O que aconteceu
      </h4>

      {retrato.eventos.length === 0 ? (
        <p className="sb-empty">
          Nenhum evento excepcional neste pedido — só cancelamento, devolução e reversão perdida geram
          registro, então o silêncio aqui é o curso normal.
        </p>
      ) : (
        retrato.eventos.map((evento) => (
          <DetailRow
            key={evento.id}
            label={formatDateTime(evento.occurredAt)}
            value={
              <span
                style={
                  evento.severity === "critico"
                    ? { color: "var(--sb-danger)" }
                    : evento.severity === "importante"
                      ? { color: "var(--sb-accent-ink)" }
                      : undefined
                }
              >
                {eventTypeLabel(evento.eventType)}
              </span>
            }
          />
        ))
      )}
    </>
  );
}
