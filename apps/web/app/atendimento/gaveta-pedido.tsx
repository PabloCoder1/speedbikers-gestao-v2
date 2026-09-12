"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";

import { DetailRow, Drawer } from "../../components/drawer";
import { TOM, tomDeStatus } from "../../components/tone";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { monogramaDeProduto } from "../../lib/initials";
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
 * ## Os cartões do frame (A13, D-321)
 *
 * Nasceu como uma lista corrida de `DetailRow` sobre branco. O frame compõe a
 * mesma informação em TRÊS cartões sobre o chão cinza — o cabeçalho do objeto
 * com a grade de fatos, um cartão por item com o monograma do produto, e o
 * histórico —, e é a composição que faz a gaveta se ler de uma passada: o que é
 * o pedido, o que foi comprado, o que saiu do trilho.
 *
 * O que o frame promete e o esquema não tem (nome do comprador, logística,
 * timeline da transportadora) está registrado em `pedido.ts`, junto da leitura.
 * Na grade, a célula "Logística" dá lugar ao frete e ao desconto do vendedor,
 * que têm fonte.
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
          chao
          eyebrow="Detalhe de pedido"
          label={`Detalhe do pedido ${String(orderId)}`}
          onClose={() => {
            setAberta(false);
          }}
        >
          {retrato === null || lendo ? (
            <div className="sb-drawer-card">
              <Identidade orderId={orderId} buyerId={null} status={null} />
              <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
                Lendo o pedido…
              </p>
            </div>
          ) : retrato.error !== null ? (
            <div className="sb-drawer-card">
              <Identidade orderId={orderId} buyerId={null} status={null} />
              <p role="alert" className="sb-note sb-note-perigo" style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.6875rem" }}>
                {retrato.error}
              </p>
            </div>
          ) : (
            <Retrato orderId={orderId} retrato={retrato} />
          )}
        </Drawer>
      )}
    </>
  );
}

/**
 * O topo do cartão de cabeçalho: o identificador em mono e o selo de estado à
 * direita, como o frame. Aparece também enquanto a leitura não chegou — o
 * número já é sabido, e a gaveta não deve piscar de um layout para outro.
 */
function Identidade({
  orderId,
  buyerId,
  status,
}: {
  orderId: number;
  buyerId: string | null;
  status: string | null;
}): ReactNode {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "var(--sb-space-2)" }}>
      <div style={{ minWidth: 0 }}>
        <span className="sb-object-id">Pedido</span>
        <h3 className="sb-mono" style={{ margin: "0 0 0.25rem", fontSize: "1rem", color: "var(--sb-primary)" }}>
          {orderId}
        </h3>
        {/*
          O frame escreve "Comprador: Lucas Almeida". Aqui o comprador é o
          NÚMERO do Mercado Livre, e a linha diz isso em vez de parecer um nome
          faltando: `orders` guarda `buyer_id` e nenhuma tabela de comprador.
        */}
        {buyerId !== null && (
          <span style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
            Comprador (id no Mercado Livre): <b className="sb-mono" style={{ color: "var(--sb-primary)" }}>{buyerId}</b>
          </span>
        )}
      </div>

      {status !== null && (
        <span className="sb-status" style={TOM[tomDeStatus(statusTone(status))]}>
          {orderStatusLabel(status)}
        </span>
      )}
    </div>
  );
}

/** Uma célula da grade de fatos: rótulo, valor, e a ressalva de onde ele vem. */
function Fato({ rotulo, valor, nota }: { rotulo: string; valor: ReactNode; nota?: string }): ReactNode {
  return (
    <div>
      <dt>{rotulo}</dt>
      <dd>
        {valor}
        {nota !== undefined && <small>{nota}</small>}
      </dd>
    </div>
  );
}

