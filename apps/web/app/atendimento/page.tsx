import Link from "next/link";
import type { ReactNode } from "react";

import { FilterPill } from "../../components/filter-pill";
import { Shell } from "../../components/shell";
import { StatusPill } from "../../components/status-pill";
import { formatDateTime } from "../../lib/format";
import {
  supportChannelLabel,
  supportInternalStatusLabel,
  supportPriorityLabel,
  supportReplyStateLabel,
} from "../../lib/labels";
import type { SupportCaseLinkRow } from "../../lib/support-case-reference";
import { resolveSupportCaseReference } from "../../lib/support-case-reference";
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
 * **Uma tela, não seis.** `docs/PRODUCT_REQUIREMENTS.md` lista "Perguntas",
 * "Mensagens", "Reclamações", "Mediações" e "Devoluções" como grupos da
 * Central — mas D-084 já decidiu que são FILTROS sobre a mesma projeção, não
 * cases separados (mediação e devolução são facetas do claim). Rotas
 * separadas duplicariam a mesma tabela cinco vezes.
 */

/** `internal_status` é fechado em cinco valores (D-084). */
const INTERNAL_STATUSES = [
  "NOVO",
  "EM_ATENDIMENTO",
  "AGUARDANDO_CLIENTE",
  "AGUARDANDO_MERCADO_LIVRE",
  "RESOLVIDO",
] as const;

const CHANNELS = ["QUESTION", "POST_SALE_MESSAGE", "CLAIM"] as const;

/** Teto de linhas por página. Sem paginação ainda — entra quando o volume pedir. */
const ROW_LIMIT = 100;

type Channel = (typeof CHANNELS)[number];
type InternalStatus = (typeof INTERNAL_STATUSES)[number];

/**
 * `abertos` é o padrão porque é a pergunta que a tela responde ("o que
 * precisa de mim agora?") e porque bate com o índice parcial
 * `support_cases_open_inbox_idx`, que existe justamente para essa consulta.
 */
type StatusFilter = "abertos" | "todos" | InternalStatus;

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
}


const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  color: "var(--sb-text-soft)",
  whiteSpace: "nowrap",
};

const td: React.CSSProperties = {
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  verticalAlign: "top",
};

function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function resolveStatus(raw: string | null): StatusFilter {
  if (raw === "todos") return "todos";
  if (raw !== null && (INTERNAL_STATUSES as readonly string[]).includes(raw)) {
    return raw as InternalStatus;
  }
  return "abertos";
}

function resolveChannel(raw: string | null): Channel | null {
  if (raw !== null && (CHANNELS as readonly string[]).includes(raw)) {
    return raw as Channel;
  }
  return null;
}

/**
 * Preserva as outras dimensões ao trocar uma — mesma ideia do `buildHref()`
 * de `/vendas`, com três dimensões em vez de duas.
 */
