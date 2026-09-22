import Link from "next/link";
import type { ReactNode } from "react";

import { FilterMenu, type FilterOption } from "../../../components/filter-menu";
import { FilterPill } from "../../../components/filter-pill";
import { Icone } from "../../../components/icons";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { monogramaDeProduto } from "../../../lib/initials";
import type { SupportCaseLinkRow } from "../../../lib/support-case-reference";
import { resolveSupportCaseReference } from "../../../lib/support-case-reference";
import { describeDeadline } from "../../../lib/support-deadline";
import { createClient } from "../../../lib/supabase/server";
import { ReplyForm, type ReplyTemplateOption } from "../[caseId]/reply-form";

export const metadata = { title: "Perguntas — Speed Bikers Gestão" };
export const dynamic = "force-dynamic";

/**
 * Fila de perguntas de pré-venda no formato pedido pelo dono do produto: por
 * ESTADO NO MERCADO LIVRE (não pelo `internal_status` interno) e com resposta
 * DIRETO no cartão — sem ir para `/atendimento/[caseId]`.
 *
 * **As cinco abas são `external_status` real** (lib/labels.ts), não um rótulo
 * inventado para parecer com a referência: Pendente = `UNANSWERED`, Respondido
 * = `ANSWERED`, Expirado = `CLOSED_UNANSWERED`, Deletado = `DELETED`,
 * Desativado = `BANNED`/`UNDER_REVIEW`. Uma pergunta sem status ainda
 * sincronizado (`external_status` nulo) cai em Pendente — é a leitura mais
 * segura (D-067): sumir da lista seria pior que aparecer no lugar errado.
 *
 * **Só uma pergunta fica com a resposta aberta por vez** (`?pergunta=`), e só
 * na aba Pendente — responder uma `ANSWERED`/`DELETED` não faz sentido, então
 * as outras abas mostram o cartão e um link para o histórico completo.
 *
 * Este é o mesmo `ReplyForm` de `/atendimento/[caseId]` (mesmo envio, mesma
 * sugestão de IA, mesma auditoria de D-096/D-112) em `templatesLayout="sidebar"`
 * — não uma cópia da lógica de envio.
 *
 * O que o pedido mostrava e NÃO entrou, por não existir de verdade aqui:
 * "Exportar" e "Sincronizar as Perguntas" (a sincronização já é automática,
 * por webhook + reconciliação — não há botão de disparo manual), saudação/
 * despedida automática (preferência que não existe no schema), e os selos de
 * "Clássico"/"Mercado Envios Full" (`listings` não guarda tipo de anúncio nem
 * modalidade de envio — o mesmo limite já documentado em `/anuncios/[itemId]`).
 */

const PAGE_SIZE = 20;

const STATUS_TABS = [
  { key: "pendente", label: "Pendente", statuses: ["UNANSWERED"], semStatusAqui: true },
  { key: "respondido", label: "Respondido", statuses: ["ANSWERED"], semStatusAqui: false },
  { key: "expirado", label: "Expirado", statuses: ["CLOSED_UNANSWERED"], semStatusAqui: false },
  { key: "deletado", label: "Deletado", statuses: ["DELETED"], semStatusAqui: false },
  { key: "desativado", label: "Desativado", statuses: ["BANNED", "UNDER_REVIEW"], semStatusAqui: false },
] as const;

type TabKey = (typeof STATUS_TABS)[number]["key"];

interface QuestionLinkRow extends SupportCaseLinkRow {
  listings:
    | (SupportCaseLinkRow["listings"] & {
        thumbnail_url: string | null;
        price: number | null;
        available_quantity: number | null;
      })
    | null;
  skus: (SupportCaseLinkRow["skus"] & { image_url: string | null }) | null;
}

interface QuestionRow {
  id: string;
  external_case_id: string;
  external_status: string | null;
  priority: string;
  remote_reply_state: string;
  remote_reply_block_reason: string | null;
  resolved_at: string | null;
  last_activity_at: string;
  customer_external_id: string | null;
  ml_accounts: { label: string } | null;
  support_case_links: QuestionLinkRow[] | null;
  support_case_deadlines: { due_at: string | null; status: string }[] | null;
}

interface MessageRow {
  support_case_id: string;
  direction: string;
  body: string | null;
  body_state: string;
  occurred_at: string;
}

function tabFrom(value: string | string[] | undefined): TabKey {
  const raw = Array.isArray(value) ? value[0] : value;

  return STATUS_TABS.find((tab) => tab.key === raw)?.key ?? "pendente";
}

