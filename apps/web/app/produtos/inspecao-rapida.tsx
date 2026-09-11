"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";

import { Drawer } from "../../components/drawer";
import { TOM } from "../../components/tone";
import { formatCount, formatDateTime } from "../../lib/format";
import { formatQtyDelta, locationKindLabel, movementTypeLabel } from "../../lib/movement-labels";

import { inspecionarSku, type SkuInspection } from "./inspecao";

/**
 * A gaveta "Inspeção Rápida" do frame `ProductsCuration` (fatia D38).
 *
 * É a primeira das cinco gavetas do Figma, adiadas desde A1 — e a razão de ser
 * a primeira é que ela é a única cujo conteúdo inteiro já existe no banco: as
 * outras quatro (MLB, pedido, fornecedor, usuário) repetem telas que a V3 já
 * tem, e decidir se gaveta SUBSTITUI ou DUPLICA a tela é decisão de
 * composição, não de acabamento.
 *
 * ## O que o frame desenha, e o que fica diferente
 *
 * No frame o clique na CÉLULA do produto abre a gaveta, e o título é o único
 * caminho: não há link para a página cheia — ela é o botão do rodapé. Aqui o
 * título continua sendo um `<Link>` de verdade, e a gaveta ganhou disparo
 * próprio ("Inspecionar"). Não é preferência de layout: link é navegação —
 * abre em nova aba, tem alvo de teclado, sobrevive ao meio-clique — e trocá-lo
 * por um `onClick` seria perder comportamento real para ganhar aparência (a
 * regra de conflito do Design Contract: função vence Figma).
 *
 * ## Nenhum número inventado
 *
 * O frame mostra "Risco de ruptura iminente em 12 anúncios" e uma cobertura
 * fixa. Aqui o alerta só aparece quando `is_ruptura` — a MESMA coluna que
 * pinta o selo "Risco de ruptura" no cabeçalho do dashboard de SKU — e o
 * número de anúncios em risco não existe: não há detecção por anúncio, e
 * inventá-la seria a classe de defeito de D-023. O que sobra é o desenho sem
 * ela, que é a regra de composição desta frente.
 */
