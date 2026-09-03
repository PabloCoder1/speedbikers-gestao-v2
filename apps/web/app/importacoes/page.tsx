import Link from "next/link";
import type { ReactNode } from "react";

import { StatusPill } from "../../components/status-pill";
import { Shell } from "../../components/shell";
import { formatCount, formatDateTime } from "../../lib/format";
import { sanitizeErrorText } from "../../lib/sanitize";
import { batchStatusLabel, kindLabel } from "../../lib/labels";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Importações — Speed Bikers Gestão" };

// A sessão vem de cookie: renderizar em build produziria a página de outra
// pessoa. Sem isto o Next tentaria pré-renderizar e falharia no deploy.
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

export default async function ImportacoesPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // Sem filtro por organização na consulta: a policy já restringe, e repetir a
  // condição aqui daria a impressão de que ela é a proteção — não é.
  const { data, error } = await supabase
    .from("erp_import_batches")
    .select(
      "id, kind, status, file_name, total_rows, ok_rows, skipped_rows, invalid_rows, created_at, last_error",
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
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>Importações</h1>

        <Link
          href="/importacoes/nova"
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
          Nova importação
        </Link>
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          Nenhum arquivo importado ainda. Envie uma exportação do UpSeller para começar.
        </p>
      )}

      {data !== null && data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "48rem" }}>
            <thead>
              <tr>
                <th style={th}>Arquivo</th>
                <th style={th}>Tipo</th>
                <th style={th}>Estado</th>
                <th style={th}>Linhas</th>
                <th style={th}>OK</th>
                <th style={th}>Ignoradas</th>
                <th style={th}>Inválidas</th>
                <th style={th}>Enviado em</th>
              </tr>
            </thead>

            <tbody>
              {data.map((batch) => (
                <tr key={batch.id}>
                  <td style={td}>
                    <Link href={`/importacoes/${batch.id}`}>{batch.file_name ?? batch.id}</Link>

                    {batch.last_error !== null && (
                      <div style={{ color: "var(--sb-danger)", fontSize: "0.75rem" }}>
                        {sanitizeErrorText(batch.last_error)}
                      </div>
                    )}
                  </td>
                  <td style={td}>{kindLabel(batch.kind)}</td>
                  <td style={td}>
                    <StatusPill code={batch.status} label={batchStatusLabel(batch.status)} />
                  </td>
                  <td style={td}>{formatCount(batch.total_rows)}</td>
                  <td style={td}>{formatCount(batch.ok_rows)}</td>
                  <td style={td}>{formatCount(batch.skipped_rows)}</td>
                  <td style={{ ...td, color: (batch.invalid_rows ?? 0) > 0 ? "var(--sb-danger)" : undefined }}>
                    {formatCount(batch.invalid_rows)}
                  </td>
                  <td style={td}>{formatDateTime(batch.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}
