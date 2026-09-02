import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { AutoRefresh } from "../../../components/auto-refresh";
import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { batchStatusLabel, operationTypeLabel } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/server";
import { ConfirmApplyForm } from "./confirm-apply-form";
import { DocumentItemRow } from "./document-item-row";

export const dynamic = "force-dynamic";

/**
 * Tela de conferência da NF-e.
 *
 * Terceira etapa do fluxo `upload -> parse -> CONFERÊNCIA -> aplicação`.
 * Cada item mostra o que o XML trouxe e, ao lado, o vínculo humano a um SKU
 * (`docs/NFE.md` secao 3) — sem vínculo, o item não gera movimento na
 * aplicação (`@sb/domain/inventory`, `computeNfeApplicationMovements`).
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

function Stat({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div>
      <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>{label}</div>
      <div style={{ fontSize: "1.125rem", fontWeight: 600 }}>{value}</div>
    </div>
  );
}

export default async function NotaFiscalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<ReactNode> {
  const { id } = await params;

  const supabase = await createClient();

  // As duas leituras partem do MESMO `id` da URL — a dos itens nunca precisou
  // esperar a da nota. Em paralelo desde D-195; a RLS restringe as duas de
  // forma independente, então o guarda de 404 continua abaixo sem virar
  // vazamento, ao custo de uma consulta desperdiçada no caminho raro.
  const [document, items] = await Promise.all([
    supabase
      .from("documents")
      .select(
        "id, file_name, status, access_key, operation_type, document_number, series, issue_date, issuer_cnpj, issuer_name, recipient_cnpj, recipient_name, total_items, resolved_items, parsed_at, last_error",
      )
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("document_items")
      .select(
        "id, position, supplier_code, ean, description, ncm, cfop, unit, quantity, unit_value, total_value, sku_id, skus(id, sku, title)",
      )
      .eq("document_id", id)
      .order("position"),
  ]);

  // `null` aqui pode ser "não existe" ou "a policy escondeu". A tela responde
  // igual nos dois casos de propósito — mesmo raciocínio de
  // apps/web/app/importacoes/[id]/page.tsx.
  if (document.error !== null || document.data === null) {
    notFound();
  }

  const info = document.data;

  // Estados de trabalho em curso — mesmo raciocínio de AutoRefresh em
  // apps/web/app/importacoes/[id]/page.tsx.
  const working = info.status === "UPLOADED" || info.status === "PARSING" || info.status === "APPLYING";
  const editable = info.status === "PARSED";

  return (
    <Shell>
      {working && <AutoRefresh />}

      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/notas-fiscais">← Notas Fiscais</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0", fontSize: "1.375rem" }}>{info.file_name ?? info.id}</h1>

      <div
        style={{
          display: "flex",
          gap: "var(--sb-space-4)",
          alignItems: "center",
          flexWrap: "wrap",
          marginBottom: "var(--sb-space-4)",
        }}
      >
        <StatusPill code={info.status} label={batchStatusLabel(info.status)} />
        {info.operation_type !== null && <Stat label="Direção" value={operationTypeLabel(info.operation_type)} />}
        <Stat label="Número" value={info.document_number ?? "—"} />
        <Stat label="Série" value={info.series ?? "—"} />
        <Stat label="Emitido em" value={info.issue_date === null ? "—" : formatDateTime(info.issue_date)} />
        <Stat label="Itens" value={formatCount(info.total_items)} />
        <Stat label="Vinculados" value={formatCount(info.resolved_items)} />
      </div>

      <div
        style={{
          display: "grid",
          gap: "0.25rem",
          marginBottom: "var(--sb-space-4)",
          fontSize: "0.8125rem",
          color: "var(--sb-text-soft)",
        }}
      >
        {info.access_key !== null && (
          <div>
            Chave de acesso: <span style={{ fontFamily: "ui-monospace, monospace" }}>{info.access_key}</span>
          </div>
        )}
        {info.issuer_name !== null && (
          <div>
            Emitente: {info.issuer_name}
            {info.issuer_cnpj !== null && ` (${info.issuer_cnpj})`}
          </div>
        )}
        {info.recipient_name !== null && (
          <div>
            Destinatário: {info.recipient_name}
            {info.recipient_cnpj !== null && ` (${info.recipient_cnpj})`}
          </div>
        )}
      </div>

      {info.last_error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          {info.last_error}
        </p>
      )}

      {info.status === "PARSED" && (
        <ConfirmApplyForm
          documentId={info.id}
          totalItems={info.total_items ?? 0}
          resolvedItems={info.resolved_items ?? 0}
        />
      )}

      {items.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os itens: {items.error.message}
        </p>
      )}

      {items.error === null && items.data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "64rem" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: "3rem" }}>#</th>
                <th style={th}>Código no fornecedor</th>
                <th style={th}>Descrição</th>
                <th style={th}>Qtd</th>
                <th style={th}>Vlr. unit.</th>
                <th style={th}>Vlr. total</th>
                <th style={{ ...th, width: "18rem" }}>SKU vinculado</th>
              </tr>
            </thead>

            <tbody>
              {items.data.map((item) => (
                <tr key={item.id}>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{item.position + 1}</td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{item.supplier_code}</td>
                  <td style={td}>
                    {item.description}
                    {item.ean !== null && (
                      <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>EAN {item.ean}</div>
                    )}
                  </td>
                  <td style={td}>
                    {item.quantity} {item.unit}
                  </td>
                  <td style={td}>{formatCurrency(item.unit_value)}</td>
                  <td style={td}>{formatCurrency(item.total_value)}</td>
                  <td style={td}>
                    <DocumentItemRow
                      itemId={item.id}
                      documentId={info.id}
                      editable={editable}
                      linkedSku={item.skus ?? null}
                    />
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
