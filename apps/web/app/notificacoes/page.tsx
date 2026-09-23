import Link from "next/link";
import type { ReactNode } from "react";

import { CarregandoSeODemorar } from "../../components/carregando-link";
import { FilterMenu } from "../../components/filter-menu";
import { FilterPill } from "../../components/filter-pill";
import { Icone } from "../../components/icons";
import { KpiStrip, type KpiCellData } from "../../components/kpi-strip";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { businessDayOf, formatBusinessDate, formatCount, formatWeekday } from "../../lib/format";
import { severityLabel } from "../../lib/labels";
import {
  NOTIFICATION_FAMILIES,
  NOTIFICATION_SEVERITIES,
  PAGE_SIZE,
  buildNotificationHref,
  countNotificationFilters,
  describeNotificationRecorte,
  notificationFamilyLabel,
  notificationFamilyPattern,
  resolveNotificationFilters,
  summarizePagedWindow,
  type NotificationFilters,
} from "../../lib/notification-filters";
import { formatAge } from "../../lib/relative-time";
import { createClient } from "../../lib/supabase/server";
import { MarkAllButton } from "./mark-all-button";
import { NotificationRow, type NotificationRowData } from "./notification-row";

export const metadata = { title: "Central de Notificações — Speed Bikers Gestão" };

// A sessão vem de cookie: pré-renderizar no build mostraria dado de outra
// pessoa. Mesmo raciocínio das demais telas.
export const dynamic = "force-dynamic";

/**
 * Central de Notificações (Fase 7, item 4, `docs/HANDOFF.md` —
 * desbloqueada pelo schema de D-073). Histórico completo com estado
 * lido/não lido por usuário (`docs/NOTIFICATIONS.md` secao 7).
 *
 * ## D-393 — a Central deixou de ser uma parede cronológica
 *
 * D-269 recusou o "Filtrar" do frame por ser funcionalidade, e a recusa era
 * honesta: "nenhum número os pediu". D-290 entregou a única candidata que
 * tinha número (não lidas) e a paginação. **Os números das outras três
 * chegaram**, medidos no Dev em 2026-09-23 contra o usuário com a caixa cheia:
 *
 * | | |
 * |---|---|
 * | a caixa | **54.306 notificações**, 13.398 não lidas, **544 páginas de 100** |
 * | severidade | **13.810 críticas (25,4%)** e 5.755 importantes, espalhadas pelas 544 |
 * | tipo | **`listing.available_quantity.changed` sozinho é 32.783 (60,4%)** |
 * | conta | 11.011 / 10.693 / 10.087 / 9.726, mais 12.789 de evento organizacional |
 *
 * Três em cada cinco linhas são o mesmo aviso de rotina, e as críticas mais
 * antigas estavam a 544 páginas de distância. É a mesma doença que
 * `docs/NOTIFICATIONS.md` §9 nomeia sobre a V2 — "cinco mil alertas não são
 * cinco mil problemas, são uma tela que ninguém abre" —, e o que faltava para
 * tratá-la era filtro, que §7 já listava como pendência desde 2026-08-24.
 *
 * ## A RAIZ DA CONSULTA MUDOU, e isso é performance medida
 *
 * Era `from("notifications")` com o destinatário embutido; passou a ser
 * `from("notification_recipients")` com a notificação embutida. Medido como
 * `authenticated`, com a RLS valendo (a lição de D-305→D-307: medir na forma
 * que a tela usa, nunca pelo `pg_stat_statements`):
 *
 * | | antes | depois |
 * |---|---:|---:|
 * | primeira página, sem recorte | **556 ms** | **63 ms** |
 * | linhas tocadas para montar 100 | 54.306 | 100 |
 *
 * O motivo é a ORDEM: com a lista de destinatários na raiz e o índice novo
 * `(user_id, created_at desc)` (migration `20260923150000`), o planejador anda
 * pela ordem e para na centésima linha, em vez de materializar tudo e ordenar
 * no fim. **E é a mesma ordem**: `private.fan_out_notification` grava a
 * notificação e os destinatários na mesma transação, e `now()` é o instante da
 * transação — conferido nas 66.932 linhas da base, zero diferença.
 *
 * ## O que continua fora
 *
 * O painel de detalhe do frame (D-269): ele repete os campos da linha e
 * acrescenta um "Impacto estimado R$ 8.400" que não tem coluna — `notifications`
 * tem QUATRO colunas. Período, busca por entidade e origem automática/manual
 * estão recusados com número em `lib/notification-filters.ts`.
 */