function Retrato({ orderId, retrato }: { orderId: number; retrato: OrderInspection }): ReactNode {
  return (
    <>
      <div className="sb-drawer-card">
        <Identidade orderId={orderId} buyerId={retrato.buyerId} status={retrato.status} />

        <dl className="sb-fact-grid">
          <Fato rotulo="Conta" valor={retrato.accountLabel ?? "—"} />
          <Fato
            rotulo="Comprado em"
            valor={retrato.dateCreated === null ? "—" : formatDateTime(retrato.dateCreated)}
            nota={
              retrato.dateClosed === null
                ? "ainda aberto no Mercado Livre"
                : `fechado em ${formatDateTime(retrato.dateClosed)}`
            }
          />
          <Fato
            rotulo="Valor total"
            valor={formatCurrency(retrato.totalAmount)}
            nota={
              // Pago menor que total é fato do pedido, não erro de leitura — e
              // dizer os dois é a única forma de a diferença aparecer.
              retrato.paidAmount === null
                ? "valor pago não informado pelo Mercado Livre"
                : `pago ${formatCurrency(retrato.paidAmount)}`
            }
          />
          {/*
            No lugar da "Logística" do frame, que não tem fonte (`shipping_id` e
            nada mais). Frete e desconto do VENDEDOR têm, e vêm de outra leitura
            (D-229) — por isso a ressalva diz quando ela ainda não passou.
          */}
          <Fato
            rotulo="Frete · desconto"
            valor={
              retrato.temFinanceiro
                ? `${formatCurrency(retrato.sellerShippingCost)} · ${formatCurrency(retrato.sellerDiscount)}`
                : "—"
            }
            nota={retrato.temFinanceiro ? "pagos pelo vendedor" : "a varredura financeira ainda não passou por este pedido"}
          />
        </dl>

        {(retrato.statusDetail !== null || retrato.cancelReason !== null || retrato.packId !== null) && (
          <div style={{ marginTop: "var(--sb-space-2)" }}>
            {retrato.statusDetail !== null && <DetailRow label="Detalhe do estado" value={retrato.statusDetail} />}
            {retrato.cancelReason !== null && <DetailRow label="Motivo do cancelamento" value={retrato.cancelReason} />}
            {retrato.packId !== null && (
              <DetailRow
                label="Pack"
                value={<span className="sb-mono">{retrato.packId}</span>}
                note="compra com mais de um pedido do mesmo comprador"
              />
            )}
          </div>
        )}
      </div>

      <h4 className="sb-section-label" style={{ marginTop: "var(--sb-space-4)" }}>
        Itens do pedido
      </h4>

      {retrato.itens.length === 0 ? (
        /*
          Pedido pago SEM item é estado conhecido e medido: dois pedidos assim
          existem no Dev, com o movimento de estoque gravado e nenhuma linha
          (D-208). A gaveta diz isso em vez de mostrar uma lista vazia que se
          leria como "não comprou nada".
        */
        <div className="sb-drawer-card">
          <p style={{ margin: 0, fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
            Este pedido não tem itens gravados. Não quer dizer compra vazia: quer dizer que a leitura dos
            itens não chegou — o que o Mercado Livre sabe, o banco não tem.
          </p>
        </div>
      ) : (
        retrato.itens.map((item) => (
          <div key={item.id} className="sb-drawer-card sb-drawer-item">
            <span className="sb-product-thumb sb-product-thumb-grande" aria-hidden="true">
              {monogramaDeProduto(item.title)}
            </span>

            <span className="sb-drawer-item-texto">
              <b>
                {item.skuId === null || item.sku === null ? (
                  item.title
                ) : (
                  <Link className="sb-entity" href={`/skus/${item.skuId}`}>
                    {item.title}
                  </Link>
                )}
              </b>
              {/*
                O código em mono, como o "SKU 5821" do frame. Sem vínculo, o que
                aparece é o `seller_sku` CRU e a palavra "sem vínculo" — é a
                linha que `/vinculacoes` conta como "vendido sem vínculo", e ela
                não pode se passar por SKU do catálogo.
              */}
              <small className="sb-mono">
                {item.sku !== null
                  ? `SKU ${item.sku}`
                  : item.sellerSku !== null
                    ? `${item.sellerSku} · sem vínculo`
                    : "sem SKU vinculado"}
              </small>
              <small>{formatCurrency(item.unitPrice)} por unidade</small>
            </span>

            <span className="sb-drawer-item-qtd">
              <small>Qtd</small>
              <b>{formatCount(item.quantity)}×</b>
            </span>
          </div>
        ))
      )}

      <h4 className="sb-section-label" style={{ marginTop: "var(--sb-space-4)" }}>
        O que aconteceu
      </h4>

      {/*
        O frame chama de "Timeline do Pedido" e desenha a transportadora
        ("Despachado", "Nova previsão"). Não há fonte para isso: o que existe são
        as EXCEÇÕES em `domain_events`, e o rótulo diz o que o cartão contém.
      */}
      <div className="sb-drawer-card">
        {retrato.eventos.length === 0 ? (
          <p style={{ margin: 0, fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
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
      </div>
    </>
  );
}
