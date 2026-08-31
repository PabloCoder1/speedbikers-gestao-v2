import Link from "next/link";
import type { ReactNode } from "react";

import { FILTER_SUBMIT_STYLE, FilterPill } from "../../components/filter-pill";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { formatCount, formatCurrency, formatDateTime, formatPercent } from "../../lib/format";
import { listingStatusLabel } from "../../lib/labels";
import {
  LINK_STATE_FILTERS,
  PAGE_SIZE,
  linkStateBadge,
  resolveLinkStateFilter,
  resolvePage,
  resolveStatusFilter,
  summarizeWindow,
} from "../../lib/listings-dashboard";
import { buildFilterHref } from "../../lib/filters";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Anúncios — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de apps/web/app/estoque/page.tsx.
export const dynamic = "force-dynamic";

/**
 * Dashboard de Anúncios (Fase 5C, D-138).
 *
 * **Deixou de ser lista e passou a responder perguntas**, que é o que
 * `docs/PRODUCT_REQUIREMENTS.md` pede: quais anúncios existem, em qual conta,
 * com qual SKU, quais venderam, quais não têm vínculo.
 *
 * 🔴 **A versão anterior mostrava 1.000 de 5.085 anúncios, em silêncio.** Lia
 * `from("listings").select(...).order("title")` sem `.range()`, e o PostgREST
 * corta em `max_rows = 1000` devolvendo `error` NULO — sexta ocorrência da
 * classe de D-131. Como ordenava por título, o que sobrevivia eram "os 1.000
 * primeiros no alfabeto".
 *
 * Agora o pivô, os filtros, a ordenação e a CONTAGEM vivem no Postgres
 * (`get_listings_dashboard`) e a tela lê uma janela declarada, exibindo
 * sempre "N de M" — mesmo precedente que D-131 usou em `/estoque`.
 */

const LOOKBACK_DAYS = 30;

interface DashboardRow {
  listing_id: string;
  item_id: string;
  title: string;
  status: string;
  price: number;
  available_quantity: number;
  synced_at: string;
  ml_account_id: string;
  account_label: string;
  sku_id: string | null;
  sku: string | null;
  link_state: string;
  units_sold: number;
  gross_revenue: number;
  visits: number | null;
  days_observed: number;
  conversion_rate: number | null;
  total_count: number;
}

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

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };


interface Filters {
  account: string | null;
  status: string | null;
  link: string;
  search: string | null;
  page: number;
}

/**
 * Preserva as outras dimensões ao trocar uma — mesmo `buildHref` de
 * `/vendas`. Trocar de conta NÃO pode resetar o filtro de vínculo.
 *
 * Qualquer mudança de filtro volta para a página 1: manter o offset seria
 * mostrar "página 7 de 2", ou pior, uma página vazia que parece "nenhum
 * resultado".
 */
function buildHref(current: Filters, override: Partial<Filters>): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/anuncios",
    {
      conta: next.account,
      estado: next.status,
      // "all" e o default do vinculo: fica fora da URL, como os demais.
      vinculo: next.link === "all" ? null : next.link,
      busca: next.search,
    },
    override.page === undefined ? 1 : next.page,
  );
}

