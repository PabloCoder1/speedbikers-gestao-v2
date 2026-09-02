import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { formatDateTime } from "../../../lib/format";
import {
  replyAttemptLabel,
  supportBodyStateLabel,
  supportCaseEventLabel,
  supportChannelLabel,
  supportDeadlineKindLabel,
  supportInternalStatusLabel,
  supportPriorityLabel,
  supportReplyStateLabel,
  supportSenderKindLabel,
} from "../../../lib/labels";
import type { SupportCaseLinkRow } from "../../../lib/support-case-reference";
import { resolveSupportCaseReference } from "../../../lib/support-case-reference";
import { createClient } from "../../../lib/supabase/server";
import { TriageCell } from "../triage-cell";
import { ReplyForm } from "./reply-form";

export const metadata = { title: "Atendimento — Speed Bikers Gestão" };

export const dynamic = "force-dynamic";

/**
 * Detalhe de um atendimento (Fase 7B, D-095) — a conversa e o contexto.
 *
 * A Caixa de Entrada (D-090) mostra QUE existe um atendimento; para responder
 * é preciso ler o que a pessoa perguntou. `support_messages` guarda o
 * transcript desde D-086; esta tela é a primeira a consumi-lo.
 *
 * **Desde D-096 é também de onde se responde.** O formulário confirma e a
 * `api` assume: o `web` nunca fala com o Mercado Livre. O que aparece aqui é
 * a confirmação humana e o registro das tentativas — o envio em si acontece
 * no worker, com revalidação do estado remoto na hora.
 *
 * Leitura direta sob RLS (Modelo A, D-012); a triagem reaproveita a mesma
 * `TriageCell` da lista, que passa pela RPC transacional de D-094.
 */

interface MessageRow {
  id: string;
  direction: string;
  sender_kind: string;
  body: string | null;
  body_state: string;
  remote_status: string | null;
  occurred_at: string;
}

interface DeadlineRow {
  id: string;
  deadline_kind: string;
  source: string;
  due_at: string | null;
  started_at: string | null;
}

interface ReplyAttemptRow {
  id: string;
  status: string;
  final_text: string;
  error_message: string | null;
  requested_at: string;
  resolved_at: string | null;
  profiles: { full_name: string | null } | null;
}

interface CaseEventRow {
  id: string;
  event_type: string;
  source: string;
  occurred_at: string;
  before: unknown;
  after: unknown;
  profiles: { full_name: string | null } | null;
}

const section: React.CSSProperties = { marginTop: "var(--sb-space-4)" };

const sectionTitle: React.CSSProperties = {
  margin: "0 0 var(--sb-space-2)",
  fontSize: "1rem",
};

const meta: React.CSSProperties = { fontSize: "0.75rem", color: "var(--sb-text-soft)" };

/**
 * Corpo da mensagem respeitando `body_state` (D-086).
 *
 * Conteúdo banido/moderado chega com texto VAZIO da API — renderizar isso
 * como uma bolha em branco apagaria a informação de que houve uma mensagem e
 * de por que ela não está ali. O estado vira texto explícito, em itálico,
 * visualmente distinto do que a pessoa realmente escreveu.
 */
function MessageBody({ message }: { message: MessageRow }): ReactNode {
  if (message.body_state === "AVAILABLE" && message.body !== null && message.body !== "") {
    return <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message.body}</p>;
  }

  return (
    <p style={{ margin: 0, fontStyle: "italic", color: "var(--sb-text-soft)" }}>
      {supportBodyStateLabel(message.body_state)}
    </p>
  );
}

