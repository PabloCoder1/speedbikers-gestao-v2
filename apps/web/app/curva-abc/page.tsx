import Link from "next/link";
import type { ReactNode } from "react";

import type { Database } from "@sb/db";
import { toSalesMetricDate } from "@sb/domain";

import { FilterMenu } from "../../components/filter-menu";
import { FilterGroup, FilterPill } from "../../components/filter-pill";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { EstadoDaTela, TENTAR_DE_NOVO } from "../../components/estado-da-tela";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { SavedFilters, type SavedFilter } from "../../components/saved-filters";
import { SeletorDeMarketplace } from "../../components/seletor-marketplace";
import { Shell } from "../../components/shell";
import { TOM, type Tom } from "../../components/tone";
import {
  ABC_CLASSES,
  ABC_KINDS,
  ABC_MOVEMENTS,
  ABC_PERIODS,
  ABC_STOCK_STATES,
  DEFAULT_PERIOD,
  PAGE_SIZE,
  aplicarContasDoRecorte,
  buildAbcHref,
  countActiveAbcFilters,
  criteriosDoEscopo,
  ordensDoEscopo,
  resolveAbcFilters,
  resolveAbcWindow,
  summarizeAbcWindow,
  type AbcFilters,
} from "../../lib/abc-filters";
import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "../../lib/format";
import { contarLojasShopee } from "../../lib/marketplace";
import { currentMembership } from "../../lib/request-membership";
import { mesmaUrl } from "../../lib/mesma-url";
import { createClient } from "../../lib/supabase/server";
import {
  HISTORICO_SHOPEE_DIAS,
  ROTULO_DO_ESCOPO,
  alternarConta,
  antesDoHistoricoShopee,
  marketplacesDoEscopo,
  type ContaDoSeletor,
} from "../../lib/vendas-multicanal";

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
 *
 * **O marketplace é mais um recorte (D-448, sobre o C-60).** Sem `marketplace`
 * na URL, a curva é a do Mercado Livre de sempre, com as mesmas chamadas.
 * `marketplace=todos|shopee` recalcula a curva com a Shopee: o critério que
 * soma é a COMPRA (o pack do ML e o pedido da Shopee), "pedidos" e cobertura
 * ficam de fora (a função os devolve nulos), e o Full só existe com o ML no
 * recorte. A loja de teste nunca entra.
 */
