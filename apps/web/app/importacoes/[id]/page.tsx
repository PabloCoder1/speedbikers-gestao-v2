import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { formatCount, formatDateTime } from "../../../lib/format";
import { batchStatusLabel, kindLabel, rowStatusLabel } from "../../../lib/labels";
import { createClient } from "../../../lib/supabase/server";
import { summarize } from "./summarize";

export const dynamic = "force-dynamic";

/**
 * Tela de conferência.
 *
 * Terceira etapa do fluxo `upload -> parse -> CONFERÊNCIA -> aplicação`. Aqui
 * ninguém altera catálogo, vínculo nem estoque: mostra-se exatamente o que o
 * arquivo produziu, para um humano decidir antes de acontecer.
 *
 * A ordem padrão é por linha, e não por status, porque quem confere está com a
 * planilha aberta ao lado — a linha 4.312 aqui tem que ser a linha 4.312 lá.
 */

const PAGE_SIZE = 100;

const FILTERS = [
  { key: "all", label: "Todas" },
  { key: "INVALID", label: "Inválidas" },
  { key: "SKIPPED", label: "Ignoradas" },
  { key: "OK", label: "OK" },
] as const;

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

export default async function ConferenciaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { id } = await params;
  const query = await searchParams;

  const filter = typeof query.status === "string" ? query.status : "all";
  const page = Math.max(1, Number(typeof query.page === "string" ? query.page : "1") || 1);

  const supabase = await createClient();

  const batch = await supabase
    .from("erp_import_batches")
    .select(
      "id, kind, status, file_name, total_rows, ok_rows, skipped_rows, invalid_rows, parsed_at, last_error",
    )
    .eq("id", id)
    .maybeSingle();

  // `null` aqui pode ser "não existe" ou "a policy escondeu". A tela responde
  // igual nos dois casos de propósito: confirmar a existência de um lote de
  // outra organização já é vazamento.
  if (batch.error !== null || batch.data === null) {
    notFound();
  }

  // Copia local: dentro de um callback o TypeScript descarta o estreitamento de
  // uma propriedade, porque nada garante que ela nao mudou nesse meio-tempo.
  const info = batch.data;

  const from = (page - 1) * PAGE_SIZE;

  let rowsQuery = supabase
    .from("erp_import_rows")
    .select("row_number, status, reason, sku_key, payload", { count: "exact" })
    .eq("batch_id", id);

  if (filter !== "all") {
    rowsQuery = rowsQuery.eq("status", filter);
  }

  const rows = await rowsQuery.order("row_number").range(from, from + PAGE_SIZE - 1);

  const total = rows.count ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function href(next: { status?: string; page?: number }): string {
    const search = new URLSearchParams();
    const status = next.status ?? filter;
    const target = next.page ?? 1;

    if (status !== "all") search.set("status", status);
    if (target > 1) search.set("page", String(target));

    const qs = search.toString();

    return qs === "" ? `/importacoes/${id}` : `/importacoes/${id}?${qs}`;
  }

  return (
    <Shell>
      <p style={{ margin: 0, fontSize: "0.875rem" }}>
        <Link href="/importacoes">← Importações</Link>
      </p>

      <h1 style={{ margin: "var(--sb-space-2) 0", fontSize: "1.375rem" }}>
        {info.file_name ?? info.id}
      </h1>

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
        <Stat label="Tipo" value={kindLabel(info.kind)} />
        <Stat label="Linhas" value={formatCount(info.total_rows)} />
        <Stat label="OK" value={formatCount(info.ok_rows)} />
        <Stat label="Ignoradas" value={formatCount(info.skipped_rows)} />
        <Stat label="Inválidas" value={formatCount(info.invalid_rows)} />
        <Stat label="Lido em" value={formatDateTime(info.parsed_at)} />
      </div>

      {info.last_error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          {info.last_error}
        </p>
      )}

      <div style={{ display: "flex", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-3)" }}>
        {FILTERS.map((option) => (
          <Link
            key={option.key}
            href={href({ status: option.key, page: 1 })}
            style={{
              padding: "0.25rem 0.75rem",
              borderRadius: "999px",
              border: "1px solid var(--sb-border)",
              fontSize: "0.8125rem",
              textDecoration: "none",
              background: filter === option.key ? "var(--sb-primary)" : "transparent",
              color: filter === option.key ? "var(--sb-white)" : "var(--sb-text-soft)",
            }}
          >
            {option.label}
          </Link>
        ))}
      </div>

      {rows.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar as linhas: {rows.error.message}
        </p>
      )}

      {rows.error === null && rows.data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhuma linha neste filtro.</p>
      )}

      {rows.error === null && rows.data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "42rem" }}>
            <thead>
              <tr>
                <th style={{ ...th, width: "5rem" }}>Linha</th>
                <th style={{ ...th, width: "7rem" }}>Estado</th>
                <th style={th}>SKU</th>
                <th style={th}>Conteúdo lido</th>
              </tr>
            </thead>

            <tbody>
              {rows.data.map((row) => (
                <tr key={row.row_number}>
                  <td style={{ ...td, fontVariantNumeric: "tabular-nums" }}>{row.row_number}</td>
                  <td style={td}>
                    <StatusPill code={row.status} label={rowStatusLabel(row.status)} />
                  </td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    {row.sku_key ?? "—"}
                  </td>
                  <td
                    style={{
                      ...td,
                      color: row.reason === null ? undefined : "var(--sb-text-soft)",
                    }}
                  >
                    {row.reason ?? summarize(info.kind, row.payload)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 && (
        <nav
          style={{
            display: "flex",
            gap: "var(--sb-space-3)",
            alignItems: "center",
            marginTop: "var(--sb-space-3)",
            fontSize: "0.875rem",
          }}
        >
          {page > 1 && <Link href={href({ page: page - 1 })}>← Anterior</Link>}

          <span style={{ color: "var(--sb-text-soft)" }}>
            Página {formatCount(page)} de {formatCount(lastPage)} · {formatCount(total)} linhas
          </span>

          {page < lastPage && <Link href={href({ page: page + 1 })}>Próxima →</Link>}
        </nav>
      )}
    </Shell>
  );
}
