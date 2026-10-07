import Link from "next/link";
import type { ReactNode } from "react";

import { toSalesMetricDate } from "@sb/domain";

import { FilterMenu } from "../../components/filter-menu";
import { FilterGroup, FilterPill } from "../../components/filter-pill";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { SavedFilters, type SavedFilter } from "../../components/saved-filters";
import { Shell } from "../../components/shell";
import { TOM, type Tom } from "../../components/tone";
import {
  ABC_CLASSES,
  ABC_CRITERIA,
  ABC_KINDS,
  ABC_MOVEMENTS,
  ABC_ORDERS,
  ABC_PERIODS,
  ABC_STOCK_STATES,
  DEFAULT_PERIOD,
  PAGE_SIZE,
  buildAbcHref,
  countActiveAbcFilters,
  resolveAbcFilters,
  resolveAbcWindow,
  summarizeAbcWindow,
  type AbcFilters,
} from "../../lib/abc-filters";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../lib/format";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Curva ABC — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Curva ABC com escopo, critério, período e comparação (Fase 5C, D-140, D-424).
 *
 * **O escopo RECALCULA a curva, não a filtra.** Conta, marca, categoria e
 * tipo entram nas duas pontas da RPC -- conjunto e denominador. Medido em
 * 2026-08-29: 743 SKUs vendem em mais de uma conta e 476 (64,1%) mudam de
 * classe conforme a conta.
 *
 * **Os filtros de depois da curva não mexem na classe.** Classe, Full,
 * estoque, movimento e busca escondem linhas da curva do recorte; o SKU que
 * sobra continua com a classe que tinha (D-424).
 *
 * 🔴 **A versão de D-140 mostrava 1.000 de 1.492 SKUs e somava as classes em
 * JavaScript sobre esse resultado truncado.** As contagens e somas são janelas
 * no Postgres sobre o conjunto filtrado inteiro, antes do limit.
 */
interface AbcAnalysisRow {
  sku_id: string;
  sku: string;
  title: string | null;
  supplier_brand: string | null;
  category: string | null;
  kind: string;
  revenue: number;
  units: number;
  orders: number;
  metric_value: number;
  metric_share: number;
  cumulative_share: number;
  abc_class: "A" | "B" | "C";
  class_revenue: string | null;
  class_units: string | null;
  class_orders: string | null;
  prev_metric_value: number | null;
  prev_abc_class: string | null;
  movement: string | null;
  local_stock: number | null;
  full_stock: number;
  coverage_days: number | null;
  total_count: number;
  class_a_count: number;
  class_b_count: number;
  class_c_count: number;
  class_a_value: number;
  class_b_value: number;
  class_c_value: number;
  without_full_count: number;
  total_revenue: number;
  total_units: number;
  total_orders: number;
  moved_up_count: number;
  moved_down_count: number;
  kept_count: number;
  new_count: number;
  scope_total_value: number;
  prev_scope_total_value: number | null;
}

const MOVIMENTO: Record<string, { texto: string; tom: Tom }> = {
  subiu: { texto: "↑ subiu", tom: "ok" },
  caiu: { texto: "↓ caiu", tom: "perigo" },
  manteve: { texto: "= manteve", tom: "neutro" },
  novo: { texto: "novo", tom: "info" },
};

/** Variação com sinal ("+12,3%"); sem base anterior, nulo -- nunca "+∞" nem 0% fingido. */
function variacao(atual: number, anterior: number | null): number | null {
  return anterior === null || anterior === 0 ? null : (atual - anterior) / anterior;
}

function textoVariacao(v: number | null): string {
  if (v === null) return "—";

  return `${v > 0 ? "+" : ""}${formatPercent(v)}`;
}

/** Os campos ocultos que um formulário GET precisa para não perder o recorte atual. */
function camposOcultos(filters: AbcFilters, sem: readonly string[]): ReactNode {
  const params = new URL(buildAbcHref(filters, { page: 1 }), "http://x").searchParams;

  return [...params.entries()]
    .filter(([chave]) => !sem.includes(chave))
    .map(([chave, valor]) => <input key={chave} type="hidden" name={chave} value={valor} />);
}

