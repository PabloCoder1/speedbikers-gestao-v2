import type { ReactNode } from "react";

import Link from "next/link";

import { FilterPill, FilterSubmit } from "../../components/filter-pill";
import { FilterMenu } from "../../components/filter-menu";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatePill } from "../../components/state-pill";
import { formatCount, formatDateTime } from "../../lib/format";
import {
  FULL_SITUATIONS,
  PAGE_SIZE,
  buildFullHref,
  fullSituationCriterion,
  fullSituationLabel,
  fullSituationTom,
  isFullRow,
  resolveFullFilters,
  summarizePagedWindow,
} from "../../lib/full-filters";
import { createClient } from "../../lib/supabase/server";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Central Full — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Central Full (D-173, trilha 5E) pelo frame `IntelligenceScreen type="full"`
 * (D25, D-265) — faixa de situações + painel "Monitoramento de Fulfillment".
 *
 * **O frame esconde o maior estado, e a medição é o que mostra isso.** Ele
 * desenha três cartões (Em Ruptura, Parados, Saudáveis) que somam exatamente o
 * total — 17 + 84 + 427 = 528 —, assumindo que só existem três situações. São
 * quatro: `ausente` ("Fora do Full") tem **778 dos 1.915 SKUs** no Dev, 41% do
 * conjunto. Três cartões somariam 1.137 e esconderiam 778 sem dizer. A faixa
 * aqui tem CINCO células: o total e as quatro situações, que aí sim fecham.
 *
 * **Duas recusas ao frame, as duas por falta de fonte:**
 *
 * 1. **"Últ. Envio"** — não existe tabela de envio ao Full em lugar nenhum do
 *    esquema. A coluna ficaria vazia ou inventada.
 * 2. **"Repor Full"** — é escrita, e não há política logística no sistema
 *    (custo de envio, lote mínimo, prazo). O botão do frame prometeria uma ação
 *    que ninguém pode executar.
 *
 * No lugar dele fica um LINK, e o destino não é o que o frame diz. A ação dele
 * é "Ver cobertura", mas **`/cobertura` só aceita `?marca=`** — mandar
 * `?busca=SKU` para lá cairia na lista inteira com um parâmetro ignorado, que é
 * exatamente o filtro fantasma que D-154 existe para impedir. `/reposicao`
 * aceita `busca` (D-147) e é a tela que responde "devo repor este SKU?", então
 * é para lá que a linha aponta.
 *
 * **E o "Atualizado há 2 min" do cabeçalho também não entrou.** Ele afirma UMA
 * frescura para a página inteira, e aqui cada bucket tem a sua `captured_at` —
 * a coluna por linha é a verdade, e é ela que sustenta a regra dos 3 dias.
 *
 * As três coisas que a tela não faz, do desenho original, seguem valendo:
 *
 * 1. **Não soma Full com estoque físico.** Full é por CONTA; Local é da
 *    ORGANIZAÇÃO (regra do PRD) — autoridades diferentes, nunca somadas.
 * 2. **Não sugere quanto enviar.** Mostra que há saldo local para um item em
 *    ruptura e para por aí.
 * 3. **Não afirma "saúde" com score.** As quatro situações são regras
 *    determinísticas, e o critério de cada uma aparece na tela.
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
    currentMembership(supabase),
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

  const now = new Date();
  const dateTo = now.toISOString().slice(0, 10);
  const dateFrom = new Date(now.getTime() - (LOOKBACK_DAYS - 1) * 86_400_000).toISOString().slice(0, 10);

  const { data, error } = await supabase.rpc("get_fulfillment_overview", {
    p_organization_id: organizationId,
    p_date_from: dateFrom,
    p_date_to: dateTo,
    p_ml_account_id: account,
    p_situation: filters.situation,
    p_search: filters.search,
    p_sku_id: null,
    p_limit: PAGE_SIZE,
    p_offset: (filters.page - 1) * PAGE_SIZE,
  });

  const linhas = data ?? [];

  /*
    A linha-sentinela (D-265) carrega as facetas quando a página está vazia —
    escolher "Parado" e não achar nada não significa que "Ruptura" também seja
    zero, e sem ela a faixa sumiria justamente quando é o caminho de volta.
    Qualquer linha serve para ler o mapa, porque a coluna se repete.
  */
  const facetas = linhas[0]?.facet_situation ?? null;
  const totalCount = linhas[0]?.total_count ?? 0;
  const rows = linhas.filter(isFullRow);

  const noFull = FULL_SITUATIONS.reduce((soma, s) => soma + contaFaceta(facetas, s), 0);

  const janela = summarizePagedWindow({
    page: filters.page,
    totalCount,
    rowsOnPage: rows.length,
    pageSize: PAGE_SIZE,
    noun: { singular: "SKU por conta", plural: "SKUs por conta" },
    emptyLabel: "Nenhum SKU encontrado com estes filtros.",
  });

  const celulas: KpiCellData[] = [
    {
      label: "SKUs no Full",
      formula: `SKUs com ao menos um bucket capturado nos últimos ${String(FRESHNESS_DAYS)} dias — inclusive os que estão com saldo zero.`,
      value: formatCount(noFull),
      previous: null,
      href: buildFullHref(filters, { situation: null, page: 1 }),
      tom: "neutro",
    },
    /*
      As quatro situações, e não as três do frame. `ausente` é o MAIOR estado
      do Dev (778 de 1.915) e o frame não lhe dá cartão — os três dele somariam
      1.137 e esconderiam 778 sem dizer. Aqui as quatro fecham com o total.
    */
    ...FULL_SITUATIONS.map(
      (situation): KpiCellData => ({
        label: fullSituationLabel(situation),
        formula: `${fullSituationLabel(situation)}: ${fullSituationCriterion(situation)}.`,
        value: formatCount(contaFaceta(facetas, situation)),
        previous: null,
        href: buildFullHref(filters, { situation, page: 1 }),
        tom: fullSituationTom(situation),
      }),
    ),
  ];

  const rotuloConta =
    account === null
      ? "Todas as contas"
      : ((accounts.data ?? []).find((row) => row.id === account)?.label ?? "Conta");

  return (
    <Shell>
      <PageTitle
        eyebrow="ESTOQUE / FULL"
        title="Central Full"
        subtitle="Estoque e situação dos produtos no fulfillment do Mercado Livre."
        aside={
          <FilterMenu
            rotulo={rotuloConta}
            opcoes={[
              {
                href: buildFullHref(filters, { account: null, page: 1 }),
                label: "Todas as contas",
                ativo: account === null,
              },
              ...(accounts.data ?? []).map((row) => ({
                href: buildFullHref(filters, { account: row.id, page: 1 }),
                label: row.label,
                ativo: account === row.id,
              })),
            ]}
          />
        }
      />

      <KpiStrip cells={celulas} />

      <Panel
        title="Monitoramento de Fulfillment"
        subtitle={janela.label}
        aside={
          <FilterMenu
            rotulo={filters.situation === null ? "Situação" : fullSituationLabel(filters.situation)}
            opcoes={[
              {
                href: buildFullHref(filters, { situation: null, page: 1 }),
                label: "Todas as situações",
                ativo: filters.situation === null,
              },
              ...FULL_SITUATIONS.map((situation) => ({
                href: buildFullHref(filters, { situation, page: 1 }),
                label: fullSituationLabel(situation),
                ativo: filters.situation === situation,
              })),
            ]}
          />
        }
      >
        {/*
          O frame não desenha ressalva nenhuma aqui, e esta tela não pode ficar
          sem: as duas colunas de estoque têm AUTORIDADES diferentes, e somá-las
          é o erro que o PRD veta por escrito.
        */}
        <div className="sb-note" style={{ margin: "var(--sb-space-3) 1.25rem 0" }}>
          <span>COMO LER ESTA TELA</span>
          <p>
            <strong>Full é por conta; estoque local é da organização</strong> — são autoridades diferentes, e
            as duas colunas nunca se somam. Só entram saldos capturados nos últimos {FRESHNESS_DAYS} dias:
            bucket que o Mercado Livre parou de reportar não é estoque atual. A tela mostra que existe saldo
            local para repor, mas <strong>não sugere quanto enviar</strong> — custo de envio, lote mínimo e
            prazo não estão no sistema. Para “Curva A sem Full”, use a{" "}
            <Link href="/curva-abc?semFull=1">Curva ABC com o filtro sem Full</Link>.
          </p>
        </div>

        {filters.situation !== null && (
          <p style={{ margin: "var(--sb-space-2) 1.25rem 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
            <strong>{fullSituationLabel(filters.situation)}</strong>: {fullSituationCriterion(filters.situation)}.
          </p>
        )}

        <form
          method="get"
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "0.375rem",
            margin: "var(--sb-space-3) 1.25rem",
            fontSize: "0.8125rem",
          }}
        >
          {/* GET nativo só envia os campos do form — preservar as dimensões de menu. */}
          {filters.situation !== null && <input type="hidden" name="situacao" value={filters.situation} />}
          {account !== null && <input type="hidden" name="conta" value={account} />}
          <input
            className="sb-input"
            type="search"
            name="busca"
            defaultValue={filters.search ?? ""}
            placeholder="Buscar SKU ou produto"
            aria-label="Buscar por SKU ou título" style={{ minWidth: "16rem" }}
          />
          <FilterSubmit>Filtrar</FilterSubmit>
        </form>

        {error !== null && (
          <p role="alert" style={{ margin: "0 1.25rem var(--sb-space-3)", color: "var(--sb-danger)" }}>
            Não foi possível carregar o Full: {error.message}
          </p>
        )}

        {error === null && rows.length === 0 && <p className="sb-empty">{janela.label}</p>}

        {error === null && rows.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table className="sb-table">
              <thead>
                <tr>
                  <th>Produto / SKU</th>
                  <th className="sb-num">Venda ({LOOKBACK_DAYS}d)</th>
                  <th className="sb-num">Estoque local</th>
                  <th className="sb-num">Estoque Full</th>
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
                {rows.map((row) => (
                  <tr key={`${row.ml_account_id}-${row.sku_id}`}>
                    <td>
                      {row.sku_title ?? <span style={{ color: "var(--sb-text-soft)" }}>sem título</span>}
                      {/*
                        O frame junta produto, SKU e identificador numa célula.
                        A CONTA entra aqui porque Full é por conta: com "Todas
                        as contas" a linha ficaria ambígua sem ela.
                      */}
                      <div className="sb-mono">
                        <Link href={`/skus/${row.sku_id}`}>{row.sku}</Link>
                        {` · ${row.account_label}`}
                      </div>
                    </td>

                    <td className="sb-num">{formatCount(row.units_sold)}</td>

                    <td
                      className="sb-num"
                      style={{ color: row.local_quantity < 0 ? "var(--sb-danger)" : undefined }}
                      title="Estoque local da organização — nunca somado ao Full"
                    >
                      {formatCount(row.local_quantity)}
                    </td>

                    <td className="sb-num" style={{ fontWeight: 600 }}>
                      {formatCount(row.full_quantity)}
                      {/* Mais de um bucket = anúncio com variações no Full. É o
                          grão que D-173 corrigiu; dizer quantos são evita que a
                          soma pareça vir do nada. */}
                      {row.buckets > 1 && (
                        <div style={{ fontSize: "0.625rem", fontWeight: 400, color: "var(--sb-text-soft)" }}>
                          {row.buckets} variações
                        </div>
                      )}
                    </td>

                    <td>
                      <StatePill tone={{ tom: fullSituationTom(row.situation), label: fullSituationLabel(row.situation) }} />
                    </td>

                    <td style={{ whiteSpace: "nowrap", color: "var(--sb-text-soft)" }}>
                      {formatDateTime(row.captured_at)}
                    </td>

                    {/*
                      O frame põe "Repor Full" nas linhas em ruptura — escrita
                      que não existe, e sem política logística para sustentá-la.
                      Fica o caminho que EXISTE, e ele muda com a situação.
                    */}
                    <td style={{ whiteSpace: "nowrap" }}>
                      <Link href={`/reposicao?busca=${encodeURIComponent(row.sku)}`}>Ver reposição →</Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {error === null && janela.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <FilterPill href={buildFullHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          {filters.page < janela.totalPages && (
            <FilterPill href={buildFullHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
