"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";

import { DetailRow, Drawer } from "../../components/drawer";
import { TOM, tomDeRelist } from "../../components/tone";
import { formatEventDiff } from "../../lib/event-format";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import { eventTypeLabel, listingStatusLabel } from "../../lib/labels";

import { inspecionarAnuncio, type ListingInspection } from "./inspecao";

/**
 * A gaveta do ANÚNCIO do frame (`MlbDetailDrawer`) — D39, a terceira das cinco.
 *
 * ## As oito abas do frame NÃO entram aqui
 *
 * O frame desenha, dentro da gaveta, o mesmo conjunto de abas do dashboard do
 * anúncio (Visão geral, Vendas, Tráfego, Preço, Full, Histórico, Diagnóstico,
 * Decisões) — e essas abas existem, migradas, em `/anuncios/[itemId]` (D13).
 * Reproduzi-las na gaveta seria a segunda implementação da mesma interface,
 * que é o que o Design Contract proíbe. **A gaveta resume e aponta.**
 *
 * ## O que sai do frame por falta de fonte
 *
 * - **miniatura**: `listings` não tem coluna de imagem (conferido no esquema);
 * - **"Tipo: Premium" e "Catálogo: Vencedor"**: nenhuma das duas existe no
 *   esquema;
 * - **"Saúde do Anúncio"**: dos três sinais, só o Full tem fonte —
 *   "competitividade de preço" exige dado de concorrente, que a V3 não coleta,
 *   e "qualidade das fotos" não existe em lugar nenhum. Um bloco com um sinal
 *   de três não é o bloco do frame: ele saiu, e o Full continua na linha da
 *   tabela, que é onde já vivia;
 * - **"Repor Full"**: escrita no Mercado Livre é ato com aprovação humana e
 *   sem política logística defensável (recusa que o próprio Figma registrou na
 *   auditoria corretiva dele).
 */
export function InspecaoAnuncio({
  mlAccountId,
  itemId,
  title,
  status,
  price,
  availableQuantity,
  fullQuantity,
  accountLabel,
  sku,
  skuId,
}: {
  mlAccountId: string;
  itemId: string;
  title: string;
  status: string;
  price: number;
  availableQuantity: number;
  fullQuantity: number | null;
  accountLabel: string;
  sku: string | null;
  skuId: string | null;
}): ReactNode {
  const [aberta, setAberta] = useState(false);
  const [retrato, setRetrato] = useState<ListingInspection | null>(null);
  const [lendo, startTransition] = useTransition();

  function abrir(): void {
    setAberta(true);
    setRetrato(null);

    startTransition(() => {
      void (async () => {
        setRetrato(await inspecionarAnuncio(mlAccountId, itemId));
      })();
    });
  }

  return (
    <>
      <button type="button" className="sb-text-button" onClick={abrir}>
        Inspecionar
      </button>

      {aberta && (
        <Drawer
          eyebrow="Detalhe de anúncio"
          label={`Detalhe do anúncio ${itemId}`}
          onClose={() => {
            setAberta(false);
          }}
          footer={
            <Link className="sb-button sb-button-primary" href={`/anuncios/${itemId}`}>
              Abrir dashboard do anúncio →
            </Link>
          }
        >
          <span className="sb-object-id">{itemId}</span>
          <h3 style={{ margin: "0.25rem 0 0.5rem", fontSize: "0.875rem", color: "var(--sb-primary)" }}>
            {title}
          </h3>
          <div style={{ display: "flex", gap: "var(--sb-space-1)", flexWrap: "wrap" }}>
            <span className="sb-status" style={status === "active" ? TOM.ok : TOM.neutro}>
              {listingStatusLabel(status)}
            </span>
            <span className="sb-status" style={TOM.info}>
              {accountLabel}
            </span>
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            <DetailRow label="Preço" value={formatCurrency(price)} />
            <DetailRow
              label="Estoque no anúncio"
              value={`${formatCount(availableQuantity)} un`}
              note={
                fullQuantity === null
                  ? "sem snapshot de Full nos últimos 3 dias"
                  : `${formatCount(fullQuantity)} no Full`
              }
            />
            <DetailRow
              label="SKU vinculado"
              value={
                skuId === null || sku === null ? (
                  "—"
                ) : (
                  <Link className="sb-mono" href={`/skus/${skuId}`}>
                    {sku}
                  </Link>
                )
              }
              note={skuId === null ? "sem vínculo — a venda não baixa estoque" : undefined}
            />

            {retrato === null || lendo ? (
              <p style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>Lendo o histórico…</p>
            ) : retrato.error !== null ? (
              <p role="alert" className="sb-note sb-note-perigo" style={{ fontSize: "0.6875rem" }}>
                {retrato.error}
              </p>
            ) : (
              <Retrato retrato={retrato} />
            )}
          </div>
        </Drawer>
      )}
    </>
  );
}

function Retrato({ retrato }: { retrato: ListingInspection }): ReactNode {
  return (
    <>
      <DetailRow
        label="Sincronizado em"
        value={retrato.syncedAt === null ? "—" : formatDateTime(retrato.syncedAt)}
        note="o preço e o estoque acima são desta leitura, não de agora"
      />

      {retrato.relistStatus !== null && (
        <DetailRow
          label="Republicação"
          value={
            <span className="sb-status" style={TOM[tomDeRelist(retrato.relistStatus)]}>
              {retrato.relistStatus}
            </span>
          }
          note={
            retrato.relistFailureReason ??
            (retrato.relistChildItemId === null
              ? retrato.relistAt === null
                ? undefined
                : `atualizada em ${formatDateTime(retrato.relistAt)}`
              : `nasceu ${retrato.relistChildItemId}`)
          }
        />
      )}

      {/*
        O QUE ACONTECEU — o que a linha da tabela não tem como mostrar. São os
        cinco últimos eventos deste anúncio; o histórico inteiro é a aba
        "Histórico" do dashboard, e o rodapé leva até lá.
      */}
      <h4 className="sb-section-label" style={{ marginTop: "var(--sb-space-3)" }}>
        O que aconteceu
      </h4>

      {retrato.eventos.length === 0 ? (
        <p className="sb-empty">
          Nenhum evento observado neste anúncio. Não quer dizer anúncio parado: quer dizer que nenhuma
          sincronização viu duas leituras diferentes.
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
            note={formatEventDiff(evento.eventType, evento.before, evento.after) ?? undefined}
          />
        ))
      )}
    </>
  );
}
