import { composeSkuReplenishment, toSalesMetricDate } from "@sb/domain";
import type {
  PurchaseSuggestionRefusal,
  ReplenishmentSetting,
  StockOperationalState,
  StockStateRefusal,
} from "@sb/domain";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { CarregandoSeODemorar } from "../../components/carregando-link";
import { FilterMenu } from "../../components/filter-menu";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { TOM, type Tom } from "../../components/tone";
import { TrendBadge } from "../../components/trend-badge";
import { formatCount, formatCurrency, formatDateTime } from "../../lib/format";
import {
  PAGE_SIZE,
  buildReplenishmentHref,
  resolveReplenishmentFilters,
  summarizeReplenishmentWindow,
} from "../../lib/replenishment-filters";
import { idadeDaLeitura, lerVisaoReposicao, posicaoCobertura } from "../../lib/replenishment-overview";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";

import { podeOperarCompras } from "../../lib/purchase-order-permission";
import { SelecaoPedido } from "./selecao-pedido";

export const metadata = { title: "Cobertura e reposição — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Cobertura e reposição — sugestão de compra auditável (D-147), fundida com a
 * cobertura em D-288 e refeita em D-358.
 *
 * A conta inteira continua em `@sb/domain` (`composeSkuReplenishment`): a RPC
 * entrega INGREDIENTES e a tela monta cada linha pela fórmula única, mostrando a
 * decomposição — "por que comprar 48?". As recusas são resposta, não erro.
 *
 * ## D-358: uma leitura, e a tela que pergunta "o que comprar agora?"
 *
 * Eram duas RPCs (`get_purchase_suggestions` e `get_purchase_state_counts`), e a
 * segunda delegava na primeira com limite de um milhão: cada carregamento
 * classificava o catálogo inteiro DUAS vezes, ~490 ms cada no Dev. Agora
 * `get_replenishment_overview` classifica uma vez (plano custom, ~255 ms) e
 * devolve a página, a contagem por estado, o investimento sugerido e o frescor
 * das entradas. Nada é somado aqui: os agregados vêm do SQL.
 */

const REFUSAL_LABEL: Record<PurchaseSuggestionRefusal, string> = {
  SEM_CONFIGURACAO: "sem configuração",
  ESTOQUE_VIRTUAL: "estoque virtual",
  HISTORICO_INCOMPLETO: "histórico incompleto",
  AMOSTRA_INSUFICIENTE: "sem amostra",
};

/** Os estados (D-148) herdam as recusas da sugestão, mais uma própria. */
const STATE_REFUSAL_LABEL: Record<StockStateRefusal, string> = {
  ...REFUSAL_LABEL,
  SEM_DEMANDA_RECENTE: "sem demanda recente",
};

/**
 * Tom por severidade (D-007: nunca todas as cores com o mesmo peso). Ruptura e
 * urgente em perigo; os dois avisos em atenção; adequada em ok; excesso em
 * informação — capital parado pede decisão, mas não é falta.
 */
const ESTADOS: Record<StockOperationalState, { rotulo: string; tom: Tom; descricao: string }> = {
  RUPTURA: { rotulo: "Em ruptura", tom: "perigo", descricao: "aproveitável zerado ou negativo" },
  COMPRA_URGENTE: { rotulo: "Compra urgente", tom: "perigo", descricao: "cobertura dentro do prazo do fornecedor" },
  COMPRAR_EM_BREVE: { rotulo: "Comprar em breve", tom: "atencao", descricao: "abaixo do ponto de pedido" },
  COBERTURA_BAIXA: { rotulo: "Cobertura baixa", tom: "atencao", descricao: "abaixo da janela de demanda" },
  ADEQUADA: { rotulo: "Adequada", tom: "ok", descricao: "cobre a janela de demanda" },
  EXCESSO: { rotulo: "Excesso", tom: "info", descricao: "acima do teto de cobertura" },
};

const ORDEM_ESTADOS: readonly StockOperationalState[] = [
  "RUPTURA",
  "COMPRA_URGENTE",
  "COMPRAR_EM_BREVE",
  "COBERTURA_BAIXA",
  "ADEQUADA",
  "EXCESSO",
];

const URGENTES = new Set<string>(["RUPTURA", "COMPRA_URGENTE"]);

const RATE = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "R$ 1,35 mi", "R$ 758 mil" — o cartão pede ordem de grandeza; o valor exato fica no `title`. */
const COMPACTO = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  notation: "compact",
  maximumFractionDigits: 1,
});

