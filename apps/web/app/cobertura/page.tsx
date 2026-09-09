import { toSalesMetricDate } from "@sb/domain";
import type { ReactNode } from "react";

import Link from "next/link";

import { FilterPill } from "../../components/filter-pill";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { TrendBadge } from "../../components/trend-badge";
import { formatCount } from "../../lib/format";
import { createClient } from "../../lib/supabase/server";
import { buildCoverageHref, resolveCoverageFilters } from "../../lib/coverage-filters";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Cobertura de estoque — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Primeira fatia de "Cobertura, ruptura, vendas perdidas estimadas" (Fase
 * 5B, docs/ROADMAP.md). Cobertura e ruptura só — "vendas perdidas
 * estimadas" fica de fora desta fatia, ver comentário na migration
 * (`get_stock_coverage`, `20260823175030_create_stock_coverage_rpc.sql`).
 *
 * ---------------------------------------------------------------------------
 * POR QUE ELA NAO FOI FUNDIDA COM `/reposicao` (D-279, fatia D37c)
 * ---------------------------------------------------------------------------
 *
 * O frame `Coverage` desenha UMA tela com duas faces -- "Visao geral" e
 * "Configuracoes" -- e as duas ja existem migradas: `/reposicao` (D-250) e
 * `/reposicao/configuracoes` (D-278). Sobrancelha, titulo, cartoes de estado e
 * painel "Recomendacao de compra" do frame sao literalmente o que `/reposicao`
 * renderiza. **Esta tela nao tem contrapartida no desenho.**
 *
 * A leitura facil seria fundi-la la. A medicao diz o contrario -- e nao pelo
 * motivo que esta linha afirmou primeiro. **CORRIGIDO em D-280:** a versao
 * original deste comentario dizia que `/reposicao` estava "muda por um defeito
 * na RPC". Estava errado: a medicao que originou a frase passou `null` num
 * `p_date_to` que nao tem default, e um nulo ali zerava toda a janela de
 * venda. Com data real, `/reposicao` classifica normalmente.
 *
 * Medido no Dev em 2026-09-09, com data real nas duas:
 *
 *   /cobertura     3.257 SKUs, **324 em ruptura**
 *   /reposicao     3.284 SKUs, **139 em RUPTURA** (2.818 sem estado)
 *
 * As duas discordam em 185 SKUs, e a divergencia e REAL -- elas medem coisas
 * diferentes por caminhos diferentes:
 *
 *   aqui        OBSERVACAO: estoque LOCAL dividido pela venda media de 30 dias
 *   /reposicao  RECOMENDACAO: local + Full + transito, com lead time e
 *               cobertura alvo, e sujeita as quatro recusas de D-147
 *
 * Fundir as duas exige escolher UMA definicao de ruptura, e essa escolha e de
 * produto, nao de acabamento visual. Continua sendo a direcao certa do
 * desenho; nao e uma fatia de passe visual.
 *
 * Janela FIXA de 30 dias — sem seletor de período nesta primeira fatia,
 * mesmo raciocínio de "escopo deliberadamente menor" já usado em outras
 * telas desta sessão. `get_stock_coverage` faz a soma em SQL, nunca aqui
 * (docs/ARCHITECTURE.md secao 21: "Zero agregação em JavaScript").
 */

const LOOKBACK_DAYS = 30;

/**
 * O gerador de tipos do Supabase não marca colunas de retorno de RPC como
 * anuláveis a partir da lógica SQL (`title`/`days_of_coverage` podem ser
 * `NULL` de verdade — `skus.title` é uma coluna anulável, e o `CASE` da
 * função devolve `NULL` quando não há venda no período) — mesma lacuna já
 * documentada nesta sessão para PARÂMETROS de RPC, aqui do lado do retorno.
 * Tipo local reflete a nulidade real, conferida contra o corpo da função.
 */
interface CoverageRow {
  sku_id: string;
  sku: string;
  title: string | null;
  local_quantity: number;
  units_sold: number;
  avg_daily_sales: number;
  days_of_coverage: number | null;
  is_ruptura: boolean;
  stock_is_virtual: boolean;
  units_15d: number;
  units_30d: number;
  units_60d: number;
  units_90d: number;
  history_days_90: number;
}

/**
 * Quantas linhas a tela mostra por vez. O conjunto real passa de 2.600 e o
 * teto do PostgREST é 1.000 — pedir "tudo" nunca trouxe tudo, só escondia o
 * corte (D-131). Com a ordenação em SQL, as primeiras linhas são as que
 * importam: ruptura antes, cobertura mais curta antes.
 */