export default async function AtendimentoDetalhePage({
  params,
}: {
  params: Promise<{ caseId: string }>;
}): Promise<ReactNode> {
  const { caseId } = await params;
  const supabase = await createClient();

  // `getUser()` em paralelo com a leitura, não antes dela (D-195). Ele revalida
  // o token contra o servidor de Auth e custa uma ida inteira; enfileirá-lo
  // atrasava a tela sem proteger nada, porque quem barra a rota é o
  // `proxy.ts` — que já chamou `getUser()` nesta mesma requisição e
  // redirecionou para `/login` se não havia sessão. E a leitura não fica
  // desprotegida por sair junto: o PostgREST confere o JWT por conta própria e
  // a RLS decide o que volta. O id daqui é só para a tela distinguir "Você".
  const [{ data: auth }, caseResult] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from("support_cases")
      .select(
        "id, channel, external_case_id, external_status, external_substatus, internal_status, priority, remote_reply_state, remote_reply_block_reason, is_mediation, has_return, customer_external_id, pack_id, last_activity_at, last_inbound_at, last_outbound_at, resolved_at, assignee_id, ml_accounts(label), profiles(full_name), support_case_links(order_id, sku_id, listing_id, external_entity_kind, external_entity_id, skus(sku), listings(item_id, title))",
      )
      .eq("id", caseId)
      .maybeSingle(),
  ]);

  const viewerId = auth.user?.id ?? null;

  if (caseResult.error !== null) {
    return (
      <Shell>
        <h1 style={{ margin: "0 0 var(--sb-space-3)", fontSize: "1.375rem" }}>Atendimento</h1>
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar o atendimento: {caseResult.error.message}
        </p>
      </Shell>
    );
  }

  // Sem linha pode ser id inexistente OU a RLS escondendo um atendimento de
  // conta que este usuário não alcança. 404 nos dois casos, de propósito:
  // distinguir revelaria a existência de um atendimento de outra conta.
  if (caseResult.data === null) {
    notFound();
  }

  const supportCase = caseResult.data as unknown as {
    id: string;
    channel: string;
    external_case_id: string;
    external_status: string | null;
    external_substatus: string | null;
    internal_status: string;
    priority: string;
    remote_reply_state: string;
    remote_reply_block_reason: string | null;
    is_mediation: boolean;
    has_return: boolean;
    customer_external_id: number | null;
    pack_id: number | null;
    last_activity_at: string;
    last_inbound_at: string | null;
    last_outbound_at: string | null;
    resolved_at: string | null;
    assignee_id: string | null;
    ml_accounts: { label: string } | null;
    profiles: { full_name: string | null } | null;
    support_case_links: SupportCaseLinkRow[] | null;
  };

  const [messagesResult, deadlinesResult, eventsResult, attemptsResult] = await Promise.all([
    supabase
      .from("support_messages")
      .select("id, direction, sender_kind, body, body_state, remote_status, occurred_at")
      .eq("support_case_id", caseId)
      .order("occurred_at", { ascending: true }),
    supabase
      .from("support_case_deadlines")
      .select("id, deadline_kind, source, due_at, started_at")
      .eq("support_case_id", caseId)
      .order("due_at", { ascending: true }),
    supabase
      .from("support_case_events")
      .select("id, event_type, source, occurred_at, before, after, profiles(full_name)")
      .eq("support_case_id", caseId)
      .order("occurred_at", { ascending: false })
      .limit(50),
    supabase
      .from("support_reply_attempts")
      .select("id, status, final_text, error_message, requested_at, resolved_at, profiles(full_name)")
      .eq("support_case_id", caseId)
      .order("requested_at", { ascending: false })
      .limit(20),
  ]);

  // Erro em qualquer uma das três se junta: mostrar a conversa sem dizer que
  // o histórico falhou seria o "sem dado" indistinguível de "erro" que D-067
  // auditou a sessão inteira.
  const sideError =
    messagesResult.error ?? deadlinesResult.error ?? eventsResult.error ?? attemptsResult.error;

  const messages = (messagesResult.data ?? []) as MessageRow[];
  const deadlines = (deadlinesResult.data ?? []) as DeadlineRow[];
  const events = (eventsResult.data ?? []) as unknown as CaseEventRow[];
  const attempts = (attemptsResult.data ?? []) as unknown as ReplyAttemptRow[];
  const podeResponder = supportCase.channel === "QUESTION" && supportCase.resolved_at === null;

  // Templates da organização (D-111) — só quando a caixa de resposta vai
  // aparecer; falha aqui degrada para "sem templates", nunca derruba a tela
  // (a resposta manual continua possível, que é o que importa).
  let templates: { id: string; name: string; body: string }[] = [];

  if (podeResponder) {
    const templatesResult = await supabase
      .from("reply_templates")
      .select("id, name, body")
      .order("name");

    if (templatesResult.error === null) {
      templates = templatesResult.data;
    }
  }
  const reference = resolveSupportCaseReference(supportCase.support_case_links);

  return (
    <Shell>
      <p style={{ margin: "0 0 var(--sb-space-1)", fontSize: "0.8125rem" }}>
        <Link href="/atendimento" style={{ color: "var(--sb-primary)" }}>
          ← Caixa de Entrada
        </Link>
      </p>

      <h1 style={{ margin: "0 0 var(--sb-space-1)", fontSize: "1.375rem" }}>
        {supportChannelLabel(supportCase.channel)} #{supportCase.external_case_id}
      </h1>

      <p style={{ ...meta, margin: "0 0 var(--sb-space-3)" }}>
        {supportCase.ml_accounts?.label ?? "—"}
        {supportCase.external_status !== null && ` · Mercado Livre: ${supportCase.external_status}`}
        {supportCase.external_substatus !== null && ` (${supportCase.external_substatus})`}
        {supportCase.is_mediation && " · Mediação"}
        {supportCase.has_return && " · Devolução"}
        {supportCase.pack_id !== null && ` · Pack ${String(supportCase.pack_id)}`}
      </p>

      {sideError !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Parte do atendimento não pôde ser carregada: {sideError.message}
        </p>
      )}

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--sb-space-4)",
          alignItems: "flex-start",
          border: "1px solid var(--sb-border)",
          borderRadius: "var(--sb-radius)",
          padding: "var(--sb-space-3)",
        }}
      >
        <div>
          <div style={meta}>Situação</div>
          <div style={{ display: "flex", gap: "0.25rem", marginTop: "0.25rem" }}>
            <StatusPill
              code={supportCase.internal_status}
              label={supportInternalStatusLabel(supportCase.internal_status)}
            />
            <StatusPill code={supportCase.priority} label={supportPriorityLabel(supportCase.priority)} />
          </div>
        </div>

        <div>
          <div style={meta}>Resposta no Mercado Livre</div>
          <div style={{ marginTop: "0.25rem" }}>
            <StatusPill
              code={supportCase.remote_reply_state}
              label={supportReplyStateLabel(supportCase.remote_reply_state)}
            />
          </div>
          {supportCase.remote_reply_block_reason !== null && (
            <div style={{ ...meta, marginTop: "0.25rem" }}>
              {supportCase.remote_reply_block_reason}
            </div>
          )}
        </div>

        <div>
          <div style={meta}>Produto / referência</div>
          <div style={{ marginTop: "0.25rem", fontSize: "0.875rem" }}>
            {reference === null ? (
              "—"
            ) : reference.href === null ? (
              reference.code
            ) : (
              <Link href={reference.href} style={{ color: "var(--sb-primary)" }}>
                {reference.code}
              </Link>
            )}
            {reference?.title != null && <div style={meta}>{reference.title}</div>}
          </div>
        </div>

        <div style={{ minWidth: "12rem" }}>
          <div style={meta}>Triagem</div>
          <div style={{ marginTop: "0.25rem" }}>
            <TriageCell
              triage={{
                id: supportCase.id,
                internalStatus: supportCase.internal_status,
                priority: supportCase.priority,
                assigneeId: supportCase.assignee_id,
                assigneeName: supportCase.profiles?.full_name ?? null,
                viewerId,
              }}
            />
          </div>
        </div>
      </div>

      <section style={section}>
        <h2 style={sectionTitle}>Conversa</h2>

        {messages.length === 0 ? (
          <p style={{ color: "var(--sb-text-soft)" }}>
            Nenhuma mensagem sincronizada para este atendimento.
          </p>
        ) : (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--sb-space-2)" }}>
            {messages.map((message) => {
              const fromSeller = message.direction === "OUTBOUND";

              return (
                <li
                  key={message.id}
                  style={{
                    border: "1px solid var(--sb-border)",
                    borderRadius: "var(--sb-radius)",
                    padding: "var(--sb-space-2)",
                    // Vendedor à direita, cliente à esquerda: a direção da
                    // conversa é a informação que se lê primeiro.
                    marginLeft: fromSeller ? "auto" : 0,
                    marginRight: fromSeller ? 0 : "auto",
                    maxWidth: "48rem",
                    width: "fit-content",
                    minWidth: "16rem",
                    background: fromSeller ? "var(--sb-muted)" : "transparent",
                  }}
                >
                  <div style={{ ...meta, marginBottom: "0.25rem" }}>
                    {supportSenderKindLabel(message.sender_kind)} · {formatDateTime(message.occurred_at)}
                    {message.body_state !== "AVAILABLE" &&
                      ` · ${supportBodyStateLabel(message.body_state)}`}
                  </div>
                  <MessageBody message={message} />
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {deadlines.length > 0 && (
        <section style={section}>
          <h2 style={sectionTitle}>Prazos</h2>
          <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem" }}>
            {deadlines.map((deadline) => (
              <li key={deadline.id}>
                {supportDeadlineKindLabel(deadline.deadline_kind)}:{" "}
                {deadline.due_at === null ? "sem prazo definido" : formatDateTime(deadline.due_at)}
                {/* A FONTE do prazo é obrigatória na exibição (D-084): prazo
                    ausente nunca pode virar estimativa apresentada como oficial. */}
                <span style={meta}> · fonte: {deadline.source}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {podeResponder && (
        <section style={section}>
          <h2 style={sectionTitle}>Responder</h2>
          <ReplyForm
            caseId={supportCase.id}
            remoteReplyState={supportCase.remote_reply_state}
            remoteReplyBlockReason={supportCase.remote_reply_block_reason}
            templates={templates}
          />
        </section>
      )}

      {attempts.length > 0 && (
        <section style={section}>
          <h2 style={sectionTitle}>Tentativas de envio</h2>
          <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem" }}>
            {attempts.map((attempt) => (
              <li key={attempt.id} style={{ marginBottom: "0.375rem" }}>
                <StatusPill code={attempt.status} label={replyAttemptLabel(attempt.status)} />
                <span style={meta}>
                  {" "}
                  · {formatDateTime(attempt.requested_at)} ·{" "}
                  {attempt.profiles?.full_name ?? "usuário removido"}
                </span>
                {/* O texto enviado fica visível: é auditoria do que o cliente
                    recebeu, e quem enxerga o atendimento já enxerga o transcript. */}
                <div style={{ whiteSpace: "pre-wrap" }}>{attempt.final_text}</div>
                {attempt.error_message !== null && (
                  <div style={{ color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
                    {attempt.error_message}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section style={section}>
        <h2 style={sectionTitle}>Histórico</h2>

        {events.length === 0 ? (
          <p style={{ color: "var(--sb-text-soft)" }}>Nenhum evento registrado ainda.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem" }}>
            {events.map((event) => (
              <li key={event.id}>
                {supportCaseEventLabel(event.event_type)}
                <span style={meta}>
                  {" "}
                  · {formatDateTime(event.occurred_at)} ·{" "}
                  {event.source === "USER"
                    ? (event.profiles?.full_name ?? "usuário removido")
                    : event.source}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p style={{ ...meta, ...section }}>
        Última atividade: {formatDateTime(supportCase.last_activity_at)}
        {supportCase.last_inbound_at !== null &&
          ` · Última do cliente: ${formatDateTime(supportCase.last_inbound_at)}`}
        {supportCase.last_outbound_at !== null &&
          ` · Última sua: ${formatDateTime(supportCase.last_outbound_at)}`}
        {supportCase.resolved_at !== null && ` · Resolvido em: ${formatDateTime(supportCase.resolved_at)}`}
      </p>
    </Shell>
  );
}
