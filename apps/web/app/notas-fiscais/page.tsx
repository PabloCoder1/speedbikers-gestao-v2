import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { formatCount, formatDateTime } from "../../lib/format";
import { batchStatusLabel, operationTypeLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Notas Fiscais — Speed Bikers Gestão" };

// A sessão vem de cookie: renderizar em build produziria a página de outra
// pessoa. Mesmo raciocínio de apps/web/app/importacoes/page.tsx.
export const dynamic = "force-dynamic";

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
};

export default async function NotasFiscaisPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // Sem filtro por organização na consulta: a policy já restringe
  // (documents_select_admin), e repetir a condição aqui daria a impressão de
  // que ela é a proteção — não é.
  const { data, error } = await supabase
    .from("documents")
    .select(
      "id, file_name, status, operation_type, document_number, issuer_name, total_items, resolved_items, created_at, last_error",
    )
    .order("created_at", { ascending: false })
    .limit(50);

  return (
    <Shell>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--sb-space-3)",
          marginBottom: "var(--sb-space-4)",
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>Notas Fiscais</h1>

        <Link
          href="/notas-fiscais/nova"
          style={{
            marginLeft: "auto",
            padding: "0.5rem 0.875rem",
            borderRadius: "var(--sb-radius)",
            background: "var(--sb-primary)",
            color: "var(--sb-white)",
            textDecoration: "none",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          Enviar NF-e
        </Link>
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          Nenhuma nota fiscal enviada ainda. Envie o XML de uma compra ou saída para começar.
        </p>
      )}

      {data !== null && data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "52rem" }}>
            <thead>
              <tr>
                <th style={th}>Arquivo</th>
                <th style={th}>Número</th>
                <th style={th}>Direção</th>
                <th style={th}>Emitente</th>
                <th style={th}>Estado</th>
                <th style={th}>Itens vinculados</th>
                <th style={th}>Enviado em</th>
              </tr>
            </thead>

            <tbody>
              {data.map((document) => (
                <tr key={document.id}>
                  <td style={td}>
                    <Link href={`/notas-fiscais/${document.id}`}>{document.file_name ?? document.id}</Link>

                    {document.last_error !== null && (
                      <div style={{ color: "var(--sb-danger)", fontSize: "0.75rem" }}>{document.last_error}</div>
                    )}
                  </td>
                  <td style={td}>{document.document_number ?? "—"}</td>
                  <td style={td}>{document.operation_type === null ? "—" : operationTypeLabel(document.operation_type)}</td>
                  <td style={td}>{document.issuer_name ?? "—"}</td>
                  <td style={td}>
                    <StatusPill code={document.status} label={batchStatusLabel(document.status)} />
                  </td>
                  <td style={td}>
                    {document.total_items === null
                      ? "—"
                      : `${formatCount(document.resolved_items)} de ${formatCount(document.total_items)}`}
                  </td>
                  <td style={td}>{formatDateTime(document.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
