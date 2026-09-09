import Link from "next/link";
import type { ReactNode } from "react";

import { FilterPill } from "../../components/filter-pill";
import { PageTitle } from "../../components/page-title";
import { Panel } from "../../components/panel";
import { Shell } from "../../components/shell";
import { formatCount } from "../../lib/format";
import {
  PAGE_SIZE,
  buildNotificationHref,
  resolveNotificationFilters,
  summarizePagedWindow,
  type NotificationFilters,
} from "../../lib/notification-filters";
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
 * lido/não lido por usuário (`docs/NOTIFICATIONS.md` secao 7) — Realtime,
 * toast e agrupamento por janela (item 5) ficam de fora desta fatia.
 *
 * `notification_recipients!inner(read_at)` sem filtro de `user_id`: a
 * policy `notification_recipients_select_own` já restringe o embed à
 * própria linha do usuário — mesmo raciocínio de `apps/web/app/compras/page.tsx`
 * ("sem filtro por organização: a policy já restringe").
 *
 * **O RECORTE DE NÃO LIDAS E A PAGINAÇÃO (D-290).** D-269 recusou o "Filtrar"
 * do frame por ser funcionalidade e deixou UMA candidata registrada com
 * número: **8.350 não lidas de 42.511**. Ela entrou como duas pílulas — e só
 * ela: severidade, tipo e conta continuam fora. A página veio junto porque o
 * recorte sem alcance seria meio caminho: "as 100 não lidas mais recentes" é o
 * mesmo beco que D-289 tirou de `/atendimento`, e aqui o resto é maior —
 * 42.411 notificações fora da primeira página.
 *
 * O filtro mora no EMBED (`notification_recipients.read_at`), nunca em
 * `notifications`: lido é estado POR PESSOA (`docs/NOTIFICATIONS.md` §7).
 */

interface NotificationQueryRow {
  id: string;
  created_at: string;
  notification_recipients: { read_at: string | null }[];
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
}

