import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu } from "../../components/filter-menu";
import { FilterPill } from "../../components/filter-pill";
import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { isPageBeyondEnd } from "../../lib/filters";
import { formatCount, formatDateTime } from "../../lib/format";
import {
  supportChannelLabel,
  supportExternalStatusLabel,
  supportInternalStatusLabel,
  supportPriorityLabel,
  supportReplyStateLabel,
} from "../../lib/labels";
import { currentMembership } from "../../lib/request-membership";
import type { SupportCaseLinkRow } from "../../lib/support-case-reference";
import { resolveSupportCaseReference } from "../../lib/support-case-reference";
import { describeDeadline } from "../../lib/support-deadline";
import {
  CHANNELS,
  INTERNAL_STATUSES,
  PAGE_SIZE,
  buildSupportHref,
  classifySupportSearch,
  resolveSupportFilters,
  summarizePagedWindow,
  type SupportFilters,
} from "../../lib/support-filters";
import { createClient } from "../../lib/supabase/server";
import { TriageCell } from "./triage-cell";

export const metadata = { title: "Caixa de Entrada — Speed Bikers Gestão" };

// Sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de `apps/web/app/anuncios/page.tsx`.
export const dynamic = "force-dynamic";

/**
 * Caixa de Entrada do Atendimento (Fase 7B, D-090), redesenhada no lote 2 do
 * pente fino (D-384, 18/09).
 *
 * **Uma tela, não seis** (D-084): perguntas, mensagens, reclamações, mediações e
 * devoluções são recortes da mesma fila — mediação e devolução são FACETAS do
 * claim. **Leitura direta do Supabase** sob RLS (Modelo A, D-012); a triagem
 * passa por RPC (`triage_support_case`, D-094) porque escreve o caso e o evento
 * na mesma transação.
 *
 * O que o lote 2 mudou, e por quê:
 *
 * - **Faixa de indicadores clicável**, com as contagens canônicas de
 *   `get_support_metrics` (METRICS 5B) — a MESMA fonte de /atendimento/metricas,
 *   para os dois lugares nunca discordarem. Cada número abre a fila que ele
 *   conta. "Aguardando a loja" NÃO é link: a regra compara duas colunas da
 *   linha (`last_inbound_at > last_outbound_at`), e o filtro do PostgREST não
 *   expressa isso sem migration — um link abriria uma fila que não bate com o
 *   número.
 * - **"Meus"**, **"Mediação"**, **prazo vencido / vence em 24 h** e **busca** por
 *   número do caso, pedido, MLB ou SKU. Com 900+ abertos, sem isso não havia
 *   como achar a própria fila nem um caso citado pelo cliente.
 * - **Prazo com leitura**: "vencido há 3 h" em vermelho, "vence em 5 h" em
 *   amarelo — a coluna mostrava só a data.
 * - **Status do ML traduzido** ("UNANSWERED" virou "sem resposta no ML").
 * - Três fileiras de pílulas viraram menus; as ações da tela viraram botões.
 *
 * A ordem segue `last_activity_at desc` e a tela NÃO afirma priorização por
 * prazo ou risco (D-267): o topo da lista não é "o mais urgente", e dizer isso
 * faria o operador confiar no que não acontece.
 */

interface SupportCaseRow {
  id: string;
  channel: string;
  external_case_id: string;
  external_status: string | null;
  internal_status: string;
  priority: string;
  remote_reply_state: string;
  is_mediation: boolean;
  has_return: boolean;
  last_activity_at: string;
  assignee_id: string | null;
  ml_accounts: { label: string } | null;
  profiles: { full_name: string | null } | null;
  support_case_links: SupportCaseLinkRow[] | null;
  support_case_deadlines: { due_at: string | null; status: string }[] | null;
}

interface SupportMetricsRow {
  abertos_total: number;
  aguardando_loja: number;
  mediacoes_abertas: number;
  prazos_proximas_24h: number;
  prazos_vencidos: number;
}