const PAGE_SIZE = 200;

export default async function CoberturaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  const membership = await currentMembership(supabase);
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="ESTOQUE / PLANEJAMENTO" title="Cobertura de estoque" compacto />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const filters = resolveCoverageFilters(query);

  const now = new Date();
  const dateTo = toSalesMetricDate(now);
  const dateFrom = toSalesMetricDate(new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 24 * 60 * 60 * 1000));

  // ORDENAÇÃO E LIMITE EXPLÍCITOS (D-131). Antes, esta chamada não tinha
  // `.range()`: o PostgREST devolvia 1.000 das 2.602 linhas por causa de
  // `max_rows = 1000`, e a página ordenava e CONTAVA em JavaScript sobre essa
  // fatia arbitrária. O cabeçalho anunciava uma ruptura contada numa amostra
  // — a real é 924. Ordenar em SQL também respeita `docs/ARCHITECTURE.md`
  // secao 15/21; a ordem é a mesma de antes, só que agora sobre o conjunto
  // inteiro: virtual por último (não é urgência, é ausência de resposta),
  // ruptura primeiro, depois menor cobertura.
  const [coverage, summary, brandsResult] = await Promise.all([
    supabase
      .rpc("get_stock_coverage", {
        p_organization_id: organizationId,
        p_date_from: dateFrom,
        p_date_to: dateTo,
        p_supplier_brand: filters.brand,
      })
      .order("stock_is_virtual")
      .order("is_ruptura", { ascending: false })
      .order("days_of_coverage", { nullsFirst: false })
      .range(0, PAGE_SIZE - 1),
    // Os totais recebem o MESMO filtro: com recorte, "924 em ruptura" tem de
    // ser da marca, não da operação inteira — senão o cabeçalho contradiz a
    // tabela logo abaixo dele.
    supabase.rpc("get_stock_coverage_summary", {
      p_organization_id: organizationId,
      p_date_from: dateFrom,
      p_date_to: dateTo,
      p_supplier_brand: filters.brand,
    }),
    // A lista vem do BANCO, nunca das linhas da página (D-194): montá-la a
    // partir do resultado paginado fazia 10 das 19 marcas nunca aparecerem.
    supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
  ]);

  const { data, error } = coverage;

  const rows = (data ?? []) as CoverageRow[];

  // Os totais vêm do Postgres sobre o conjunto INTEIRO — nunca de contar o
  // que coube na página.
  const brands = (brandsResult.data ?? []).map((r) => r.supplier_brand);
  const totals = summary.data?.[0] ?? null;
  const rupturaCount = totals?.em_ruptura ?? 0;
  const virtualCount = totals?.virtuais ?? 0;
  const totalCount = totals?.total ?? rows.length;

  /*
    Os tres numeros que esta tela MEDE, tirados do paragrafo onde estavam
    misturados com as definicoes. O paragrafo dizia o total, a ruptura, a
    ressalva do estoque virtual e o convite a classificar, tudo corrido -- os
    numeros ficavam invisiveis no meio do texto (D-279).

    Nao ha quarta celula. "Vendas perdidas estimadas" e o que o item do ROADMAP
    pede junto de cobertura e ruptura, e continua fora por falta de saldo
    inicial no ledger (D-061): a estimativa exigiria saber o estoque no comeco
    do periodo, e o ledger comeca depois.
  */
  const celulas: readonly KpiCellData[] = [
    {
      label: "SKUs no recorte",
      formula:
        "SKUs com estoque local ou venda registrada nos ultimos 30 dias. O total vem do Postgres sobre o conjunto inteiro, nunca de contar a pagina.",
      value: formatCount(totalCount),
      previous: null,
      tom: "neutro",
    },
    {
      label: "Em ruptura",
      formula:
        "Sem estoque local E com venda registrada no periodo -- demanda perdida agora. Zero estoque sem venda nao e ruptura, e catalogo parado.",
      value: formatCount(rupturaCount),
      previous: null,
      tom: "perigo",
    },
    {
      label: "Com estoque virtual",
      formula:
        "Saldo sentinela do ERP, nao contagem fisica (D-127). Para esses a cobertura fica em branco de proposito.",
      value: formatCount(virtualCount),
      previous: null,
      // Spread condicional, nao `ressalva: ... : undefined`:
      // `exactOptionalPropertyTypes` exige a chave de fato AUSENTE (o mesmo
      // motivo ja registrado em `notas-fiscais/actions.ts`).
      ...(virtualCount > 0
        ? {
            ressalva:
              "cobertura em branco: sem saldo real, um numero seria resposta errada com cara de precisa",
          }
        : {}),
      href: "/produtos?estado=pendente&sinal=sentinela",
      tom: "atencao",
    },
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / PLANEJAMENTO"
        title="Cobertura de estoque"
        subtitle={`Estoque local dividido pela venda média diária — quantos dias faltam para esgotar no ritmo atual. Últimos ${String(LOOKBACK_DAYS)} dias (${dateFrom} a ${dateTo})${filters.brand === null ? "" : `, só ${filters.brand}`}.`}
        aside={
          /*
            O par desta tela. Aqui e OBSERVACAO -- onde o estoque esta; la e
            RECOMENDACAO -- o que comprar, com lead time e cobertura alvo. O
            frame trata as duas como uma tela so, e a fusao continua sendo a
            direcao certa; o motivo de nao ser hoje esta medido no topo do
            arquivo (D-279).
          */
          <Link className="sb-button" href="/reposicao" style={{ textDecoration: "none" }}>
            Sugestão de compra →
          </Link>
        }
      />

      <KpiStrip cells={celulas} />

      <p style={{ margin: "var(--sb-space-3) 0", fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
        SKU com saldo sentinela ainda não classificado aparece aqui como se o número fosse real —{" "}
        <Link href="/produtos?estado=pendente&amp;sinal=sentinela">classificar estoque virtual</Link>.
      </p>

      {/*
        Só MARCA. Não há seletor de conta aqui de propósito: estoque físico é
        da organização (regra do item P1) — Full é que é por conta, e quem
        responde por conta é a Central Full.
      */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--sb-space-2)",
          alignItems: "center",
          marginBottom: "var(--sb-space-3)",
        }}
      >
        <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", minWidth: "4rem" }}>Marca</span>
        <FilterPill href={buildCoverageHref(filters, { brand: null })} active={filters.brand === null}>
          Todas
        </FilterPill>
        {brands.map((brand) => (
          <FilterPill key={brand} href={buildCoverageHref(filters, { brand })} active={filters.brand === brand}>
            {brand}
          </FilterPill>
        ))}
      </div>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <Panel
          title="Cobertura por SKU"
          subtitle={
            totalCount > rows.length
              ? `Mostrando os ${formatCount(rows.length)} mais urgentes de ${formatCount(totalCount)} SKUs — ruptura primeiro, depois menor cobertura. Os números acima são do conjunto inteiro, não desta página.`
              : `${formatCount(totalCount)} SKU(s) — ruptura primeiro, depois menor cobertura.`
          }
        >
        {rows.length === 0 && (
          <p className="sb-empty">
            {filters.brand === null
              ? "Nenhum SKU com estoque local ou venda recente."
              : `Nenhum SKU de ${filters.brand} com estoque local ou venda recente. A operação inteira pode ter — este é o recorte da marca.`}
          </p>
        )}

        {rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="sb-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th className="sb-num">Estoque local</th>
                <th className="sb-num">Vendido no período</th>
                <th className="sb-num">Média/dia</th>
                <th className="sb-num">Cobertura (dias)</th>
                <th>Tendência</th>
              </tr>
            </thead>

            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.sku_id}
                  style={
                    row.stock_is_virtual
                      ? { color: "var(--sb-text-soft)" }
                      : row.is_ruptura
                        ? { background: "var(--sb-danger-soft)" }
                        : undefined
                  }
                >
                  <td className="sb-mono">
                    {row.sku}
                    {row.title !== null && (
                      <div style={{ fontFamily: "inherit", color: "var(--sb-text-soft)", fontSize: "0.75rem" }}>
                        {row.title}
                      </div>
                    )}
                  </td>
                  <td className="sb-num">{formatCount(row.local_quantity)}</td>
                  <td className="sb-num">{formatCount(row.units_sold)}</td>
                  <td className="sb-num">{row.avg_daily_sales}</td>
                  <td className="sb-num">
                    {row.stock_is_virtual
                      ? "estoque virtual"
                      : row.is_ruptura
                        ? "Em ruptura"
                        : (row.days_of_coverage ?? "—")}
                  </td>
                  <td>
                    {/* Classificação e aparência compartilhadas com /reposicao (D-147). */}
                    <TrendBadge
                      units15={row.units_15d}
                      units30={row.units_30d}
                      units60={row.units_60d}
                      units90={row.units_90d}
                      historyDays90={row.history_days_90}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
        </Panel>
      )}
    </Shell>
  );
}