export default async function NotificacoesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<ReactNode> {
  const supabase = await createClient();

  /*
    AS DUAS DIMENSÕES DE D-290. O recorte de não lidas era a candidata que
    D-269 registrou com número (8.350 de 42.511), e a página veio junto pelo
    mesmo motivo de D-289: a tela lia as 100 mais recentes e nada mais — com
    o recorte ligado, "as 100 não lidas mais recentes" é o mesmo beco.
  */
  const filters: NotificationFilters = resolveNotificationFilters(await searchParams);
  const desde = (filters.page - 1) * PAGE_SIZE;
  const soNaoLidas = filters.state === "nao-lidas";

  // As três em paralelo: a lista e as DUAS contagens. Contar custa 2,7 ms e
  // 1,0 ms contra as 28.386 linhas do Dev (medido em D-183) — o round trip a
  // mais é mais barato do que o número errado que ele evita.
  let listQuery = supabase
    .from("notifications")
    .select(
      "id, created_at, notification_recipients!inner(read_at), domain_events(event_type, entity_type, entity_id, severity, occurred_at, before, after, ml_accounts(label))",
    )
    .order("created_at", { ascending: false })
    .range(desde, desde + PAGE_SIZE - 1);

  /*
    O recorte mora no EMBED, e só funciona porque ele já era `!inner`: a
    condição é sobre a linha do destinatário (a MINHA), não sobre a
    notificação — lida é estado por pessoa (`docs/NOTIFICATIONS.md` §7), e um
    filtro em `notifications` responderia "alguém leu", que é outra pergunta.
  */
  if (soNaoLidas) {
    listQuery = listQuery.is("notification_recipients.read_at", null);
  }

  const [{ data, error: listError }, totalResult, unreadResult] = await Promise.all([
    listQuery,
    supabase.from("notification_recipients").select("notification_id", { count: "exact", head: true }),
    supabase
      .from("notification_recipients")
      .select("notification_id", { count: "exact", head: true })
      .is("read_at", null),
  ]);

  const error = listError;

  const rows: NotificationRowData[] = ((data ?? []) as NotificationQueryRow[]).map((row) => {
    const readAt = row.notification_recipients[0]?.read_at ?? null;
    const event = row.domain_events;

    return {
      id: row.id,
      createdAt: row.created_at,
      readAt,
      eventType: event?.event_type ?? "—",
      entityType: event?.entity_type ?? "—",
      entityId: event?.entity_id ?? "—",
      severity: event?.severity ?? "informativo",
      occurredAt: event?.occurred_at ?? row.created_at,
      before: (event?.before ?? null) as Record<string, unknown> | null,
      after: (event?.after ?? null) as Record<string, unknown> | null,
      accountLabel: event?.ml_accounts?.label ?? null,
    };
  });

  // D-183 — o defeito que esta fatia corrige.
  //
  // `unreadCount` era `rows.filter(...).length`: contava as não lidas ENTRE AS
  // 100 CARREGADAS. Medido no Dev: 28.386 notificações, 2.543 não lidas. A
  // tela dizia "100 no histórico" e no máximo 100 não lidas.
  //
  // O pior não era o número: era o botão. "Marcar todas como lidas" só
  // aparece com `unreadCount > 0`, então bastava ler as 100 mais recentes
  // para ele SUMIR — deixando milhares de não lidas sem nenhuma forma de
  // limpar pela interface, enquanto a Server Action por trás dele sempre
  // marcou todas. Mesma classe de D-138/D-140, que criaram o
  // `summarizePagedWindow` justamente para isto.
  //
  // `count` nulo é recusa, não zero (D-131): quando a contagem não vem, a
  // tela diz que não sabe em vez de inventar o tamanho da página.
  const totalCount = totalResult.count;
  const unreadCount = unreadResult.count;

  /*
    A JANELA CONTA O RECORTE, NÃO A TELA. Com "só não lidas" ligado, dizer
    "1 a 100 de 42.511" seria a faixa de um conjunto que não está na tela — a
    mesma classe de D-236 (cabeçalho discordando do corpo). As duas contagens
    já existiam e cada uma continua dona do seu número; a janela escolhe qual
    das duas descreve o que está listado.
  */
  const windowCount = soNaoLidas ? unreadCount : totalCount;
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
    PÁGINA ALÉM DO FIM — AQUI POR CONTAGEM, NÃO POR ERRO, e a diferença foi
    medida (D-290).

    D-289 tratou o mesmo caso em `/atendimento` com o **416 `PGRST103`** que o
    PostgREST devolve. Medido agora, o gatilho daquele 416 não é o `.range()`
    sozinho: é `.range()` **junto de `count: exact` na mesma consulta**. Sem
    `count`, o mesmo pedido volta **200 com zero linhas** — conferido nas duas
    tabelas.

    Esta tela tira as contagens de duas consultas próprias (D-183), então a
    lista não pede `count` e não há erro nenhum para detectar. O que sobra é
    melhor: com o total em mãos, "página 9 de 1" se sabe por aritmética, sem
    depender do comportamento do servidor.
  */
  const paginaVazia = window !== null && filters.page > 1 && filters.page > window.totalPages;

  return (
    <Shell>
      <PageTitle
        eyebrow="CENTRAL / ALERTAS"
        title="Central de Notificações"
        subtitle="O que mudou na operação — com contexto suficiente para agir."
        aside={
          <>
            <Link href="/notificacoes/preferencias" style={{ fontSize: "0.6875rem", color: "var(--sb-secondary)" }}>
              Preferências
            </Link>
            {unreadCount !== null && unreadCount > 0 && <MarkAllButton />}
          </>
        }
      />

      {error !== null && (
        <p role="alert" style={{ color: "var(--sb-danger)" }}>
          Não foi possível carregar: {error.message}
        </p>
      )}

      {/*
        O RECORTE QUE D-269 DEIXOU REGISTRADO COM NÚMERO. Duas pílulas, não o
        botão "Filtrar" do frame: o desenho sugere um menu de filtros que esta
        tela não tem — severidade, tipo e conta continuam fora, porque nenhum
        número os pediu. A contagem no rótulo é a MESMA de "não lida(s)" no
        painel: um dado, um dono.
      */}
      {error === null && (
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: "var(--sb-space-2)", marginBottom: "var(--sb-space-3)" }}
        >
          <FilterPill href={buildNotificationHref(filters, { state: "todas" })} active={!soNaoLidas}>
            Todas
          </FilterPill>
          <FilterPill href={buildNotificationHref(filters, { state: "nao-lidas" })} active={soNaoLidas}>
            {unreadCount === null ? "Não lidas" : `Não lidas (${formatCount(unreadCount)})`}
          </FilterPill>
        </div>
      )}

      {paginaVazia && (
        <p style={{ color: "var(--sb-text-soft)" }}>
          Esta página não existe neste recorte — a lista encolheu ou o link é antigo.{" "}
          <Link href={buildNotificationHref(filters, { page: 1 })}>Voltar à primeira página</Link>.
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
              {/* Com o recorte ligado a janela já diz "de N não lidas" — repetir
                  aqui seria o mesmo número duas vezes na mesma frase. */}
              {!soNaoLidas && unreadCount !== null && ` · ${formatCount(unreadCount)} não lida(s).`}
            </>
          }
        >
          {rows.length === 0 ? (
            <p className="sb-empty">
              {soNaoLidas ? "Nenhuma não lida — a caixa está limpa." : "Nenhuma notificação ainda."}
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {rows.map((row) => (
                <NotificationRow key={row.id} notification={row} />
              ))}
            </ul>
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
        <div style={{ display: "flex", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}>
          {filters.page > 1 && (
            <FilterPill href={buildNotificationHref(filters, { page: filters.page - 1 })} active={false}>
              ← Anterior
            </FilterPill>
          )}
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
