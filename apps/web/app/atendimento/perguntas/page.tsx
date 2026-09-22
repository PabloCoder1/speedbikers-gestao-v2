import Link from "next/link";
import type { ReactNode } from "react";

import { FilterPill } from "../../../components/filter-pill";
import { Icone } from "../../../components/icons";
import { KpiStrip, type KpiCellData } from "../../../components/kpi-strip";
import { PageTitle } from "../../../components/page-title";
import { Panel } from "../../../components/panel";
import { Shell } from "../../../components/shell";
import { StatusPill } from "../../../components/status-pill";
import { formatCount, formatCurrency, formatDateTime } from "../../../lib/format";
import { monogramaDeProduto } from "../../../lib/initials";
import { supportExternalStatusLabel, supportInternalStatusLabel, supportPriorityLabel } from "../../../lib/labels";
import type { SupportCaseLinkRow } from "../../../lib/support-case-reference";
import { resolveSupportCaseReference } from "../../../lib/support-case-reference";
import { describeDeadline } from "../../../lib/support-deadline";
import { createClient } from "../../../lib/supabase/server";

export const metadata = { title: "Perguntas — Speed Bikers Gestão" };
export const dynamic = "force-dynamic";

/**
 * Fila dedicada de perguntas de pré-venda, irmã de `/atendimento/reclamacoes`
 * (mesmo recorte por `channel`, mesma composição).
 *
 * **Isto não contradiz D-084.** A Caixa de Entrada (`/atendimento`) continua
 * sendo a fila completa e a fonte única de verdade — pergunta, mensagem e
 * claim continuam recortes do MESMO `support_cases`, sem tabela própria nem
 * RPC própria. O que muda é só a APRESENTAÇÃO: pergunta de pré-venda se lê
 * pelo PRODUTO ("serve na miha moto?"), não pelo cliente ou pelo prazo — por
 * isso a lista aqui mostra foto, preço e estoque do anúncio, que a tabela
 * genérica não tinha motivo para carregar. Abrir um caso continua levando
 * para `/atendimento/[caseId]`, que é quem sabe responder — esta tela não
 * duplica conversa nem envio.
 */

const PAGE_SIZE = 50;

/**
 * Pergunta de pré-venda não tem ida e volta com o cliente (D-084 continua
 * valendo: isto é leitura, não um estado próprio). Uma vez respondida, o caso
 * sai de `NOVO`/`EM_ATENDIMENTO` para `AGUARDANDO_MERCADO_LIVRE` (a loja já
 * falou, falta o Mercado Livre processar) ou é resolvido direto — nenhum dos
 * dois pede ação de novo. "Aberta" aqui é ESSA dupla, não "diferente de
 * Resolvido": a Caixa de Entrada genérica usa o critério mais largo porque
 * mistura canais com fluxos diferentes; aqui, dentro de UM canal só, a régua
 * pode ser mais precisa.
 */
const OPEN_STATUSES = ["NOVO", "EM_ATENDIMENTO"] as const;
const CLOSED_STATUSES = ["AGUARDANDO_CLIENTE", "AGUARDANDO_MERCADO_LIVRE", "RESOLVIDO"] as const;

type StatusFilter = "abertas" | "fechadas";

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
  internal_status: string;
  priority: string;
  last_activity_at: string;
  ml_accounts: { label: string } | null;
  support_case_links: QuestionLinkRow[] | null;
  support_case_deadlines: { due_at: string | null; status: string }[] | null;
}

interface SupportMetricsRow {
  novos_question: number;
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

function pageFrom(value: string | string[] | undefined): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed = Number(raw);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function statusFrom(value: string | string[] | undefined): StatusFilter {
  const raw = Array.isArray(value) ? value[0] : value;

  return raw === "fechadas" ? "fechadas" : "abertas";
}

function perguntasHref({ status, page }: { status: StatusFilter; page: number }): string {
  const params = new URLSearchParams();

  if (status === "fechadas") params.set("status", "fechadas");
  if (page > 1) params.set("pagina", String(page));

  const query = params.toString();

  return query === "" ? "/atendimento/perguntas" : `/atendimento/perguntas?${query}`;
}

export default async function PerguntasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const query = await searchParams;
  const status = statusFrom(query.status);
  const page = pageFrom(query.pagina);
  const from = (page - 1) * PAGE_SIZE;
  const now = new Date();
  const supabase = await createClient();

