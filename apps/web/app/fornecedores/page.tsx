import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Fornecedores — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
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

export default async function FornecedoresPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // Sem filtro por organização: a policy já restringe (suppliers_select_permitted).
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, name, legal_name, document, contact_name, phone, is_active")
    .order("name")
    .limit(200);

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
        <h1 style={{ margin: 0, fontSize: "1.375rem" }}>Fornecedores</h1>

        <Link
          href="/fornecedores/novo"
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
          Novo fornecedor
        </Link>
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum fornecedor cadastrado ainda.</p>
      )}

      {data !== null && data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "42rem" }}>
            <thead>
              <tr>
                <th style={th}>Nome</th>
                <th style={th}>Razão social</th>
                <th style={th}>Documento</th>
                <th style={th}>Contato</th>
                <th style={th}>Telefone</th>
                <th style={th}>Estado</th>
              </tr>
            </thead>

            <tbody>
              {data.map((supplier) => (
                <tr key={supplier.id}>
                  <td style={td}>
                    {/* Dashboard do fornecedor (D-174) — o destino individual. */}
                    <Link href={`/fornecedores/${supplier.id}`}>{supplier.name}</Link>
                  </td>
                  <td style={{ ...td, color: "var(--sb-text-soft)" }}>{supplier.legal_name ?? "—"}</td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{supplier.document ?? "—"}</td>
                  <td style={td}>{supplier.contact_name ?? "—"}</td>
                  <td style={td}>{supplier.phone ?? "—"}</td>
                  <td style={{ ...td, color: supplier.is_active ? undefined : "var(--sb-text-soft)" }}>
                    {supplier.is_active ? "Ativo" : "Inativo"}
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
