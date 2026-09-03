import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { formatDateTime } from "../../../lib/format";
import { createClient } from "../../../lib/supabase/server";
import { createSetting, deleteSetting, updateSetting } from "./actions";
import { currentMembership } from "../../../lib/membership";

export const metadata = { title: "Configuração de Reposição — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Configuração de reposição (D-144) — a fundação da Fase 5D.
 *
 * Três escopos, o mais específico vence: SKU > marca do fornecedor > padrão
 * da organização. **Zero linhas semeadas**: configurar é ato humano
 * (precedente D-127/D-133), e enquanto não houver configuração aplicável a
 * sugestão de compra RECUSA número em vez de inventar default.
 *
 * O PRD dá referências, e elas aparecem AQUI como texto — nunca como valor
 * pré-preenchido: ~90 dias de cobertura para importação, ~15 dias de lead
 * para nacional. Referência é o que o ADMIN digita, não o que o código assume.
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
  verticalAlign: "middle",
};

const inputStyle: React.CSSProperties = {
  padding: "0.25rem 0.5rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  fontSize: "0.8125rem",
  width: "5rem",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.25rem 0.625rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  background: "transparent",
  color: "var(--sb-text-soft)",
  fontSize: "0.8125rem",
  cursor: "pointer",
};

interface SettingRow {
  id: string;
  supplier_brand: string | null;
  sku_id: string | null;
  lead_time_days: number;
  target_coverage_days: number;
  safety_stock_days: number;
  max_coverage_days: number | null;
  policy_note: string | null;
  updated_at: string;
  skus: { sku: string } | null;
}

function scopeLabel(row: SettingRow): string {
  if (row.sku_id !== null) return `SKU ${row.skus?.sku ?? row.sku_id}`;
  if (row.supplier_brand !== null) return `Marca ${row.supplier_brand}`;

  return "Padrão da organização";
}