export default async function AnunciosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  const membership = await supabase.from("organization_members").select("organization_id").maybeSingle();
  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Anúncios</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const accountsResult = await supabase.from("ml_accounts").select("id, slug, label").order("label");
  const accounts = accountsResult.data ?? [];

  const requestedAccount = typeof query.conta === "string" ? query.conta : null;
  const selectedAccount = accounts.find((a) => a.slug === requestedAccount) ?? null;

  const filters: Filters = {
    // Slug desconhecido cai em "todas as contas" em silêncio — mesmo
    // tratamento de `/vendas`, não é erro de rede nem de dado.
    account: selectedAccount?.slug ?? null,
    status: resolveStatusFilter(query.estado),
    link: resolveLinkStateFilter(query.vinculo),
    search: typeof query.busca === "string" && query.busca.trim() !== "" ? query.busca.trim() : null,
    page: resolvePage(query.pagina),
  };

  const { data, error } = await supabase.rpc("get_listings_dashboard", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: selectedAccount?.id ?? null,
    p_status: filters.status,
    p_link_state: filters.link,
    p_search: filters.search,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
  });

  const rows = (data ?? []) as DashboardRow[];
  // `total_count` vem repetido em toda linha (window function). Zero linhas
  // significa zero no conjunto filtrado — não há de onde ler o total, e é a
  // resposta certa.
  const totalCount = rows[0]?.total_count ?? 0;
  const window = summarizeWindow(filters.page, totalCount, rows.length);

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Anúncios</h1>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Catálogo real do Mercado Livre (D-121), sincronizado a cada 6h, com venda, visitas e conversão dos últimos{" "}
        {LOOKBACK_DAYS} dias. Anúncio sem vínculo aparece aqui — a fila de trabalho para vinculá-los está na Central
        de Vinculações.
      </p>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
        <span style={{ fontFamily: "ui-monospace, monospace" }}>visitas</span> ·{" "}
        <span style={{ fontFamily: "ui-monospace, monospace" }}>taxa_conversao</span> — a conversão usa como
        numerador os pedidos dos dias em que houve coleta de visitas (a coluna “obs.” mostra quantos foram), nunca a
        janela inteira sobre um denominador parcial. Sem visita observada a taxa fica “—”: indefinida, não 0%.
      </p>

      {/* Filtros. Todos na URL, para o link ser compartilhável e o voltar do navegador funcionar. */}
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-3)" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "4.5rem" }}>Conta</span>
          <FilterPill href={buildHref(filters, { account: null })} active={filters.account === null}>
            Todas
          </FilterPill>
          {accounts.map((account) => (
            <FilterPill
              key={account.id}
              href={buildHref(filters, { account: account.slug })} active={filters.account === account.slug}
            >
              {account.label}
            </FilterPill>
          ))}
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", alignItems: "center" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "4.5rem" }}>Vínculo</span>
          {LINK_STATE_FILTERS.map((option) => (
            <FilterPill
              key={option.key}
              href={buildHref(filters, { link: option.key })} active={filters.link === option.key}
            >
              {option.label}
            </FilterPill>
          ))}

          <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", marginLeft: "var(--sb-space-3)" }}>
            Estado
          </span>
          <FilterPill href={buildHref(filters, { status: null })} active={filters.status === null}>
            Todos
          </FilterPill>
          {["active", "paused", "closed"].map((status) => (
            <FilterPill
              key={status}
              href={buildHref(filters, { status })} active={filters.status === status}
            >
              {listingStatusLabel(status)}
            </FilterPill>
          ))}
        </div>

        <form method="get" style={{ display: "flex", gap: "0.375rem", alignItems: "center" }}>
          {/*
            Hidden para cada dimensão ativa: um GET nativo envia SÓ os campos
            do formulário, então sem isto buscar descartaria conta, vínculo e
            estado. Mesmo cuidado de `/vendas` (D-136).
          */}
          {filters.account !== null && <input type="hidden" name="conta" value={filters.account} />}
          {filters.status !== null && <input type="hidden" name="estado" value={filters.status} />}
          {filters.link !== "all" && <input type="hidden" name="vinculo" value={filters.link} />}
          <input
            type="search"
            name="busca"
            defaultValue={filters.search ?? ""}
            placeholder="SKU, MLB ou título"
            aria-label="Buscar por SKU, MLB ou título"
            style={{
              padding: "0.25rem 0.5rem",
              borderRadius: "var(--sb-radius)",
              border: "1px solid var(--sb-border)",
              fontSize: "0.8125rem",
              minWidth: "16rem",
            }}
          />
          <button type="submit" style={FILTER_SUBMIT_STYLE}>
            Buscar
          </button>
          {filters.search !== null && (
            <Link href={buildHref(filters, { search: null })} style={{ fontSize: "0.8125rem" }}>
              limpar
            </Link>
          )}
        </form>
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          {window.label}
        </p>
      )}

      {error === null && rows.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>Nenhum anúncio corresponde a estes filtros.</p>
      )}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "72rem" }}>
            <thead>
              <tr>
                <th style={th}>Anúncio</th>
                <th style={th}>SKU</th>
                <th style={th}>Conta</th>
                <th style={th}>Estado</th>
                <th style={th}>Preço</th>
                <th style={th}>Disponível</th>
                <th style={th}>Vendido ({LOOKBACK_DAYS}d)</th>
                <th style={th}>Receita ({LOOKBACK_DAYS}d)</th>
                <th style={th}>Visitas ({LOOKBACK_DAYS}d)</th>
                <th style={th}>Obs.</th>
                <th style={th}>Conversão</th>
                <th style={th}>Sincronizado em</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => {
                const badge = linkStateBadge(row.link_state);

                return (
                  <tr key={row.listing_id}>
                    <td style={td}>
                      {row.title}
                      <div
                        style={{
                          fontFamily: "ui-monospace, monospace",
                          color: "var(--sb-text-soft)",
                          fontSize: "0.75rem",
                        }}
                      >
                        {/* Dashboard 360º do anúncio (D-168) — o destino individual. */}
                        <Link href={`/anuncios/${row.item_id}`}>{row.item_id}</Link>
                      </div>
                    </td>
                    <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                      {row.sku_id !== null && row.sku !== null ? (
                        <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>
                      ) : (
                        <span style={{ color: badge.tone }} title={badge.hint}>
                          {badge.label}
                        </span>
                      )}
                    </td>
                    <td style={td}>{row.account_label}</td>
                    <td style={td}>
                      <StatusPill code={row.status} label={listingStatusLabel(row.status)} />
                    </td>
                    <td style={tdNumber}>{formatCurrency(row.price)}</td>
                    <td style={tdNumber}>{row.available_quantity}</td>
                    <td style={tdNumber}>{formatCount(row.units_sold)}</td>
                    <td style={tdNumber}>{formatCurrency(row.gross_revenue)}</td>
                    <td style={tdNumber}>{row.visits === null ? "—" : formatCount(row.visits)}</td>
                    {/*
                      Dias com coleta de visitas dentro da janela: é a base do
                      denominador, e sem ela a taxa ao lado seria lida como se
                      cobrisse os 30 dias.
                    */}
                    <td style={{ ...tdNumber, color: "var(--sb-text-soft)" }} title="Dias com visitas observadas na janela">
                      {row.days_observed === 0 ? "—" : `${String(row.days_observed)}/${String(LOOKBACK_DAYS)}`}
                    </td>
                    <td style={tdNumber}>{formatPercent(row.conversion_rate)}</td>
                    <td style={td}>{formatDateTime(row.synced_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error === null && window.totalPages > 1 && (
        <div
          style={{
            display: "flex",
            gap: "var(--sb-space-2)",
            alignItems: "center",
            marginTop: "var(--sb-space-3)",
            fontSize: "0.8125rem",
          }}
        >
          {filters.page > 1 && (
            <FilterPill href={buildHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          <span style={{ color: "var(--sb-text-soft)" }}>
            Página {filters.page} de {window.totalPages}
          </span>
          {filters.page < window.totalPages && (
            <FilterPill href={buildHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
