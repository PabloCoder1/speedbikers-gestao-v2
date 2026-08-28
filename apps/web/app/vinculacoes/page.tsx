import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatDateTime } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { CandidateRow } from "./candidate-row";
import { ManualLinkForm } from "./manual-link-form";

export const metadata = { title: "Central de Vinculações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Ver apps/web/app/importacoes/page.tsx para o mesmo raciocínio.
export const dynamic = "force-dynamic";

/**
 * Central de Vinculações (docs/PROMPT_MASTER.md secao 15).
 *
 * Lista candidatos `OPEN`: referências de anúncio cujo SKU ainda não existe no
 * catálogo. Match exato resolve sozinho quando o SKU aparece numa importação
 * futura (worker); esta tela cobre a confirmação humana para o resto.
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

function reference(row: {
  ref_kind: string;
  item_id: string | null;
  variation_id: string | null;
  user_product_id: string | null;
}): string {
  if (row.ref_kind === "USER_PRODUCT") return row.user_product_id ?? "—";

  return row.variation_id === null ? (row.item_id ?? "—") : `${row.item_id ?? "—"} · ${row.variation_id}`;
}

export default async function VinculacoesPage(): Promise<ReactNode> {
  const supabase = await createClient();

  // Sem filtro por organização: a policy já restringe
  // (link_candidates_select_permitted, has_account_access).
  const [{ data, error }, contas, manuais] = await Promise.all([
    supabase
      .from("link_candidates")
      .select("id, sku_key, ref_kind, item_id, variation_id, user_product_id, created_at, ml_accounts(label)")
      .eq("status", "OPEN")
      .order("created_at", { ascending: true })
      .limit(200),
    // Só as contas que o usuário alcança — a RLS de `ml_accounts` decide.
    supabase.from("ml_accounts").select("id, label").order("label"),
    // Leitura de volta: sem isto o operador vincula e não vê nada mudar em
    // lugar nenhum — o vínculo criado não entra na lista de candidatos.
    supabase
      .from("sku_listing_links")
      .select("id, item_id, variation_id, confirmed_at, skus(sku), ml_accounts(label)")
      .eq("source", "MANUAL")
      .order("confirmed_at", { ascending: false, nullsFirst: false })
      .limit(10),
  ]);

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1.375rem" }}>Central de Vinculações</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        A lista abaixo vem da importação do UpSeller: anúncios cuja planilha citou um SKU que ainda
        não existe no catálogo. <strong>Ela não conhece anúncios que só existem no Mercado Livre</strong> —
        para esses, use a vinculação manual.
      </p>

      {contas.error === null && contas.data.length > 0 && <ManualLinkForm accounts={contas.data} />}

      {contas.error === null && contas.data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          Você não alcança nenhuma conta Mercado Livre, então a vinculação manual não aparece — peça
          acesso a um ADMIN.
        </p>
      )}

      {contas.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar as contas: {contas.error.message}
        </p>
      )}

      {manuais.error === null && manuais.data.length > 0 && (
        <details style={{ marginBottom: "var(--sb-space-4)" }}>
          <summary style={{ cursor: "pointer", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Últimos {manuais.data.length} vínculos feitos à mão
          </summary>
          <ul style={{ margin: "var(--sb-space-2) 0 0", paddingLeft: "1.25rem", fontSize: "0.8125rem" }}>
            {manuais.data.map((link) => (
              <li key={link.id} style={{ marginBottom: "0.25rem" }}>
                <span style={{ fontFamily: "ui-monospace, monospace" }}>
                  {link.variation_id === null ? link.item_id : `${link.item_id ?? "—"} · ${link.variation_id}`}
                </span>{" "}
                → SKU <strong>{link.skus.sku}</strong> · {link.ml_accounts.label}
                {link.confirmed_at !== null && (
                  <span style={{ color: "var(--sb-text-soft)" }}> · {formatDateTime(link.confirmed_at)}</span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {manuais.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os vínculos manuais: {manuais.error.message}
        </p>
      )}

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum candidato pendente no momento.</p>
      )}

      {error === null && data.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "52rem" }}>
            <thead>
              <tr>
                <th style={th}>SKU do anúncio</th>
                <th style={th}>Loja</th>
                <th style={th}>Referência</th>
                <th style={th}>Pendente desde</th>
                <th style={{ ...th, width: "20rem" }}>Ação</th>
              </tr>
            </thead>

            <tbody>
              {data.map((row) => (
                <tr key={row.id}>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{row.sku_key}</td>
                  <td style={td}>{row.ml_accounts.label}</td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>{reference(row)}</td>
                  <td style={td}>{formatDateTime(row.created_at)}</td>
                  <td style={td}>
                    <CandidateRow candidateId={row.id} />
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