function buildHref(
  current: { account: string | null; channel: Channel | null; status: StatusFilter; prazo: boolean },
  override: { account?: string | null; channel?: Channel | null; status?: StatusFilter; prazo?: boolean },
): string {
  const account = override.account !== undefined ? override.account : current.account;
  const channel = override.channel !== undefined ? override.channel : current.channel;
  const status = override.status ?? current.status;
  const prazo = override.prazo ?? current.prazo;

  const search = new URLSearchParams();

  if (account !== null) search.set("account", account);
  if (channel !== null) search.set("canal", channel);
  if (status !== "abertos") search.set("status", status);
  if (prazo) search.set("prazo", "risco");

  const qs = search.toString();

  return qs === "" ? "/atendimento" : `/atendimento?${qs}`;
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

  const accountSlug = readParam(query.account);
  const channel = resolveChannel(readParam(query.canal));
  const status = resolveStatus(readParam(query.status));
  // Filtro de SLA (D-115, destravado por D-107): só cases com prazo ATIVO
  // vencendo nas próximas 24h — ou já vencido.
  const prazoRisco = readParam(query.prazo) === "risco";

  const accounts = accountsResult.data ?? [];
  const selectedAccount = accounts.find((account) => account.slug === accountSlug) ?? null;

  // O embed de `support_case_links` atravessa a FK COMPOSTA
  // (support_case_id, organization_id, ml_account_id) — é ela que garante que
  // um vínculo nunca pertence a outra conta (D-085). Sem filtro explícito por
  // organização: a RLS (`has_account_access(ml_account_id)`) já restringe, e
  // duplicar a regra aqui seria a segunda fonte de verdade que D-012 evita.
  // O `!inner` do embed de prazos SÓ entra quando o filtro está ativo:
  // como inner join, ele excluiria da listagem normal todo case sem prazo.
  const baseSelect =
    "id, channel, external_case_id, external_status, internal_status, priority, remote_reply_state, is_mediation, has_return, last_activity_at, assignee_id, ml_accounts(label), profiles(full_name), support_case_links(order_id, sku_id, listing_id, external_entity_kind, external_entity_id, skus(sku), listings(item_id, title))";

  let casesQuery = supabase
    .from("support_cases")
    .select(prazoRisco ? `${baseSelect}, support_case_deadlines!inner(due_at, status)` : baseSelect)
    .order("last_activity_at", { ascending: false })
    .limit(ROW_LIMIT);

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
  const error = casesResult.error ?? accountsResult.error;

  const current = { account: accountSlug, channel, status, prazo: prazoRisco };

  return (
    <Shell>
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--sb-space-3)", flexWrap: "wrap" }}>
        <h1 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1.375rem" }}>Caixa de Entrada</h1>
        <Link href="/atendimento/templates" style={{ fontSize: "0.8125rem", color: "var(--sb-secondary)" }}>
          Templates de resposta
        </Link>
        <Link href="/atendimento/conhecimento" style={{ fontSize: "0.8125rem", color: "var(--sb-secondary)" }}>
          Base de Conhecimento
        </Link>
        <Link href="/atendimento/metricas" style={{ fontSize: "0.8125rem", color: "var(--sb-secondary)" }}>
          Métricas
        </Link>
      </div>
      <p style={{ margin: "0 0 var(--sb-space-3)", color: "var(--sb-text-soft)", fontSize: "0.875rem" }}>
        {/* Corrigido em D-111 — dizia "só perguntas são sincronizadas",
            congelado de D-090; os três canais sincronizam desde D-097/D-108. */}
        Perguntas, mensagens pós-venda e reclamações das contas Mercado Livre.
      </p>

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar os atendimentos: {error.message}
        </p>
      )}

      {accountsResult.error === null && accounts.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-2)" }}>
          <FilterPill href={buildHref(current, { account: null })} active={selectedAccount === null}>
            Todas as contas
          </FilterPill>
          {accounts.map((account) => (
            <FilterPill
              key={account.id}
              href={buildHref(current, { account: account.slug })} active={selectedAccount?.id === account.id}
            >
              {account.label}
            </FilterPill>
          ))}
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-2)" }}>
        <FilterPill href={buildHref(current, { channel: null })} active={channel === null}>
          Todos os tipos
        </FilterPill>
        {CHANNELS.map((code) => (
          <FilterPill key={code} href={buildHref(current, { channel: code })} active={channel === code}>
            {supportChannelLabel(code)}
          </FilterPill>
        ))}
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-4)" }}>
        <FilterPill href={buildHref(current, { status: "abertos" })} active={status === "abertos"}>
          Abertos
        </FilterPill>
        {INTERNAL_STATUSES.map((code) => (
          <FilterPill key={code} href={buildHref(current, { status: code })} active={status === code}>
            {supportInternalStatusLabel(code)}
          </FilterPill>
        ))}
        <FilterPill href={buildHref(current, { status: "todos" })} active={status === "todos"}>
          Todos
        </FilterPill>
        <FilterPill href={buildHref(current, { prazo: !prazoRisco })} active={prazoRisco} tone="danger">
          ⏱ Prazo em risco
        </FilterPill>
      </div>

      {error === null && cases.length === 0 && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          {status === "abertos" && channel === null && selectedAccount === null
            ? "Nenhum atendimento em aberto. A sincronização traz perguntas novas pelo webhook em segundos e reconcilia a cada 6 horas."
            : "Nenhum atendimento com esses filtros."}
        </p>
      )}

      {error === null && cases.length > 0 && (
        <>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={th}>Conta</th>
                  <th style={th}>Tipo</th>
                  <th style={th}>Produto / referência</th>
                  <th style={th}>Triagem</th>
                  <th style={th}>Resposta</th>
                  <th style={th}>Última atividade</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((row) => {
                  const reference = resolveSupportCaseReference(row.support_case_links);
                  const rowFacets = facets(row);

                  return (
                    <tr key={row.id}>
                      <td style={td}>{row.ml_accounts?.label ?? "—"}</td>
                      <td style={td}>
                        <Link href={`/atendimento/${row.id}`} style={{ color: "var(--sb-primary)" }}>
                          {supportChannelLabel(row.channel)}
                        </Link>
                        {rowFacets.length > 0 && (
                          <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
                            {rowFacets.join(" · ")}
                          </div>
                        )}
                        <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
                          #{row.external_case_id}
                          {row.external_status !== null && ` · ${row.external_status}`}
                        </div>
                      </td>
                      <td style={td}>
                        {reference === null ? (
                          "—"
                        ) : (
                          <>
                            {reference.href === null ? (
                              <span>{reference.code}</span>
                            ) : (
                              <Link href={reference.href} style={{ color: "var(--sb-primary)" }}>
                                {reference.code}
                              </Link>
                            )}
                            {reference.title !== null && (
                              <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
                                {reference.title}
                              </div>
                            )}
                          </>
                        )}
                      </td>
                      <td style={td}>
                        <div style={{ display: "flex", gap: "0.25rem", marginBottom: "0.25rem" }}>
                          <StatusPill
                            code={row.internal_status}
                            label={supportInternalStatusLabel(row.internal_status)}
                          />
                          <StatusPill code={row.priority} label={supportPriorityLabel(row.priority)} />
                        </div>
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
                      <td style={td}>
                        <StatusPill
                          code={row.remote_reply_state}
                          label={supportReplyStateLabel(row.remote_reply_state)}
                        />
                      </td>
                      <td style={td}>{formatDateTime(row.last_activity_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {cases.length === ROW_LIMIT && (
            <p style={{ marginTop: "var(--sb-space-2)", color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
              Mostrando os {ROW_LIMIT} atendimentos com atividade mais recente. Use os filtros para
              estreitar — paginação entra quando o volume real justificar.
            </p>
          )}
        </>
      )}
    </Shell>
  );
}
