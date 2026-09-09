import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { ObjectHeader, type ObjectBadge } from "../../../components/object-header";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { TOM, tomDeStatus } from "../../../components/tone";
import { formatDateTime } from "../../../lib/format";
import {
  replyAttemptLabel,
  statusTone,
  supportBodyStateLabel,
  supportCaseEventLabel,
  supportChannelLabel,
  supportDeadlineKindLabel,
  supportDeadlineSourceLabel,
  supportInternalStatusLabel,
  supportPriorityLabel,
  supportReplyStateLabel,
  supportSenderKindLabel,
} from "../../../lib/labels";
import { safeNext } from "../../../lib/safe-next";
import { resolveSupportCaseReference } from "../../../lib/support-case-reference";
import { createClient } from "../../../lib/supabase/server";
import { GavetaPedido } from "../gaveta-pedido";
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
  status: string;
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


const section: React.CSSProperties = { marginTop: "var(--sb-space-4)" };

const meta: React.CSSProperties = {
  fontSize: "0.75rem",
  color: "var(--sb-text-soft)",
};

/**
 * Corpo da mensagem respeitando `body_state` (D-086).
 *
 * Conteúdo banido/moderado chega com texto VAZIO da API — renderizar isso
 * como uma bolha em branco apagaria a informação de que houve uma mensagem e
 * de por que ela não está ali. O estado vira texto explícito, em itálico,
 * visualmente distinto do que a pessoa realmente escreveu.
 */
function MessageBody({ message }: { message: MessageRow }): ReactNode {
  if (
    message.body_state === "AVAILABLE" &&
    message.body !== null &&
    message.body !== ""
  ) {
    return <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{message.body}</p>;
  }

  return (
    <p style={{ margin: 0, fontStyle: "italic", color: "var(--sb-text-soft)" }}>
      {supportBodyStateLabel(message.body_state)}
    </p>
  );
}

/**
 * A VOLTA PARA A FILA, com o recorte que a pessoa aplicou (D-286).
 *
 * `safeNext` já recusa caminho externo e URL protocolo-relativa; aqui a
 * exigência é mais estreita: a volta só pode ser a Caixa de Entrada. Um
 * `volta=/configuracoes` seria interno e mesmo assim errado — o rótulo do link
 * diz "Voltar à Caixa de Entrada", e link que mente sobre o destino é pior que
 * link sem parâmetro.
 */
function voltaParaFila(bruto: string | string[] | undefined): string {
  const destino = safeNext(typeof bruto === "string" ? bruto : null);

  return destino === "/atendimento" || destino.startsWith("/atendimento?") ? destino : "/atendimento";
}

