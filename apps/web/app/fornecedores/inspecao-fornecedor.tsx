"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";

import { DetailRow, Drawer } from "../../components/drawer";
import { TOM } from "../../components/tone";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";

import { inspecionarFornecedor, type SupplierInspection } from "./inspecao";

/**
 * A gaveta "Detalhe do Fornecedor" do frame (D39 — a segunda das cinco).
 *
 * ## A pergunta que as quatro gavetas restantes faziam, respondida aqui
 *
 * Todas mostram entidade que **já tem tela cheia**. A regra que D38 já usava e
 * que passa a valer para as cinco: **a gaveta é um RESUMO que leva à tela, nunca
 * uma segunda versão dela.** Por isso as cinco abas do frame ("SKUs já
 * comprados", "Pedidos", "Custos", "Histórico") NÃO viram abas aqui — elas são
 * a página `/fornecedores/[supplierId]`, e o rodapé aponta para lá.
 *
 * ## O que o frame promete e não existe
 *
 * "Lead Time 11 dias" no cabeçalho: **`suppliers` não tem lead time** — foi
 * conferido no esquema, não no código da tela. O prazo mora em
 * `replenishment_settings`, por marca ou por SKU (D-144), e não há relação
 * fornecedor→marca. É a mesma recusa que D-256 registrou para a lista.
 */
export function InspecaoFornecedor({
  organizationId,
  supplierId,
  nome,
}: {
  organizationId: string;
  supplierId: string;
  nome: string;
}): ReactNode {
  const [aberta, setAberta] = useState(false);
  const [retrato, setRetrato] = useState<SupplierInspection | null>(null);
  const [lendo, startTransition] = useTransition();

  function abrir(): void {
    setAberta(true);
    setRetrato(null);

    startTransition(() => {
      void (async () => {
        setRetrato(await inspecionarFornecedor(organizationId, supplierId));
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
          eyebrow="Detalhe do fornecedor"
          label={`Detalhe do fornecedor ${nome}`}
          onClose={() => {
            setAberta(false);
          }}
          footer={
            <Link className="sb-button sb-button-primary" href={`/fornecedores/${supplierId}`}>
              Abrir página completa →
            </Link>
          }
        >
          {retrato === null || lendo ? (
            <p style={{ fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>Lendo o cadastro…</p>
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

function Retrato({ retrato }: { retrato: SupplierInspection }): ReactNode {
  const emAberto =
    (retrato.ordersDraft ?? 0) + (retrato.ordersApproved ?? 0) + (retrato.ordersOrdered ?? 0);

  return (
    <>
      <span className="sb-object-id">Fornecedor</span>
      <h3 style={{ margin: "0.25rem 0 0.5rem", fontSize: "0.875rem", color: "var(--sb-primary)" }}>
        {retrato.name ?? "—"}
      </h3>
      <div style={{ display: "flex", gap: "var(--sb-space-1)", flexWrap: "wrap" }}>
        <span className="sb-status" style={retrato.isActive === false ? TOM.neutro : TOM.ok}>
          {retrato.isActive === false ? "inativo" : "ativo"}
        </span>
        {retrato.document !== null && (
          <span className="sb-status" style={TOM.info}>
            {retrato.document}
          </span>
        )}
      </div>

      {retrato.legalName !== null && (
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
          {retrato.legalName}
        </p>
      )}

      {/*
        OS CANAIS DE CONTATO — o que a gaveta acrescenta à linha da tabela.
        Cada um só aparece quando existe: um "—" para cada canal vazio faria a
        gaveta parecer um formulário por preencher, e o cadastro é de quem
        cadastra, não da tela.
      */}
      <h4 className="sb-section-label" style={{ marginTop: "var(--sb-space-3)" }}>
        Contato
      </h4>

      {retrato.contactName === null &&
      retrato.email === null &&
      retrato.phone === null &&
      retrato.whatsapp === null &&
      retrato.website === null ? (
        <p className="sb-empty">Nenhum canal de contato cadastrado.</p>
      ) : (
        <>
          {retrato.contactName !== null && <DetailRow label="Pessoa" value={retrato.contactName} />}
          {retrato.email !== null && <DetailRow label="E-mail" value={retrato.email} />}
          {retrato.phone !== null && <DetailRow label="Telefone" value={retrato.phone} />}
          {retrato.whatsapp !== null && <DetailRow label="WhatsApp" value={retrato.whatsapp} />}
          {retrato.website !== null && <DetailRow label="Site" value={retrato.website} />}
        </>
      )}

      {/*
        A decomposição por estado. As três células FECHAM com o total — em
        aberto + recebidos + cancelados —, e é a aritmética que D-265 cobrou do
        frame da Central Full: partição que esconde estado mente sobre o
        conjunto.
      */}
      <h4 className="sb-section-label" style={{ marginTop: "var(--sb-space-3)" }}>
        Pedidos de compra
      </h4>

      <DetailRow
        label="Total"
        value={formatCount(retrato.ordersTotal)}
        note={`${formatCount(retrato.skusDistintos)} SKU(s) distintos já comprados`}
      />
      <DetailRow
        label="Em aberto"
        value={formatCount(emAberto)}
        note={`rascunho ${formatCount(retrato.ordersDraft)} · aprovado ${formatCount(
          retrato.ordersApproved,
        )} · pedido ${formatCount(retrato.ordersOrdered)}`}
      />
      <DetailRow label="Recebidos" value={formatCount(retrato.ordersReceived)} />
      <DetailRow
        label="Cancelados"
        value={formatCount(retrato.ordersCancelled)}
        note="nunca somados ao valor comprado (D-174)"
      />

      <DetailRow
        label="Valor comprado"
        value={formatCurrency(retrato.valorPedido)}
        note={
          // Três saídas, e elas significam coisas diferentes (D-254): zero
          // sabido, ausência de custo, e soma parcial.
          retrato.valorPedido === null
            ? "nenhum item com custo cadastrado — ausência não é zero"
            : (retrato.itensSemCusto ?? 0) > 0
              ? `soma parcial — ${formatCount(retrato.itensSemCusto)} item(ns) sem custo`
              : "todos os itens têm custo"
        }
      />

      <DetailRow
        label="Último pedido"
        value={retrato.ultimoPedidoEm === null ? "—" : formatDateTime(retrato.ultimoPedidoEm)}
        note={
          retrato.primeiroPedidoEm === null
            ? "nenhum pedido de compra registrado"
            : `primeiro em ${formatDateTime(retrato.primeiroPedidoEm)}`
        }
      />
    </>
  );
}
