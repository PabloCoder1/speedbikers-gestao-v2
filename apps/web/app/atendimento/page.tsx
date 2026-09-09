import Link from "next/link";
import type { ReactNode } from "react";

import { FilterPill } from "../../components/filter-pill";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { isPageBeyondEnd } from "../../lib/filters";
import { formatCount, formatDateTime } from "../../lib/format";
import {
  supportChannelLabel,
  supportInternalStatusLabel,
  supportPriorityLabel,
  supportReplyStateLabel,
} from "../../lib/labels";
import type { SupportCaseLinkRow } from "../../lib/support-case-reference";
import { resolveSupportCaseReference } from "../../lib/support-case-reference";
import {
  CHANNELS,
  INTERNAL_STATUSES,
  PAGE_SIZE,
  buildSupportHref,
  resolveSupportFilters,
  summarizePagedWindow,
  type SupportFilters,
} from "../../lib/support-filters";
import { createClient } from "../../lib/supabase/server";
import { TriageCell } from "./triage-cell";
import { currentMembership } from "../../lib/membership";

export const metadata = { title: "Caixa de Entrada — Speed Bikers Gestão" };

// Sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio de `apps/web/app/anuncios/page.tsx`.
export const dynamic = "force-dynamic";

/**
 * Caixa de Entrada do Atendimento (Fase 7B, D-090) — a primeira tela do SAC.
 *
 * Até aqui a ingestão de Perguntas funcionava (D-087/D-088/D-089) e ninguém
 * conseguia VER o que tinha sido ingerido. Esta tela é só leitura: lista
 * `support_cases` sob RLS, com filtro por conta, tipo e status.
 *
 * **Leitura direta do Supabase, sem rota na `api`** (Modelo A, D-012) — é
 * exatamente a categoria que `docs/ARCHITECTURE.md` secao 4 descreve: read
 * model indexado, nenhum segredo envolvido.
 *
 * **A triagem, ao contrário, passa por RPC** (D-094, `triage_support_case`):
 * ela atualiza `support_cases` E acrescenta `support_case_events` na MESMA
 * transação (D-084), e duas escritas separadas do navegador não teriam como
 * ser atômicas. É a exceção deliberada ao padrão de escrita desta tela.
 *
 * **A fila PAGINA desde D-289.** Ela mostrava as 100 mais recentes e mais
 * nada: com 929 abertos no Dev, 829 casos não tinham como ser alcançados por
 * esta tela — nenhum filtro daqui separa "os 100 mais recentes" do resto, e a
 * frase honesta de D-267 ("100 de 929") só tornava a falta visível. O
 * vocabulário (conta, canal, status, prazo, página) mudou para
 * `lib/support-filters.ts`, sobre a mecânica que oito telas já usam.
 *
 * **Uma tela, não seis.** `docs/PRODUCT_REQUIREMENTS.md` lista "Perguntas",
 * "Mensagens", "Reclamações", "Mediações" e "Devoluções" como grupos da
 * Central — mas D-084 já decidiu que são FILTROS sobre a mesma projeção, não
 * cases separados (mediação e devolução são facetas do claim). Rotas
 * separadas duplicariam a mesma tabela cinco vezes.
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

/**
 * O prazo VIGENTE de um caso — o `ACTIVE` que vence primeiro.
 *
 * Um caso pode ter mais de um prazo (2.059 para 2.840 casos no Dev, então menos
 * de um em média, mas nada impede dois). Escolher o mais próximo em TypeScript
 * não é a agregação que `AGENTS.md` proíbe: as linhas já vieram do banco no
 * mesmo `select`, e é o mesmo que `resolveSupportCaseReference` faz com os
 * vínculos logo ao lado.
 *
 * `null` quando não há prazo ativo — e a célula mostra "—", nunca uma data
 * inventada nem um "no prazo" que ninguém mediu.
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

export default async function AtendimentoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const supabase = await createClient();

  // Três leituras que nada devem umas às outras, juntas desde D-195: eram
  // três idas ao banco em fila antes da primeira linha aparecer.
  //
  // - `getUser()` só serve para a `TriageCell` distinguir "Você" de outro
  //   responsável — a autorização real acontece dentro da RPC, nunca a partir
  //   deste id. Ele revalida o token e custa uma ida inteira; quem barra a
  //   rota é o `proxy.ts`, que já chamou `getUser()` nesta requisição.
  // - a organização vem da RLS em toda leitura; este `select` existe para
  //   distinguir "sem organização" de "falha de leitura" (D-067).
  // - as contas alimentam o seletor e não dependem de nenhuma das outras.
  const [{ data: auth }, membership, accountsResult] = await Promise.all([
    supabase.auth.getUser(),
    currentMembership(supabase),
    supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true }),
  ]);

  const viewerId = auth.user?.id ?? null;

  // Falha de leitura e "sem organização" são coisas diferentes (D-067,
  // Nível 3): a segunda é cadastro, a primeira é erro transitório.
  if (membership.error !== null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Caixa de Entrada</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível verificar sua organização. Tente recarregar a página.
        </p>
      </Shell>
    );
  }

  if (membership.organizationId == null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Caixa de Entrada</h1>
        <p style={{ color: "var(--sb-text-soft)" }}>
          Sua conta não está associada a nenhuma organização.
        </p>
      </Shell>
    );
  }

  /*
    O vocabulário desta tela mora em `lib/support-filters.ts` desde D-289 —
    incluindo `pagina`, que é a dimensão nova. O filtro de SLA (D-115,
    destravado por D-107) continua sendo só cases com prazo ATIVO vencendo nas
    próximas 24h, ou já vencido.
  */
  const filters: SupportFilters = resolveSupportFilters(query);
  const { channel, status, prazo: prazoRisco } = filters;

  const accounts = accountsResult.data ?? [];
  const selectedAccount = accounts.find((account) => account.slug === filters.account) ?? null;

  // O embed de `support_case_links` atravessa a FK COMPOSTA
  // (support_case_id, organization_id, ml_account_id) — é ela que garante que
  // um vínculo nunca pertence a outra conta (D-085). Sem filtro explícito por
  // organização: a RLS (`has_account_access(ml_account_id)`) já restringe, e
  // duplicar a regra aqui seria a segunda fonte de verdade que D-012 evita.
  // O `!inner` do embed de prazos SÓ entra quando o filtro está ativo:
  // como inner join, ele excluiria da listagem normal todo case sem prazo.
  const baseSelect =
    "id, channel, external_case_id, external_status, internal_status, priority, remote_reply_state, is_mediation, has_return, last_activity_at, assignee_id, ml_accounts(label), profiles(full_name), support_case_links(order_id, sku_id, listing_id, external_entity_kind, external_entity_id, skus(sku), listings(item_id, title))";

  /*
    O prazo passa a vir SEMPRE (D-267). Antes ele só era embutido quando o
    filtro "prazo em risco" estava ligado — servia para recortar e nunca
    aparecia. `due_at` existe em 2.059 prazos no Dev, e o frame pede a coluna
    SLA: o dado estava lá, invisível.

    `!inner` continua só no caso do filtro, porque ali o embed É o predicado.
  */
  const embedPrazo = prazoRisco
    ? "support_case_deadlines!inner(due_at, status)"
    : "support_case_deadlines(due_at, status)";

  /*
    `count: "exact"` na MESMA viagem, e agora `.range()` no lugar do `.limit()`
    (D-289). D-267 declarou a janela ("100 de 929") e deixou escrito que a
    paginação ficava como dívida, não como "quando justificar" — o volume já
    justificava. Sem as páginas 2 em diante, os outros 829 abertos do Dev eram
    inalcançáveis por esta tela: nenhum filtro daqui separa "os 100 mais
    recentes" do resto.
  */
  const desde = (filters.page - 1) * PAGE_SIZE;

  let casesQuery = supabase
    .from("support_cases")
    .select(`${baseSelect}, ${embedPrazo}`, { count: "exact" })
    .order("last_activity_at", { ascending: false })
    .range(desde, desde + PAGE_SIZE - 1);

  if (prazoRisco) {
    const em24h = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    casesQuery = casesQuery
      .eq("support_case_deadlines.status", "ACTIVE")
      .lte("support_case_deadlines.due_at", em24h);
  }

  if (selectedAccount !== null) {
    casesQuery = casesQuery.eq("ml_account_id", selectedAccount.id);
  }

  if (channel !== null) {
    casesQuery = casesQuery.eq("channel", channel);
  }

  if (status === "abertos") {
    casesQuery = casesQuery.neq("internal_status", "RESOLVIDO");
  } else if (status !== "todos") {
    casesQuery = casesQuery.eq("internal_status", status);
  }

  const casesResult = await casesQuery;
  const cases = (casesResult.data ?? []) as unknown as SupportCaseRow[];

  /*
    PÁGINA QUE PASSOU DO FIM NÃO É FALHA DE LEITURA — e o PostgREST não as
    distingue sozinho: ele devolve **416 `PGRST103`** com `count` nulo (medido).
    Um `?pagina=9` guardado nos Filtros Salvos depois que a fila encolheu cairia
    aqui, e a tela pintaria "Não foi possível carregar" em vermelho para um
    pedido legítimo. A resposta certa é dizer que a página não existe e
    oferecer a volta — sem inventar total nenhum, porque nesta resposta não
    veio total.
  */
  const paginaVazia = isPageBeyondEnd(casesResult.error);
  const error = paginaVazia ? accountsResult.error : (casesResult.error ?? accountsResult.error);

  /*
    A JANELA DECLARADA (D-267) agora sabe em que página está: "Mostrando 101 a
    200 de 929", não mais "100 de 929" fixo.
  */
  const totalCount = casesResult.count ?? cases.length;
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

  return (
    <Shell>
      <PageTitle
        eyebrow="ATENDIMENTO / OPERAÇÃO"
        title="Caixa de Entrada"
        subtitle={
          <>
            {/* Corrigido em D-111 — dizia "só perguntas são sincronizadas",
                congelado de D-090; os três canais sincronizam desde D-097/D-108. */}
            Perguntas, mensagens pós-venda e reclamações das contas Mercado Livre.
          </>
        }
        aside={
          <>
            <Link href="/atendimento/templates" style={{ fontSize: "0.6875rem", color: "var(--sb-secondary)" }}>
              Templates de resposta
            </Link>
            <Link href="/atendimento/conhecimento" style={{ fontSize: "0.6875rem", color: "var(--sb-secondary)" }}>
              Base de Conhecimento
            </Link>
            <Link href="/atendimento/metricas" style={{ fontSize: "0.6875rem", color: "var(--sb-secondary)" }}>
              Métricas
            </Link>
          </>
        }
      />

      {/*
        O `support-overview` do frame: um selo, UM número e uma nota — não é
        faixa de KPIs. Ele trata cada fila como tela própria, e o número dele é
        o daquela fila; aqui é o do RECORTE ATUAL, que é exatamente o que a
        tabela mostra, para cabeçalho e corpo não discordarem (D-236).

        A legenda do frame ("Fila priorizada por prazo, risco e cliente") NÃO
        entrou: a fila ordena por `last_activity_at desc`, não por prazo nem
        risco. Afirmar priorização que não acontece é pior do que não dizer
        nada, porque o operador confiaria no topo da lista.
      */}
      {error === null && !paginaVazia && (
        <div className="sb-stat" style={{ marginBottom: "var(--sb-space-3)", maxWidth: "24rem" }}>
          <span className="sb-stat-label">No recorte</span>
          <b className="sb-stat-value">{formatCount(totalCount)}</b>
          <span className="sb-stat-note">{janela.label}</span>
        </div>
      )}

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os atendimentos: {error.message}
        </p>
      )}

      {accountsResult.error === null && accounts.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-2)" }}>
          <FilterPill href={buildSupportHref(current, { account: null })} active={selectedAccount === null}>
            Todas as contas
          </FilterPill>
          {accounts.map((account) => (
            <FilterPill
              key={account.id}
              href={buildSupportHref(current, { account: account.slug })} active={selectedAccount?.id === account.id}
            >
              {account.label}
            </FilterPill>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-2)" }}>
        <FilterPill href={buildSupportHref(current, { channel: null })} active={channel === null}>
          Todos os tipos
        </FilterPill>
        {CHANNELS.map((code) => (
          <FilterPill key={code} href={buildSupportHref(current, { channel: code })} active={channel === code}>
            {supportChannelLabel(code)}
          </FilterPill>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-4)" }}>
        <FilterPill href={buildSupportHref(current, { status: "abertos" })} active={status === "abertos"}>
          Abertos
        </FilterPill>
        {INTERNAL_STATUSES.map((code) => (
          <FilterPill key={code} href={buildSupportHref(current, { status: code })} active={status === code}>
            {supportInternalStatusLabel(code)}
          </FilterPill>
        ))}
        <FilterPill href={buildSupportHref(current, { status: "todos" })} active={status === "todos"}>
          Todos
        </FilterPill>
        <FilterPill href={buildSupportHref(current, { prazo: !prazoRisco })} active={prazoRisco} tone="danger">
          ⏱ Prazo em risco
        </FilterPill>
      </div>

      {/*
        A PÁGINA QUE NÃO EXISTE tem texto próprio, e o motivo é que ela não é
        "fila vazia": o recorte pode estar cheio, e só esta página passou do
        fim. Mandar de volta à primeira é a única ação útil daqui.
      */}
      {paginaVazia && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          Esta página não existe neste recorte — a fila encolheu ou o link é antigo.{" "}
          <Link href={buildSupportHref(current, { page: 1 })}>Voltar à primeira página</Link>.
        </p>
      )}

      {error === null && !paginaVazia && cases.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          {status === "abertos" && channel === null && selectedAccount === null
            ? "Nenhum atendimento em aberto. A sincronização traz perguntas novas pelo webhook em segundos e reconcilia a cada 6 horas."
            : "Nenhum atendimento com esses filtros."}
        </p>
      )}

      {error === null && cases.length > 0 && (
        <Panel
          title="Fila de atendimentos"
          subtitle="Prazo, tipo, produto e conta visíveis antes de abrir o caso."
        >
          <div style={{ overflowX: "auto" }}>
            <table className="sb-table">
              <thead>
                <tr>
                  <th>Prioridade</th>
                  {/*
                    O frame trata Perguntas, Mensagens, Reclamações, Devoluções
                    e Mediações como CINCO telas. Aqui são cinco recortes de uma
                    fila só — e essa decisão não é desta fatia: **D-084 já a
                    tomou**, porque mediação e devolução são FACETAS do claim,
                    não canais próprios. O cabeçalho deste arquivo diz isso
                    desde então ("uma tela, não seis").

                    Por isso o tipo precisa ser coluna: com as cinco filas
                    juntas, sem ela a linha não diz de qual veio.
                  */}
                  <th>Tipo</th>
                  <th>Conta</th>
                  <th>Produto / referência</th>
                  {/*
                    A coluna que o frame acrescenta e que o dado já sustentava
                    sem aparecer: `due_at` existe em 2.059 prazos no Dev e até
                    aqui só servia de filtro.
                  */}
                  <th>SLA</th>
                  <th>Status</th>
                  {/*
                    Onde o frame põe "Responsável". A célula é maior que o
                    rótulo dele: `TriageCell` controla prioridade E atribuição
                    na mesma escrita atômica (D-094), então o cabeçalho diz o
                    que ela é de verdade.
                  */}
                  <th>Triagem</th>
                  <th>Última atividade</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((row) => {
                  const reference = resolveSupportCaseReference(row.support_case_links);
                  const rowFacets = facets(row);
                  const prazo = prazoVigente(row.support_case_deadlines);

                  return (
                    <tr key={row.id}>
                      <td>
                        <StatusPill code={row.priority} label={supportPriorityLabel(row.priority)} />
                      </td>

                      <td>
                        {/*
                          O RECORTE VIAJA COM O CASO (D-286).

                          Abrir um atendimento e voltar devolvia a fila sem
                          filtro nenhum: quem recortou "prazo em risco +
                          reclamação + Loja X" entre **943 casos abertos**
                          recomeçava do zero a cada caso lido. É a única coisa
                          que o inbox de três colunas do frame realmente
                          protege, e ela custa um parâmetro — não uma tela.
                        */}
                        <Link
                          href={`/atendimento/${row.id}?volta=${encodeURIComponent(
                            /*
                              A PÁGINA VIAJA JUNTO (D-289). `buildSupportHref`
                              volta à página 1 quando um FILTRO muda — conjunto
                              novo, começo novo —, e aqui nada mudou: passar
                              `page` de propósito é o que impede que ler o caso
                              da página 7 devolva a pessoa à 1.
                            */
                            buildSupportHref(current, { page: current.page }),
                          )}`}
                        >
                          {supportChannelLabel(row.channel)}
                        </Link>
                        {rowFacets.length > 0 && <div className="sb-mono">{rowFacets.join(" · ")}</div>}
                        <div className="sb-mono">
                          #{row.external_case_id}
                          {row.external_status !== null && ` · ${row.external_status}`}
                        </div>
                      </td>

                      <td>{row.ml_accounts?.label ?? "—"}</td>

                      <td>
                        {reference === null ? (
                          "—"
                        ) : (
                          <>
                            {reference.href === null ? (
                              <span>{reference.code}</span>
                            ) : (
                              <Link href={reference.href}>{reference.code}</Link>
                            )}
                            {reference.title !== null && <div className="sb-mono">{reference.title}</div>}
                          </>
                        )}
                      </td>

                      {/* Sem prazo ativo é "—", nunca "no prazo": ninguém mediu isso. */}
                      <td style={{ whiteSpace: "nowrap" }}>
                        {prazo === null ? <span style={{ color: "var(--sb-text-soft)" }}>—</span> : formatDateTime(prazo)}
                      </td>

                      <td>
                        <StatusPill
                          code={row.internal_status}
                          label={supportInternalStatusLabel(row.internal_status)}
                        />
                        <div style={{ marginTop: "0.25rem" }}>
                          <StatusPill
                            code={row.remote_reply_state}
                            label={supportReplyStateLabel(row.remote_reply_state)}
                          />
                        </div>
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

                      <td style={{ whiteSpace: "nowrap" }}>{formatDateTime(row.last_activity_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/*
        O PAGINADOR — mesma forma de `/precos` e `/curva-abc`: duas pílulas, e
        só quando há mais de uma página. Sem salto para página arbitrária de
        propósito: a fila ordena por atividade recente e muda embaixo de quem
        lê, então "página 7" não é um lugar estável — anterior e próxima são o
        que se pode prometer.
      */}
      {error === null && !paginaVazia && janela.totalPages > 1 && (
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <FilterPill href={buildSupportHref(current, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          {filters.page < janela.totalPages && (
            <FilterPill href={buildSupportHref(current, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