function scopeLabel(scope: "SKU" | "MARCA" | "PADRAO", brand: string | null): string {
  if (scope === "SKU") return "regra do SKU";
  if (scope === "MARCA") return `regra da marca ${brand ?? ""}`;

  return "padrão da organização";
}

function ehEstado(valor: string | null): valor is StockOperationalState {
  return valor !== null && valor in ESTADOS;
}

export default async function ReposicaoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  const membership = await currentMembership();
  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="ESTOQUE / PLANEJAMENTO" title="Cobertura e reposição" />
        <p style={{ color: "var(--sb-text-soft)" }}>Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const filters = resolveReplenishmentFilters(query);
  const dateTo = toSalesMetricDate(new Date());

  // Três leituras numa ida (D-185). A pesada é UMA agora (D-358).
  const [overviewResult, settingsResult, brandsResult] = await Promise.all([
    supabase.rpc("get_replenishment_overview", {
      p_organization_id: organizationId,
      p_date_to: dateTo,
      p_supplier_brand: filters.brand,
      p_search: filters.search,
      p_state: filters.state,
      p_limit: PAGE_SIZE,
      p_offset: (filters.page - 1) * PAGE_SIZE,
    }),
    supabase
      .from("replenishment_settings")
      .select(
        "supplier_brand, sku_id, lead_time_days, target_coverage_days, safety_stock_days, max_coverage_days, policy_note",
      ),
    // D-194: a agregação das marcas é do BANCO.
    supabase.rpc("get_supplier_brands", { p_organization_id: organizationId }),
  ]);

  const visao = overviewResult.error === null ? lerVisaoReposicao(overviewResult.data) : null;
  const erro =
    overviewResult.error?.message ??
    settingsResult.error?.message ??
    brandsResult.error?.message ??
    (visao === null ? "a leitura da reposição voltou fora do contrato esperado" : null);

  const settings: ReplenishmentSetting[] = (settingsResult.data ?? []).map((s) => ({
    supplierBrand: s.supplier_brand,
    skuId: s.sku_id,
    leadTimeDays: s.lead_time_days,
    targetCoverageDays: s.target_coverage_days,
    safetyStockDays: s.safety_stock_days,
    maxCoverageDays: s.max_coverage_days,
    policyNote: s.policy_note,
  }));

  const brands = (brandsResult.data ?? []).map((r) => r.supplier_brand);
  const temTeto = settings.some((s) => s.maxCoverageDays !== null);

  const agora = new Date();
  const frescorVendas = idadeDaLeitura(visao?.vendasCalculadasEm ?? null, agora);
  const frescorFull = idadeDaLeitura(visao?.fullCapturadoEm ?? null, agora);

  const contagem = new Map((visao?.contagens ?? []).map((c) => [c.state, c]));
  const windowInfo = summarizeReplenishmentWindow(filters.page, visao?.total ?? 0, visao?.linhas.length ?? 0);

  const filtroAtivo = filters.brand !== null || filters.search !== null || filters.state !== null;
  const estadoAtivo = ehEstado(filters.state) ? ESTADOS[filters.state].rotulo : filters.state === "SEM_ESTADO" ? "Sem estado" : null;

  return (
    <Shell>
      {/* Sobrancelha e título do frame `Coverage` (ESTOQUE / PLANEJAMENTO). */}
      <PageTitle
        eyebrow="ESTOQUE / PLANEJAMENTO"
        title="Cobertura e reposição"
        subtitle="Quantos dias o estoque aguenta e quanto comprar — o aproveitável (local + Full + trânsito) contra a venda dos últimos 30 dias, o prazo do fornecedor e a cobertura desejada."
        aside={
          <>
            <FilterMenu
              rotulo={filters.brand ?? "Todas as marcas"}
              opcoes={[
                { href: buildReplenishmentHref(filters, { brand: null }), ativo: filters.brand === null, label: "Todas as marcas" },
                ...brands.map((brand) => ({
                  href: buildReplenishmentHref(filters, { brand }),
                  ativo: filters.brand === brand,
                  label: brand,
                })),
              ]}
            />
            <form method="get" action="/reposicao" className="sb-rep-busca">
              {/* Hidden por dimensão ativa: GET nativo só envia campos do form (D-136). */}
              {filters.brand !== null && <input type="hidden" name="marca" value={filters.brand} />}
              {filters.state !== null && <input type="hidden" name="estado" value={filters.state} />}
              <input
                className="sb-input"
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder="SKU ou título"
                aria-label="Buscar por SKU ou título"
              />
              <button type="submit" className="sb-button">
                Buscar
              </button>
            </form>
            <Link className="sb-button" href="/reposicao/configuracoes">
              Configurações
            </Link>
          </>
        }
      />

      {erro !== null && (
        <p role="alert" className="sb-note sb-note-perigo" style={{ margin: "0 0 var(--sb-space-3)" }}>
          Não foi possível carregar a reposição: {erro}
        </p>
      )}

      {erro === null && settings.length === 0 && (
        <div role="alert" className="sb-rep-aviso">
          <div>
            <b>Nenhuma configuração de reposição cadastrada</b>
            <span>
              Sem prazo do fornecedor e cobertura desejada, a sugestão recusa número para todos os SKUs — de
              propósito, em vez de inventar uma política.
            </span>
          </div>
          <Link className="sb-button sb-button-primary" href="/reposicao/configuracoes">
            Cadastrar a primeira regra
          </Link>
        </div>
      )}

      {visao !== null && (
        <>
          {/*
            O RESUMO DE DECISÃO: o que comprar agora e quanto custa tudo. Os dois
            agregados vêm prontos do SQL, no mesmo conjunto dos cartões (marca e
            busca, sem o filtro de estado).
          */}
          <section className="sb-rep-resumo" aria-label="Resumo da reposição">
            <div className="sb-rep-destaque sb-rep-destaque-perigo">
              <span className="sb-rep-destaque-rotulo">Comprar agora</span>
              <strong>{formatCount(visao.comprarAgora.skus)} SKUs</strong>
              <span className="sb-rep-destaque-nota">
                em ruptura ou compra urgente · {formatCount(visao.comprarAgora.unidades)} un sugeridas
              </span>
            </div>

            <div className="sb-rep-destaque" title={formatCurrency(visao.comprarAgora.investimento)}>
              <span className="sb-rep-destaque-rotulo">Investimento para comprar agora</span>
              <strong>{COMPACTO.format(visao.comprarAgora.investimento)}</strong>
              <span className="sb-rep-destaque-nota">
                custo cadastrado × sugestão
                {visao.comprarAgora.sem_custo > 0 && ` · ${formatCount(visao.comprarAgora.sem_custo)} SKU(s) sem custo fora da conta`}
              </span>
            </div>

            <div className="sb-rep-destaque" title={formatCurrency(visao.totais.investimento)}>
              <span className="sb-rep-destaque-rotulo">Investimento sugerido total</span>
              <strong>{COMPACTO.format(visao.totais.investimento)}</strong>
              <span className="sb-rep-destaque-nota">
                {formatCount(visao.totais.unidades)} un em todos os estados
                {visao.totais.sem_custo > 0 && ` · ${formatCount(visao.totais.sem_custo)} sem custo`}
              </span>
            </div>

            <div className="sb-rep-destaque sb-rep-frescor">
              <span className="sb-rep-destaque-rotulo">Dados usados</span>
              <span className={frescorVendas?.velha === true ? "sb-rep-selo sb-rep-selo-velho" : "sb-rep-selo"}>
                <i aria-hidden="true" />
                Vendas {frescorVendas === null ? "sem recálculo" : `recalculadas ${frescorVendas.texto}`}
              </span>
              <span className={frescorFull?.velha === true ? "sb-rep-selo sb-rep-selo-velho" : "sb-rep-selo"}>
                <i aria-hidden="true" />
                Full {frescorFull === null ? "sem captura nos últimos 3 dias" : `capturado ${frescorFull.texto}`}
              </span>
            </div>
          </section>

          {/*
            OS SETE ESTADOS (D-250): os seis do vocabulário canônico mais o
            bucket de recusa. Excesso sem teto configurado não mostra zero mudo.
          */}
          <nav className="sb-rep-estados" aria-label="Filtrar por estado">
            {ORDEM_ESTADOS.map((estado) => {
              const dado = contagem.get(estado);
              const ativo = filters.state === estado;
              const semTeto = estado === "EXCESSO" && !temTeto;

              return (
                <Link
                  key={estado}
                  href={buildReplenishmentHref(filters, { state: ativo ? null : estado })}
                  className={ativo ? "sb-rep-estado sb-rep-estado-ativo" : "sb-rep-estado"}
                  style={{ "--sb-rep-tom": TOM[ESTADOS[estado].tom].color } as CSSProperties}
                  aria-current={ativo ? "true" : undefined}
                >
                  <span className="sb-rep-estado-rotulo">{ESTADOS[estado].rotulo}</span>
                  <strong>{semTeto ? "—" : formatCount(dado?.skus ?? 0)}</strong>
                  <small>
                    {semTeto
                      ? "exige teto de cobertura configurado"
                      : dado !== undefined && dado.investimento > 0
                        ? `${COMPACTO.format(dado.investimento)} · ${formatCount(dado.unidades)} un`
                        : ESTADOS[estado].descricao}
                  </small>
                  <CarregandoSeODemorar />
                </Link>
              );
            })}

            <Link
              href={buildReplenishmentHref(filters, { state: filters.state === "SEM_ESTADO" ? null : "SEM_ESTADO" })}
              className={filters.state === "SEM_ESTADO" ? "sb-rep-estado sb-rep-estado-ativo" : "sb-rep-estado"}
              style={{ "--sb-rep-tom": "var(--sb-muted-ink)" } as CSSProperties}
              aria-current={filters.state === "SEM_ESTADO" ? "true" : undefined}
            >
              <span className="sb-rep-estado-rotulo">Sem estado</span>
              <strong>{formatCount(contagem.get("SEM_ESTADO")?.skus ?? 0)}</strong>
              <small>sem configuração, estoque virtual, histórico ou amostra</small>
              <CarregandoSeODemorar />
            </Link>
          </nav>

          <details className="sb-rep-metodo">
            <summary>Como a conta é feita</summary>
            <div>
              <p>
                <b>Sugestão = venda/dia (30d) × janela de demanda − estoque aproveitável.</b> A janela vem da{" "}
                <Link href="/reposicao/configuracoes">configuração de reposição</Link> (prazo + cobertura +
                segurança); o aproveitável soma local, Full e trânsito, com o reservado fora. É cálculo
                determinístico, nunca IA — e quando falta base (configuração, estoque real, histórico ou amostra), a
                linha diz o motivo em vez de inventar número.
              </p>
              <p>
                O <b>estado</b> compara a cobertura em dias com os limiares da própria política: prazo, ponto de
                pedido, janela e teto. Excesso só é afirmado com teto configurado. A <b>ordem é a prioridade de
                compra</b>, por chaves explicáveis e sem pesos: estado (ruptura primeiro), classe ABC, menor
                cobertura, maior venda recente. Priorizar é ordenar — a compra continua decisão sua.
              </p>
              <p>
                O <b>investimento</b> multiplica a sugestão pelo custo cadastrado; SKU sem custo fica fora da soma e
                é contado à parte. SKU com estoque virtual destrava no{" "}
                <Link href="/produtos?estado=pendente&sinal=sentinela">ensaio de classificação</Link>.
              </p>
            </div>
          </details>

          <Panel
            title={estadoAtivo === null ? "Recomendação de compra" : `Recomendação de compra · ${estadoAtivo}`}
            subtitle={`Em ordem de prioridade. ${windowInfo.label}`}
            aside={
              <>
                {filtroAtivo && (
                  <Link className="sb-button" href="/reposicao">
                    Limpar filtros
                    <CarregandoSeODemorar />
                  </Link>
                )}
                {windowInfo.totalPages > 1 && (
                  <span className="sb-rep-paginas">
                    {filters.page > 1 && (
                      <Link className="sb-button" href={buildReplenishmentHref(filters, { page: filters.page - 1 })}>
                        ‹ Anterior
                        <CarregandoSeODemorar />
                      </Link>
                    )}
                    <span>
                      {filters.page} de {windowInfo.totalPages}
                    </span>
                    {filters.page < windowInfo.totalPages && (
                      <Link className="sb-button" href={buildReplenishmentHref(filters, { page: filters.page + 1 })}>
                        Próxima ›
                        <CarregandoSeODemorar />
                      </Link>
                    )}
                  </span>
                )}
              </>
            }
          >
            {visao.linhas.length === 0 && (
              <p className="sb-empty">
                Nenhum SKU corresponde a estes filtros.{" "}
                {filtroAtivo && <Link href="/reposicao">Ver todos</Link>}
              </p>
            )}

            {visao.linhas.length > 0 && (
              <>
                {/*
                  A ponte cobertura→pedido (D-151): GET nativo para /compras/novo
                  com pares `sku=<uuid>:<qtd sugerida>` — o pedido nasce como
                  RASCUNHO e segue a aprovação humana de D-055.
                */}
                <form id="rep-pedido" action="/compras/novo" method="get">
                  <div style={{ overflowX: "auto" }}>
                    <table className="sb-table sb-rep-tabela">
                      <thead>
                        <tr>
                          <th title="Marque para levar ao pedido de compra — só linhas com sugestão defensável">
                            <span className="sb-sr-only">Pedido</span>
                          </th>
                          <th>SKU</th>
                          <th title="Curva ABC por faturamento, 90 dias (D-140) — segunda chave da prioridade">Classe</th>
                          <th className="sb-num" title="Venda média diária dos últimos 30 dias">Venda/dia</th>
                          <th>Tendência</th>
                          <th className="sb-num" title="Local + Full + trânsito, com o reservado fora">
                            Aproveitável
                          </th>
                          {/*
                            A coluna que veio de `/cobertura` na fusão (D-288):
                            aproveitável ÷ venda média diária dos últimos 30 dias.
                          */}
                          <th title="Aproveitável ÷ venda média diária dos últimos 30 dias — quantos dias faltam para esgotar no ritmo atual">
                            Cobertura (dias)
                          </th>
                          <th>Estado</th>
                          <th className="sb-num">Sugestão</th>
                          <th className="sb-num" title="Custo cadastrado × sugestão">Custo</th>
                        </tr>
                      </thead>

                      <tbody>
                        {visao.linhas.map((row) => {
                          /*
                            A composição vem das peças canônicas — a tela nunca
                            refaz uma conta por dentro (regra da fórmula única,
                            composição compartilhada com o Copiloto desde D-293).
                          */
                          const { usable, policy, suggestion, stockState } = composeSkuReplenishment(row, settings);
                          const { breakdown } = suggestion;
                          const sugestao = suggestion.suggestedQuantity;
                          // Custo nulo ou 0 é desconhecido, nunca zero (D-356).
                          const custo = row.purchase_cost !== null && row.purchase_cost > 0 ? row.purchase_cost : null;
                          const custoLinha = sugestao !== null && sugestao > 0 && custo !== null ? sugestao * custo : null;
                          const estado = stockState.state;
                          const barra = posicaoCobertura(stockState.coverageDays, breakdown.demandWindowDays);

                          return (
                            <tr key={row.sku_id} className={estado !== null && URGENTES.has(estado) ? "sb-rep-linha-urgente" : undefined}>
                              <td className="sb-rep-marcar">
                                {/*
                                  Só onde há SUGESTÃO defensável e positiva — linha
                                  recusada ou coberta não tem o que pedir.
                                */}
                                {sugestao !== null && sugestao > 0 && (
                                  <input
                                    type="checkbox"
                                    name="sku"
                                    value={`${row.sku_id}:${String(sugestao)}`}
                                    data-unidades={String(sugestao)}
                                    {...(custoLinha === null ? {} : { "data-custo": String(custoLinha) })}
                                    {...(estado !== null && URGENTES.has(estado) ? { "data-urgente": "1" } : {})}
                                    aria-label={`Levar ${row.sku} ao pedido de compra com ${String(sugestao)} unidade(s)`}
                                  />
                                )}
                              </td>
                              <td>
                                <Link className="sb-rep-sku" href={`/skus/${row.sku_id}`}>
                                  {row.sku}
                                </Link>
                                <span className="sb-rep-titulo">
                                  {row.title ?? "sem título"}
                                  {/* Marca vazia é estado legítimo (D-129). */}
                                  {row.supplier_brand !== null && <em> · {row.supplier_brand}</em>}
                                </span>
                              </td>
                              <td>
                                {/* "—" = sem venda no período da curva, não classe faltando. */}
                                {row.abc_class === null ? (
                                  <span className="sb-rep-mudo">—</span>
                                ) : (
                                  <span className={`sb-rep-abc sb-rep-abc-${row.abc_class.toLowerCase()}`}>{row.abc_class}</span>
                                )}
                              </td>
                              <td className="sb-num">{RATE.format(breakdown.dailyRate)}</td>
                              <td>
                                <TrendBadge
                                  units15={row.units_15d}
                                  units30={row.units_30d}
                                  units60={row.units_60d}
                                  units90={row.units_90d}
                                  historyDays90={row.history_days_90}
                                />
                              </td>
                              <td className="sb-num">
                                {usable.total === null ? (
                                  <span className="sb-rep-mudo">estoque virtual</span>
                                ) : (
                                  <>
                                    <span style={usable.total < 0 ? { color: "var(--sb-danger)", fontWeight: 600 } : undefined}>
                                      {formatCount(usable.total)}
                                    </span>
                                    <span
                                      className="sb-rep-partes"
                                      title={`reservado ${String(usable.components.reservedExcluded)} fica fora`}
                                    >
                                      L {formatCount(usable.components.local)} · F {formatCount(usable.components.full)} · T{" "}
                                      {formatCount(usable.components.transit)}
                                    </span>
                                  </>
                                )}
                              </td>
                              <td>
                                {stockState.coverageDays === null ? (
                                  <span
                                    className="sb-rep-mudo"
                                    title={
                                      usable.total === null
                                        ? "saldo sentinela: a cobertura fica em branco de propósito (D-127)"
                                        : "sem venda na janela — não há taxa para dividir"
                                    }
                                  >
                                    —
                                  </span>
                                ) : (
                                  <span
                                    className="sb-rep-cobertura"
                                    title={
                                      policy === null || breakdown.demandWindowDays === null
                                        ? "sem janela de demanda: falta configuração de reposição"
                                        : `janela ${String(breakdown.demandWindowDays)}d = prazo ${String(policy.leadTimeDays)} + cobertura ${String(policy.targetCoverageDays)} + segurança ${String(policy.safetyStockDays)} · ${scopeLabel(policy.scope, policy.supplierBrand)}`
                                    }
                                  >
                                    <b>{RATE.format(stockState.coverageDays)}</b>
                                    {barra !== null && (
                                      <span
                                        className="sb-rep-barra"
                                        style={{ "--sb-rep-tom": estado === null ? "var(--sb-muted-ink)" : TOM[ESTADOS[estado].tom].color } as CSSProperties}
                                        aria-hidden="true"
                                      >
                                        <i style={{ width: `${barra.toFixed(1)}%` }} />
                                      </span>
                                    )}
                                    {breakdown.demandWindowDays !== null && (
                                      <small>janela {formatCount(breakdown.demandWindowDays)}d</small>
                                    )}
                                  </span>
                                )}
                              </td>
                              <td>
                                {estado === null ? (
                                  <span className="sb-rep-recusa">
                                    {stockState.refusals.map((r) => (
                                      <span key={r}>{STATE_REFUSAL_LABEL[r]}</span>
                                    ))}
                                  </span>
                                ) : (
                                  <span
                                    className="sb-status"
                                    style={TOM[ESTADOS[estado].tom]}
                                    title={`cobertura ${stockState.coverageDays === null ? "0" : RATE.format(stockState.coverageDays)}d · prazo ${String(stockState.thresholds.leadTimeDays)} · ponto de pedido ${String(stockState.thresholds.reorderPointDays)} · janela ${String(stockState.thresholds.demandWindowDays)}${stockState.thresholds.maxCoverageDays === null ? " · teto de excesso não configurado" : ` · teto ${String(stockState.thresholds.maxCoverageDays)}`}`}
                                  >
                                    {ESTADOS[estado].rotulo}
                                  </span>
                                )}
                              </td>
                              <td className="sb-num">
                                {sugestao === null ? (
                                  /*
                                    O motivo já está na coluna Estado, ao lado:
                                    repeti-lo aqui dobrava a largura da tabela e
                                    empurrava custo para fora da tela. Fica no
                                    `title`, para quem pergunta "por que não?".
                                  */
                                  <span className="sb-rep-mudo" title={`sem sugestão: ${suggestion.refusals.map((r) => REFUSAL_LABEL[r]).join(" · ")}`}>
                                    —
                                  </span>
                                ) : sugestao === 0 ? (
                                  <span
                                    className="sb-rep-mudo"
                                    title={`${RATE.format(breakdown.dailyRate)}/dia × ${String(breakdown.demandWindowDays)}d = ${String(breakdown.projectedDemand)} projetado − ${String(breakdown.usableStock)} aproveitável — a janela já está coberta`}
                                  >
                                    0
                                  </span>
                                ) : (
                                  <span
                                    className="sb-rep-sugestao"
                                    title={`${RATE.format(breakdown.dailyRate)}/dia × ${String(breakdown.demandWindowDays)}d = ${String(breakdown.projectedDemand)} projetado − ${String(breakdown.usableStock)} aproveitável = comprar ${String(sugestao)}`}
                                  >
                                    {formatCount(sugestao)} <small>un</small>
                                  </span>
                                )}
                              </td>
                              <td className="sb-num">
                                {custoLinha !== null ? (
                                  <span title="custo CADASTRADO × sugestão — o custo do PEDIDO é editável na criação e nunca escreve de volta no cadastro (D-149)">
                                    {formatCurrency(custoLinha)}
                                  </span>
                                ) : sugestao !== null && sugestao > 0 ? (
                                  <span className="sb-rep-mudo">sem custo</span>
                                ) : (
                                  <span className="sb-rep-mudo">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </form>

                {/* A seleção vira pedido de compra, e só ADMIN/GESTOR cria pedido
                    (`check_purchase_order_writer`) — lote 1 do pente fino, 18/09. */}
                {podeOperarCompras(membership.role) ? (
                  <SelecaoPedido formId="rep-pedido" />
                ) : (
                  <p className="sb-rep-rodape">Pedidos de compra são criados por ADMIN ou GESTOR.</p>
                )}
              </>
            )}
          </Panel>

          {(visao.vendasCalculadasEm !== null || visao.fullCapturadoEm !== null) && (
            <p className="sb-rep-rodape">
              Vendas recalculadas em {visao.vendasCalculadasEm === null ? "—" : formatDateTime(visao.vendasCalculadasEm)} ·
              Full capturado em {visao.fullCapturadoEm === null ? "—" : formatDateTime(visao.fullCapturadoEm)} · o pedido
              nasce como rascunho, com quantidade e custo revisáveis e aprovação humana.
            </p>
          )}
        </>
      )}
    </Shell>
  );
}
