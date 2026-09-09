import Link from "next/link";
import type { ReactNode } from "react";

import { FilterPill } from "../../components/filter-pill";
import { PageTitle } from "../../components/page-title";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { summarizePagedWindow } from "../../lib/filters";
import { formatDateTime } from "../../lib/format";
import { featureSuggestionStatusLabel } from "../../lib/labels";
import { currentMembership } from "../../lib/membership";
import {
  SUGGESTIONS_PAGE_SIZE,
  buildSuggestionHref,
  resolveSuggestionFilters,
  selectSuggestion,
} from "../../lib/suggestion-filters";
import { createClient } from "../../lib/supabase/server";
import { NewSuggestionForm } from "./new-suggestion-form";
import { SuggestionDetail, type SuggestionData } from "./suggestion-detail";

export const metadata = { title: "Sugestões de Melhoria — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Central de Sugestões (Fase 7, item 9, D-079) pelo frame `CentralScreen` na
 * variação de ideias (D30, D-270).
 *
 * **O mestre-detalhe se justifica aqui, e em `/notificacoes` não se
 * justificava (D-269).** Lá o painel repetia os três campos da linha. Aqui há
 * NOVE campos estruturados, que a versão anterior escondia num `<details>`
 * dentro de uma célula — com um comentário que se desculpava, "para a tabela
 * não explodir".
 *
 * **A tela lia SEM LIMITE e imprimia `rows.length` como total.** Com o teto de
 * 1.000 do PostgREST, a frase mentiria exatamente como `/acoes` mentia
 * (D-263); só não mentia ainda porque a tabela está vazia. Agora tem janela
 * declarada.
 *
 * **Sete estados, não os três que o frame desenha** (`nova`, `em_analise`,
 * `aprovada`, `planejada`, `em_desenvolvimento`, `entregue`, `recusada`) — o
 * seletor de status já os oferecia todos, e a lista precisa poder mostrá-los.
 */

interface SuggestionQueryRow {
  id: string;
  original_text: string;
  status: string;
  created_at: string;
  title: string | null;
  problem: string | null;
  objective: string | null;
  impacted_users: string | null;
  suggested_flow: string | null;
  expected_benefit: string | null;
  acceptance_criteria: string | null;
  dependencies_risks: string | null;
  complexity: string | null;
  profiles: { full_name: string | null } | null;
}

export default async function SugestoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const filters = resolveSuggestionFilters(await searchParams);
  const supabase = await createClient();

  const desde = (filters.page - 1) * SUGGESTIONS_PAGE_SIZE;

  // As duas leituras são INDEPENDENTES: o papel decide o que a tela DEIXA
  // fazer, e a listagem é restringida pela RLS, não pelo papel. Em fila
  // custavam duas idas ao banco somadas; em paralelo, uma (D-195).
  const [membership, suggestions] = await Promise.all([
    currentMembership(supabase),
    supabase
      .from("feature_suggestions")
      .select(
        "id, original_text, status, created_at, title, problem, objective, impacted_users, suggested_flow, expected_benefit, acceptance_criteria, dependencies_risks, complexity, profiles(full_name)",
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(desde, desde + SUGGESTIONS_PAGE_SIZE - 1),
  ]);

  const role = membership.role;
  const canManage = role === "ADMIN" || role === "GESTOR";
  const { data, error, count } = suggestions;

  const rows: SuggestionData[] = ((data ?? []) as unknown as SuggestionQueryRow[]).map((row) => ({
    id: row.id,
    originalText: row.original_text,
    status: row.status,
    createdAt: row.created_at,
    authorName: row.profiles?.full_name ?? null,
    structured: {
      title: row.title,
      problem: row.problem,
      objective: row.objective,
      impactedUsers: row.impacted_users,
      suggestedFlow: row.suggested_flow,
      expectedBenefit: row.expected_benefit,
      acceptanceCriteria: row.acceptance_criteria,
      dependenciesRisks: row.dependencies_risks,
      complexity: row.complexity,
    },
  }));

  const totalCount = count ?? rows.length;
  const janela = summarizePagedWindow({
    page: filters.page,
    totalCount,
    rowsOnPage: rows.length,
    pageSize: SUGGESTIONS_PAGE_SIZE,
    noun: { singular: "sugestão registrada", plural: "sugestões registradas" },
    emptyLabel: "Nenhuma sugestão ainda.",
    trailing: ", da mais recente",
  });

  const selecionada = selectSuggestion(rows, filters.selectedId);

  return (
    <Shell>
      <PageTitle
        eyebrow="CENTRAL / EVOLUÇÃO DO PRODUTO"
        title="Sugestões de Melhoria"
        subtitle="Observações da equipe, estruturadas em propostas claras pela IA — e o texto original preservado como foi escrito."
      />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {error === null && selecionada === null && (
        <p className="sb-empty">
          Nenhuma sugestão ainda. A primeira nasce no formulário abaixo, em texto livre — o que você escreve
          fica preservado exatamente como foi escrito.
        </p>
      )}

      {error === null && selecionada !== null && (
        <div className="sb-split-layout">
          {/* MESTRE — o "Backlog de sugestões" do frame. */}
          <section className="sb-panel" aria-label="Backlog de sugestões" style={{ padding: "0.4375rem" }}>
            {rows.map((row) => (
              <Link
                key={row.id}
                className="sb-split-item"
                href={buildSuggestionHref(filters, { selectedId: row.id })}
                aria-current={row.id === selecionada.id ? "true" : undefined}
              >
                <StatusPill code={row.status} label={featureSuggestionStatusLabel(row.status)} />
                {/*
                  O título estruturado quando existe; o texto original quando
                  não. Uma sugestão sem estruturar continua sendo uma sugestão —
                  a lista nunca fica com linha em branco esperando a IA.
                */}
                <b>{row.structured.title ?? row.originalText}</b>
                <span>
                  {row.authorName ?? "Autor desconhecido"}
                  <span>{formatDateTime(row.createdAt)}</span>
                </span>
              </Link>
            ))}
          </section>

          <SuggestionDetail suggestion={selecionada} canManage={canManage} />
        </div>
      )}

      {error === null && (
        <p style={{ margin: "var(--sb-space-3) 0 0", fontSize: "0.6875rem", color: "var(--sb-text-soft)" }}>
          {janela.label}
        </p>
      )}

      {error === null && janela.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-2)" }}>
          {filters.page > 1 && (
            <FilterPill href={buildSuggestionHref(filters, { page: filters.page - 1, selectedId: null })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          {filters.page < janela.totalPages && (
            <FilterPill href={buildSuggestionHref(filters, { page: filters.page + 1, selectedId: null })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}

      {/* O "Nova sugestão" que o frame põe no cabeçalho já existia como
          formulário. Fica onde está: ele é o caminho de escrita da tela. */}
      <section style={{ marginTop: "var(--sb-space-4)" }}>
        <h2 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "0.9375rem" }}>Nova sugestão</h2>
        <NewSuggestionForm />
      </section>
    </Shell>
  );
}