export function InspecaoRapida({
  organizationId,
  skuId,
  sku,
  title,
  supplierBrand,
  classificacao,
  listingCount,
}: {
  organizationId: string;
  skuId: string;
  sku: string;
  title: string | null;
  supplierBrand: string | null;
  /** O mesmo texto do chip da coluna "Classificação" — um vocabulário só. */
  classificacao: { texto: string; tom: "info" | "atencao" };
  listingCount: number;
}): ReactNode {
  const [aberta, setAberta] = useState(false);
  const [retrato, setRetrato] = useState<SkuInspection | null>(null);
  const [lendo, startTransition] = useTransition();

  function abrir(): void {
    setAberta(true);
    setRetrato(null);

    startTransition(() => {
      void (async () => {
        setRetrato(await inspecionarSku(organizationId, skuId, supplierBrand));
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
          eyebrow="Inspeção rápida"
          label={`Inspeção rápida do SKU ${sku}`}
          onClose={() => {
            setAberta(false);
          }}
          footer={
            <>
              {/*
                O destino que o botão do frame aponta ("Abrir página completa
                →"). A gaveta é o resumo; a decisão mora na tela cheia.
              */}
              <Link className="sb-button sb-button-primary" href={`/skus/${skuId}`}>
                Abrir página completa →
              </Link>
              <Link className="sb-button" href={`/skus/${skuId}?aba=diagnostico`}>
                Ver diagnóstico
              </Link>
            </>
          }
        >
          {/* Object Header, versão gaveta: sobrancelha mono, título, selos. */}
          <span className="sb-object-id">SKU {sku}</span>
          <h3 style={{ margin: "0.25rem 0 0.5rem", fontSize: "0.875rem", color: "var(--sb-primary)" }}>
            {title ?? sku}
          </h3>
          <div style={{ display: "flex", gap: "var(--sb-space-1)", flexWrap: "wrap" }}>
            <span className="sb-status" style={TOM[classificacao.tom]}>
              {classificacao.texto}
            </span>
            {supplierBrand !== null && (
              <span className="sb-status" style={TOM.info}>
                {supplierBrand}
              </span>
            )}
            <span className="sb-status" style={TOM.neutro}>
              {formatCount(listingCount)} anúncio(s)
            </span>
          </div>

          <div style={{ marginTop: "var(--sb-space-3)" }}>
            {retrato === null || lendo ? (
              <p style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>Lendo o retrato deste SKU…</p>
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

/**
 * O corpo do retrato. As cinco linhas do frame — vendas 30d, físico, Full,
 * cobertura alvo, última movimentação —, mais a cobertura REAL, que no frame
 * vive dentro do alerta e aqui precisa existir mesmo quando não há alerta.
 */
function Retrato({ retrato }: { retrato: SkuInspection }): ReactNode {
  return (
    <>
      {/*
        O "Atenção Operacional" do frame. Duas situações o merecem, e as duas
        são estado NOMEADO do banco — nenhuma é inferência desta tela.
      */}
      {retrato.isRuptura === true && (
        <p className="sb-note sb-note-perigo" style={{ marginBottom: "var(--sb-space-3)" }}>
          <span>Atenção operacional</span>
          <span style={{ display: "block", fontFamily: "var(--sb-sans)", fontSize: "0.6875rem", marginTop: "0.375rem" }}>
            Vende e o saldo LOCAL acabou. O veredito de ruptura considera Full e trânsito e mora em Cobertura e
            reposição (D-288).
          </span>
        </p>
      )}

      {retrato.stockIsVirtual && (
        <p className="sb-note sb-note-atencao" style={{ marginBottom: "var(--sb-space-3)" }}>
          <span>Estoque virtual</span>
          <span style={{ display: "block", fontFamily: "var(--sb-sans)", fontSize: "0.6875rem", marginTop: "0.375rem" }}>
            A cobertura fica em branco de propósito: o saldo do ERP é sentinela, não contagem (D-127).
          </span>
        </p>
      )}

      <div className="sb-detail-row">
        <span>Vendas (30 d)</span>
        <b>{formatCount(retrato.units30d)} un</b>
      </div>

      <div className="sb-detail-row">
        <span>Estoque físico</span>
        <b>
          {formatCount(retrato.localQuantity)} un
          <small>
            {formatCount(retrato.reservedQuantity)} reservado · {formatCount(retrato.transitQuantity)} em trânsito
          </small>
        </b>
      </div>

      <div className="sb-detail-row">
        <span>Estoque Full</span>
        <b>{formatCount(retrato.fullQuantity)} un</b>
      </div>

      {/*
        A MESMA CONTA E O MESMO TEXTO do cartão "Cobertura" do dashboard de SKU
        (D-314): as duas superfícies leem `descreverCobertura`, então não
        conseguem divergir. Antes daqui a gaveta imprimia `local ÷ venda
        média`, a definição que D-288 aposentou.
      */}
      <div className="sb-detail-row">
        <span>Cobertura</span>
        <b title={retrato.cobertura.titulo}>
          {retrato.cobertura.valor}
          <small>{retrato.cobertura.ressalva}</small>
        </b>
      </div>

      <div className="sb-detail-row">
        <span>Cobertura alvo</span>
        <b>
          {retrato.targetCoverageDays === null ? "—" : `${formatCount(retrato.targetCoverageDays)} dias`}
          <small>
            {/*
              Sem política aplicável o alvo NÃO é chutado (D-144): o PRD dá
              referências, e referência é o que o ADMIN digita na tela.
            */}
            {retrato.policyScope === null
              ? "nenhuma política de reposição alcança este SKU"
              : retrato.policyScope === "SKU"
                ? "política deste SKU"
                : retrato.policyScope === "MARCA"
                  ? "política da marca do fornecedor"
                  : "política padrão da organização"}
          </small>
        </b>
      </div>

      <div className="sb-detail-row">
        <span>Última movimentação</span>
        <b>
          {retrato.lastMovement === null ? "—" : formatDateTime(retrato.lastMovement.occurredAt)}
          <small>
            {retrato.lastMovement === null
              ? "nenhuma no ledger deste SKU"
              : `${movementTypeLabel(retrato.lastMovement.movementType)} · ${locationKindLabel(
                  retrato.lastMovement.locationKind,
                )} ${formatQtyDelta(retrato.lastMovement.qtyDelta)}`}
          </small>
        </b>
      </div>
    </>
  );
}
