import type { ReactNode } from "react";

import Link from "next/link";

import { FILTER_SUBMIT_STYLE, FilterPill } from "../../components/filter-pill";
import { Shell } from "../../components/shell";
import { formatCurrency, formatDateTime, formatPercent } from "../../lib/format";
import { listingStatusLabel } from "../../lib/labels";
import {
  PAGE_SIZE,
  PRICE_DIRECTIONS,
  buildPriceHref,
  priceDirectionLabel,
  resolvePriceFilters,
  summarizePagedWindow,
} from "../../lib/price-filters";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Preços — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Central de Preços (D-172, trilha 5E) — primeira versão.
 *
 * As mudanças de preço já eram registradas em `domain_events`
 * (`listing.price.changed`, a cada varredura de anúncios) e não apareciam em
 * lugar nenhum: "que preços mudaram esta semana?" exigia SQL na mão.
 *
 * **O que esta tela NÃO faz, de propósito:** o item do ROADMAP pede análise
 * antes/depois e "impacto observado". A série começa em 24/08/2026 e as
 * visitas por anúncio são esporádicas (média de 4,9 dias observados em 31,
 * medido em D-170) — não existe janela comparável dos dois lados de cada
 * mudança. Afirmar impacto sobre isso seria a atribuição causal indevida que
 * o próprio item lista como risco. A tela mostra O QUE mudou e deixa o
 * porquê e o efeito para quem tem contexto: o histórico, aqui, é evidência,
 * não explicação.
 */

const LOOKBACK_DAYS = 30;

/**
 * Primeiro `listing.price.changed` observado — a série não existe antes
 * disso. Em DIA CIVIL já formatado: passar por `new Date(...)` deslocaria
 * para 23/08 (meia-noite UTC é 21h do dia anterior em São Paulo), o mesmo
 * erro de fuso que a casa proíbe em data de negócio.
 */
const SERIES_START_LABEL = "24/08/2026";


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