export default async function CurvaAbcPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  // As contas não dependem da organização: a RLS já as restringe. As leituras
  // que não dependem de nada saem juntas (D-195).
  const [membership, accountsResult, savedFiltersResult] = await Promise.all([
    currentMembership(),
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
    supabase.from("saved_filters").select("id, name, params").eq("screen", "/curva-abc").order("name"),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Curva ABC</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const today = toSalesMetricDate(new Date());
  const filters = resolveAbcFilters(query, today);
  const janela = resolveAbcWindow(filters, today);

  const accounts = accountsResult.data ?? [];
  // Slug desconhecido cai em "consolidado" em silêncio — mesmo tratamento de
  // `/vendas` e `/anuncios`.
  const selectedAccount = accounts.find((a) => a.slug === filters.accountSlug) ?? null;
  const savedFilters: SavedFilter[] = (savedFiltersResult.data ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    params: row.params as Record<string, string>,
  }));

  // As listas de marca e categoria vêm do BANCO, nunca das linhas da página
  // (D-194). Saem no mesmo round trip da curva.
  const [curva, brandsResult, categoriesResult] = await Promise.all([
    supabase.rpc("get_sku_abc_analysis", {
      p_organization_id: organizationId,
      p_date_from: janela.from,
      p_date_to: janela.to,
      p_prev_from: janela.prevFrom,
      p_prev_to: janela.prevTo,
      p_ml_account_id: selectedAccount?.id ?? null,
      p_supplier_brand: filters.brand,
      p_category: filters.category,
      p_kind: filters.kind?.value ?? null,
      p_criterion: filters.criterion.key,
      p_abc_class: filters.abcClass,
      p_only_without_full: filters.onlyWithoutFull,
      p_stock: filters.stock?.key ?? null,
      p_movement: filters.movement?.key ?? null,
      p_search: filters.search,
      p_order: filters.order.key,
      p_limit: PAGE_SIZE,
      p_offset: (filters.page - 1) * PAGE_SIZE,
    }),
    supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
    supabase.rpc("get_sku_categories", { p_organization_id: organizationId }),
  ]);

  const { data, error } = curva;
  const brands = (brandsResult.data ?? []).map((r) => r.supplier_brand);
  const categories = (categoriesResult.data ?? []).map((r) => r.category);

  const rows = (data ?? []) as AbcAnalysisRow[];
  const first = rows[0];
  const totalCount = first?.total_count ?? 0;
  const windowInfo = summarizeAbcWindow(filters.page, totalCount, rows.length);
  const formatValue = filters.criterion.format === "currency" ? formatCurrency : formatCount;
  const totalDasClasses =
    first === undefined ? 0 : first.class_a_value + first.class_b_value + first.class_c_value;

  // Os recortes que recalculam a curva, numa oração só.
  const recortes = [
    selectedAccount?.label,
    filters.brand === null ? null : `marca ${filters.brand}`,
    filters.category === null ? null : `categoria ${filters.category}`,
    filters.kind === null ? null : filters.kind.label.toLowerCase(),
  ].filter((r): r is string => r !== undefined && r !== null);
  const escopo = recortes.length === 0 ? ", consolidado" : `, recalculada dentro de ${recortes.join(" e ")}`;
  const periodoTexto =
    filters.custom === null
      ? `Últimos ${String(filters.days)} dias`
      : `De ${formatBusinessDate(janela.from)} a ${formatBusinessDate(janela.to)}`;
  const exportHref = buildAbcHref(filters, { page: 1 }).replace(/^\/curva-abc/, "/curva-abc/export/xlsx");
  const filtrosAtivos = countActiveAbcFilters(filters);

  const variacaoRecorte =
    first === undefined ? null : variacao(first.scope_total_value, first.prev_scope_total_value);
  const kpis: KpiCellData[] =
    first === undefined
      ? []
      : [
          {
            label: `${filters.criterion.label} do recorte`,
            formula: `Soma de ${filters.criterion.label.toLowerCase()} de todos os SKUs do recorte no período, contra o período anterior de ${String(janela.dayCount)} dias (${formatBusinessDate(janela.prevFrom)} a ${formatBusinessDate(janela.prevTo)}).`,
            value: formatValue(first.scope_total_value),
            previous: first.prev_scope_total_value === null ? null : formatValue(first.prev_scope_total_value),
            ...(variacaoRecorte === null
              ? {}
              : {
                  variacao: {
                    texto: textoVariacao(variacaoRecorte),
                    tom: variacaoRecorte >= 0 ? ("ok" as const) : ("perigo" as const),
                    titulo: "Variação contra o período anterior de mesmo tamanho.",
                  },
                }),
          },
          {
            label: "SKUs listados",
            formula: "SKUs com venda no recorte que passam pelos filtros (classe, estoque, movimento, busca).",
            value: formatCount(first.total_count),
            previous: null,
          },
          // As outras duas métricas -- a do critério já está na primeira célula.
          ...(
            [
              {
                key: "faturamento",
                label: "Faturamento",
                formula: "Soma do faturamento bruto dos SKUs listados (com os filtros aplicados).",
                value: formatCurrency(first.total_revenue),
                previous: null,
              },
              {
                key: "unidades",
                label: "Unidades",
                formula: "Soma das unidades vendidas dos SKUs listados.",
                value: formatCount(first.total_units),
                previous: null,
              },
              {
                key: "pedidos",
                label: "Pedidos",
                formula: "Soma dos pedidos dos SKUs listados (um pedido com dois SKUs conta nos dois).",
                value: formatCount(first.total_orders),
                previous: null,
              },
            ] as const
          )
            .filter((cell) => cell.key !== filters.criterion.key)
            .map((cell) => ({ label: cell.label, formula: cell.formula, value: cell.value, previous: cell.previous })),
          {
            label: "Ticket médio",
            formula: "Faturamento ÷ pedidos dos SKUs listados.",
            value: first.total_orders === 0 ? "—" : formatCurrency(first.total_revenue / first.total_orders),
            previous: null,
          },
          {
            label: "Movimento de classe",
            formula: "Classe no período contra a classe no período anterior de mesmo tamanho, no mesmo recorte.",
            value: `${formatCount(first.moved_up_count)} ↑ · ${formatCount(first.moved_down_count)} ↓`,
            previous: null,
            ressalva: `${formatCount(first.new_count)} novos · ${formatCount(first.kept_count)} mantiveram`,
          },
        ];

  return (
    <Shell>
      {/* Sobrancelha e título do frame `Abc` (ESTOQUE / CLASSIFICAÇÃO). */}
      <PageTitle
        eyebrow="ESTOQUE / CLASSIFICAÇÃO"
        title="Curva ABC"
        subtitle="Onde receita, volume e disponibilidade se concentram."
        aside={
          <>
            <FilterMenu
              rotulo={filters.custom === null ? `Últimos ${String(filters.days)} dias` : "Período personalizado"}
              opcoes={ABC_PERIODS.map((days) => ({
                href: buildAbcHref(filters, { days }),
                label: `Últimos ${String(days)} dias`,
                ativo: filters.custom === null && filters.days === days,
              }))}
            >
              {/* GET nativo manda SÓ os campos do formulário: os ocultos levam o resto do recorte. */}
              <form method="get" className="sb-abc-periodo">
                {camposOcultos(filters, ["dias", "de", "ate"])}
                <input
                  type="date"
                  name="de"
                  defaultValue={filters.custom?.from}
                  max={today}
                  aria-label="Data inicial"
                  className="sb-input"
                  required
                />
                <input
                  type="date"
                  name="ate"
                  defaultValue={filters.custom?.to}
                  max={today}
                  aria-label="Data final"
                  className="sb-input"
                  required
                />
                <button type="submit" className="sb-button sb-button-primary">
                  Aplicar período
                </button>
              </form>
            </FilterMenu>
            <FilterMenu
              rotulo={selectedAccount?.label ?? "Todas as contas"}
              opcoes={[
                { href: buildAbcHref(filters, { accountSlug: null }), label: "Todas as contas", ativo: selectedAccount === null },
                ...accounts.map((account) => ({
                  href: buildAbcHref(filters, { accountSlug: account.slug }),
                  label: account.label,
                  ativo: selectedAccount?.id === account.id,
                })),
              ]}
            />
            <FilterMenu
              rotulo={filters.brand ?? "Todas as marcas"}
              opcoes={[
                { href: buildAbcHref(filters, { brand: null }), label: "Todas as marcas", ativo: filters.brand === null },
                ...brands.map((brand) => ({
                  href: buildAbcHref(filters, { brand }),
                  label: brand,
                  ativo: filters.brand === brand,
                })),
              ]}
            />
            <FilterMenu
              rotulo={filters.category ?? "Todas as categorias"}
              opcoes={[
                {
                  href: buildAbcHref(filters, { category: null }),
                  label: "Todas as categorias",
                  ativo: filters.category === null,
                },
                ...categories.map((category) => ({
                  href: buildAbcHref(filters, { category }),
                  label: category,
                  ativo: filters.category === category,
                })),
              ]}
            />
            <FilterMenu
              rotulo={filters.kind?.label ?? "Produtos e kits"}
              opcoes={[
                { href: buildAbcHref(filters, { kind: null }), label: "Produtos e kits", ativo: filters.kind === null },
                ...ABC_KINDS.map((kind) => ({
                  href: buildAbcHref(filters, { kind }),
                  label: kind.label,
                  ativo: filters.kind?.key === kind.key,
                })),
              ]}
            />
            <SavedFilters screen="/curva-abc" organizationId={organizationId} filters={savedFilters} />
          </>
        }
      />

      {filters.invalidCustom && (
        <p role="alert" className="sb-note" style={{ marginBottom: "var(--sb-space-3)" }}>
          Período personalizado inválido (datas fora de ordem, no futuro ou com mais de dois anos) — mostrando os
          últimos {DEFAULT_PERIOD} dias.
        </p>
      )}

      <section className="sb-abc-controls" aria-label="Configuração da análise">
        <div className="sb-abc-controls-head">
          <div>
            <span className="sb-eyebrow">ANÁLISE ATUAL</span>
            <p>
              {periodoTexto}, por {filters.criterion.label.toLowerCase()}
              {escopo}. Comparação com {formatBusinessDate(janela.prevFrom)} a {formatBusinessDate(janela.prevTo)}.
            </p>
          </div>
          <div className="sb-abc-controls-acoes">
            {filtrosAtivos > 0 && (
              <Link className="sb-button" href="/curva-abc">
                Limpar filtros ({filtrosAtivos})
              </Link>
            )}
            {/* O Excel leva o MESMO recorte da tela -- `export/xlsx/route.ts`. */}
            <a className="sb-button sb-button-primary" href={exportHref} download>
              Baixar Excel
            </a>
          </div>
        </div>

        <div className="sb-abc-filter-grid">
          <FilterGroup label="Critério">
            {ABC_CRITERIA.map((criterion) => (
              <FilterPill
                key={criterion.key}
                href={buildAbcHref(filters, { criterion })}
                active={filters.criterion.key === criterion.key}
              >
                {criterion.label}
              </FilterPill>
            ))}
          </FilterGroup>

          <FilterGroup label="Classe ABC">
            <FilterPill href={buildAbcHref(filters, { abcClass: null })} active={filters.abcClass === null}>
              Todas
            </FilterPill>
            {ABC_CLASSES.map((abcClass) => (
              <FilterPill
                key={abcClass}
                href={buildAbcHref(filters, { abcClass })}
                active={filters.abcClass === abcClass}
              >
                Classe {abcClass}
              </FilterPill>
            ))}
          </FilterGroup>

          <FilterGroup label="Movimento">
            <FilterPill href={buildAbcHref(filters, { movement: null })} active={filters.movement === null}>
              Todos
            </FilterPill>
            {ABC_MOVEMENTS.map((movement) => (
              <FilterPill
                key={movement.key}
                href={buildAbcHref(filters, { movement })}
                active={filters.movement?.key === movement.key}
              >
                {movement.label}
              </FilterPill>
            ))}
          </FilterGroup>

          <FilterGroup label="Estoque">
            <FilterPill href={buildAbcHref(filters, { stock: null })} active={filters.stock === null}>
              Todos
            </FilterPill>
            {ABC_STOCK_STATES.map((stock) => (
              <FilterPill
                key={stock.key}
                href={buildAbcHref(filters, { stock })}
                active={filters.stock?.key === stock.key}
              >
                {stock.label}
              </FilterPill>
            ))}
          </FilterGroup>
        </div>

        <form method="get" className="sb-abc-busca" role="search">
          {camposOcultos(filters, ["busca", "ordem"])}
          <input
            type="search"
            name="busca"
            defaultValue={filters.search ?? ""}
            placeholder="Buscar por SKU ou nome do produto"
            aria-label="Buscar por SKU ou nome do produto"
            maxLength={80}
            className="sb-input"
          />
          <select name="ordem" defaultValue={filters.order.key} aria-label="Ordenar por" className="sb-input">
            {ABC_ORDERS.map((order) => (
              <option key={order.key} value={order.key}>
                Ordenar: {order.label}
              </option>
            ))}
          </select>
          <button type="submit" className="sb-button">
            Aplicar
          </button>
        </form>
      </section>

      {first !== undefined && <KpiStrip cells={kpis} ancora />}

      {/*
        Os três cartões de classe do frame `Abc`. O valor por classe vem de
        JANELA no banco, calculada antes do limit (D-251): somar em JavaScript
        daria o valor da PÁGINA, não do recorte. A participação é razão entre
        dois totais já fornecidos, não agregação.
      */}
      {first !== undefined && (
        <div className="sb-abc-cards">
          {(
            [
              { classe: "A", limite: "até 80%", valor: first.class_a_value, skus: first.class_a_count },
              { classe: "B", limite: "de 80% a 95%", valor: first.class_b_value, skus: first.class_b_count },
              { classe: "C", limite: "acima de 95%", valor: first.class_c_value, skus: first.class_c_count },
            ] as const
          ).map((c) => (
            <section
              className={`sb-abc-card sb-abc-card-${c.classe.toLowerCase()}`}
              key={c.classe}
              aria-label={`Classe ${c.classe}`}
            >
              <div className="sb-abc-card-head">
                <span>CLASSE {c.classe}</span>
                <small>{c.limite} do acumulado</small>
              </div>
              <strong>{formatValue(c.valor)}</strong>
              <p>
                {totalDasClasses === 0
                  ? "sem base para percentual"
                  : `${formatPercent(c.valor / totalDasClasses)} do resultado`}
              </p>
              <div className="sb-abc-card-foot">
                <b>
                  {formatCount(c.skus)} {c.skus === 1 ? "SKU" : "SKUs"}
                </b>
                <small>nesta classe</small>
              </div>
              <i
                aria-hidden="true"
                style={{ width: totalDasClasses === 0 ? "0%" : `${String((c.valor / totalDasClasses) * 100)}%` }}
              />
            </section>
          ))}
        </div>
      )}

      {/*
        "Sem Full" PERTENCE à curva (`p_only_without_full`). "Em ruptura" e
        "Baixa cobertura" NÃO: são estados com dono (`get_purchase_suggestions`,
        D-150) e viram LINK para a tela dona (D-224).
      */}
      {first !== undefined && (
        <div className="sb-abc-bars">
          <section className="sb-abc-full-card">
            <div className="sb-abc-insight-head">
              <div>
                <span className="sb-eyebrow">DISPONIBILIDADE FULL</span>
                <b>Sem estoque no Full</b>
              </div>
              <strong>{formatCount(first.without_full_count)}</strong>
            </div>
            <div className="sb-abc-progress" aria-hidden="true">
              <i
                style={{
                  width: `${String(Math.min(100, Math.round((first.without_full_count / Math.max(first.total_count, 1)) * 100)))}%`,
                }}
              />
            </div>
            <p>
              {formatCount(first.without_full_count)} de {formatCount(first.total_count)} SKUs do recorte.
            </p>
            <FilterPill
              href={buildAbcHref(filters, { onlyWithoutFull: !filters.onlyWithoutFull })}
              active={filters.onlyWithoutFull}
            >
              {filters.onlyWithoutFull ? "Mostrando somente sem Full" : "Ver somente sem Full"}
            </FilterPill>
          </section>

          <section className="sb-note sb-abc-risk-card">
            <span>RISCO OPERACIONAL</span>
            <p>
              Ruptura e cobertura baixa seguem a política de reposição. Consulte a fila operacional para agir
              sobre esses estados.
            </p>
            <div className="sb-abc-risk-links">
              <Link href="/reposicao?estado=RUPTURA">Ver rupturas →</Link>
              <Link href="/reposicao?estado=COBERTURA_BAIXA">Ver cobertura baixa →</Link>
            </div>
          </section>
        </div>
      )}

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <Panel
          title={
            filters.onlyWithoutFull
              ? "SKUs sem estoque no Full"
              : filters.abcClass
                ? `SKUs da classe ${filters.abcClass}`
                : "SKUs por participação"
          }
          subtitle={windowInfo.label}
          aside={
            <span className="sb-abc-table-context">
              {filters.criterion.label} · {filters.custom === null ? `${String(filters.days)} dias` : "período personalizado"}
              {filters.abcClass ? ` · Classe ${filters.abcClass}` : ""} · {filters.order.label}
            </span>
          }
        >
          {rows.length === 0 && <p className="sb-empty">Nenhum SKU com venda no período e escopo escolhidos.</p>}

          {rows.length > 0 && (
            <div className="sb-abc-table-wrap">
              <table className="sb-table">
                <thead>
                  <tr>
                    <th>Classe</th>
                    <th>Produto / SKU</th>
                    <th className="sb-num">
                      Faturamento
                    </th>
                    <th className="sb-num">Unidades</th>
                    <th className="sb-num">Pedidos</th>
                    <th className="sb-num">Ticket médio</th>
                    <th className="sb-num">% do total</th>
                    <th className="sb-num">% acumulado</th>
                    <th className="sb-num" title="Variação do critério contra o período anterior de mesmo tamanho">
                      vs anterior
                    </th>
                    <th className="sb-num">Estoque local</th>
                    <th className="sb-num">Full</th>
                    <th className="sb-num" title="Dias que o estoque local + Full cobre na venda média diária do período">
                      Cobertura
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {rows.map((row) => {
                    const mov = row.movement === null ? null : (MOVIMENTO[row.movement] ?? null);
                    const v = variacao(row.metric_value, row.prev_metric_value);

                    return (
                      <tr key={row.sku_id}>
                        <td>
                          <span className={`sb-abc-class sb-abc-class-${row.abc_class.toLowerCase()}`}>
                            {row.abc_class}
                          </span>
                          <div
                            className="sb-abc-classes-fup"
                            title="Classe em faturamento / unidades / pedidos"
                          >
                            {row.class_revenue ?? "–"}
                            {row.class_units ?? "–"}
                            {row.class_orders ?? "–"}
                          </div>
                        </td>
                        <td>
                          <Link className="sb-entity" href={`/skus/${row.sku_id}`}>
                            {row.title ?? "Produto sem título"}
                          </Link>
                          <div className="sb-mono">
                            {row.sku}
                            {row.kind === "KIT" ? " · kit" : ""}
                          </div>
                          {(row.supplier_brand !== null || row.category !== null) && (
                            <div className="sb-abc-meta">
                              {[row.supplier_brand, row.category].filter((x): x is string => x !== null).join(" · ")}
                            </div>
                          )}
                        </td>
                        <td className="sb-num">{formatCurrency(row.revenue)}</td>
                        <td className="sb-num">{formatCount(row.units)}</td>
                        <td className="sb-num">{formatCount(row.orders)}</td>
                        <td className="sb-num">{row.orders === 0 ? "—" : formatCurrency(row.revenue / row.orders)}</td>
                        <td className="sb-num">
                          <div className="sb-abc-share">
                            <i aria-hidden="true" style={{ width: `${String(Math.min(100, row.metric_share))}%` }} />
                            {/* A RPC devolve em pontos percentuais (12.34); `formatPercent` recebe fração. */}
                            <span>{formatPercent(row.metric_share / 100)}</span>
                          </div>
                        </td>
                        <td className="sb-num">{formatPercent(row.cumulative_share / 100)}</td>
                        <td className="sb-num">
                          <div className="sb-abc-vs">
                            <span style={{ color: v === null ? undefined : v >= 0 ? "var(--sb-success)" : "var(--sb-danger)" }}>
                              {textoVariacao(v)}
                            </span>
                            {mov !== null && (
                              <span
                                className="sb-abc-mov"
                                style={TOM[mov.tom]}
                                title={
                                  row.prev_abc_class === null
                                    ? "Sem venda no período anterior"
                                    : `Era classe ${row.prev_abc_class} no período anterior`
                                }
                              >
                                {mov.texto}
                                {row.prev_abc_class !== null && row.movement !== "manteve" ? ` (era ${row.prev_abc_class})` : ""}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="sb-num">{formatCount(row.local_stock)}</td>
                        <td className="sb-num">
                          {row.full_stock === 0 ? (
                            <span className="sb-abc-full-empty">Sem Full</span>
                          ) : (
                            formatCount(row.full_stock)
                          )}
                        </td>
                        <td className="sb-num">
                          {row.coverage_days === null ? "—" : `${formatCount(Math.round(row.coverage_days))} d`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}

      {error === null && windowInfo.totalPages > 1 && (
        <nav className="sb-abc-pagination" aria-label="Paginação da Curva ABC">
          {filters.page > 1 && (
            <FilterPill href={buildAbcHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          <span>
            Página {filters.page} de {windowInfo.totalPages}
          </span>
          {filters.page < windowInfo.totalPages && (
            <FilterPill href={buildAbcHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </nav>
      )}
    </Shell>
  );
}