/** Teto da busca: é recorte para achar um caso, não para listar a base. */
const SEARCH_LIMIT = 500;

/**
 * O prazo VIGENTE de um caso — o `ACTIVE` que vence primeiro. Escolher em
 * TypeScript não é a agregação que `AGENTS.md` proíbe: as linhas vieram no
 * mesmo `select`. `null` quando não há prazo ativo — "—", nunca "no prazo".
 */
function prazoVigente(linhas: SupportCaseRow["support_case_deadlines"]): string | null {
  if (linhas === null) return null;

  const ativos = linhas
    .filter((linha): linha is { due_at: string; status: string } => linha.status === "ACTIVE" && linha.due_at !== null)
    .map((linha) => linha.due_at)
    .sort();

  return ativos[0] ?? null;
}

/** Facetas do claim (D-084) — mostradas junto do tipo, nunca como tipo próprio. */
function facets(row: SupportCaseRow): string[] {
  const result: string[] = [];
  if (row.is_mediation) result.push("Mediação");
  if (row.has_return) result.push("Devolução");
  return result;
}

type Supabase = Awaited<ReturnType<typeof createClient>>;

/**
 * A busca vira uma lista de ids de caso. Cada ramo usa um índice que já existe
 * (`support_case_links_{order,sku,listing}_idx`, D-085) e nenhum lê a base
 * inteira: SKU e anúncio primeiro acham o cadastro, depois o vínculo.
 */
async function casosDaBusca(supabase: Supabase, search: string): Promise<{ ids: string[]; error: string | null }> {
  const termo = classifySupportSearch(search);
  const ids = new Set<string>();

  if (termo.kind === "numero") {
    const [casos, pedidos] = await Promise.all([
      supabase.from("support_cases").select("id").eq("external_case_id", termo.value).limit(50),
      supabase.from("support_case_links").select("support_case_id").eq("order_id", Number(termo.value)).limit(SEARCH_LIMIT),
    ]);

    if (casos.error !== null || pedidos.error !== null) {
      return { ids: [], error: (casos.error ?? pedidos.error)?.message ?? "falha na busca" };
    }

    for (const linha of casos.data) ids.add(linha.id);
    for (const linha of pedidos.data) ids.add(linha.support_case_id);

    return { ids: [...ids], error: null };
  }

  const cadastro =
    termo.kind === "anuncio"
      ? await supabase.from("listings").select("id").eq("item_id", termo.value).limit(20)
      : await supabase.from("skus").select("id").ilike("sku", `%${termo.value}%`).limit(50);

  if (cadastro.error !== null) return { ids: [], error: cadastro.error.message };

  const alvos = cadastro.data.map((linha) => linha.id);

  if (alvos.length === 0) return { ids: [], error: null };

  // fila-justificada: vinculos usa os IDs descobertos pela consulta cadastro acima.
  const vinculos = await supabase
    .from("support_case_links")
    .select("support_case_id")
    .in(termo.kind === "anuncio" ? "listing_id" : "sku_id", alvos)
    .limit(SEARCH_LIMIT);

  if (vinculos.error !== null) return { ids: [], error: vinculos.error.message };

  for (const linha of vinculos.data) ids.add(linha.support_case_id);

  return { ids: [...ids], error: null };
}