interface NotificationQueryRow {
  notification_id: string;
  read_at: string | null;
  created_at: string;
  notifications: {
    domain_events: {
      event_type: string;
      entity_type: string;
      entity_id: string;
      severity: string;
      occurred_at: string;
      before: unknown;
      after: unknown;
      ml_accounts: { label: string } | null;
    } | null;
  } | null;
}

/** Um dia civil de CHEGADA e as linhas que chegaram nele. */
interface GrupoDoDia {
  dia: string;
  /** O instante da primeira linha do grupo — de onde sai o dia da semana. */
  instante: string;
  rows: NotificationRowData[];
}

/**
 * O SELECT, escrito uma vez e reusado pela lista e pelas contagens.
 *
 * `!inner` nos dois níveis é o que permite FILTRAR por coluna de
 * `domain_events` a partir da raiz — sem ele o PostgREST devolveria a linha do
 * destinatário com o embed vazio em vez de descartá-la. Os dois embeds têm FK
 * que os sustenta (`check:embeds`): `notification_recipients.notification_id`
 * e `notifications.domain_event_id`.
 */
const SELECT_LISTA =
  "notification_id, read_at, created_at, notifications!inner(domain_events!inner(event_type, entity_type, entity_id, severity, occurred_at, before, after, ml_accounts(label)))";

/** O mesmo caminho, sem coluna nenhuma além do necessário para contar. */
const SELECT_CONTAGEM = "notification_id, notifications!inner(domain_event_id, domain_events!inner(id))";