type AbcAnalysisRow = Database["public"]["Functions"]["get_sku_abc_analysis"]["Returns"][number];


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
  const today = toSalesMetricDate(new Date());
  // Os filtros só dependem da URL: saem antes, porque o recorte decide o que ler.
  const pedidos = resolveAbcFilters(query, today);
  const multicanal = pedidos.escopo !== "ml";

  // As contas não dependem da organização: a RLS já as restringe. As leituras
  // que não dependem de nada saem juntas (D-195). Fora do ML, a lista de contas
  // e lojas vem da fonte única (C-52); no ML basta o NÚMERO de lojas, que só
  // decide se o seletor de marketplace aparece (D-431).
  const [membership, accountsResult, savedFiltersResult, lojasShopee, contasDoRecorte] = await Promise.all([
    currentMembership(),
    supabase.from("ml_accounts").select("id, slug, label").order("label"),
    supabase.from("saved_filters").select("id, name, params").eq("screen", "/curva-abc").order("name"),
    contarLojasShopee(supabase),
    multicanal
      ? supabase
          .from("marketplace_accounts")
          .select("account_id, marketplace, name, environment")
          .order("marketplace", { ascending: true })
          .order("name", { ascending: true })
      : Promise.resolve({ data: null, error: null }),
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

  const accounts = accountsResult.data ?? [];

  // As contas do link que a pessoa alcança e que cabem no recorte; as outras
  // caem, com aviso (D-440). A mesma regra do Excel (`aplicarContasDoRecorte`).
  const todasAsContas: ContaDoSeletor[] = contasDoRecorte.data ?? [];
  const { filters, selecionadas, descartadas, leMl } = aplicarContasDoRecorte(pedidos, todasAsContas);
  const janela = resolveAbcWindow(filters, today);
  const contasDoMenu = todasAsContas.filter((c) => filters.escopo === "todos" || c.marketplace === "SHOPEE");
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
      // O recorte ML chama a função EXATAMENTE como antes (C-60: marketplace
      // nulo = só ML); fora dele, a conta vai em p_account_ids.
      ...(filters.escopo === "ml"
        ? { p_ml_account_id: selectedAccount?.id ?? null }
        : {
            p_marketplaces: marketplacesDoEscopo(filters.escopo),
            p_account_ids: filters.contas === null ? null : [...filters.contas],
          }),
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

  /*
    T-R6 (achado do A3, D-067): as leituras de apoio que, ao falhar, virariam
    "nada" — o menu de contas vazio, a conta do link caindo em "todas" calada,
    as listas de marca e categoria sem opção, os filtros salvos sumindo. A
    curva continua (ela é a leitura principal); a tela diz o que faltou.
  */
  // D-468: o que faltou e o efeito na tela; a mensagem técnica vai à parte, sanitizada pelo `EstadoDaTela`.
  const leiturasQueFalharam = [
    accountsResult.error === null
      ? null
      : {
          oQue: "as contas do Mercado Livre: o filtro por conta do ML fica fora, e a curva mostra todas as contas",
          mensagem: accountsResult.error.message,
        },
    contasDoRecorte.error === null
      ? null
      : {
          oQue: "as contas e lojas do recorte: a escolha de contas fica fora, e a curva mostra o recorte inteiro",
          mensagem: contasDoRecorte.error.message,
        },
    brandsResult.error === null && categoriesResult.error === null
      ? null
      : {
          oQue: "as listas de marca e categoria: os filtros por elas ficam sem opções",
          mensagem: (brandsResult.error ?? categoriesResult.error)?.message ?? "",
        },
    savedFiltersResult.error === null ? null : { oQue: "os filtros salvos", mensagem: savedFiltersResult.error.message },
  ].filter((falha): falha is { oQue: string; mensagem: string } => falha !== null);

  const rows: AbcAnalysisRow[] = data ?? [];
  const first = rows[0];
  const totalCount = first?.total_count ?? 0;
  const windowInfo = summarizeAbcWindow(filters.page, totalCount, rows.length);
  const formatValue = filters.criterion.format === "currency" ? formatCurrency : formatCount;
  const totalDasClasses =
    first === undefined ? 0 : first.class_a_value + first.class_b_value + first.class_c_value;

  // Os recortes que recalculam a curva, numa oração só.
  const nomesDasContas =
    selecionadas === null
      ? null
      : selecionadas.length === 1
        ? (selecionadas[0]?.name ?? "1 conta")
        : `${String(selecionadas.length)} contas e lojas`;
  const recortes = [
    // "todos os marketplaces" no meio da frase; Shopee é nome próprio.
    filters.escopo === "todos" ? ROTULO_DO_ESCOPO.todos.toLowerCase() : filters.escopo === "shopee" ? ROTULO_DO_ESCOPO.shopee : null,
    nomesDasContas,
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
  // A Shopee guarda 90 dias: um período anterior mais velho faz ela parecer "nova" (T-R2).
  const historicoCurto = filters.escopo !== "ml" && antesDoHistoricoShopee(janela.prevFrom, today);
  const comprasNoLugarDePedidos = multicanal;
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
              comprasNoLugarDePedidos
                ? {
                    key: "compras",
                    label: "Compras",
                    formula:
                      "Soma das compras dos SKUs listados: o pack do Mercado Livre e o pedido da Shopee (uma compra com dois SKUs conta nos dois).",
                    value: formatCount(first.total_purchases),
                    previous: null,
                  }
                : {
                    key: "pedidos",
                    label: "Pedidos",
                    formula: "Soma dos pedidos dos SKUs listados (um pedido com dois SKUs conta nos dois).",
                    value: formatCount(first.total_orders),
                    previous: null,
                  },
            ] as const
          )
            .filter((cell) => cell.key !== filters.criterion.key)
            .map((cell) => ({
              label: cell.label,
              formula: cell.formula,
              value: cell.value,
              previous: cell.previous,
              // Item Shopee de preço zero (bundle) não tem receita: dito, não somado.
              ...(cell.key === "faturamento" && (first.total_shopee_items_without_revenue ?? 0) > 0
                ? {
                    ressalva: `${formatCount(first.total_shopee_items_without_revenue)} itens Shopee sem receita conhecida, fora da soma`,
                  }
                : {}),
            })),
          // O ticket do ML é faturamento ÷ pedidos; fora do ML o pedido não
          // soma, e a receita dos itens Shopee de preço zero é desconhecida:
          // o ticket entre marketplaces mora em /vendas, recalculado no banco.
          ...(multicanal
            ? []
            : [
                {
                  label: "Ticket médio",
                  formula: "Faturamento ÷ pedidos dos SKUs listados.",
                  value:
                    first.total_orders === null || first.total_orders === 0 || first.total_revenue === null
                      ? "—"
                      : formatCurrency(first.total_revenue / first.total_orders),
                  previous: null,
                },
              ]),
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
            {/* O marketplace vem primeiro (D-431): é o recorte mais largo. */}
            <SeletorDeMarketplace
              ativo={filters.escopo}
              contas={{ ml: accountsResult.error === null ? accounts.length : null, shopee: lojasShopee }}
              destinos={{
                todos: buildAbcHref(filters, { escopo: "todos" }),
                ml: buildAbcHref(filters, { escopo: "ml" }),
                shopee: buildAbcHref(filters, { escopo: "shopee" }),
              }}
            />
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
            {filters.escopo === "ml" ? (
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
            ) : (
              // Várias contas e lojas, uma por clique, num valor só na URL (D-440).
              contasDoMenu.length > 0 && (
                <FilterMenu
                  nome="Contas"
                  rotulo={nomesDasContas ?? "Todas as contas"}
                  opcoes={[
                    { href: buildAbcHref(filters, { contas: null }), label: "Todas as contas", ativo: selecionadas === null },
                    ...contasDoMenu.map((conta) => {
                      const marcada = selecionadas?.some((c) => c.account_id === conta.account_id) ?? false;
                      const proximas = alternarConta(selecionadas, conta);

                      return {
                        href: buildAbcHref(filters, { contas: proximas === null ? null : proximas.map((c) => c.account_id) }),
                        ativo: marcada,
                        label: `${marcada ? "✓ " : ""}${conta.name} · ${conta.marketplace === "ML" ? "Mercado Livre" : "Shopee"}${conta.environment === "live" ? "" : " (teste)"}`,
                      };
                    }),
                  ]}
                />
              )
            )}
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

      {leiturasQueFalharam.length > 0 && (
        <EstadoDaTela
          tipo="erro"
          titulo="Parte da Curva ABC não foi lida"
          descricao={`Faltou ler ${leiturasQueFalharam.map((falha) => falha.oQue).join("; ")}. O que aparece vazio por isso não quer dizer que não existe.`}
          detalhe={leiturasQueFalharam.map((falha) => falha.mensagem).join("; ")}
          acao={{ href: mesmaUrl("/curva-abc", query), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
      )}

      {/* Sem a leitura das contas, "não estão disponíveis para você" seria mentira: o aviso de cima diz o porquê. */}
      {descartadas > 0 && contasDoRecorte.error === null && (
        <p role="note" className="sb-an-nota">
          {descartadas === 1
            ? "1 conta do link não está disponível para você neste recorte e ficou de fora."
            : `${String(descartadas)} contas do link não estão disponíveis para você neste recorte e ficaram de fora.`}
        </p>
      )}

      {multicanal && (
        <p role="note" className="sb-an-nota">
          Com a Shopee no recorte, a curva soma <strong>compras</strong> (o pack do Mercado Livre e o pedido da Shopee):
          pedidos, ticket e cobertura em dias são do Mercado Livre e ficam de fora{leMl ? "" : ", assim como o Full"}. A
          loja Shopee de teste nunca entra.
          {historicoCurto &&
            ` A Shopee guarda ${String(HISTORICO_SHOPEE_DIAS)} dias de histórico: o período anterior começa antes disso, e o movimento de classe dela aparece como "novo" ou "subiu".`}
        </p>
      )}

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
            {/* O Excel leva o MESMO recorte da tela, marketplace e contas inclusive (D-450) -- `export/xlsx/route.ts`. */}
            <a className="sb-button sb-button-primary" href={exportHref} download>
              Baixar Excel
            </a>
          </div>
        </div>

        <div className="sb-abc-filter-grid">
          <FilterGroup label="Critério">
            {criteriosDoEscopo(filters.escopo).map((criterion) => (
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
            {ordensDoEscopo(filters.escopo).map((order) => (
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
          {leMl && (
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
          )}

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
        <EstadoDaTela
          tipo="erro"
          titulo="Não foi possível carregar a Curva ABC"
          detalhe={error.message}
          acao={{ href: mesmaUrl("/curva-abc", query), rotulo: TENTAR_DE_NOVO, mesmaTela: true }}
        />
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
                    {multicanal ? (
                      <th className="sb-num" title="O pack do Mercado Livre e o pedido da Shopee que contêm o SKU">
                        Compras
                      </th>
                    ) : (
                      <>
                        <th className="sb-num">Pedidos</th>
                        <th className="sb-num">Ticket médio</th>
                      </>
                    )}
                    {filters.escopo === "todos" && (
                      <>
                        <th className="sb-num">Mercado Livre</th>
                        <th className="sb-num">Shopee</th>
                      </>
                    )}
                    <th className="sb-num">% do total</th>
                    <th className="sb-num">% acumulado</th>
                    <th className="sb-num" title="Variação do critério contra o período anterior de mesmo tamanho">
                      vs anterior
                    </th>
                    <th className="sb-num">Estoque local</th>
                    {leMl && <th className="sb-num">Full</th>}
                    {!multicanal && (
                      <th className="sb-num" title="Dias que o estoque local + Full cobre na venda média diária do período">
                        Cobertura
                      </th>
                    )}
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
                            title={`Classe em faturamento / unidades / ${multicanal ? "compras" : "pedidos"}`}
                          >
                            {row.class_revenue ?? "–"}
                            {row.class_units ?? "–"}
                            {(multicanal ? row.class_purchases : row.class_orders) ?? "–"}
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
                        <td className="sb-num">
                          {formatCurrency(row.revenue)}
                          {(row.shopee_items_without_revenue ?? 0) > 0 && (
                            <small className="sb-an-sub">
                              {formatCount(row.shopee_items_without_revenue)} itens Shopee sem receita
                            </small>
                          )}
                        </td>
                        <td className="sb-num">{formatCount(row.units)}</td>
                        {multicanal ? (
                          <td className="sb-num">{formatCount(row.purchases)}</td>
                        ) : (
                          <>
                            <td className="sb-num">{formatCount(row.orders)}</td>
                            <td className="sb-num">
                              {row.orders === null || row.orders === 0 || row.revenue === null
                                ? "—"
                                : formatCurrency(row.revenue / row.orders)}
                            </td>
                          </>
                        )}
                        {filters.escopo === "todos" && (
                          <>
                            <td className="sb-num" title="receita · unidades no Mercado Livre">
                              {formatCurrency(row.revenue_ml)}
                              <small className="sb-an-sub">{formatCount(row.units_ml)} un</small>
                            </td>
                            <td className="sb-num" title="receita · unidades na Shopee">
                              {formatCurrency(row.revenue_shopee)}
                              <small className="sb-an-sub">{formatCount(row.units_shopee)} un</small>
                            </td>
                          </>
                        )}
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
                        {leMl && (
                          <td className="sb-num">
                            {row.full_stock === 0 ? (
                              <span className="sb-abc-full-empty">Sem Full</span>
                            ) : (
                              formatCount(row.full_stock)
                            )}
                          </td>
                        )}
                        {!multicanal && (
                          <td className="sb-num">
                            {row.coverage_days === null ? "—" : `${formatCount(Math.round(row.coverage_days))} d`}
                          </td>
                        )}
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
