import type { ReactNode } from "react";

import Link from "next/link";

import { FilterMenu } from "../../components/filter-menu";
import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatePill } from "../../components/state-pill";
import { PAGE_SIZES } from "../../lib/filters";
import { formatCount, formatDateTime } from "../../lib/format";
import {
  CRITICAL_COVERAGE_DAYS,
  FULL_SITUATIONS,
  FULL_SORTS,
  LOW_COVERAGE_DAYS,
  buildFullHref,
  coverageOf,
  coverageTom,
  formatCoverage,
  fullFocusCriterion,
  fullFocusLabel,
  fullSituationCriterion,
  fullSituationLabel,
  fullSituationTom,
  fullSortLabel,
  isFullRow,
  resolveFullFilters,
  summarizePagedWindow,
  type FullFilters,
} from "../../lib/full-filters";
import { monogramaDeProduto } from "../../lib/initials";
import { formatAge } from "../../lib/relative-time";
import { currentMembership } from "../../lib/request-membership";
import { createClient } from "../../lib/supabase/server";

export const metadata = { title: "Central Full — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Central Full (D-173, trilha 5E) pelo frame `IntelligenceScreen type="full"`
 * (D25, D-265), reorganizada como FILA DE ENVIO em D-380.
 *
 * **A pergunta do operador é "o que eu mando para o Full agora?"**, e as quatro
 * situações de D-265 só respondiam "tem ou não tem". Medido em produção em
 * 2026-09-18: dos 537 SKUs "saudáveis", 205 acabam em menos de 15 dias no
 * ritmo da janela e 76 em menos de 7 — pintados de verde. D-380 acrescenta:
 *
 * 1. **Cobertura** por linha: saldo no Full ÷ venda média diária da MESMA
 *    janela da coluna "Venda". Aritmética declarada, sem previsão nem score.
 * 2. **Focos** "Acabando" e "Pode enviar hoje" (ruptura ou acabando, com saldo
 *    local), e a ordem padrão por **prioridade de envio** — ruptura primeiro,
 *    pela venda; depois quem acaba antes.
 * 3. **Exportação CSV** do recorte, para montar o envio fora da tela.
 *
 * **O frame esconde o maior estado.** Ele desenha três cartões (Em Ruptura,
 * Parados, Saudáveis) como se fossem todo o conjunto. São quatro situações:
 * `ausente` ("Fora do Full") era 41% do Dev. A faixa aqui tem CINCO células —
 * o total e as quatro situações —, e elas fecham.
 *
 * **Recusas ao frame que continuam valendo, por falta de fonte:**
 *
 * - **"Últ. Envio"** — não existe tabela de envio ao Full. No lugar fica
 *   "Capturado", por linha: cada bucket tem a sua `captured_at`, e é ela que
 *   sustenta a regra dos 3 dias.
 * - **"Repor Full"** — é escrita, e não há política logística no sistema
 *   (custo de envio, lote mínimo, prazo). Fica o LINK para `/reposicao`, que
 *   aceita `busca` (D-147); `/cobertura` só aceita `?marca=` e mandar
 *   `?busca=` para lá seria o filtro fantasma que D-154 impede.
 * - **Nenhuma sugestão de quantidade.** A cobertura diz QUANDO acaba, não
 *   QUANTO mandar.
 * - **Full nunca soma com o estoque local.** Full é por CONTA; Local é da
 *   ORGANIZAÇÃO (regra do PRD) — autoridades diferentes, colunas separadas.
 */

const LOOKBACK_DAYS = 30;

/** Mesma janela da RPC — declarada aqui porque a tela precisa explicá-la. */
const FRESHNESS_DAYS = 3;

/** Lê uma contagem do mapa de facetas. Chave ausente é zero MEDIDO. */
function contaFaceta(facet: unknown, chave: string): number {
  if (typeof facet !== "object" || facet === null) return 0;

  const valor = (facet as Record<string, unknown>)[chave];

  return typeof valor === "number" && Number.isFinite(valor) ? valor : 0;
}

/** A barra da cobertura enche até o dobro do limiar — acima disso é "folgado". */
function larguraDaCobertura(days: number | null): number {
  if (days === null) return 100;

  return Math.max(4, Math.min(100, (days / (LOW_COVERAGE_DAYS * 2)) * 100));
}

export default async function FullPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const filters = resolveFullFilters(await searchParams);
  const supabase = await createClient();

  // A RLS já restringe `ml_accounts` por organização E por permissão de conta
  // (`accessible_accounts`), então esta leitura não depende da anterior — as
  // duas saem juntas. A RPC abaixo SIM depende da conta escolhida.
  const [membership, accounts] = await Promise.all([
    currentMembership(),
    supabase.from("ml_accounts").select("id, label").order("label"),
  ]);

  const organizationId = membership.organizationId;

  if (organizationId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="ESTOQUE / FULL" title="Central Full" />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const accountIds = new Set((accounts.data ?? []).map((row) => row.id));
  const account = filters.account !== null && accountIds.has(filters.account) ? filters.account : null;
  const atual: FullFilters = { ...filters, account };

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

  const argumentos = {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: account,
    p_situation: atual.situation,
    p_search: atual.search,
    p_sku_id: null,
    p_limit: atual.pageSize,
    p_offset: (atual.page - 1) * atual.pageSize,
  };

  const leitura = await supabase.rpc("get_fulfillment_overview", {
    ...argumentos,
    p_focus: atual.focus,
    p_sort: atual.sort,
    p_low_coverage_days: LOW_COVERAGE_DAYS,
  });

  /*
    A web pode chegar ao ar antes da migration de D-380 (ela só vai a produção
    pelo workflow com aprovação, D-334). Sem os argumentos novos o PostgREST não
    acha a função (PGRST202) e a tela cai na assinatura antiga: situação, busca e
    página continuam valendo; foco e ordem não existem lá e são ignorados, e a
    cobertura é calculada aqui com a MESMA fórmula da RPC. A tela diz isso.
  */
  const legado = leitura.error?.code === "PGRST202";
  const resposta = legado ? await supabase.rpc("get_fulfillment_overview", argumentos) : leitura;
  const { error } = resposta;
  const data = legado
    ? (resposta.data ?? []).map((linha) => ({
        ...linha,
        ...coverageOf(linha.full_quantity ?? 0, linha.units_sold ?? 0, LOOKBACK_DAYS),
        // A assinatura antiga não conta focos: zero declarado pelo aviso da tela.
        facet_low_coverage: 0,
        facet_can_ship: 0,
      }))
    : resposta.data;

  const linhas = data ?? [];

  /*
    A linha-sentinela (D-265) carrega as facetas quando a página está vazia —
    escolher "Parado" e não achar nada não significa que "Ruptura" também seja
    zero, e sem ela a faixa sumiria justamente quando é o caminho de volta.
    Qualquer linha serve para ler o mapa, porque a coluna se repete.
  */
  const primeira = linhas[0];
  const facetas = primeira?.facet_situation ?? null;
  const totalCount = primeira?.total_count ?? 0;
  const acabando = primeira?.facet_low_coverage ?? 0;
  const enviavel = primeira?.facet_can_ship ?? 0;
  const rows = linhas.filter(isFullRow);

  const noFull = FULL_SITUATIONS.reduce((soma, s) => soma + contaFaceta(facetas, s), 0);

  const janela = summarizePagedWindow({
    page: atual.page,
    totalCount,
    rowsOnPage: rows.length,
    pageSize: atual.pageSize,
    noun: { singular: "SKU por conta", plural: "SKUs por conta" },
    emptyLabel: "Nenhum SKU encontrado com estes filtros.",
  });

  const celulas: KpiCellData[] = [
    {
      label: "SKUs no Full",
      formula: `SKUs com ao menos um bucket capturado nos últimos ${String(FRESHNESS_DAYS)} dias — inclusive os que estão com saldo zero.`,
      value: formatCount(noFull),
      previous: null,
      href: buildFullHref(atual, { situation: null, focus: null, page: 1 }),
      tom: "neutro",
    },
    /*
      As quatro situações, e não as três do frame. `ausente` era o MAIOR estado
      do Dev (778 de 1.915) e o frame não lhe dá cartão. Aqui as quatro fecham
      com o total.
    */
    ...FULL_SITUATIONS.map(
      (situation): KpiCellData => ({
        label: fullSituationLabel(situation),
        formula: `${fullSituationLabel(situation)}: ${fullSituationCriterion(situation)}.`,
        value: formatCount(contaFaceta(facetas, situation)),
        previous: null,
        href: buildFullHref(atual, { situation, focus: null, page: 1 }),
        tom: fullSituationTom(situation),
      }),
    ),
  ];

  const rotuloConta =
    account === null
      ? "Todas as contas"
      : ((accounts.data ?? []).find((row) => row.id === account)?.label ?? "Conta");


  const criterioAtivo =
    atual.focus !== null
      ? { label: fullFocusLabel(atual.focus), texto: fullFocusCriterion(atual.focus) }
      : atual.situation !== null
        ? { label: fullSituationLabel(atual.situation), texto: fullSituationCriterion(atual.situation) }
        : null;

  // A exportação leva o MESMO recorte da tela, sem a página: quem monta o
  // envio quer a lista inteira da visão, não os 50 de cima.
  const exportHref = buildFullHref(atual, { page: 1 }).replace(/^\/full/, "/full/exportar");

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / FULL"
        title="Central Full"
        subtitle="O que está no fulfillment do Mercado Livre, quanto tempo dura e o que precisa ser enviado primeiro."
        aside={
          <>
            <FilterMenu
              rotulo={rotuloConta}
              opcoes={[
                {
                  href: buildFullHref(atual, { account: null, page: 1 }),
                  label: "Todas as contas",
                  ativo: account === null,
                },
                ...(accounts.data ?? []).map((row) => ({
                  href: buildFullHref(atual, { account: row.id, page: 1 }),
                  label: row.label,
                  ativo: account === row.id,
                })),
              ]}
            />
            {/* Âncora comum e não `Link`: é um arquivo, não uma página. */}
            <a className="sb-button" href={exportHref} download>
              <Icone nome="prancheta" tamanho={14} /> Exportar CSV
            </a>
          </>
        }
      />

      {legado && (
        <p role="note" className="sb-full-legacy">
          A fila de envio (focos, ordem e contagem de “acabando”) chega quando o banco receber a atualização desta
          tela. A cobertura por linha já aparece.
        </p>
      )}

      <KpiStrip cells={celulas} />

      {/* A leitura rápida responde à pergunta do operador antes da tabela. */}
      <section className="sb-full-insights" aria-label="O que pede ação no Full">
        <Link
          className={`sb-full-insight sb-full-insight-danger${atual.situation === "ruptura" && atual.focus === null ? " is-active" : ""}`}
          href={buildFullHref(atual, { situation: "ruptura", focus: null, page: 1 })}
        >
          <span className="sb-full-insight-icon" aria-hidden="true">
            <Icone nome="caixa" tamanho={16} />
          </span>
          <span className="sb-full-insight-copy">
            <span className="sb-full-insight-label">Vendendo sem Full</span>
            <strong>{formatCount(contaFaceta(facetas, "ruptura"))} em ruptura</strong>
            <small>Venderam nos últimos {LOOKBACK_DAYS} dias e estão com saldo zero no Full.</small>
          </span>
        </Link>
        <Link
          className={`sb-full-insight sb-full-insight-warning${atual.focus === "acabando" ? " is-active" : ""}`}
          href={buildFullHref(atual, { situation: null, focus: "acabando", page: 1 })}
        >
          <span className="sb-full-insight-icon" aria-hidden="true">
            <Icone nome="pulso" tamanho={16} />
          </span>
          <span className="sb-full-insight-copy">
            <span className="sb-full-insight-label">Acabando em breve</span>
            <strong>{legado ? "—" : formatCount(acabando)} com menos de {LOW_COVERAGE_DAYS} dias</strong>
            <small>Saldo no Full dividido pela venda média diária da janela.</small>
          </span>
        </Link>
        <Link
          className={`sb-full-insight sb-full-insight-primary${atual.focus === "enviavel" ? " is-active" : ""}`}
          href={buildFullHref(atual, { situation: null, focus: "enviavel", page: 1 })}
        >
          <span className="sb-full-insight-icon" aria-hidden="true">
            <Icone nome="caminhao" tamanho={16} />
          </span>
          <span className="sb-full-insight-copy">
            <span className="sb-full-insight-label">Pode enviar hoje</span>
            <strong>{legado ? "—" : formatCount(enviavel)} com saldo na loja</strong>
            <small>Em ruptura ou acabando, e com estoque local para mandar.</small>
          </span>
        </Link>
      </section>

      <Panel
        title="Monitoramento de Fulfillment"
        subtitle={janela.label}
        aside={
          <>
            <FilterMenu
              rotulo={fullSortLabel(atual.sort)}
              opcoes={FULL_SORTS.map((sort) => ({
                href: buildFullHref(atual, { sort, page: 1 }),
                label: fullSortLabel(sort),
                ativo: atual.sort === sort,
              }))}
            />
            <FilterMenu
              rotulo={`${String(atual.pageSize)} por página`}
              opcoes={PAGE_SIZES.map((tamanho) => ({
                href: buildFullHref(atual, { pageSize: tamanho, page: 1 }),
                label: `${String(tamanho)} por página`,
                ativo: atual.pageSize === tamanho,
              }))}
            />
          </>
        }
      >

        <div className="sb-full-toolbar">
          <form method="get" className="sb-full-search" role="search">
            {/* GET nativo só envia os campos do form — preservar as outras dimensões. */}
            {atual.situation !== null && <input type="hidden" name="situacao" value={atual.situation} />}
            {atual.focus !== null && <input type="hidden" name="foco" value={atual.focus} />}
            {account !== null && <input type="hidden" name="conta" value={account} />}
            {atual.sort !== "prioridade" && <input type="hidden" name="ordem" value={atual.sort} />}
            {atual.pageSize !== 50 && <input type="hidden" name="tamanho" value={String(atual.pageSize)} />}
            <span className="sb-full-search-icon" aria-hidden="true">
              <Icone nome="lupa" tamanho={14} />
            </span>
            <input
              className="sb-input"
              type="search"
              name="busca"
              defaultValue={atual.search ?? ""}
              placeholder="Buscar SKU ou produto"
              aria-label="Buscar por SKU ou título"
            />
            <button className="sb-button" type="submit">
              Buscar
            </button>
            {atual.search !== null && (
              <Link className="sb-text-button" href={buildFullHref(atual, { search: null, page: 1 })}>
                Limpar busca
              </Link>
            )}
          </form>

          {criterioAtivo !== null && (
            <p className="sb-full-criterion">
              <span className="sb-full-chip">
                {criterioAtivo.label}
                <Link
                  href={buildFullHref(atual, { situation: null, focus: null, page: 1 })}
                  aria-label={`Remover o filtro ${criterioAtivo.label}`}
                >
                  ×
                </Link>
              </span>
              {criterioAtivo.texto}.
            </p>
          )}
        </div>

        {/*
          A ressalva não pode sumir — somar Full com local é o erro que o PRD
          veta por escrito —, mas também não precisa ocupar a tela toda vez.
        */}
        <details className="sb-full-help">
          <summary>
            <Icone nome="lampada" tamanho={14} /> Como ler esta tela
          </summary>
          <div className="sb-note">
            <span>COMO LER ESTA TELA</span>
            <p>
              <strong>Full é por conta; estoque local é da organização</strong> — são autoridades diferentes, e
              as duas colunas nunca se somam. Só entram saldos capturados nos últimos {FRESHNESS_DAYS} dias:
              bucket que o Mercado Livre parou de reportar não é estoque atual. <strong>Cobertura</strong> é o
              saldo no Full dividido pela venda média diária dos últimos {LOOKBACK_DAYS} dias — sem sazonalidade
              nem previsão; abaixo de {CRITICAL_COVERAGE_DAYS} dias fica vermelha e abaixo de{" "}
              {LOW_COVERAGE_DAYS}, amarela. A tela mostra o que acaba e se há saldo local para repor, mas{" "}
              <strong>não sugere quanto enviar</strong> — custo de envio, lote mínimo e prazo não estão no sistema.
              Para “Curva A sem Full”, use a <Link href="/curva-abc?semFull=1">Curva ABC com o filtro sem Full</Link>.
            </p>
          </div>
        </details>

        {error !== null && (
          <div role="alert" className="sb-full-state sb-full-state-error">
            <strong>Não foi possível carregar o Full.</strong>
            <span>{error.message}</span>
            <Link className="sb-button" href={buildFullHref(atual, {})}>
              Tentar de novo
            </Link>
          </div>
        )}

        {error === null && rows.length === 0 && (
          <div className="sb-full-state">
            <span className="sb-full-state-icon" aria-hidden="true">
              <Icone nome="armazem" tamanho={20} />
            </span>
            <strong>{janela.label}</strong>
            <span>
              {atual.search !== null || criterioAtivo !== null
                ? "Troque a visão acima ou limpe a busca para ver os outros SKUs."
                : `Nenhum saldo do Full foi capturado nos últimos ${String(FRESHNESS_DAYS)} dias.`}
            </span>
          </div>
        )}

        {error === null && rows.length > 0 && (
          <div className="sb-full-table-wrap">
            <table className="sb-table sb-full-table">
              <thead>
                <tr>
                  <th>Produto / SKU</th>
                  <th className="sb-num">Venda ({LOOKBACK_DAYS}d)</th>
                  <th className="sb-num">Estoque Full</th>
                  <th>Cobertura</th>
                  <th className="sb-num">Estoque local</th>
                  <th>Situação</th>
                  {/*
                    Onde o frame põe "Últ. Envio" — que não tem fonte — fica a
                    captura, que tem: é ela que sustenta a regra dos 3 dias, e
                    varia por bucket.
                  */}
                  <th>Capturado</th>
                  <th>Ação</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const cobertura = row.coverage_days;
                  const tom = row.situation === "ruptura" ? "perigo" : coverageTom(cobertura);
                  const podeEnviar =
                    row.local_quantity > 0 &&
                    (row.situation === "ruptura" || (cobertura !== null && cobertura < LOW_COVERAGE_DAYS));
                  const idade = formatAge(row.captured_at);

                  return (
                    <tr key={`${row.ml_account_id}-${row.sku_id}`} className={`sb-full-row-${row.situation}`}>
                      <td>
                        <span className="sb-full-product">
                          <span className="sb-product-thumb" aria-hidden="true">
                            {monogramaDeProduto(row.sku_title ?? row.sku)}
                          </span>
                          <span className="sb-full-product-copy">
                            <span className="sb-full-product-title">
                              {row.sku_title ?? <span className="sb-full-muted">sem título</span>}
                            </span>
                            {/*
                              A CONTA entra aqui porque Full é por conta: com
                              "Todas as contas" a linha ficaria ambígua sem ela.
                            */}
                            <span className="sb-mono sb-full-product-meta">
                              <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>
                              {` · ${row.account_label}`}
                            </span>
                          </span>
                        </span>
                      </td>

                      <td className="sb-num">
                        <strong>{formatCount(row.units_sold)}</strong>
                        {row.daily_rate !== null && (
                          <small className="sb-full-sub">
                            {new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 }).format(row.daily_rate)}/dia
                          </small>
                        )}
                      </td>

                      <td className="sb-num">
                        <strong>{formatCount(row.full_quantity)}</strong>
                        {/* Mais de um bucket = anúncio com variações no Full. É o
                            grão que D-173 corrigiu; dizer quantos são evita que a
                            soma pareça vir do nada. */}
                        {row.buckets > 1 && <small className="sb-full-sub">{row.buckets} variações</small>}
                      </td>

                      <td>
                        <span className={`sb-full-coverage sb-full-coverage-${tom}`}>
                          <span className="sb-full-coverage-bar" aria-hidden="true">
                            <span style={{ width: `${String(larguraDaCobertura(cobertura))}%` }} />
                          </span>
                          <span className="sb-full-coverage-text">{formatCoverage(cobertura)}</span>
                        </span>
                      </td>

                      <td
                        className="sb-num"
                        title="Estoque local da organização — nunca somado ao Full"
                        style={{ color: row.local_quantity < 0 ? "var(--sb-danger)" : undefined }}
                      >
                        {formatCount(row.local_quantity)}
                        {podeEnviar && <small className="sb-full-sub sb-full-can-ship">pode enviar</small>}
                      </td>

                      <td>
                        <StatePill
                          tone={{ tom: fullSituationTom(row.situation), label: fullSituationLabel(row.situation) }}
                        />
                      </td>

                      <td className="sb-full-captured" title={formatDateTime(row.captured_at)}>
                        {idade ?? formatDateTime(row.captured_at)}
                      </td>

                      {/*
                        O frame põe "Repor Full" nas linhas em ruptura — escrita
                        que não existe, e sem política logística para sustentá-la.
                        Fica o caminho que EXISTE.
                      */}
                      <td style={{ whiteSpace: "nowrap" }}>
                        <Link className="sb-full-action" href={`/reposicao?busca=${encodeURIComponent(row.sku)}`}>
                          Ver reposição →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {error === null && janela.totalPages > 1 && (
          <nav className="sb-full-pages" aria-label="Páginas">
            {atual.page > 1 ? (
              <Link className="sb-button" href={buildFullHref(atual, { page: atual.page - 1 })}>
                ‹ Anterior
              </Link>
            ) : (
              <span />
            )}
            <span>
              Página {formatCount(atual.page)} de {formatCount(janela.totalPages)}
            </span>
            {atual.page < janela.totalPages ? (
              <Link className="sb-button" href={buildFullHref(atual, { page: atual.page + 1 })}>
                Próxima ›
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </Panel>
    </Shell>
  );
}
