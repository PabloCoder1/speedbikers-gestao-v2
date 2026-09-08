import { actionKindLabel, describeActionEvidence } from "@sb/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import { PageTitle } from "../../components/page-title";
import { Shell } from "../../components/shell";
import {
  ACTIONS_PAGE_SIZE,
  buildActionsHref,
  facetEntries,
  isQueueRow,
  readFacet,
  resolveActionFilters,
  toRpcArgs,
} from "../../lib/action-filters";
import { actionShortcuts } from "../../lib/action-shortcuts";
import { summarizePagedWindow } from "../../lib/filters";
import { formatBusinessDate, formatCount } from "../../lib/format";
import { currentMembership } from "../../lib/membership";
import { formatAge } from "../../lib/relative-time";
import { createClient } from "../../lib/supabase/server";
import type { ActionCardData, DecisionData, OutcomeData } from "./action-card";
import { ActionCard } from "./action-card";

export const metadata = { title: "Central de Ações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Central de Ações (`/acoes`) pelo frame `IntelligenceScreen type="actions"`
 * (D23, D-263) — painel de filtros à esquerda, fila em CARTÕES à direita.
 *
 * **Duas recusas ao frame, e as duas por medição:**
 *
 * 1. **"Executar fila em lote"** (o botão do cabeçalho). Não existe: as
 *    escritas são por ação (`claimAction`, `resolveAction`, `dismissAction`).
 *    Seria escrita em massa sobre objetos HETEROGÊNEOS — "executar" significa
 *    coisa diferente para cada `kind`, e resolver uma anomalia de venda não é
 *    responder uma reclamação. A casa já tem doutrina: a curadoria em lote de
 *    `/produtos` só escreve depois de dizer a consequência. Um botão que
 *    executa 1.449 ações sem poder enunciar o que causa é o oposto disso.
 * 2. **"Ordenar: Impacto Financeiro"** como MENU. A ordem é única e canônica
 *    (`ARCHITECTURE.md` secao 16: nunca por contagem, nunca por data). Um menu
 *    com uma opção promete alternativas que não existem — virou a frase que
 *    declara a ordem.
 *
 * **E a prioridade "Crítica" do frame não existe**: `severity` tem três
 * valores. Ver `lib/action-filters.ts`.
 */

interface QueueRow {
  id: string | null;
  kind: string | null;
  severity: string | null;
  confidence: string | null;
  estimated_impact_brl: number | null;
  sku_id: string | null;
  sku: string | null;
  sku_title: string | null;
  mlb_id: string | null;
  account_label: string | null;
  evidence: unknown;
  recommendation: string | null;
  status: string | null;
  assignee_id: string | null;
  created_at: string | null;
  total_count: number;
  open_total: number;
  facet_severity: unknown;
  facet_kind: unknown;
}

export default async function AcoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const filters = resolveActionFilters(await searchParams);
  const supabase = await createClient();

  // `getUser()` revalida o token contra o servidor de Auth e custa uma ida
  // inteira; sai junto com a organização porque nenhum dos dois depende do
  // outro. A RPC abaixo NÃO pode entrar aqui: ela recebe `p_organization_id`,
  // então depende do resultado desta leitura — mesma forma de `/compras`.
  const [{ data: auth }, membership] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(supabase),
  ]);

  const userId = auth.user?.id ?? null;
  const organizationId = membership.organizationId;

  if (organizationId === null || userId === null) {
    return (
      <Shell>
        <PageTitle eyebrow="VISÃO GERAL / INBOX" title="Central de Ações" />
        <p className="sb-empty">Sua conta não está associada a nenhuma organização.</p>
      </Shell>
    );
  }

  const { data, error: queueError } = await supabase.rpc("get_actions_queue", {
    p_organization_id: organizationId,
    ...toRpcArgs(filters),
  });

  const linhas = (data ?? []) as QueueRow[];

  // A linha-sentinela carrega as facetas quando a página está vazia; qualquer
  // linha serve para lê-las, porque as três colunas de faceta se repetem.
  const facetas = linhas[0] ?? null;
  const abertas = facetas?.open_total ?? 0;
  const totalFiltrado = facetas?.total_count ?? 0;

  const acoes = linhas.filter(isQueueRow);
  const actionIds = acoes.map((row) => row.id);

  // Memória de decisões (Fase 6, PROMPT_MASTER secao 29). Dependem dos ids da
  // PÁGINA — antes de D23 esta lista chegava a 1.000 ids numa query string só.
  const decisionsResult =
    actionIds.length > 0
      ? await supabase
          .from("action_decisions")
          .select("id, action_id, decision, baseline_snapshot, created_at")
          .in("action_id", actionIds)
          .order("created_at", { ascending: false })
      : { data: [] };

  const decisionRows = decisionsResult.data ?? [];
  const decisionIds = decisionRows.map((row) => row.id);

  const outcomesResult =
    decisionIds.length > 0
      ? await supabase
          .from("action_outcomes")
          .select("action_decision_id, window_days, outcome_snapshot, measured_at")
          .in("action_decision_id", decisionIds)
      : { data: [] };

  const outcomesByDecision = new Map<string, OutcomeData[]>();

  for (const row of outcomesResult.data ?? []) {
    const list = outcomesByDecision.get(row.action_decision_id) ?? [];
    list.push({
      windowDays: row.window_days,
      outcomeSnapshot: row.outcome_snapshot as Record<string, unknown>,
      measuredAt: row.measured_at,
    });
    outcomesByDecision.set(row.action_decision_id, list);
  }

  // Falha ao ler decisões/outcomes ficava invisível antes: a Central mostraria
  // cada ação sem nenhuma decisão registrada, indistinguível de "ninguém
  // registrou uma decisão ainda" (D-067).
  const error =
    queueError ??
    ("error" in decisionsResult ? decisionsResult.error : null) ??
    ("error" in outcomesResult ? outcomesResult.error : null);

  const decisionsByAction = new Map<string, DecisionData[]>();

  for (const row of decisionRows) {
    const list = decisionsByAction.get(row.action_id) ?? [];
    list.push({
      id: row.id,
      decision: row.decision,
      baselineSnapshot: row.baseline_snapshot as Record<string, unknown>,
      createdAt: row.created_at,
      outcomes: (outcomesByDecision.get(row.id) ?? []).sort((a, b) => a.windowDays - b.windowDays),
    });
    decisionsByAction.set(row.action_id, list);
  }

  const agora = new Date();

  const cartoes = acoes.map(
    (row): ActionCardData => ({
      id: row.id,
      sku: row.sku,
      title: row.sku_title,
      mlbId: row.mlb_id,
      accountLabel: row.account_label,
      severity: row.severity ?? "media",
      confidence: row.confidence ?? "media",
      estimated_impact_brl: row.estimated_impact_brl,
      evidence: describeActionEvidence(row.kind ?? "", row.evidence),
      recommendation: row.recommendation ?? "",
      status: row.status ?? "novo",
      assignee_id: row.assignee_id,
      // Duração enquanto ela informa; acima de 7 dias a data absoluta diz mais
      // (`lib/relative-time.ts`), e ela sai de `formatBusinessDate`, que é o
      // único dono do fuso de negócio no projeto.
      age:
        formatAge(row.created_at, agora) ??
        (row.created_at === null ? "—" : formatBusinessDate(row.created_at)),
      decisions: decisionsByAction.get(row.id) ?? [],
      shortcuts: actionShortcuts({ kind: row.kind ?? "", skuId: row.sku_id, sku: row.sku }),
    }),
  );

  const janela = summarizePagedWindow({
    page: filters.page,
    totalCount: totalFiltrado,
    rowsOnPage: cartoes.length,
    pageSize: ACTIONS_PAGE_SIZE,
    noun: { singular: "ação pendente", plural: "ações pendentes" },
    emptyLabel: "Nenhuma ação neste recorte.",
    trailing: ", em ordem de impacto",
  });

  const severidades = [
    { chave: "alta" as const, rotulo: "Alta prioridade" },
    { chave: "media" as const, rotulo: "Média" },
    { chave: "baixa" as const, rotulo: "Baixa" },
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="VISÃO GERAL / INBOX"
        title="Central de Ações"
        subtitle="Seu inbox operacional: problemas e oportunidades priorizados por impacto."
      />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && (
        <div className="sb-inbox-layout">
          {/* PAINEL DE FILTROS — a metade esquerda do frame. */}
          <nav className="sb-panel sb-inbox-filters" aria-label="Filtros da fila">
            <span>Filtros (inbox)</span>

            <Link
              className="sb-inbox-filter"
              aria-current={filters.severity === "todas" && filters.kind === null ? "true" : undefined}
              href={buildActionsHref(filters, { severity: "todas", kind: null })}
            >
              Todas as ações <span>{formatCount(abertas)}</span>
            </Link>

            {/*
              Três níveis, não os quatro do frame. "Baixa 0" fica: o mapa de
              facetas sai do inbox inteiro, então chave ausente é zero MEDIDO —
              e esconder a linha seria a mentira, não mostrá-la (D-250).
            */}
            {severidades.map(({ chave, rotulo }) => (
              <Link
                key={chave}
                className="sb-inbox-filter"
                aria-current={filters.severity === chave ? "true" : undefined}
                href={buildActionsHref(filters, { severity: chave })}
              >
                {rotulo} <span>{formatCount(readFacet(facetas?.facet_severity, chave))}</span>
              </Link>
            ))}

            {/*
              Os filtros de domínio do frame são "Estoque / Anúncios /
              Atendimento". Aqui a lista vem do DADO (`kind` não tem `check`
              constraint), então um tipo novo gravado pelo detector aparece
              sozinho em vez de sumir do painel sem aviso.
            */}
            {facetEntries(facetas?.facet_kind).length > 0 && <hr />}

            {facetEntries(facetas?.facet_kind).map(({ key, count }) => (
              <Link
                key={key}
                className="sb-inbox-filter"
                aria-current={filters.kind === key ? "true" : undefined}
                href={buildActionsHref(filters, { kind: filters.kind === key ? null : key })}
              >
                {actionKindLabel(key)} <span>{formatCount(count)}</span>
              </Link>
            ))}
          </nav>

          <div>
            <section className="sb-panel" aria-label="Fila de ações">
              <div className="sb-inbox-bar">
                <b>{janela.label}</b>
                {/*
                  O frame põe um MENU "Ordenar: Impacto Financeiro". A ordem é
                  única e canônica (ARCHITECTURE secao 16) — um menu de uma
                  opção prometeria alternativas inexistentes.
                */}
                <span>Ordenado por impacto financeiro estimado</span>
              </div>

              {cartoes.length === 0 ? (
                /*
                  A barra acima JÁ diz "Nenhuma ação neste recorte." (é o
                  `emptyLabel` da janela). Repetir a frase aqui era o que estava
                  escrito antes, e o teste pegou por ambiguidade — duas vezes a
                  mesma sentença, empilhadas. O corpo diz o que a barra NÃO diz:
                  para onde ir.
                */
                <p className="sb-empty">
                  {abertas === 0
                    ? "Nada pendente: a fila está vazia."
                    : "O painel à esquerda conta o que a fila tem fora deste recorte."}
                </p>
              ) : (
                cartoes.map((cartao) => <ActionCard key={cartao.id} action={cartao} userId={userId} />)
              )}
            </section>

            {janela.totalPages > 1 && (
              <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
                {filters.page > 1 && (
                  <Link className="sb-button" href={buildActionsHref(filters, { page: filters.page - 1 })}>
                    ← Anterior
                  </Link>
                )}
                {filters.page < janela.totalPages && (
                  <Link className="sb-button" href={buildActionsHref(filters, { page: filters.page + 1 })}>
                    Próxima →
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}