export default async function AtendimentoDetalhePage({
  params,
  searchParams,
}: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const { caseId } = await params;
  const volta = voltaParaFila((await searchParams).volta);
  const supabase = await createClient();

  // `getUser()` em paralelo com a leitura, não antes dela (D-195). Ele revalida
  // o token contra o servidor de Auth e custa uma ida inteira; enfileirá-lo
  // atrasava a tela sem proteger nada, porque quem barra a rota é o
  // `proxy.ts` — que já chamou `getUser()` nesta mesma requisição e
  // redirecionou para `/login` se não havia sessão. E a leitura não fica
  // desprotegida por sair junto: o PostgREST confere o JWT por conta própria e
  // a RLS decide o que volta. O id daqui é só para a tela distinguir "Você".
  //
  // As SEIS leituras partem do mesmo `caseId` da URL (D-197). O bloco de
  // mensagens/prazos/eventos/tentativas já era paralelo, mas esperava o
  // cabeçalho do atendimento — e nenhuma das quatro usa nada dele. Era o
  // mesmo defeito de `/compras/[id]`, e o guarda só passou a vê-lo quando
  // deixou de tratar `Promise.all` como simples marco.
  //
  // Os guardas de erro e de 404 continuam abaixo e continuam corretos: a RLS
  // restringe as seis leituras de forma independente, então buscá-las antes
  // de saber se o atendimento existe não mostra nada a quem não podia ver.
  const [
    { data: auth },
    caseResult,
    messagesResult,
    deadlinesResult,
    eventsResult,
    attemptsResult,
  ] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from("support_cases")
      .select(
        "id, channel, external_case_id, external_status, external_substatus, internal_status, priority, remote_reply_state, remote_reply_block_reason, is_mediation, has_return, customer_external_id, pack_id, last_activity_at, last_inbound_at, last_outbound_at, resolved_at, assignee_id, ml_accounts(label), profiles(full_name), support_case_links(order_id, sku_id, listing_id, external_entity_kind, external_entity_id, skus(sku), listings(item_id, title))",
      )
      .eq("id", caseId)
      .maybeSingle(),
    supabase
      .from("support_messages")
      .select(
        "id, direction, sender_kind, body, body_state, remote_status, occurred_at",
      )
      .eq("support_case_id", caseId)
      .order("occurred_at", { ascending: true }),
    supabase
      .from("support_case_deadlines")
      .select("id, deadline_kind, source, due_at, started_at, status")
      .eq("support_case_id", caseId)
      .order("due_at", { ascending: true }),
    supabase
      .from("support_case_events")
      .select(
        "id, event_type, source, occurred_at, before, after, profiles(full_name)",
      )
      .eq("support_case_id", caseId)
      .order("occurred_at", { ascending: false })
      .limit(50),
    supabase
      .from("support_reply_attempts")
      .select(
        "id, status, final_text, error_message, requested_at, resolved_at, profiles(full_name)",
      )
      .eq("support_case_id", caseId)
      .order("requested_at", { ascending: false })
      .limit(20),
  ]);

  const viewerId = auth.user?.id ?? null;

  if (caseResult.error !== null) {
    return (
      <Shell>
        <PageTitle eyebrow="ATENDIMENTO / OPERAÇÃO" title="Atendimento" compacto />
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

  const supportCase = caseResult.data;

  // Erro em qualquer uma das três se junta: mostrar a conversa sem dizer que
  // o histórico falhou seria o "sem dado" indistinguível de "erro" que D-067
  // auditou a sessão inteira.
  const sideError =
    messagesResult.error ??
    deadlinesResult.error ??
    eventsResult.error ??
    attemptsResult.error;

  const messages = (messagesResult.data ?? []) as MessageRow[];
  const deadlines = (deadlinesResult.data ?? []) as DeadlineRow[];
  const events = eventsResult.data ?? [];
  const attempts = (attemptsResult.data ?? []) as unknown as ReplyAttemptRow[];
  const podeResponder =
    supportCase.channel === "QUESTION" && supportCase.resolved_at === null;

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

  // O primeiro vínculo de PEDIDO, independentemente da referência escolhida.
  const pedidoVinculado =
    supportCase.support_case_links.find((link) => link.order_id !== null)?.order_id ?? null;

  /*
    O PRAZO VIGENTE: o ATIVO que vence primeiro. Mesma escolha de
    `/atendimento` (`prazoVigente`), e pelo mesmo motivo — com mais de um
    prazo aberto, quem decide o que fazer agora olha o mais próximo.

    A comparação é entre dois INSTANTES, não entre datas: fuso não entra, e é
    a propriedade que `lib/relative-time.ts` registra como a razão de preferir
    duração a "hoje".
  */
  const agora = Date.now();

  const prazo =
    deadlines
      // So `ACTIVE`, como `prazoVigente` em `/atendimento`. Um prazo `MET` ou
      // `CANCELLED` com `due_at` no passado seria pintado de "vencido" pela
      // comparacao de instantes -- e cumprido no prazo e o oposto de vencido.
      // O esquema tem os quatro estados (`ACTIVE`, `MET`, `BREACHED`,
      // `CANCELLED`) desde `20260825170000`; a primeira versao desta faixa
      // ignorava a coluna.
      .filter((linha) => linha.status === "ACTIVE" && linha.due_at !== null)
      .sort((a, b) => (a.due_at ?? "").localeCompare(b.due_at ?? ""))
      .map((linha) => ({
        kind: linha.deadline_kind,
        source: linha.source,
        dueAt: linha.due_at,
        vencido: linha.due_at !== null && Date.parse(linha.due_at) < agora,
      }))[0] ?? null;

  const selos: readonly ObjectBadge[] = [
    {
      label: supportInternalStatusLabel(supportCase.internal_status),
      tom: tomDeStatus(statusTone(supportCase.internal_status)),
    },
    {
      label: supportPriorityLabel(supportCase.priority),
      tom: tomDeStatus(statusTone(supportCase.priority)),
    },
    {
      label: supportReplyStateLabel(supportCase.remote_reply_state),
      tom: tomDeStatus(statusTone(supportCase.remote_reply_state)),
    },
  ];

  /*
    Os fatos do atendimento. "Produto / referência" era um dos quatro blocos do
    cartão antigo; os outros três viraram selos (situação, prioridade, resposta)
    e ação (triagem), que é onde o `ObjectHeader` os põe.

    Campo ausente vira "—" e continua na grade: sumir seria a tela dizendo que
    o campo não existe quando ele só veio vazio (D-067).
  */
  const fatos: readonly (readonly [string, ReactNode])[] = [
    [
      "Produto / referência",
      reference === null ? (
        "—"
      ) : reference.href === null ? (
        <span className="sb-mono">{reference.code}</span>
      ) : (
        <Link className="sb-mono" href={reference.href}>
          {reference.code}
        </Link>
      ),
    ],
    /*
      O PEDIDO, e ele é linha PRÓPRIA — não a referência.

      `resolveSupportCaseReference` escolhe UM vínculo para representar o caso, e
      o pedido é a quarta preferência dela: um caso que também tem SKU nunca
      mostrava o pedido, embora o vínculo estivesse ali. E o número sozinho
      nunca levou a lugar nenhum, porque **pedido de venda não tem tela na V3**
      — a gaveta (D39) é a primeira superfície a responder o que foi comprado.
    */
    ...(pedidoVinculado === null
      ? []
      : ([
          [
            "Pedido",
            <span key="pedido" style={{ display: "flex", gap: "var(--sb-space-2)", alignItems: "center" }}>
              <span className="sb-mono">{pedidoVinculado}</span>
              <GavetaPedido orderId={pedidoVinculado} />
            </span>,
          ],
        ] as const)),
    ["Estado no Mercado Livre", supportCase.external_status ?? "—"],
    ["Subestado", supportCase.external_substatus ?? "—"],
    [
      "Natureza",
      [supportCase.is_mediation ? "Mediação" : null, supportCase.has_return ? "Devolução" : null]
        .filter((parte): parte is string => parte !== null)
        .join(" · ") || "—",
    ],
    ["Pack", supportCase.pack_id === null ? "—" : String(supportCase.pack_id)],
    ...(supportCase.remote_reply_block_reason === null
      ? []
      : ([["Bloqueio da resposta", supportCase.remote_reply_block_reason]] as const)),
  ];

  return (
    <Shell>
      {/*
        O `<h1>` da TELA. O `ObjectHeader` renderiza `<h2>` de proposito -- no
        frame o cartao de entidade vem depois de um cabecalho de pagina --, e
        sem este bloco a tela ficava sem nivel 1 nenhum. Foi o e2e de
        `/atendimento` que apontou, afirmando um `<h1>` com o numero do caso.
      */}
      <PageTitle
        eyebrow="ATENDIMENTO / OPERAÇÃO"
        title="Atendimento"
        subtitle={<Link href={volta}>← Voltar à Caixa de Entrada</Link>}
        compacto
      />

      {/* Sem `?.` desde D-206 -- mesma razao de `/anuncios/[itemId]`: a policy
          de `support_cases` filtra por `accessible_accounts()`, derivada da
          propria `ml_accounts`, entao um orfao esconde o ATENDIMENTO em vez de
          devolver a conta nula. */}
      <ObjectHeader
        identificador={`#${supportCase.external_case_id}`}
        titulo={supportChannelLabel(supportCase.channel)}
        badges={selos}
        meta={supportCase.ml_accounts.label}
        acoes={
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
        }
      >
        <dl className="sb-fact-grid">
          {fatos.map(([rotulo, valor]) => (
            <div key={rotulo}>
              <dt>{rotulo}</dt>
              <dd>{valor}</dd>
            </div>
          ))}
        </dl>
      </ObjectHeader>

      {/*
        A FAIXA DE PRAZO, na posição que o frame lhe dá (D-279).

        O `CaseDetail` do desenho põe o prazo logo abaixo do título, em banda
        própria — é o dado que expira, e por isso o primeiro a ser lido. Aqui
        ele estava numa lista com marcador DEPOIS da conversa inteira.

        **Não há contagem regressiva, e a ausência é deliberada.** O frame
        escreve "8 min restantes"; uma página renderizada no servidor congela
        esse número no instante da renderização, e um relógio parado que parece
        andar é pior do que instante nenhum. A faixa mostra o INSTANTE, a fonte
        (obrigatória por D-084) e uma comparação entre dois instantes — vencido
        ou não —, que é a única leitura que não depende de fuso nem de quando a
        página foi desenhada. `formatAge` não serve: ela devolve `null` para o
        futuro, de propósito, e prazo é sempre futuro.
      */}
      {prazo !== null && (
        <p
          style={{
            ...(prazo.vencido ? TOM.perigo : TOM.info),
            display: "flex",
            flexWrap: "wrap",
            gap: "0.5rem",
            alignItems: "baseline",
            margin: "var(--sb-space-3) 0 0",
            padding: "var(--sb-space-3)",
            borderRadius: "var(--sb-radius)",
            fontSize: "0.8125rem",
          }}
        >
          <strong>
            {prazo.vencido ? "Prazo vencido" : "Prazo em aberto"} ·{" "}
            {supportDeadlineKindLabel(prazo.kind)}
          </strong>
          <span>
            {prazo.dueAt === null ? "sem prazo definido" : formatDateTime(prazo.dueAt)} · fonte: {supportDeadlineSourceLabel(prazo.source)}
          </span>
        </p>
      )}

      {sideError !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Parte do atendimento não pôde ser carregada: {sideError.message}
        </p>
      )}

      <div style={{ marginTop: "var(--sb-space-3)" }}>
      <Panel title="Conversa" subtitle="Vendedor à direita, cliente à esquerda — a direção é o que se lê primeiro.">

        {messages.length === 0 ? (
          <p style={{ color: "var(--sb-text-soft)" }}>
            Nenhuma mensagem sincronizada para este atendimento.
          </p>
        ) : (
          <ol
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: "var(--sb-space-2)",
            }}
          >
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
                    {supportSenderKindLabel(message.sender_kind)} ·{" "}
                    {formatDateTime(message.occurred_at)}
                    {message.body_state !== "AVAILABLE" &&
                      ` · ${supportBodyStateLabel(message.body_state)}`}
                  </div>
                  <MessageBody message={message} />
                </li>
              );
            })}
          </ol>
        )}
      </Panel>
      </div>

      {/* A faixa acima mostra o prazo VIGENTE. Esta lista continua porque um
          atendimento pode ter mais de um (resposta, envio, devolução), e a
          faixa só cabe um. */}
      {deadlines.length > 1 && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel title="Todos os prazos" subtitle="A fonte acompanha cada prazo: prazo ausente nunca vira estimativa apresentada como oficial (D-084).">
          <ul
            style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem" }}
          >
            {deadlines.map((deadline) => (
              <li key={deadline.id}>
                {supportDeadlineKindLabel(deadline.deadline_kind)}:{" "}
                {deadline.due_at === null
                  ? "sem prazo definido"
                  : formatDateTime(deadline.due_at)}
                {/* A FONTE do prazo é obrigatória na exibição (D-084): prazo
                    ausente nunca pode virar estimativa apresentada como oficial. */}
                <span style={meta}> · fonte: {supportDeadlineSourceLabel(deadline.source)}</span>
              </li>
            ))}
          </ul>
        </Panel>
        </div>
      )}

      {podeResponder && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel title="Responder" subtitle="A resposta vai para o Mercado Livre — revise antes de enviar.">
          <div className="sb-panel-body">
          <ReplyForm
            caseId={supportCase.id}
            remoteReplyState={supportCase.remote_reply_state}
            remoteReplyBlockReason={supportCase.remote_reply_block_reason}
            templates={templates}
          />
          </div>
        </Panel>
        </div>
      )}

      {attempts.length > 0 && (
        <div style={{ marginTop: "var(--sb-space-3)" }}>
        <Panel title="Tentativas de envio" subtitle="Cada tentativa fica registrada, inclusive as que falharam.">
          <ul
            style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem" }}
          >
            {attempts.map((attempt) => (
              <li key={attempt.id} style={{ marginBottom: "0.375rem" }}>
                <StatusPill
                  code={attempt.status}
                  label={replyAttemptLabel(attempt.status)}
                />
                <span style={meta}>
                  {" "}
                  · {formatDateTime(attempt.requested_at)} ·{" "}
                  {attempt.profiles?.full_name ?? "usuário removido"}
                </span>
                {/* O texto enviado fica visível: é auditoria do que o cliente
                    recebeu, e quem enxerga o atendimento já enxerga o transcript. */}
                <div style={{ whiteSpace: "pre-wrap" }}>
                  {attempt.final_text}
                </div>
                {attempt.error_message !== null && (
                  <div
                    style={{ color: "var(--sb-danger)", fontSize: "0.8125rem" }}
                  >
                    {attempt.error_message}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Panel>
        </div>
      )}

      <div style={{ marginTop: "var(--sb-space-3)" }}>
      <Panel title="Histórico" subtitle="Append-only: uma linha por evento do atendimento.">

        {events.length === 0 ? (
          <p style={{ color: "var(--sb-text-soft)" }}>
            Nenhum evento registrado ainda.
          </p>
        ) : (
          <ul
            style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem" }}
          >
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
      </Panel>
      </div>

      <p style={{ ...meta, ...section }}>
        Última atividade: {formatDateTime(supportCase.last_activity_at)}
        {supportCase.last_inbound_at !== null &&
          ` · Última do cliente: ${formatDateTime(supportCase.last_inbound_at)}`}
        {supportCase.last_outbound_at !== null &&
          ` · Última sua: ${formatDateTime(supportCase.last_outbound_at)}`}
        {supportCase.resolved_at !== null &&
          ` · Resolvido em: ${formatDateTime(supportCase.resolved_at)}`}
      </p>
    </Shell>
  );
}