function pageFrom(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function readParam(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;

  return raw === undefined || raw === "" ? null : raw;
}

function perguntasHref({
  tab,
  page,
  pergunta,
  account,
}: {
  tab: TabKey;
  page: number;
  pergunta?: string | null;
  account: string | null;
}): string {
  const params = new URLSearchParams();

  if (tab !== "pendente") params.set("aba", tab);
  if (account !== null) params.set("conta", account);
  if (page > 1) params.set("pagina", String(page));
  if (pergunta !== undefined && pergunta !== null) params.set("pergunta", pergunta);

  const query = params.toString();

  return query === "" ? "/atendimento/perguntas" : `/atendimento/perguntas?${query}`;
}

/** Foto, preço e estoque vêm do ANÚNCIO vinculado — é o que a pergunta é sobre. */
function questionMedia(links: QuestionLinkRow[] | null): { photo: string | null; price: number | null; stock: number | null } {
  const withListing = links?.find((link) => link.listing_id !== null && link.listings !== null) ?? null;
  const withSku = links?.find((link) => link.sku_id !== null && link.skus !== null) ?? null;

  return {
    photo: withListing?.listings?.thumbnail_url ?? withSku?.skus?.image_url ?? null,
    price: withListing?.listings?.price ?? null,
    stock: withListing?.listings?.available_quantity ?? null,
  };
}

function firstActiveDeadline(deadlines: QuestionRow["support_case_deadlines"]): string | null {
  if (deadlines === null) return null;

  return (
    deadlines
      .filter((deadline): deadline is { due_at: string; status: string } => deadline.status === "ACTIVE" && deadline.due_at !== null)
      .map((deadline) => deadline.due_at)
      .sort()[0] ?? null
  );
}

export default async function PerguntasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const tab = tabFrom(query.aba);
  const page = pageFrom(query.pagina);
  const accountSlug = readParam(query.conta);
  const pergunta = readParam(query.pergunta);
  const from = (page - 1) * PAGE_SIZE;
  const now = new Date();
  const supabase = await createClient();

  const accountsResult = await supabase.from("ml_accounts").select("id, slug, label").order("label", { ascending: true });
  const accounts = accountsResult.data ?? [];
  const selectedAccount = accounts.find((account) => account.slug === accountSlug) ?? null;

  const abaAtual = STATUS_TABS.find((candidate) => candidate.key === tab) ?? STATUS_TABS[0];

  const baseSelect =
    "id, external_case_id, external_status, priority, remote_reply_state, remote_reply_block_reason, resolved_at, last_activity_at, customer_external_id, ml_accounts(label), support_case_links(order_id, sku_id, listing_id, external_entity_kind, external_entity_id, skus(sku, image_url), listings(item_id, title, thumbnail_url, price, available_quantity)), support_case_deadlines(due_at, status)";

  /** `external_status.in.(...)` filtrado pela aba; Pendente também aceita nulo (D-067: sumir é pior que aparecer no lugar errado). */
  function recorte(statuses: readonly string[], incluiNulo: boolean): string {
    return incluiNulo ? `external_status.in.(${statuses.join(",")}),external_status.is.null` : `external_status.in.(${statuses.join(",")})`;
  }

  let questionsQuery = supabase
    .from("support_cases")
    .select(baseSelect, { count: "exact" })
    .eq("channel", "QUESTION")
    .or(recorte(abaAtual.statuses, abaAtual.semStatusAqui))
    .order("last_activity_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  if (selectedAccount !== null) questionsQuery = questionsQuery.eq("ml_account_id", selectedAccount.id);

  // Uma contagem por aba, no MESMO recorte de conta — os números da faixa de
  // abas têm de bater com o que cada uma mostra (D-236), nunca ser a
  // organização inteira enquanto a lista está filtrada por conta.
  const [contagens, questionsResult] = await Promise.all([
    Promise.all(
      STATUS_TABS.map((candidateTab) => {
        let contagemQuery = supabase
          .from("support_cases")
          .select("id", { count: "exact", head: true })
          .eq("channel", "QUESTION")
          .or(recorte(candidateTab.statuses, candidateTab.semStatusAqui));

        if (selectedAccount !== null) contagemQuery = contagemQuery.eq("ml_account_id", selectedAccount.id);

        return contagemQuery;
      }),
    ),
    questionsQuery,
  ]);
  const questions = (questionsResult.data ?? []) as unknown as QuestionRow[];
  const total = questionsResult.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // As mensagens de TODAS as perguntas da página, numa consulta só — não uma
  // por cartão. A primeira INBOUND é a pergunta; o resto é histórico depois
  // de respondida.
  const ids = questions.map((question) => question.id);
  const messagesResult =
    ids.length === 0
      ? { data: [] as MessageRow[], error: null }
      : await supabase
          .from("support_messages")
          .select("support_case_id, direction, body, body_state, occurred_at")
          .in("support_case_id", ids)
          .order("occurred_at", { ascending: true });

  const mensagensPorCaso = new Map<string, MessageRow[]>();

  for (const message of messagesResult.data ?? []) {
    const lista = mensagensPorCaso.get(message.support_case_id) ?? [];

    lista.push(message);
    mensagensPorCaso.set(message.support_case_id, lista);
  }

  // Só a aba Pendente abre resposta — responder uma pergunta já respondida,
  // expirada, apagada ou desativada não é uma ação que a tela ofereça.
  const selecionada = tab === "pendente" ? (questions.find((question) => question.id === pergunta) ?? questions[0] ?? null) : null;

  let templates: ReplyTemplateOption[] = [];

  if (selecionada !== null && selecionada.resolved_at === null) {
    const templatesResult = await supabase.from("reply_templates").select("id, name, body").order("name");

    if (templatesResult.error === null) templates = templatesResult.data;
  }

  const error = questionsResult.error?.message ?? accountsResult.error?.message ?? messagesResult.error?.message ?? null;
  const rotuloConta = selectedAccount?.label ?? "Todas as contas";
  const opcoesConta: FilterOption[] = [
    { href: perguntasHref({ tab, page: 1, account: null }), label: "Todas as contas", ativo: selectedAccount === null },
    ...accounts.map((account) => ({
      href: perguntasHref({ tab, page: 1, account: account.slug }),
      label: account.label,
      ativo: selectedAccount?.id === account.id,
    })),
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ATENDIMENTO / PRÉ-VENDA"
        title="Perguntas"
        subtitle="Responda direto no cartão — foto, preço e estoque do anúncio junto de cada pergunta."
        aside={
          <>
            {accountsResult.error === null && accounts.length > 1 && <FilterMenu rotulo={rotuloConta} opcoes={opcoesConta} />}
            <Link className="sb-button" href="/atendimento/templates">
              <Icone nome="mensagem" tamanho={14} /> Modelos de resposta
            </Link>
            <Link className="sb-button" href="/atendimento">
              <Icone nome="bandeja" tamanho={14} /> Ver Caixa de Entrada
            </Link>
          </>
        }
      />

      <div className="sb-inbox-toggles" aria-label="Estado no Mercado Livre" style={{ marginBottom: "var(--sb-space-3)" }}>
        {STATUS_TABS.map((candidateTab, index) => (
          <FilterPill
            key={candidateTab.key}
            href={perguntasHref({ tab: candidateTab.key, page: 1, account: accountSlug })}
            active={tab === candidateTab.key}
          >
            {candidateTab.label} {formatCount(contagens[index]?.count ?? 0)}
          </FilterPill>
        ))}
      </div>

      {error !== null && (
        <div role="alert" className="sb-inbox-state sb-inbox-state-error">
          <strong>Não foi possível carregar as perguntas.</strong>
          <span>{error}</span>
          <Link className="sb-button" href={perguntasHref({ tab, page, account: accountSlug })}>
            Tentar de novo
          </Link>
        </div>
      )}

      {error === null && (
        <section className="sb-inbox-section">
          <Panel
            title={`Perguntas · ${abaAtual.label.toLowerCase()}`}
            subtitle={total > 0 ? `${formatCount(total)} ${total === 1 ? "pergunta" : "perguntas"} nesta aba` : undefined}
          >
            {questions.length === 0 && (
              <div className="sb-inbox-state">
                <span className="sb-inbox-state-icon" aria-hidden="true">
                  <Icone nome="duvida" tamanho={20} />
                </span>
                <strong>Nenhuma pergunta {abaAtual.label.toLowerCase()}</strong>
                <span>
                  {tab === "pendente"
                    ? "A sincronização traz perguntas novas pelo webhook em segundos."
                    : "Nada nesta aba com o recorte atual."}
                </span>
              </div>
            )}

            {questions.length > 0 && (
              <div className="sb-question-cards">
                {questions.map((question) => {
                  const reference = resolveSupportCaseReference(question.support_case_links);
                  const media = questionMedia(question.support_case_links);
                  const mensagens = mensagensPorCaso.get(question.id) ?? [];
                  const pergunta_ = mensagens.find((message) => message.direction === "INBOUND") ?? null;
                  const deadline = firstActiveDeadline(question.support_case_deadlines);
                  const deadlineView = deadline === null ? null : describeDeadline(deadline, now);
                  const expandida = selecionada?.id === question.id;
                  const caseHref = `/atendimento/${question.id}?volta=${encodeURIComponent(perguntasHref({ tab, page, account: accountSlug }))}`;

                  return (
                    <article className="sb-question-card" key={question.id}>
                      <div className="sb-question-card-head">
                        {media.photo === null ? (
                          <span className="sb-product-thumb sb-question-card-foto" aria-hidden="true">
                            {monogramaDeProduto(reference?.title ?? reference?.code ?? "?")}
                          </span>
                        ) : (
                          <img
                            className="sb-question-card-foto"
                            src={media.photo}
                            alt=""
                            width={44}
                            height={44}
                            loading="lazy"
                            decoding="async"
                            referrerPolicy="no-referrer"
                          />
                        )}

                        <div className="sb-question-card-produto">
                          {reference === null ? (
                            <b>Sem referência de produto</b>
                          ) : (
                            <>
                              <Link className="sb-inbox-case" href={reference.href ?? caseHref}>
                                {reference.title ?? reference.code}
                              </Link>
                              <span className="sb-question-card-facts">
                                <span className="sb-mono">{reference.code}</span>
                                {media.price !== null && <span>{formatCurrency(media.price)}</span>}
                                {media.stock !== null && <span>{formatCount(media.stock)} em estoque</span>}
                              </span>
                            </>
                          )}
                        </div>

                        <span className="sb-question-card-conta">{question.ml_accounts?.label ?? "—"}</span>
                      </div>

                      <div className="sb-question-card-pergunta">
                        <b>
                          {pergunta_ === null
                            ? "Pergunta sem transcript sincronizado"
                            : pergunta_.body_state === "AVAILABLE" && pergunta_.body !== null && pergunta_.body !== ""
                              ? pergunta_.body
                              : "Conteúdo indisponível"}
                        </b>
                        <span className="sb-question-card-meta">
                          {question.customer_external_id !== null && <span>Comprador: {question.customer_external_id}</span>}
                          <span className="sb-mono">#{question.external_case_id}</span>
                          <span>{formatDateTime(pergunta_?.occurred_at ?? question.last_activity_at)}</span>
                          {deadlineView?.relative !== null && deadlineView !== null && (
                            <span className={`sb-inbox-deadline-pill sb-inbox-deadline-${deadlineView.tone}`}>{deadlineView.relative}</span>
                          )}
                        </span>
                      </div>

                      {tab === "pendente" && expandida ? (
                        <div className="sb-question-card-reply">
                          <ReplyForm
                            caseId={question.id}
                            remoteReplyState={question.remote_reply_state}
                            remoteReplyBlockReason={question.remote_reply_block_reason}
                            templates={templates}
                            templatesLayout="sidebar"
                          />
                        </div>
                      ) : (
                        <p style={{ margin: "var(--sb-space-2) 0 0" }}>
                          {tab === "pendente" ? (
                            <Link className="sb-button sb-button-sm" href={perguntasHref({ tab, page, account: accountSlug, pergunta: question.id })}>
                              Responder
                            </Link>
                          ) : (
                            <Link className="sb-text-button" href={caseHref}>
                              Ver conversa completa →
                            </Link>
                          )}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            )}

            {totalPages > 1 && (
              <nav className="sb-inbox-pages" aria-label="Páginas da fila de perguntas">
                {page > 1 ? (
                  <Link className="sb-button" href={perguntasHref({ tab, page: page - 1, account: accountSlug })}>
                    ‹ Anterior
                  </Link>
                ) : (
                  <span />
                )}
                <span>
                  Página {page} de {totalPages}
                </span>
                {page < totalPages ? (
                  <Link className="sb-button" href={perguntasHref({ tab, page: page + 1, account: accountSlug })}>
                    Próxima ›
                  </Link>
                ) : (
                  <span />
                )}
              </nav>
            )}
          </Panel>
        </section>
      )}
    </Shell>
  );
}