export default async function AtendimentoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();
  const filters: SupportFilters = resolveSupportFilters(query);

  // Leituras independentes, juntas (D-195). `getUser()` só serve para "Você"
  // e para o filtro "Meus" — a autorização real é da RLS e da RPC de triagem.
  const [{ data: auth }, membership, accountsResult, metricsResult] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(),
    supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true }),
    supabase.rpc("get_support_metrics", { p_days: 7 }).maybeSingle(),
  ]);

  const viewerId = auth.user?.id ?? null;

  // Falha de leitura e "sem organização" são coisas diferentes (D-067).
  if (membership.error !== null || membership.organizationId == null) {
    return (
      <Shell>
        <PageTitle eyebrow="ATENDIMENTO / OPERAÇÃO" title="Caixa de Entrada" />
        <p role={membership.error !== null ? "alert" : undefined} className="sb-empty">
          {membership.error !== null
            ? "Não foi possível verificar sua organização. Tente recarregar a página."
            : "Sua conta não está associada a nenhuma organização."}
        </p>
      </Shell>
    );
  }

  const { channel, status, prazo } = filters;
  const accounts = accountsResult.data ?? [];
  const selectedAccount = accounts.find((account) => account.slug === filters.account) ?? null;

  // "Meus" sem saber quem está vendo não pode virar "todos": fila vazia é a
  // resposta honesta, e o aviso abaixo diz por quê.
  const semViewer = filters.mine && viewerId === null;

  const busca = filters.search === null ? null : await casosDaBusca(supabase, filters.search);

  /*
    O embed de `support_case_links` atravessa a FK COMPOSTA (D-085). Prazo vem
    SEMPRE (D-267); `!inner` só quando o recorte de prazo está ligado, porque
    como inner join ele excluiria da listagem normal todo caso sem prazo.
  */
  const baseSelect =
    "id, channel, external_case_id, external_status, internal_status, priority, remote_reply_state, is_mediation, has_return, last_activity_at, assignee_id, ml_accounts(label), profiles(full_name), support_case_links(order_id, sku_id, listing_id, external_entity_kind, external_entity_id, skus(sku), listings(item_id, title))";
  const embedPrazo = prazo === null ? "support_case_deadlines(due_at, status)" : "support_case_deadlines!inner(due_at, status)";

  const desde = (filters.page - 1) * PAGE_SIZE;
  const agora = new Date();
  const agoraIso = agora.toISOString();
  const em24h = new Date(agora.getTime() + 24 * 60 * 60 * 1000).toISOString();

  let casesQuery = supabase
    .from("support_cases")
    .select(`${baseSelect}, ${embedPrazo}`, { count: "exact" })
    .order("last_activity_at", { ascending: false })
    .range(desde, desde + PAGE_SIZE - 1);

  if (prazo !== null) {
    casesQuery = casesQuery.eq("support_case_deadlines.status", "ACTIVE");

    if (prazo === "risco") casesQuery = casesQuery.lte("support_case_deadlines.due_at", em24h);
    if (prazo === "vencido") casesQuery = casesQuery.lt("support_case_deadlines.due_at", agoraIso);
    if (prazo === "24h") {
      casesQuery = casesQuery.gte("support_case_deadlines.due_at", agoraIso).lt("support_case_deadlines.due_at", em24h);
    }
  }

  if (selectedAccount !== null) casesQuery = casesQuery.eq("ml_account_id", selectedAccount.id);
  if (channel !== null) casesQuery = casesQuery.eq("channel", channel);
  if (filters.mediation) casesQuery = casesQuery.eq("is_mediation", true);
  if (filters.mine && viewerId !== null) casesQuery = casesQuery.eq("assignee_id", viewerId);
  if (busca !== null) casesQuery = casesQuery.in("id", busca.ids.length === 0 ? ["00000000-0000-0000-0000-000000000000"] : busca.ids);

  if (status === "abertos") {
    casesQuery = casesQuery.neq("internal_status", "RESOLVIDO");
  } else if (status !== "todos") {
    casesQuery = casesQuery.eq("internal_status", status);
  }

  // "Meus abertos" para a faixa — uma contagem com `head`, sem trazer linha.
  const [casesResult, meusResult] = await Promise.all([
    semViewer || busca?.error != null ? Promise.resolve(null) : casesQuery,
    viewerId === null
      ? Promise.resolve(null)
      : supabase
          .from("support_cases")
          .select("id", { count: "exact", head: true })
          .eq("assignee_id", viewerId)
          .neq("internal_status", "RESOLVIDO"),
  ]);

  const cases = (casesResult?.data ?? []) as unknown as SupportCaseRow[];

  /*
    Página que passou do fim não é falha de leitura: o PostgREST devolve 416
    `PGRST103` com `count` nulo (medido, D-289). A tela diz que a página não
    existe e oferece a volta.
  */
  const paginaVazia = isPageBeyondEnd(casesResult?.error ?? null);
  const erroLista = busca?.error ?? (paginaVazia ? null : (casesResult?.error?.message ?? null));
  const erro = erroLista ?? accountsResult.error?.message ?? null;

  const totalCount = casesResult?.count ?? cases.length;
  const janela = summarizePagedWindow({
    page: filters.page,
    totalCount,
    rowsOnPage: cases.length,
    pageSize: PAGE_SIZE,
    noun: { singular: "atendimento", plural: "atendimentos" },
    emptyLabel: "Nenhum atendimento com estes filtros.",
    trailing: ", por atividade mais recente",
  });

  const current = filters;
  const limpo: Partial<SupportFilters> = {
    account: null,
    channel: null,
    status: "abertos",
    prazo: null,
    mine: false,
    mediation: false,
    search: null,
  };

  const metrics = metricsResult.error === null ? (metricsResult.data as SupportMetricsRow | null) : null;
  const numero = (valor: number | undefined): string => (metrics === null || valor === undefined ? "—" : formatCount(valor));

  /*
    A faixa conta a ORGANIZAÇÃO inteira (é a leitura de `get_support_metrics`,
    que não recebe conta), e é navegação: cada célula abre a fila dela a partir
    do recorte limpo. É por isso que ela não segue os filtros da tabela — o
    número do painel abaixo é o do recorte (D-236).
  */
  const celulas: KpiCellData[] = [
    {
      label: "Abertos",
      formula: "Atendimentos com status interno diferente de Resolvido, em todas as contas.",
      value: numero(metrics?.abertos_total),
      previous: null,
      href: buildSupportHref(current, limpo),
      tom: "neutro",
    },
    {
      label: "Aguardando a loja",
      formula: "Pergunta sem resposta, ou conversa/reclamação em que o cliente falou por último.",
      value: numero(metrics?.aguardando_loja),
      previous: null,
      ressalva: "pergunta sem resposta ou cliente falou por último",
      tom: "atencao",
      ...(metrics !== null && metrics.aguardando_loja > 0 ? { destaque: "atencao" as const } : {}),
    },
    {
      label: "Prazo vencido",
      formula: "Prazos ativos do Mercado Livre com a data no passado.",
      value: numero(metrics?.prazos_vencidos),
      previous: null,
      href: buildSupportHref(current, { ...limpo, prazo: "vencido" }),
      tom: "perigo",
      ...(metrics !== null && metrics.prazos_vencidos > 0 ? { destaque: "perigo" as const } : {}),
    },
    {
      label: "Vence em 24 h",
      formula: "Prazos ativos do Mercado Livre que vencem nas próximas 24 horas.",
      value: numero(metrics?.prazos_proximas_24h),
      previous: null,
      href: buildSupportHref(current, { ...limpo, prazo: "24h" }),
      tom: "atencao",
    },
    {
      label: "Em mediação",
      formula: "Reclamações abertas com mediação do Mercado Livre.",
      value: numero(metrics?.mediacoes_abertas),
      previous: null,
      href: buildSupportHref(current, { ...limpo, mediation: true }),
      tom: "perigo",
    },
    {
      label: "Meus abertos",
      formula: "Atendimentos abertos atribuídos a você.",
      value: meusResult?.error !== null ? "—" : formatCount(meusResult.count ?? 0),
      previous: null,
      href: buildSupportHref(current, { ...limpo, mine: true }),
      tom: "info",
    },
  ];

  const rotuloConta = selectedAccount?.label ?? "Todas as contas";
  const rotuloTipo = channel === null ? "Todos os tipos" : supportChannelLabel(channel);
  const rotuloStatus =
    status === "abertos" ? "Abertos" : status === "todos" ? "Todos os status" : supportInternalStatusLabel(status);

  const recorteAtivo =
    filters.account !== null ||
    channel !== null ||
    status !== "abertos" ||
    prazo !== null ||
    filters.mine ||
    filters.mediation ||
    filters.search !== null;

  return (
    <Shell>
      <PageTitle
        eyebrow="ATENDIMENTO / OPERAÇÃO"
        title="Caixa de Entrada"
        subtitle="Perguntas, mensagens pós-venda e reclamações das contas Mercado Livre, numa fila só."
        aside={
          <>
            <Link className="sb-button" href="/atendimento/metricas">
              <Icone nome="barras" tamanho={14} /> Métricas
            </Link>
            <Link className="sb-button" href="/atendimento/templates">
              <Icone nome="mensagem" tamanho={14} /> Templates
            </Link>
            <Link className="sb-button" href="/atendimento/conhecimento">
              <Icone nome="livro" tamanho={14} /> Base de conhecimento
            </Link>
          </>
        }
      />

      <KpiStrip ancora cells={celulas} />

      {metricsResult.error !== null && (
        <p role="alert" className="sb-inbox-note sb-inbox-note-danger">
          Os indicadores acima não carregaram agora — a fila abaixo continua valendo.
        </p>
      )}

      <div className="sb-inbox-section">
        <Panel
          title="Fila de atendimentos"
          // A janela só quando há linha: vazia, o estado abaixo já diz o que houve.
          {...(cases.length > 0 ? { subtitle: janela.label } : {})}
          aside={
            <>
              {accountsResult.error === null && accounts.length > 1 && (
                <FilterMenu
                  rotulo={rotuloConta}
                  opcoes={[
                    { href: buildSupportHref(current, { account: null }), label: "Todas as contas", ativo: selectedAccount === null },
                    ...accounts.map((account) => ({
                      href: buildSupportHref(current, { account: account.slug }),
                      label: account.label,
                      ativo: selectedAccount?.id === account.id,
                    })),
                  ]}
                />
              )}
              <FilterMenu
                rotulo={rotuloTipo}
                opcoes={[
                  { href: buildSupportHref(current, { channel: null }), label: "Todos os tipos", ativo: channel === null },
                  ...CHANNELS.map((code) => ({
                    href: buildSupportHref(current, { channel: code }),
                    label: supportChannelLabel(code),
                    ativo: channel === code,
                  })),
                ]}
              />
              <FilterMenu
                rotulo={rotuloStatus}
                opcoes={[
                  { href: buildSupportHref(current, { status: "abertos" }), label: "Abertos", ativo: status === "abertos" },
                  ...INTERNAL_STATUSES.map((code) => ({
                    href: buildSupportHref(current, { status: code }),
                    label: supportInternalStatusLabel(code),
                    ativo: status === code,
                  })),
                  { href: buildSupportHref(current, { status: "todos" }), label: "Todos os status", ativo: status === "todos" },
                ]}
              />
            </>
          }
        >
          <div className="sb-inbox-toolbar">
            <form method="get" action="/atendimento" className="sb-inbox-search" role="search">
              {/* GET nativo só envia os campos do form: as outras dimensões vão escondidas. */}
              {filters.account !== null && <input type="hidden" name="account" value={filters.account} />}
              {channel !== null && <input type="hidden" name="canal" value={channel} />}
              {status !== "abertos" && <input type="hidden" name="status" value={status} />}
              {prazo !== null && <input type="hidden" name="prazo" value={prazo} />}
              {filters.mine && <input type="hidden" name="meus" value="1" />}
              {filters.mediation && <input type="hidden" name="mediacao" value="1" />}
              <span className="sb-inbox-search-icon" aria-hidden="true">
                <Icone nome="lupa" tamanho={14} />
              </span>
              <input
                className="sb-input"
                type="search"
                name="busca"
                defaultValue={filters.search ?? ""}
                placeholder="Nº do caso, pedido, MLB ou SKU"
                aria-label="Buscar por número do caso, pedido, anúncio (MLB) ou SKU"
              />
              <button className="sb-button" type="submit">
                Buscar
              </button>
            </form>

            <div className="sb-inbox-toggles" aria-label="Recortes rápidos">
              <FilterPill href={buildSupportHref(current, { mine: !filters.mine })} active={filters.mine}>
                Meus
              </FilterPill>
              <FilterPill
                href={buildSupportHref(current, { prazo: prazo === "risco" ? null : "risco" })}
                active={prazo === "risco"}
                tone="danger"
              >
                Prazo em risco
              </FilterPill>
              <FilterPill href={buildSupportHref(current, { mediation: !filters.mediation })} active={filters.mediation}>
                Mediação
              </FilterPill>
              {recorteAtivo && (
                <Link className="sb-text-button" href={buildSupportHref(current, limpo)}>
                  Limpar filtros
                </Link>
              )}
            </div>
          </div>

          {(prazo === "vencido" || prazo === "24h") && (
            <p className="sb-inbox-note">
              <strong>{prazo === "vencido" ? "Prazo vencido" : "Vence em 24 h"}</strong>:{" "}
              {prazo === "vencido"
                ? "casos com prazo ativo do Mercado Livre já no passado."
                : "casos com prazo ativo do Mercado Livre nas próximas 24 horas."}
            </p>
          )}

          {semViewer && (
            <p className="sb-inbox-note">Não foi possível identificar quem está vendo — o recorte “Meus” fica vazio.</p>
          )}

          {erro !== null && (
            <div role="alert" className="sb-inbox-state sb-inbox-state-error">
              <strong>Não foi possível carregar os atendimentos.</strong>
              <span>{erro}</span>
              <Link className="sb-button" href={buildSupportHref(current, { page: current.page })}>
                Tentar de novo
              </Link>
            </div>
          )}

          {/* Página além do fim não é "fila vazia": o recorte pode estar cheio. */}
          {paginaVazia && erro === null && (
            <div className="sb-inbox-state">
              <strong>Esta página não existe neste recorte.</strong>
              <span>A fila encolheu ou o link é antigo.</span>
              <Link className="sb-button" href={buildSupportHref(current, { page: 1 })}>
                Voltar à primeira página
              </Link>
            </div>
          )}

          {erro === null && !paginaVazia && cases.length === 0 && (
            <div className="sb-inbox-state">
              <span className="sb-inbox-state-icon" aria-hidden="true">
                <Icone nome="bandeja" tamanho={20} />
              </span>
              <strong>{recorteAtivo ? "Nenhum atendimento com estes filtros" : "Nenhum atendimento em aberto"}</strong>
              <span>
                {recorteAtivo
                  ? filters.search !== null
                    ? "A busca procura o número do caso, o número do pedido, o MLB do anúncio ou o código do SKU."
                    : "Troque o recorte ou limpe os filtros."
                  : "A sincronização traz perguntas novas pelo webhook em segundos e reconcilia a cada 6 horas."}
              </span>
            </div>
          )}

          {erro === null && cases.length > 0 && (
            <div className="sb-inbox-table-wrap">
              <table className="sb-table sb-inbox-table">
                <thead>
                  <tr>
                    <th>Prioridade</th>
                    <th>Tipo</th>
                    <th>Conta</th>
                    <th>Produto / referência</th>
                    <th>Prazo</th>
                    <th>Status</th>
                    {/* `TriageCell` controla prioridade E atribuição na mesma escrita (D-094). */}
                    <th>Triagem</th>
                    <th>Última atividade</th>
                    <th aria-label="Abrir" />
                  </tr>
                </thead>
                <tbody>
                  {cases.map((row) => {
                    const reference = resolveSupportCaseReference(row.support_case_links);
                    const rowFacets = facets(row);
                    const prazoDoCaso = prazoVigente(row.support_case_deadlines);
                    const leituraPrazo = prazoDoCaso === null ? null : describeDeadline(prazoDoCaso, agora);
                    /*
                      O RECORTE E A PÁGINA VIAJAM COM O CASO (D-286, D-289): quem
                      abre um caso da página 7 de "Prazo em risco + Loja X" volta
                      para lá, não para o começo da fila.
                    */
                    const hrefCaso = `/atendimento/${row.id}?volta=${encodeURIComponent(
                      buildSupportHref(current, { page: current.page }),
                    )}`;

                    return (
                      <tr key={row.id} className={leituraPrazo?.tone === "perigo" ? "sb-inbox-row-late" : undefined}>
                        <td>
                          <StatusPill code={row.priority} label={supportPriorityLabel(row.priority)} />
                        </td>

                        <td>
                          <Link className="sb-inbox-case" href={hrefCaso}>
                            {supportChannelLabel(row.channel)}
                          </Link>
                          {rowFacets.length > 0 && <span className="sb-inbox-facets">{rowFacets.join(" · ")}</span>}
                          <span className="sb-inbox-meta">
                            <span className="sb-mono">#{row.external_case_id}</span>
                            {row.external_status !== null && ` · ${supportExternalStatusLabel(row.external_status)}`}
                          </span>
                        </td>

                        <td>{row.ml_accounts?.label ?? "—"}</td>

                        <td>
                          {reference === null ? (
                            <span className="sb-inbox-muted">—</span>
                          ) : (
                            <>
                              {reference.href === null ? (
                                <span>{reference.code}</span>
                              ) : (
                                <Link href={reference.href}>{reference.code}</Link>
                              )}
                              {reference.title !== null && <span className="sb-inbox-meta">{reference.title}</span>}
                            </>
                          )}
                        </td>

                        {/* Sem prazo ativo é "—", nunca "no prazo": ninguém mediu isso. */}
                        <td className="sb-inbox-deadline">
                          {prazoDoCaso === null || leituraPrazo === null ? (
                            <span className="sb-inbox-muted">—</span>
                          ) : (
                            <>
                              {leituraPrazo.relative !== null && (
                                <span className={`sb-inbox-deadline-pill sb-inbox-deadline-${leituraPrazo.tone}`}>
                                  {leituraPrazo.relative}
                                </span>
                              )}
                              <span className="sb-inbox-meta">{formatDateTime(prazoDoCaso)}</span>
                            </>
                          )}
                        </td>

                        <td>
                          <StatusPill code={row.internal_status} label={supportInternalStatusLabel(row.internal_status)} />
                          <span className="sb-inbox-reply">
                            <StatusPill code={row.remote_reply_state} label={supportReplyStateLabel(row.remote_reply_state)} />
                          </span>
                        </td>

                        <td>
                          <TriageCell
                            triage={{
                              id: row.id,
                              internalStatus: row.internal_status,
                              priority: row.priority,
                              assigneeId: row.assignee_id,
                              assigneeName: row.profiles?.full_name ?? null,
                              viewerId,
                            }}
                          />
                        </td>

                        <td className="sb-inbox-nowrap">{formatDateTime(row.last_activity_at)}</td>

                        <td>
                          <Link className="sb-button sb-inbox-open" href={hrefCaso} aria-label={`Abrir o caso #${row.external_case_id}`}>
                            Abrir
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/*
            Anterior e próxima, sem salto para página arbitrária: a fila ordena
            por atividade recente e muda embaixo de quem lê (D-289).
          */}
          {erro === null && !paginaVazia && janela.totalPages > 1 && (
            <nav className="sb-inbox-pages" aria-label="Páginas">
              {filters.page > 1 ? (
                <Link className="sb-button" href={buildSupportHref(current, { page: filters.page - 1 })}>
                  ‹ Anterior
                </Link>
              ) : (
                <span />
              )}
              <span>
                Página {formatCount(filters.page)} de {formatCount(janela.totalPages)}
              </span>
              {filters.page < janela.totalPages ? (
                <Link className="sb-button" href={buildSupportHref(current, { page: filters.page + 1 })}>
                  Próxima ›
                </Link>
              ) : (
                <span />
              )}
            </nav>
          )}
        </Panel>
      </div>
    </Shell>
  );
}