export default async function NotificacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const filters: NotificationFilters = resolveNotificationFilters(await searchParams);
  const supabase = await createClient();

  const desde = (filters.page - 1) * PAGE_SIZE;
  const soNaoLidas = filters.state === "nao-lidas";
  const temRecorte = filters.severity !== null || filters.family !== null || filters.account !== null;
  const filtrosAtivos = countNotificationFilters(filters);

  /*
    O RECORTE NUM LUGAR SÓ, aplicado à lista E às duas contagens — é o que
    impede o cabeçalho de discordar do corpo (D-236). Os filtros moram no
    EMBED, nunca em `notification_recipients`: severidade, tipo e conta são
    atributos do EVENTO; lida é estado POR PESSOA (`docs/NOTIFICATIONS.md` §7).

    As condições são DADO, não código repetido: a lista de colunas e valores
    existe uma vez, e cada consulta só a percorre. Três cópias do mesmo `if`
    seriam três lugares para a quarta dimensão nascer torta.
  */
  const condicoes: readonly { operador: "eq" | "like"; coluna: string; valor: string }[] = [
    ...(filters.severity === null
      ? []
      : [{ operador: "eq" as const, coluna: "notifications.domain_events.severity", valor: filters.severity }]),
    ...(filters.family === null
      ? []
      : [
          {
            operador: "like" as const,
            coluna: "notifications.domain_events.event_type",
            valor: notificationFamilyPattern(filters.family),
          },
        ]),
    ...(filters.account === null
      ? []
      : [{ operador: "eq" as const, coluna: "notifications.domain_events.ml_account_id", valor: filters.account }]),
  ];

  let listQuery = supabase
    .from("notification_recipients")
    .select(SELECT_LISTA)
    .order("created_at", { ascending: false })
    .range(desde, desde + PAGE_SIZE - 1);

  let contagemDoRecorte = supabase
    .from("notification_recipients")
    .select(SELECT_CONTAGEM, { count: "exact", head: true });

  let naoLidasDoRecorte = supabase
    .from("notification_recipients")
    .select(SELECT_CONTAGEM, { count: "exact", head: true })
    .is("read_at", null);

  for (const condicao of condicoes) {
    if (condicao.operador === "eq") {
      listQuery = listQuery.eq(condicao.coluna, condicao.valor);
      contagemDoRecorte = contagemDoRecorte.eq(condicao.coluna, condicao.valor);
      naoLidasDoRecorte = naoLidasDoRecorte.eq(condicao.coluna, condicao.valor);
      continue;
    }

    listQuery = listQuery.like(condicao.coluna, condicao.valor);
    contagemDoRecorte = contagemDoRecorte.like(condicao.coluna, condicao.valor);
    naoLidasDoRecorte = naoLidasDoRecorte.like(condicao.coluna, condicao.valor);
  }

  if (soNaoLidas) {
    listQuery = listQuery.is("read_at", null);
  }

  /*
    A FAIXA CONTA A CENTRAL INTEIRA, e a lista conta o recorte — dois conjuntos
    diferentes na mesma tela, que é exatamente a armadilha de D-265. A
    diferença está escrita nos rótulos e na ressalva de cada célula, não
    subentendida: "na Central" numa, "neste recorte" na outra.

    As três contagens da faixa custam pouco porque todas passam pelo índice
    parcial de não lidas (`user_id, created_at where read_at is null`): medido
    como `authenticated`, 24 ms cada.
  */
  const naoLidasGerais = supabase
    .from("notification_recipients")
    .select("notification_id", { count: "exact", head: true })
    .is("read_at", null);

  const naoLidasCriticas = supabase
    .from("notification_recipients")
    .select(SELECT_CONTAGEM, { count: "exact", head: true })
    .is("read_at", null)
    .eq("notifications.domain_events.severity", "critico");

  const naoLidasImportantes = supabase
    .from("notification_recipients")
    .select(SELECT_CONTAGEM, { count: "exact", head: true })
    .is("read_at", null)
    .eq("notifications.domain_events.severity", "importante");

  const contasQuery = supabase.from("ml_accounts").select("id, label").order("label");

  const [
    { data, error: listError },
    totalResult,
    unreadRecorteResult,
    unreadGeralResult,
    criticasResult,
    importantesResult,
    contasResult,
  ] = await Promise.all([
    listQuery,
    contagemDoRecorte,
    naoLidasDoRecorte,
    naoLidasGerais,
    naoLidasCriticas,
    naoLidasImportantes,
    contasQuery,
  ]);

  const error = listError;
  const contas = contasResult.data ?? [];
  const contaAtiva = filters.account === null ? null : (contas.find((c) => c.id === filters.account) ?? null);
  const recorte = describeNotificationRecorte(filters, contaAtiva?.label ?? null);

  const agora = new Date();

  const rows: NotificationRowData[] = ((data ?? []) as unknown as NotificationQueryRow[]).map((row) => {
    const event = row.notifications?.domain_events ?? null;
    const occurredAt = event?.occurred_at ?? row.created_at;

    return {
      id: row.notification_id,
      createdAt: row.created_at,
      readAt: row.read_at,
      eventType: event?.event_type ?? "—",
      entityType: event?.entity_type ?? "—",
      entityId: event?.entity_id ?? "—",
      severity: event?.severity ?? "informativo",
      occurredAt,
      before: (event?.before ?? null) as Record<string, unknown> | null,
      after: (event?.after ?? null) as Record<string, unknown> | null,
      accountLabel: event?.ml_accounts?.label ?? null,
      idade: formatAge(occurredAt, agora),
    };
  });

  /*
    OS GRUPOS DE DIA, e o dia é o da CHEGADA — não o do fato.

    A lista é ordenada por `created_at` do destinatário; agrupar pelo
    `occurred_at` do evento faria o cabeçalho voltar no tempo no meio da
    página. Não é hipótese: medido, **541 das 54.306** têm o fato num dia civil
    e a chegada em outro, com atraso máximo de **32 dias** (um backfill de
    sincronização que só virou notificação depois). O cabeçalho diz quando
    chegou; a linha continua dizendo quando aconteceu, e quando os dois
    discordam a diferença fica visível em vez de escondida.

    Consecutivo, não `groupBy`: a lista já vem ordenada, então basta comparar
    com o último grupo — e ordem é o que garante que cada dia apareça uma vez.
  */
  const grupos: GrupoDoDia[] = [];

  for (const row of rows) {
    const dia = businessDayOf(row.createdAt);
    const ultimo = grupos[grupos.length - 1];

    if (ultimo?.dia === dia) {
      ultimo.rows.push(row);
      continue;
    }

    grupos.push({ dia, instante: row.createdAt, rows: [row] });
  }

  /*
    "Hoje" e "Ontem" só existem dentro de um FUSO, e é por isso que
    `lib/relative-time.ts` se recusa a produzi-los a partir de uma duração —
    a armadilha de D-260, que deslocou um histórico inteiro para outro dia da
    semana ao usar `toISOString()`. Aqui os dois lados da comparação saem de
    `businessDayOf`, que é `America/Sao_Paulo` nos dois. O dia da semana sai do
    INSTANTE da primeira linha do grupo, nunca de `new Date("2026-09-14")` —
    essa string seria meia-noite UTC, ou seja, o dia anterior em São Paulo.
  */
  const hoje = businessDayOf(agora);
  const ontem = businessDayOf(new Date(agora.getTime() - 24 * 60 * 60 * 1000));

  function rotuloDoDia(grupo: GrupoDoDia): string {
    if (grupo.dia === hoje) return "Hoje";
    if (grupo.dia === ontem) return "Ontem";

    return `${formatWeekday(grupo.instante)}, ${formatBusinessDate(grupo.dia)}`;
  }

  // `count` nulo é recusa, não zero (D-131): quando a contagem não vem, a tela
  // diz que não sabe em vez de inventar o tamanho da página.
  const totalCount = totalResult.count;
  const unreadRecorte = unreadRecorteResult.count;
  const unreadGeral = unreadGeralResult.count;
  const criticasNaoLidas = criticasResult.count;
  const importantesNaoLidas = importantesResult.count;

  /*
    A JANELA CONTA O RECORTE, NÃO A TELA (D-290). Com "só não lidas" ligado,
    dizer "1 a 100 de 54.306" seria a faixa de um conjunto que não está na
    tela. As duas contagens já existiam e cada uma continua dona do seu número;
    a janela escolhe qual das duas descreve o que está listado.
  */
  const windowCount = soNaoLidas ? unreadRecorte : totalCount;
  const window =
    windowCount === null
      ? null
      : summarizePagedWindow({
          page: filters.page,
          totalCount: windowCount,
          rowsOnPage: rows.length,
          pageSize: PAGE_SIZE,
          noun: soNaoLidas
            ? { singular: "não lida", plural: "não lidas" }
            : { singular: "notificação", plural: "notificações" },
          emptyLabel: soNaoLidas ? "Nenhuma não lida." : "Nenhuma notificação ainda.",
          trailing: ", as mais recentes",
        });

  /*
    PÁGINA ALÉM DO FIM — por CONTAGEM, não por erro, e a diferença foi medida
    (D-290). O 416 `PGRST103` do PostgREST só aparece quando `.range()` vem
    junto de `count: exact` na MESMA consulta; a lista aqui não pede `count`,
    então um pedido fora da faixa volta 200 com zero linhas. Com o total em
    mãos, "página 9 de 1" se sabe por aritmética.
  */
  const paginaVazia = window !== null && filters.page > 1 && filters.page > window.totalPages;

  /*
    A FAIXA (`.kpi-strip`) — três células, e cada uma é um LINK para o recorte
    que produziu o número.

    **D-269 registrou que o frame não dá resumo a esta variação, e isso
    continua verdade** — o que entra aqui não é o resumo do frame. É navegação,
    que é a pergunta que D-265 manda fazer: a faixa conta o mesmo conjunto da
    tabela, ou é navegação? É navegação, e por isso cada célula leva ao recorte
    exato que a contou, como o chip "ver lista" das outras telas. Sem isso, as
    únicas dez críticas não lidas desta base continuariam invisíveis atrás de
    544 páginas.
  */
  const celulas: KpiCellData[] = [
    {
      label: "Não lidas",
      formula: "notification_recipients do usuário com read_at nulo, em toda a Central.",
      value: formatCount(unreadGeral),
      previous: null,
      ressalva: "em toda a Central, não no recorte",
      href: buildNotificationHref({ ...filters, severity: null, family: null, account: null }, { state: "nao-lidas" }),
      tom: "info",
    },
    {
      label: "Críticas não lidas",
      formula: "Não lidas cujo domain_event tem severity = critico.",
      value: formatCount(criticasNaoLidas),
      previous: null,
      href: buildNotificationHref(
        { ...filters, family: null, account: null },
        { state: "nao-lidas", severity: "critico" },
      ),
      tom: "perigo",
      // `exactOptionalPropertyTypes`: propriedade opcional não aceita
      // `undefined` explícito, então ela ENTRA ou não entra.
      ...(criticasNaoLidas !== null && criticasNaoLidas > 0 ? { destaque: "perigo" as const } : {}),
    },
    {
      label: "Importantes não lidas",
      formula: "Não lidas cujo domain_event tem severity = importante.",
      value: formatCount(importantesNaoLidas),
      previous: null,
      href: buildNotificationHref(
        { ...filters, family: null, account: null },
        { state: "nao-lidas", severity: "importante" },
      ),
      tom: "atencao",
    },
  ];

  const podeMarcar = unreadRecorte !== null && unreadRecorte > 0;

  return (
    <Shell>
      <PageTitle
        eyebrow="CENTRAL / ALERTAS"
        title="Central de Notificações"
        subtitle="O que mudou na operação — com contexto suficiente para agir."
        aside={
          <>
            <Link className="sb-text-button" href="/notificacoes/preferencias">
              Preferências
              <CarregandoSeODemorar />
            </Link>
            {podeMarcar && (
              <MarkAllButton
                unreadCount={unreadRecorte}
                recorte={recorte}
                scope={{
                  severity: filters.severity,
                  family: filters.family,
                  account: filters.account,
                }}
              />
            )}
          </>
        }
      />

      {error !== null && (
        <div className="sb-notification-error-bloco" role="alert">
          <span aria-hidden="true">
            <Icone nome="pulso" tamanho={18} />
          </span>
          <div>
            <strong>Não foi possível carregar a Central agora.</strong>
            <p>Seus filtros foram preservados e nada foi marcado como lido. {error.message}</p>
          </div>
          <Link className="sb-button" href={buildNotificationHref(filters, { page: filters.page })}>
            Tentar novamente
            <CarregandoSeODemorar />
          </Link>
        </div>
      )}

      {error === null && <KpiStrip cells={celulas} />}

      {paginaVazia && (
        <p className="sb-notification-vazio-pagina">
          Esta página não existe neste recorte — a lista encolheu ou o link é antigo.{" "}
          <Link href={buildNotificationHref(filters, { page: 1 })}>
            Voltar à primeira página
            <CarregandoSeODemorar />
          </Link>
          .
        </p>
      )}

      {error === null && !paginaVazia && (
        <Panel
          title="Eventos recentes"
          subtitle={
            <>
              {window === null
                ? `${formatCount(rows.length)} carregadas — total indisponível.`
                : window.label.replace(/\.$/, "")}
              {/* Com o recorte de não lidas ligado a janela já diz "de N não
                  lidas" — repetir aqui seria o mesmo número duas vezes na
                  mesma frase. */}
              {!soNaoLidas && unreadRecorte !== null && ` · ${formatCount(unreadRecorte)} não lida(s)`}
              {temRecorte && ` · recorte: ${recorte}`}.
            </>
          }
          aside={
            <>
              {/*
                O "Filtrar" do frame, entregue. D-269 o recusou como botão sem
                função — o desenho sugere um MENU de filtros, e o que faltava
                não era o menu: era o número que dissesse o que pôr dentro
                dele. Agora são três dimensões, cada uma com a sua medição.
              */}
              <FilterMenu
                rotulo={filters.severity === null ? "Severidade" : severityLabel(filters.severity)}
                opcoes={[
                  {
                    href: buildNotificationHref(filters, { severity: null }),
                    label: "Todas as severidades",
                    ativo: filters.severity === null,
                  },
                  ...NOTIFICATION_SEVERITIES.map((severity) => ({
                    href: buildNotificationHref(filters, { severity }),
                    label: severityLabel(severity),
                    ativo: filters.severity === severity,
                  })),
                ]}
              />
              <FilterMenu
                rotulo={filters.family === null ? "Tipo" : notificationFamilyLabel(filters.family)}
                opcoes={[
                  {
                    href: buildNotificationHref(filters, { family: null }),
                    label: "Todos os tipos",
                    ativo: filters.family === null,
                  },
                  ...NOTIFICATION_FAMILIES.map((family) => ({
                    href: buildNotificationHref(filters, { family }),
                    label: notificationFamilyLabel(family),
                    ativo: filters.family === family,
                  })),
                ]}
              />
              <FilterMenu
                rotulo={contaAtiva?.label ?? "Conta"}
                opcoes={[
                  {
                    href: buildNotificationHref(filters, { account: null }),
                    label: "Todas as contas",
                    ativo: filters.account === null,
                  },
                  ...contas.map((conta) => ({
                    href: buildNotificationHref(filters, { account: conta.id }),
                    label: conta.label,
                    ativo: filters.account === conta.id,
                  })),
                ]}
              />
            </>
          }
        >
          {/*
            O RECORTE DE NÃO LIDAS, que D-290 entregou como duas pílulas. Elas
            ficam FORA do menu de propósito: é a dimensão que se alterna o
            tempo todo, e esconder um interruptor dentro de um dropdown é
            trocar um clique por dois na ação mais frequente da tela.
          */}
          <div className="sb-notification-filters">
            <FilterPill href={buildNotificationHref(filters, { state: "todas" })} active={!soNaoLidas}>
              Todas
            </FilterPill>
            <FilterPill href={buildNotificationHref(filters, { state: "nao-lidas" })} active={soNaoLidas}>
              {unreadRecorte === null ? "Não lidas" : `Não lidas (${formatCount(unreadRecorte)})`}
            </FilterPill>

            {filtrosAtivos > 0 && (
              <Link className="sb-button sb-notification-limpar" href="/notificacoes">
                Limpar {filtrosAtivos === 1 ? "filtro" : `${String(filtrosAtivos)} filtros`}
                <CarregandoSeODemorar />
              </Link>
            )}
          </div>

          {rows.length === 0 ? (
            <div className="sb-notification-vazio">
              <span aria-hidden="true">
                <Icone nome="megafone" tamanho={20} />
              </span>
              <div>
                <strong>
                  {filtrosAtivos > 0
                    ? "Nenhuma notificação neste recorte."
                    : "Nenhuma notificação ainda."}
                </strong>
                <p>
                  {filtrosAtivos > 0
                    ? "Amplie o recorte para ver o resto da Central — o histórico completo continua lá."
                    : "Quando a operação mudar, o evento aparece aqui com contexto suficiente para agir."}
                </p>
              </div>
              {filtrosAtivos > 0 && (
                <Link className="sb-button" href="/notificacoes">
                  Limpar filtros
                  <CarregandoSeODemorar />
                </Link>
              )}
            </div>
          ) : (
            <div className="sb-notification-dias">
              {grupos.map((grupo) => (
                <section className="sb-notification-dia" key={grupo.dia} aria-label={rotuloDoDia(grupo)}>
                  <h3 className="sb-notification-dia-head">
                    <span>{rotuloDoDia(grupo)}</span>
                    <span className="sb-notification-dia-conta">
                      {formatCount(grupo.rows.length)} {grupo.rows.length === 1 ? "evento" : "eventos"}
                    </span>
                  </h3>

                  <ul className="sb-notification-list">
                    {grupo.rows.map((row) => (
                      <NotificationRow key={row.id} notification={row} />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Panel>
      )}

      {/*
        O paginador — mesma forma de `/atendimento` e `/precos`. Sem salto para
        página arbitrária: a lista é cronológica e cresce por cima, então
        "página 7" não é lugar estável — anterior e próxima são o que se pode
        prometer.
      */}
      {error === null && !paginaVazia && window !== null && window.totalPages > 1 && (
        <div className="sb-notification-paginador">
          {filters.page > 1 && (
            <FilterPill href={buildNotificationHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
          <span className="sb-notification-pagina">
            Página {formatCount(filters.page)} de {formatCount(window.totalPages)}
          </span>
          {filters.page < window.totalPages && (
            <FilterPill href={buildNotificationHref(filters, { page: filters.page + 1 })} active={false}>
              Próxima →
            </FilterPill>
          )}
        </div>
      )}
    </Shell>
  );
}
