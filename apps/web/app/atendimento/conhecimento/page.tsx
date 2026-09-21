import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../../components/filter-menu";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { isPageBeyondEnd, summarizePagedWindow } from "../../../lib/filters";
import { formatCount, formatPercent } from "../../../lib/format";
import {
  buildKnowledgeHref,
  KNOWLEDGE_KINDS,
  KNOWLEDGE_PAGE_SIZE,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_STATUSES,
  resolveKnowledgeFilters,
} from "../../../lib/knowledge-filters";
import { currentMembership } from "../../../lib/request-membership";
import { createClient } from "../../../lib/supabase/server";
import { KNOWLEDGE_KIND_LABEL, KNOWLEDGE_SOURCE_LABEL, KNOWLEDGE_STATUS_LABEL } from "./constants";
import { KnowledgeRow, type KnowledgeRowData } from "./knowledge-row";
import { NewKnowledgeForm } from "./new-knowledge-form";

export const metadata = { title: "Base de Conhecimento — Speed Bikers Gestão" };
export const dynamic = "force-dynamic";

/** A base é curadoria humana; apenas VALIDADO pode fundamentar o Copiloto. */
export default async function ConhecimentoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const filters = resolveKnowledgeFilters(query);
  const supabase = await createClient();
  const offset = (filters.page - 1) * KNOWLEDGE_PAGE_SIZE;

  let entriesQuery = supabase
    .from("knowledge_entries")
    .select("id, kind, content, note, source, status, updated_at, confirmed_by, skus(sku)", { count: "exact" })
    .order("updated_at", { ascending: false })
    .range(offset, offset + KNOWLEDGE_PAGE_SIZE - 1);

  if (filters.status !== null) entriesQuery = entriesQuery.eq("status", filters.status);
  if (filters.kind !== null) entriesQuery = entriesQuery.eq("kind", filters.kind);
  if (filters.source !== null) entriesQuery = entriesQuery.eq("source", filters.source);
  if (filters.search !== null) entriesQuery = entriesQuery.ilike("content", `%${filters.search}%`);

  const [entriesResult, membership, totalResult, validatedResult, suggestedResult, obsoleteResult] = await Promise.all([
    entriesQuery,
    currentMembership(),
    supabase.from("knowledge_entries").select("id", { count: "exact", head: true }),
    supabase.from("knowledge_entries").select("id", { count: "exact", head: true }).eq("status", "VALIDADO"),
    supabase.from("knowledge_entries").select("id", { count: "exact", head: true }).eq("status", "SUGERIDO"),
    supabase.from("knowledge_entries").select("id", { count: "exact", head: true }).eq("status", "OBSOLETO"),
  ]);

  const entries = entriesResult.data ?? [];
  const confirmedIds = [...new Set(entries.flatMap((entry) => (entry.confirmed_by === null ? [] : [entry.confirmed_by])))];
  const profilesResult = confirmedIds.length === 0
    ? { data: [], error: null }
    : await supabase.from("profiles").select("id, full_name").in("id", confirmedIds);
  const nameById = new Map((profilesResult.data ?? []).map((profile) => [profile.id, profile.full_name] as const));
  const canManage = membership.role === "ADMIN" || membership.role === "GESTOR";
  const rows: KnowledgeRowData[] = entries.map((entry) => ({
    id: entry.id, kind: entry.kind, content: entry.content, note: entry.note, source: entry.source, status: entry.status,
    skuCode: entry.skus?.sku ?? null,
    confirmedByName: entry.confirmed_by === null ? null : (nameById.get(entry.confirmed_by) ?? null),
    updatedAt: entry.updated_at,
  }));

  const total = totalResult.error === null ? (totalResult.count ?? 0) : null;
  const validated = validatedResult.error === null ? (validatedResult.count ?? 0) : null;
  const pending = suggestedResult.error === null ? (suggestedResult.count ?? 0) : null;
  const obsolete = obsoleteResult.error === null ? (obsoleteResult.count ?? 0) : null;
  const validationRate = validated === null || total === null || total === 0 ? null : validated / total;
  const pageBeyondEnd = isPageBeyondEnd(entriesResult.error);
  const listError = pageBeyondEnd ? null : (entriesResult.error?.message ?? profilesResult.error?.message ?? null);
  const window = summarizePagedWindow({
    page: filters.page, totalCount: entriesResult.count ?? entries.length, rowsOnPage: rows.length, pageSize: KNOWLEDGE_PAGE_SIZE,
    noun: { singular: "conhecimento", plural: "conhecimentos" }, emptyLabel: "Nenhum conhecimento neste recorte.", trailing: ", por atualização mais recente",
  });
  const hasFilters = filters.status !== null || filters.kind !== null || filters.source !== null || filters.search !== null;

  return <Shell>
    <PageTitle
      eyebrow="ATENDIMENTO / CONHECIMENTO"
      title="Base de Conhecimento"
      subtitle="A fonte revisada que sustenta atendimento, operação e respostas do Copiloto."
      aside={<><Link className="sb-button" href="/atendimento">← Caixa de Entrada</Link><NewKnowledgeForm /></>}
    />

    <div className="sb-stat-grid" style={{ marginBottom: "var(--sb-space-3)" }}>
      <div className="sb-stat"><span className="sb-stat-label">Conhecimentos registrados</span><b className="sb-stat-value">{total === null ? "—" : formatCount(total)}</b><span className="sb-stat-note">todos os estados, inclusive rejeitados e obsoletos</span></div>
      <div className="sb-stat"><span className="sb-stat-label">Validados pela equipe</span><b className="sb-stat-value">{formatPercent(validationRate)}</b><span className="sb-stat-note">validados ÷ total, com rejeitados e obsoletos no denominador</span></div>
      <div className="sb-stat"><span className="sb-stat-label">Aguardando revisão</span><b className="sb-stat-value">{pending === null ? "—" : formatCount(pending)}</b><span className="sb-stat-note">sugeridos, à espera de ADMIN ou GESTOR</span></div>
      <div className="sb-stat"><span className="sb-stat-label">Fora de uso</span><b className="sb-stat-value">{obsolete === null ? "—" : formatCount(obsolete)}</b><span className="sb-stat-note">histórico preservado; não entra como evidência</span></div>
    </div>

    <Panel
      title={filters.status === "SUGERIDO" ? "Revisão pendente" : "Conhecimentos"}
      subtitle={rows.length > 0 ? window.label : "Só o que está VALIDADO vira evidência do Copiloto."}
      aside={<>
        <FilterMenu rotulo={filters.status === null ? "Todos os estados" : (KNOWLEDGE_STATUS_LABEL[filters.status] ?? filters.status)} opcoes={[
          { href: buildKnowledgeHref(filters, { status: null }), label: "Todos os estados", ativo: filters.status === null },
          ...KNOWLEDGE_STATUSES.map((status) => ({ href: buildKnowledgeHref(filters, { status }), label: KNOWLEDGE_STATUS_LABEL[status] ?? status, ativo: filters.status === status })),
        ]} />
        <FilterMenu rotulo={filters.kind === null ? "Todos os tipos" : (KNOWLEDGE_KIND_LABEL[filters.kind] ?? filters.kind)} opcoes={[
          { href: buildKnowledgeHref(filters, { kind: null }), label: "Todos os tipos", ativo: filters.kind === null },
          ...KNOWLEDGE_KINDS.map((kind) => ({ href: buildKnowledgeHref(filters, { kind }), label: KNOWLEDGE_KIND_LABEL[kind] ?? kind, ativo: filters.kind === kind })),
        ]} />
        <FilterMenu rotulo={filters.source === null ? "Todas as fontes" : (KNOWLEDGE_SOURCE_LABEL[filters.source] ?? filters.source)} opcoes={[
          { href: buildKnowledgeHref(filters, { source: null }), label: "Todas as fontes", ativo: filters.source === null },
          ...KNOWLEDGE_SOURCES.map((source) => ({ href: buildKnowledgeHref(filters, { source }), label: KNOWLEDGE_SOURCE_LABEL[source] ?? source, ativo: filters.source === source })),
        ]} />
      </>}
    >
      <div className="sb-knowledge-toolbar">
        <form method="get" action="/atendimento/conhecimento" className="sb-knowledge-search" role="search">
          {filters.status !== null && <input type="hidden" name="status" value={filters.status} />}
          {filters.kind !== null && <input type="hidden" name="tipo" value={filters.kind} />}
          {filters.source !== null && <input type="hidden" name="fonte" value={filters.source} />}
          <input className="sb-input" type="search" name="busca" defaultValue={filters.search ?? ""} placeholder="Buscar no fato registrado" aria-label="Buscar no fato registrado" />
          <button className="sb-button" type="submit">Buscar</button>
        </form>
        <div className="sb-knowledge-actions">
          {pending !== null && pending > 0 && filters.status !== "SUGERIDO" && <Link className="sb-button" href={buildKnowledgeHref(filters, { status: "SUGERIDO" })}>Revisar {formatCount(pending)} sugestões</Link>}
          {hasFilters && <Link className="sb-text-button" href="/atendimento/conhecimento">Limpar filtros</Link>}
        </div>
      </div>

      {listError !== null && <div role="alert" className="sb-knowledge-state sb-knowledge-state-error"><strong>Não foi possível carregar os conhecimentos.</strong><span>{listError}</span><Link className="sb-button" href={buildKnowledgeHref(filters, { page: filters.page })}>Tentar de novo</Link></div>}
      {pageBeyondEnd && <div className="sb-knowledge-state"><strong>Esta página não existe neste recorte.</strong><span>O conjunto mudou ou o link é antigo.</span><Link className="sb-button" href={buildKnowledgeHref(filters, { page: 1 })}>Voltar à primeira página</Link></div>}
      {listError === null && !pageBeyondEnd && rows.length === 0 && <div className="sb-knowledge-state"><strong>{hasFilters ? "Nenhum conhecimento com estes filtros" : "A base ainda não tem conhecimentos"}</strong><span>{hasFilters ? "Troque o recorte ou limpe os filtros para ver outros registros." : "Registre um fato como sugerido; ele só vira evidência após a validação humana."}</span></div>}
      {listError === null && !pageBeyondEnd && rows.length > 0 && <div style={{ overflowX: "auto" }}><table className="sb-table"><thead><tr><th>SKU</th><th>Tipo</th><th>Conhecimento</th><th>Fonte</th><th>Confirmado por</th><th>Atualizado</th><th>Status</th></tr></thead><tbody>{rows.map((entry) => <KnowledgeRow key={entry.id} entry={entry} canManage={canManage} />)}</tbody></table></div>}
      {listError === null && !pageBeyondEnd && window.totalPages > 1 && <nav className="sb-knowledge-pages" aria-label="Páginas da base de conhecimento">
        {filters.page > 1 ? <Link className="sb-button" href={buildKnowledgeHref(filters, { page: filters.page - 1 })}>‹ Anterior</Link> : <span />}
        <span>Página {formatCount(filters.page)} de {formatCount(window.totalPages)}</span>
        {filters.page < window.totalPages ? <Link className="sb-button" href={buildKnowledgeHref(filters, { page: filters.page + 1 })}>Próxima ›</Link> : <span />}
      </nav>}
    </Panel>
  </Shell>;
}