export default async function ReposicaoConfigPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const actionError = typeof query.erro === "string" ? query.erro : null;
  const supabase = await createClient();

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;
  const role = membership.role;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Configuração de Reposição</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const canWrite = role === "ADMIN" || role === "GESTOR";

  const [settingsResult, brandsResult] = await Promise.all([
    supabase
      .from("replenishment_settings")
      .select(
        "id, supplier_brand, sku_id, lead_time_days, target_coverage_days, safety_stock_days, max_coverage_days, policy_note, updated_at, skus(sku)",
      )
      .order("supplier_brand", { ascending: true, nullsFirst: true }),
    // D-194: ver o comentário equivalente em `/reposicao`.
    supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
  ]);

  const rows = (settingsResult.data ?? []) as SettingRow[];
  // Sem `Set` e sem filtro de nulo: a RPC já devolve distintas e não-nulas.
  const brands = (brandsResult.data ?? []).map((r) => r.supplier_brand);
  const configuredBrands = new Set(rows.map((r) => r.supplier_brand).filter((b) => b !== null));
  const error = settingsResult.error ?? brandsResult.error;

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Configuração de Reposição</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Prazo de reposição, cobertura desejada e estoque de segurança — por marca do fornecedor ou como padrão da
        organização; o escopo mais específico vence. A sugestão de compra só produz número para SKU com configuração
        aplicável. <strong>Prazo não é cobertura</strong>: a compra precisa cobrir o prazo <em>mais</em> a cobertura
        desejada — referências usuais da operação: ~90 dias de cobertura para importação, ~15 dias de prazo para
        nacional.
      </p>

      {actionError !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          {actionError}
        </p>
      )}

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && rows.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)", marginBottom: "var(--sb-space-3)" }}>
          Nenhuma configuração ainda — e, de propósito, nada vem preenchido de fábrica. Enquanto isso, a sugestão de
          compra fica indisponível para todos os SKUs.
        </p>
      )}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto", marginBottom: "var(--sb-space-4)" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "56rem" }}>
            <thead>
              <tr>
                <th style={th}>Escopo</th>
                <th style={th}>Prazo (dias)</th>
                <th style={th}>Cobertura (dias)</th>
                <th style={th}>Segurança (dias)</th>
                <th style={th} title="O buffer máximo: cobertura acima disso é EXCESSO. Vazio = excesso nunca é afirmado.">
                  Teto (dias)
                </th>
                <th style={th}>Nota</th>
                <th style={th}>Atualizado</th>
                {canWrite && <th style={th}></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td style={{ ...td, fontWeight: 600 }}>{scopeLabel(row)}</td>
                  {canWrite ? (
                    <td style={td} colSpan={4}>
                      {/*
                        Editar é um form por linha: os quatro números mudam, o
                        ESCOPO nunca — mudar a marca de uma regra existente
                        re-atribuiria a política de outro conjunto de SKUs em
                        silêncio (identidade fixa, mesmo desenho de D-076).
                      */}
                      <form action={updateSetting} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        <input type="hidden" name="id" value={row.id} />
                        <input
                          type="number"
                          name="lead_time_days"
                          defaultValue={row.lead_time_days}
                          aria-label="Prazo de reposição em dias"
                          style={inputStyle}
                          min={1}
                          max={365}
                        />
                        <input
                          type="number"
                          name="target_coverage_days"
                          defaultValue={row.target_coverage_days}
                          aria-label="Cobertura desejada em dias"
                          style={inputStyle}
                          min={1}
                          max={365}
                        />
                        <input
                          type="number"
                          name="safety_stock_days"
                          defaultValue={row.safety_stock_days}
                          aria-label="Estoque de segurança em dias"
                          style={inputStyle}
                          min={0}
                          max={365}
                        />
                        <input
                          type="number"
                          name="max_coverage_days"
                          defaultValue={row.max_coverage_days ?? ""}
                          aria-label="Teto de cobertura em dias (buffer máximo, opcional)"
                          placeholder="teto"
                          style={inputStyle}
                          min={1}
                          max={1095}
                        />
                        <button type="submit" style={buttonStyle}>
                          Salvar
                        </button>
                      </form>
                    </td>
                  ) : (
                    <>
                      <td style={td}>{row.lead_time_days}</td>
                      <td style={td}>{row.target_coverage_days}</td>
                      <td style={td}>{row.safety_stock_days}</td>
                      <td style={td}>{row.max_coverage_days ?? "—"}</td>
                    </>
                  )}
                  <td style={{ ...td, color: "var(--sb-text-soft)", maxWidth: "16rem" }}>{row.policy_note ?? "—"}</td>
                  <td style={{ ...td, whiteSpace: "nowrap", color: "var(--sb-text-soft)" }}>
                    {formatDateTime(row.updated_at)}
                  </td>
                  {canWrite && (
                    <td style={td}>
                      <form action={deleteSetting}>
                        <input type="hidden" name="id" value={row.id} />
                        <button type="submit" style={{ ...buttonStyle, color: "var(--sb-danger)" }}>
                          Remover
                        </button>
                      </form>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canWrite && (
        <>
          <h2 style={{ fontSize: "1.0625rem", margin: "0 0 var(--sb-space-2)" }}>Nova configuração</h2>

          <form
            action={createSetting}
            style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "flex-end" }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
              Escopo
              <select name="supplier_brand" style={{ ...inputStyle, width: "14rem" }}>
                <option value="">Padrão da organização</option>
                {brands.map((brand) => (
                  <option key={brand} value={brand} disabled={configuredBrands.has(brand)}>
                    {brand}
                    {configuredBrands.has(brand) ? " (já configurada)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
              Prazo (dias)
              <input type="number" name="lead_time_days" style={inputStyle} min={1} max={365} required />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
              Cobertura (dias)
              <input type="number" name="target_coverage_days" style={inputStyle} min={1} max={365} required />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
              Segurança (dias)
              <input type="number" name="safety_stock_days" style={inputStyle} min={0} max={365} defaultValue={0} />
            </label>
            <label
              style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}
              title="Cobertura acima disso é EXCESSO. Vazio = excesso nunca é afirmado. Precisa ser ≥ prazo + cobertura + segurança."
            >
              Teto (dias, opcional)
              <input type="number" name="max_coverage_days" style={inputStyle} min={1} max={1095} />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem", fontSize: "0.75rem" }}>
              Nota (opcional)
              <input type="text" name="policy_note" style={{ ...inputStyle, width: "18rem" }} maxLength={500} />
            </label>
            <button type="submit" style={buttonStyle}>
              Criar
            </button>
          </form>
        </>
      )}

      {!canWrite && (
        <p style={{ color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
          Somente ADMIN e GESTOR alteram a configuração de reposição.
        </p>
      )}
    </Shell>
  );
}