  const questionsQuery = supabase
    .from("support_cases")
    .select(
      "id, external_case_id, external_status, internal_status, priority, last_activity_at, ml_accounts(label), support_case_links(order_id, sku_id, listing_id, external_entity_kind, external_entity_id, skus(sku, image_url), listings(item_id, title, thumbnail_url, price, available_quantity)), support_case_deadlines(due_at, status)",
      { count: "exact" },
    )
    .eq("channel", "QUESTION")
    .in("internal_status", status === "abertas" ? OPEN_STATUSES : CLOSED_STATUSES)
    .order("last_activity_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);

  // Contagem do KPI é INDEPENDENTE da aba selecionada — "Perguntas abertas"
  // não pode virar a contagem de "Fechadas" só porque a pessoa trocou de aba
  // (D-236: o número do painel é o do recorte, e aqui o painel É o recorte
  // "abertas", sempre, não o que a tela mostra no momento).
  const abertasCountQuery = supabase
    .from("support_cases")
    .select("id", { count: "exact", head: true })
    .eq("channel", "QUESTION")
    .in("internal_status", OPEN_STATUSES);

  const [questionsResult, metricsResult, abertasCountResult] = await Promise.all([
    questionsQuery,
    supabase.rpc("get_support_metrics", { p_days: 7 }).maybeSingle(),
    abertasCountQuery,
  ]);

  const questions = (questionsResult.data ?? []) as unknown as QuestionRow[];
  const metrics = metricsResult.error === null ? (metricsResult.data as SupportMetricsRow | null) : null;
  const total = questionsResult.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const error = questionsResult.error?.message ?? metricsResult.error?.message ?? abertasCountResult.error?.message ?? null;

  const cells: KpiCellData[] = [
    {
      metricId: "sac_abertos_question",
      label: "Perguntas abertas",
      formula: "Perguntas de pré-venda em Novo ou Em atendimento — as que ainda pedem uma resposta da loja.",
      value: abertasCountResult.error !== null ? "—" : formatCount(abertasCountResult.count ?? 0),
      previous: null,
      href: perguntasHref({ status: "abertas", page: 1 }),
      tom: "atencao",
      destaque: "atencao",
    },
    {
      metricId: "sac_novos_question",
      label: "Novas em 7 dias",
      formula: "Perguntas de pré-venda criadas nos últimos 7 dias, em todas as contas.",
      value: metrics === null ? "—" : formatCount(metrics.novos_question),
      previous: null,
      tom: "info",
    },
  ];

  return (
    <Shell>
      <PageTitle
        eyebrow="ATENDIMENTO / PRÉ-VENDA"
        title="Perguntas"
        subtitle="A fila de quem ainda não comprou — foto, preço e estoque do anúncio ao lado de cada pergunta."
        aside={
          <>
            <Link className="sb-button" href="/atendimento">
              <Icone nome="bandeja" tamanho={14} /> Ver Caixa de Entrada
            </Link>
            <Link className="sb-button" href="/atendimento/conhecimento">
              <Icone nome="livro" tamanho={14} /> Base de Conhecimento
            </Link>
          </>
        }
      />

      <KpiStrip ancora cells={cells} />

      {error !== null && (
        <div role="alert" className="sb-inbox-state sb-inbox-state-error">
          <strong>Não foi possível carregar as perguntas.</strong>
          <span>{error}</span>
          <Link className="sb-button" href={perguntasHref({ status, page })}>
            Tentar de novo
          </Link>
        </div>
      )}

      {error === null && (
        <section className="sb-inbox-section">
          <Panel
            title={status === "abertas" ? "Fila de perguntas" : "Perguntas respondidas e fechadas"}
            subtitle={
              total > 0
                ? `${formatCount(total)} ${total === 1 ? "pergunta" : "perguntas"}${status === "abertas" ? " em aberto" : " fora da fila"}, por atividade mais recente`
                : undefined
            }
            aside={
              <div className="sb-inbox-toggles" aria-label="Estado das perguntas">
                <FilterPill href={perguntasHref({ status: "abertas", page: 1 })} active={status === "abertas"}>
                  Abertas
                </FilterPill>
                <FilterPill href={perguntasHref({ status: "fechadas", page: 1 })} active={status === "fechadas"}>
                  Respondidas e fechadas
                </FilterPill>
              </div>
            }
          >
            {questions.length === 0 && (
              <div className="sb-inbox-state">
                <span className="sb-inbox-state-icon" aria-hidden="true">
                  <Icone nome="duvida" tamanho={20} />
                </span>
                <strong>{status === "abertas" ? "Nenhuma pergunta em aberto" : "Nenhuma pergunta fechada ainda"}</strong>
                <span>
                  {status === "abertas"
                    ? "A sincronização traz perguntas novas pelo webhook em segundos."
                    : "Perguntas já respondidas ou resolvidas aparecem aqui."}
                </span>
              </div>
            )}

            {questions.length > 0 && (
              <div className="sb-inbox-table-wrap">
                <table className="sb-table sb-inbox-table">
                  <thead>
                    <tr>
                      <th>Prioridade</th>
                      <th>Produto</th>
                      <th>Conta</th>
                      <th>Preço / estoque</th>
                      <th>Prazo</th>
                      <th>Status</th>
                      <th>Última atividade</th>
                      <th aria-label="Abrir" />
                    </tr>
                  </thead>
                  <tbody>
                    {questions.map((question) => {
                      const deadline = firstActiveDeadline(question.support_case_deadlines);
                      const deadlineView = deadline === null ? null : describeDeadline(deadline, now);
                      const reference = resolveSupportCaseReference(question.support_case_links);
                      const media = questionMedia(question.support_case_links);
                      const caseHref = `/atendimento/${question.id}?volta=${encodeURIComponent(perguntasHref({ status, page }))}`;

                      return (
                        <tr key={question.id} className={deadlineView?.tone === "perigo" ? "sb-inbox-row-late" : undefined}>
                          <td>
                            <StatusPill code={question.priority} label={supportPriorityLabel(question.priority)} />
                          </td>

                          <td className="sb-an-produto">
                            <span className="sb-an-produto-linha">
                              {media.photo === null ? (
                                <span className="sb-product-thumb sb-an-foto" aria-hidden="true">
                                  {monogramaDeProduto(reference?.title ?? reference?.code ?? "?")}
                                </span>
                              ) : (
                                <img
                                  className="sb-an-foto"
                                  src={media.photo}
                                  alt=""
                                  width={40}
                                  height={40}
                                  loading="lazy"
                                  decoding="async"
                                  referrerPolicy="no-referrer"
                                />
                              )}
                              <span className="sb-an-produto-texto">
                                <Link className="sb-inbox-case" href={caseHref}>
                                  {reference?.title ?? reference?.code ?? "Sem referência"}
                                </Link>
                                <span className="sb-inbox-meta">
                                  {reference?.title != null && (
                                    <>
                                      {reference.href === null ? <span className="sb-mono">{reference.code}</span> : <Link className="sb-mono" href={reference.href}>{reference.code}</Link>}
                                      <span aria-hidden="true"> · </span>
                                    </>
                                  )}
                                  <span className="sb-mono">#{question.external_case_id}</span>
                                  {question.external_status !== null && ` · ${supportExternalStatusLabel(question.external_status)}`}
                                </span>
                              </span>
                            </span>
                          </td>

                          <td>{question.ml_accounts?.label ?? "—"}</td>

                          <td className="sb-num">
                            {media.price === null ? <span className="sb-inbox-muted">—</span> : formatCurrency(media.price)}
                            {media.stock !== null && <span className="sb-inbox-meta">{formatCount(media.stock)} em estoque</span>}
                          </td>

                          <td className="sb-inbox-deadline">
                            {deadline === null || deadlineView === null ? (
                              <span className="sb-inbox-muted">—</span>
                            ) : (
                              <>
                                {deadlineView.relative !== null && (
                                  <span className={`sb-inbox-deadline-pill sb-inbox-deadline-${deadlineView.tone}`}>{deadlineView.relative}</span>
                                )}
                                <span className="sb-inbox-meta">{formatDateTime(deadline)}</span>
                              </>
                            )}
                          </td>

                          <td>
                            <StatusPill code={question.internal_status} label={supportInternalStatusLabel(question.internal_status)} />
                          </td>

                          <td className="sb-inbox-nowrap">{formatDateTime(question.last_activity_at)}</td>

                          <td>
                            <Link className="sb-button sb-inbox-open" href={caseHref} aria-label={`Abrir pergunta #${question.external_case_id}`}>
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

            {totalPages > 1 && (
              <nav className="sb-inbox-pages" aria-label="Páginas da fila de perguntas">
                {page > 1 ? (
                  <Link className="sb-button" href={perguntasHref({ status, page: page - 1 })}>
                    ‹ Anterior
                  </Link>
                ) : (
                  <span />
                )}
                <span>
                  Página {page} de {totalPages}
                </span>
                {page < totalPages ? (
                  <Link className="sb-button" href={perguntasHref({ status, page: page + 1 })}>
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
