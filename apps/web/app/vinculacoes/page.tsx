import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatDateTime } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { CandidateRow } from "./candidate-row";

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
  const { data, error } = await supabase
    .from("link_candidates")
    .select("id, sku_key, ref_kind, item_id, variation_id, user_product_id, created_at, ml_accounts(label)")
    .eq("status", "OPEN")
    .order("created_at", { ascending: true })
    .limit(200);

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1.375rem" }}>Central de Vinculações</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Anúncios cujo SKU ainda não existe no catálogo. Quando o SKU aparecer numa importação
        futura, o vínculo se resolve sozinho — o que sobra aqui precisa de uma decisão manual.
      </p>

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