const tdNumber: React.CSSProperties = { ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" };

export default async function PrecosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const filters = resolvePriceFilters(query);

  // O `.eq("organization_id", ...)` que morava aqui era REDUNDANTE, e o preço
  // dele era um nível inteiro de latência (D-197). A policy de `ml_accounts` é
  // `id in (select private.accessible_accounts())`, e essa função junta
  // `organization_members` por `auth.uid()`: a RLS já restringe por
  // organização **e** por permissão de conta — estritamente mais estreita que
  // o filtro manual. O filtro não removia uma linha sequer; só amarrava esta
  // leitura à anterior, obrigando três latências em fila onde duas bastam.
  //
  // É como `/vendas`, `/anuncios`, `/curva-abc`, `/atendimento` e
  // `/vinculacoes` já liam. A RPC abaixo continua depois — ela SIM depende da
  // conta escolhida.
  const [membership, accounts] = await Promise.all([
    supabase.from("organization_members").select("organization_id").maybeSingle(),
    supabase.from("ml_accounts").select("id, label").order("label"),
  ]);

  const organizationId = membership.data?.organization_id ?? null;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Preços</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  // Conta desconhecida (ou de outra organização) na URL vira "sem filtro"
  // antes de tocar a RPC — mesma regra dos conjuntos fechados.
  const accountIds = new Set((accounts.data ?? []).map((row) => row.id));
  const account = filters.account !== null && accountIds.has(filters.account) ? filters.account : null;

  // O usuário filtra por DIA; o evento tem hora. `ate` é inclusivo na tela e
  // vira o início do dia seguinte na consulta — o intervalo é `[de, ate)`.
  const now = new Date();
  const defaultFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);
  const dateFrom = filters.dateFrom ?? defaultFrom;
  const dateTo = filters.dateTo;

  const { data, error } = await supabase.rpc("get_price_changes", {
    p_organization_id: organizationId,
    p_date_from: `${dateFrom}T00:00:00Z`,
    p_date_to:
      dateTo === null
        ? new Date(now.getTime() + 86_400_000).toISOString()
        : new Date(new Date(`${dateTo}T00:00:00Z`).getTime() + 86_400_000).toISOString(),
    p_ml_account_id: account,
    p_direction: filters.direction,
    p_search: filters.search,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
  });

  const rows = data ?? [];
  const totalCount = rows[0]?.total_count ?? 0;
  const window = summarizePagedWindow({
    page: filters.page,
    totalCount,
    rowsOnPage: rows.length,
    pageSize: PAGE_SIZE,
    // `summarizePagedWindow` não flexiona número (as demais telas exibem "1
    // anúncios"); aqui o singular é resolvido antes de entrar. Corrigir o
    // helper para todas as telas é fatia própria.
    noun: totalCount === 1 ? "mudança de preço" : "mudanças de preço",
    emptyLabel: "Nenhuma mudança de preço encontrada com estes filtros.",
  });

  return (
    <Shell>
      <h1 style={{ margin: "0 0 var(--sb-space-2)", fontSize: "1.375rem" }}>Preços</h1>

      <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        Toda mudança de preço observada nos seus anúncios, com o valor anterior, o novo e quando aconteceu. A
        varredura de anúncios roda a cada 6h — uma mudança feita e desfeita entre duas varreduras não aparece
        aqui.
      </p>

      <p style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.75rem", color: "var(--sb-muted-ink)" }}>
        O registro começa em {SERIES_START_LABEL} — antes disso não há histórico, e ausência de linha não
        significa preço estável. <strong>Esta versão não afirma impacto</strong>:
        comparar venda antes e depois exigiria janela comparável dos dois lados de cada mudança, que a série
        ainda não tem.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-2)" }}>
        <FilterPill href={buildPriceHref(filters, { direction: null })} active={filters.direction === null}>
          Todas
        </FilterPill>
        {PRICE_DIRECTIONS.map((direction) => (
          <FilterPill
            key={direction}
            href={buildPriceHref(filters, { direction })}
            active={filters.direction === direction}
          >
            {priceDirectionLabel(direction)}
          </FilterPill>
        ))}

        <span style={{ color: "var(--sb-border)" }}>|</span>

        <FilterPill href={buildPriceHref(filters, { account: null })} active={account === null}>
          Todas as contas
        </FilterPill>
        {(accounts.data ?? []).map((row) => (
          <FilterPill key={row.id} href={buildPriceHref(filters, { account: row.id })} active={account === row.id}>
            {row.label}
          </FilterPill>
        ))}
      </div>

      <form
        method="get"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "0.375rem",
          marginBottom: "var(--sb-space-3)",
          fontSize: "0.8125rem",
        }}
      >
        {/* GET nativo só envia os campos do form — preservar as dimensões de pill. */}
        {filters.direction !== null && <input type="hidden" name="direcao" value={filters.direction} />}
        {account !== null && <input type="hidden" name="conta" value={account} />}
        <input
          type="search"
          name="busca"
          defaultValue={filters.search ?? ""}
          placeholder="MLB, SKU ou título"
          aria-label="Buscar por MLB, SKU ou título"
          style={{
            padding: "0.25rem 0.5rem",
            borderRadius: "var(--sb-radius)",
            border: "1px solid var(--sb-border)",
            fontSize: "0.8125rem",
            minWidth: "14rem",
          }}
        />
        <input
          type="date"
          name="de"
          defaultValue={filters.dateFrom ?? undefined}
          aria-label="Data inicial"
          style={{ padding: "0.25rem 0.5rem", borderRadius: "var(--sb-radius)", border: "1px solid var(--sb-border)", fontSize: "0.8125rem" }}
        />
        <span style={{ color: "var(--sb-text-soft)" }}>até</span>
        <input
          type="date"
          name="ate"
          defaultValue={filters.dateTo ?? undefined}
          aria-label="Data final"
          style={{ padding: "0.25rem 0.5rem", borderRadius: "var(--sb-radius)", border: "1px solid var(--sb-border)", fontSize: "0.8125rem" }}
        />
        <button type="submit" style={FILTER_SUBMIT_STYLE}>
          Filtrar
        </button>
      </form>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar as mudanças de preço: {error.message}
        </p>
      )}

      {error === null && (
        <p style={{ margin: "0 0 var(--sb-space-2)", fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          {window.label}
        </p>
      )}

      {error === null && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: "58rem" }}>
            <thead>
              <tr>
                <th style={th}>Quando</th>
                <th style={th}>Anúncio</th>
                <th style={th}>SKU</th>
                <th style={th}>Conta</th>
                <th style={{ ...th, textAlign: "right" }}>De</th>
                <th style={{ ...th, textAlign: "right" }}>Para</th>
                <th style={{ ...th, textAlign: "right" }}>Δ</th>
                <th style={{ ...th, textAlign: "right" }}>Δ %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const subiu = row.delta > 0;

                return (
                  <tr key={row.event_id}>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{formatDateTime(row.occurred_at)}</td>
                    <td style={td}>
                      {/* Título ausente = anúncio saiu do catálogo depois do
                          evento. O evento continua sendo verdade. */}
                      {row.title ?? <span style={{ color: "var(--sb-text-soft)" }}>anúncio fora do catálogo</span>}
                      <div style={{ fontFamily: "ui-monospace, monospace", fontSize: "0.75rem" }}>
                        <Link href={`/anuncios/${row.item_id}`}>{row.item_id}</Link>
                        {row.status !== null && (
                          <span style={{ color: "var(--sb-text-soft)" }}> · {listingStatusLabel(row.status)}</span>
                        )}
                      </div>
                    </td>
                    <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                      {row.sku_id !== null && row.sku !== null ? (
                        <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>
                      ) : (
                        <span style={{ color: "var(--sb-text-soft)", fontFamily: "inherit" }}>sem vínculo</span>
                      )}
                    </td>
                    <td style={td}>{row.account_label}</td>
                    <td style={tdNumber}>{formatCurrency(row.price_before)}</td>
                    <td style={tdNumber}>{formatCurrency(row.price_after)}</td>
                    <td style={{ ...tdNumber, color: subiu ? "var(--sb-secondary)" : "var(--sb-danger)" }}>
                      {subiu ? "+" : ""}
                      {formatCurrency(row.delta)}
                    </td>
                    <td style={{ ...tdNumber, color: subiu ? "var(--sb-secondary)" : "var(--sb-danger)" }}>
                      {row.delta_ratio === null ? "—" : `${subiu ? "+" : ""}${formatPercent(row.delta_ratio)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {error === null && window.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <FilterPill href={buildPriceHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          {filters.page < window.totalPages && (
            <FilterPill href={buildPriceHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
