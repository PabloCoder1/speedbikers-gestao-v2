import type { ReactNode } from "react";

import { Shell } from "../../components/shell";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
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

const tdNumber: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
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

export default async function VinculacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const supabase = await createClient();
  const params = await searchParams;

  const primeiro = (chave: string): string => {
    const valor = params[chave];

    return typeof valor === "string" ? valor : "";
  };

  // Padrão é SÓ ATIVOS: pausado é fila legítima, mas não é o trabalho do dia.
  const statusFiltro = primeiro("estado") === "todos" ? null : "active";

  const membership = await supabase
    .from("organization_members")
    .select("organization_id")
    .limit(1)
    .maybeSingle();

  const organizationId = membership.data?.organization_id ?? null;

  // Sem filtro por organização: a policy já restringe
  // (link_candidates_select_permitted, has_account_access).
  const [{ data, error }, contas, manuais, semVinculo, integridade] = await Promise.all([
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
    organizationId === null
      ? Promise.resolve({ data: [], error: null })
      : supabase.rpc("get_unlinked_listings", {
          p_organization_id: organizationId,
          p_days: 30,
          p_limit: 100,
          // `exactOptionalPropertyTypes`: omitir é diferente de mandar undefined,
          // e a função trata `null` como "todos os estados".
          ...(statusFiltro === null ? {} : { p_status: statusFiltro }),
        }),
    organizationId === null
      ? Promise.resolve({ data: [], error: null })
      : supabase.rpc("get_link_integrity", { p_organization_id: organizationId, p_days: 90 }),
  ]);

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1.375rem" }}>Central de Vinculações</h1>

      <p style={{ margin: "0 0 var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
        Duas listas: <strong>anúncios sem vínculo</strong>, vindos do catálogo real do Mercado Livre (D-121),
        e os <strong>candidatos da importação do UpSeller</strong> — planilha que citou um SKU inexistente no
        catálogo. São filas diferentes, com origens diferentes.
      </p>

      {integridade.error === null && integridade.data.length > 0 && (
        <section style={{ marginBottom: "var(--sb-space-4)" }}>
          <h2 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1rem" }}>Integridade por conta</h2>

          <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            A última coluna é a que vale: <strong>ela não vem deste pipeline</strong>. Um anúncio que gerou pedido
            existe, independentemente do que a nossa varredura conheça. Se ela discordar da fila de candidatos, o
            problema está no pipeline — não no número.
          </p>

          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "52rem" }}>
              <thead>
                <tr>
                  <th style={th}>Conta</th>
                  <th style={{ ...th, textAlign: "right" }}>Anúncios</th>
                  <th style={{ ...th, textAlign: "right" }}>Vinculados</th>
                  <th style={{ ...th, textAlign: "right" }}>Sem vínculo</th>
                  <th style={{ ...th, textAlign: "right" }}>% vinculado</th>
                  <th style={{ ...th, textAlign: "right" }}>Candidatos abertos</th>
                  <th style={{ ...th, textAlign: "right" }}>Venderam sem vínculo (90d)</th>
                </tr>
              </thead>

              <tbody>
                {integridade.data.map((linha) => (
                  <tr key={linha.ml_account_id}>
                    <td style={td}>{linha.account_label}</td>
                    <td style={tdNumber}>{formatCount(linha.listings_total)}</td>
                    <td style={tdNumber}>{formatCount(linha.com_vinculo)}</td>
                    <td style={tdNumber}>{formatCount(linha.sem_vinculo)}</td>
                    <td style={tdNumber}>{linha.listings_total === 0 ? "—" : `${String(linha.pct_vinculado)}%`}</td>
                    <td style={tdNumber}>{formatCount(linha.candidatos_abertos)}</td>
                    <td style={tdNumber}>
                      {linha.vendidos_sem_vinculo > 0 ? (
                        <strong style={{ color: "var(--sb-danger)" }}>
                          {formatCount(linha.vendidos_sem_vinculo)}
                        </strong>
                      ) : (
                        formatCount(0)
                      )}
                      <div style={{ color: "var(--sb-text-soft)", fontSize: "0.75rem", fontWeight: 400 }}>
                        {formatCurrency(linha.receita_sem_vinculo)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {integridade.data.some((l) => l.vendidos_sem_vinculo > 0 && l.candidatos_abertos === 0) && (
            <p style={{ margin: "var(--sb-space-2) 0 0", fontSize: "0.8125rem", color: "var(--sb-danger)" }}>
              <strong>Divergência:</strong> há anúncio que vendeu sem vínculo e a fila de candidatos está vazia. É
              exatamente o caso que D-117 mediu — a fila nunca soube desses anúncios, porque o gerador de candidatos
              só conhece a planilha do UpSeller. Use a lista abaixo.
            </p>
          )}
        </section>
      )}

      {integridade.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar a integridade: {integridade.error.message}
        </p>
      )}

      {contas.error === null && contas.data.length > 0 && <ManualLinkForm
          accounts={contas.data}
          initialAccountId={primeiro("conta")}
          initialItemId={primeiro("item")}
        />}

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

      {semVinculo.error === null && semVinculo.data.length > 0 && (
        <section style={{ marginBottom: "var(--sb-space-4)" }}>
          <h2 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1rem" }}>
            Anúncios sem vínculo{" "}
            <span style={{ color: "var(--sb-text-soft)", fontWeight: 400, fontSize: "0.875rem" }}>
              — {formatCount(semVinculo.data.length)} de {formatCount(semVinculo.data[0]?.total_count ?? 0)}
              {statusFiltro === null ? " (todos os estados)" : " ativos"}
            </span>
          </h2>

          <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
            Anúncios do catálogo do Mercado Livre que não têm vínculo em <strong>nenhuma forma</strong> — nem por
            anúncio inteiro, nem por variação. Ordenados por receita dos últimos 30 dias, porque o que importa é o
            anúncio que vende sem estar vinculado.{" "}
            <a href={statusFiltro === null ? "/vinculacoes" : "/vinculacoes?estado=todos"}>
              {statusFiltro === null ? "Ver só os ativos" : "Ver todos os estados"}
            </a>
          </p>

          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "52rem" }}>
              <thead>
                <tr>
                  <th style={th}>Anúncio</th>
                  <th style={th}>Loja</th>
                  <th style={th}>Estado</th>
                  <th style={{ ...th, textAlign: "right" }}>Receita (30d)</th>
                  <th style={{ ...th, textAlign: "right" }}>Vendido</th>
                  <th style={th}>Ação</th>
                </tr>
              </thead>

              <tbody>
                {semVinculo.data.map((row) => (
                  <tr key={`${row.ml_account_id}:${row.item_id}`}>
                    <td style={td}>
                      {row.title}
                      <div style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
                        {row.item_id}
                      </div>
                    </td>
                    <td style={td}>{row.account_label}</td>
                    <td style={td}>{row.status}</td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {formatCurrency(row.gross_revenue)}
                    </td>
                    <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {formatCount(row.units_sold)}
                    </td>
                    <td style={td}>
                      {/* Pré-preenche o formulário acima pela URL — mesmo padrão de
                          filtro na URL do resto do app, sem estado novo. */}
                      <a href={`/vinculacoes?conta=${row.ml_account_id}&item=${row.item_id}`}>Vincular</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {semVinculo.error === null && semVinculo.data.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          Nenhum anúncio {statusFiltro === null ? "" : "ativo "}sem vínculo — todo anúncio do catálogo alcança um SKU.
        </p>
      )}

      {semVinculo.error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os anúncios sem vínculo: {semVinculo.error.message}
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
