import Link from "next/link";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { createClient } from "../../../lib/supabase/server";
import { KnowledgeRow, type KnowledgeRowData } from "./knowledge-row";
import { NewKnowledgeForm } from "./new-knowledge-form";

export const metadata = { title: "Base de Conhecimento — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Base de Conhecimento Validada (Fase 7B, D-071/D-113).
 *
 * Qualquer membro sugere; ADMIN/GESTOR validam. SÓ o que está VALIDADO vira
 * evidência do Copiloto na sugestão de resposta — a lista deixa os quatro
 * estados visíveis de propósito, porque rejeitar/obsoletar preserva o
 * histórico da decisão em vez de apagá-lo.
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


export default async function ConhecimentoPage(): Promise<ReactNode> {
  const supabase = await createClient();

  const [entriesResult, membershipResult] = await Promise.all([
    supabase
      .from("knowledge_entries")
      .select("id, kind, content, note, source, status, created_at, skus(sku)")
      .order("created_at", { ascending: false })
      .limit(200),
    supabase.from("organization_members").select("role").maybeSingle(),
  ]);

  const role = membershipResult.data?.role ?? null;
  const canManage = role === "ADMIN" || role === "GESTOR";

  const rows: KnowledgeRowData[] = (entriesResult.data ?? []).map(
    (row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      note: row.note,
      source: row.source,
      status: row.status,
      skuCode: row.skus?.sku ?? null,
      createdAt: row.created_at,
    }),
  );

  return (
    <Shell>
      <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem" }}>
        <Link href="/atendimento" style={{ color: "var(--sb-secondary)" }}>
          ← Caixa de Entrada
        </Link>
      </p>

      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Base de Conhecimento</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Fatos confirmados pela equipe. Só o que está <strong>Validado</strong> vira evidência para a
        sugestão de resposta do Copiloto — sugestões aguardam validação de ADMIN/GESTOR.
      </p>

      {entriesResult.error !== null ? (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar o conhecimento: {entriesResult.error.message}
        </p>
      ) : rows.length === 0 ? (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum conhecimento registrado ainda.</p>
      ) : (
        <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-5)" }}>
          <table style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead>
              <tr>
                <th style={th}>SKU</th>
                <th style={th}>Tipo</th>
                <th style={th}>Fato</th>
                <th style={th}>Fonte</th>
                <th style={th}>Registrado em</th>
                <th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => (
                <KnowledgeRow key={entry.id} entry={entry} canManage={canManage} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <section>
        <h2 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.0625rem" }}>Registrar conhecimento</h2>
        <NewKnowledgeForm />
      </section>
    </Shell>
  );
}
