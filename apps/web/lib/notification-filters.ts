/**
 * Filtros da Central de Notificações (D-290, ampliados em D-393) — mesma
 * divisão de D-141/D-172/D-289: a MECÂNICA (href, página, resumo da janela)
 * vem de `./filters`; aqui mora só o vocabulário desta tela.
 *
 * **D-290 tinha DUAS dimensões, e a recusa de D-269 era honesta na época:**
 * severidade, tipo e conta ficaram fora porque "nenhum número os pediu". Os
 * números chegaram, medidos no Dev em 2026-09-23 contra o usuário com a caixa
 * cheia (54.306 notificações, 544 páginas de 100):
 *
 * | dimensão | o que a medição mostrou |
 * |---|---|
 * | severidade | **13.810 críticas** (25,4%) e 5.755 importantes, espalhadas pelas 544 páginas — para chegar às críticas de 25/08 era preciso paginar até o fim |
 * | tipo | **`listing.available_quantity.changed` sozinho é 32.783 (60,4%)** — três em cada cinco linhas da Central são o mesmo aviso de rotina |
 * | conta | 11.011 / 10.693 / 10.087 / 9.726 nas quatro contas, mais 12.789 sem conta (evento organizacional) — particiona de verdade |
 *
 * O que continua FORA, e agora também com número:
 *
 * - **período** — o Dev inteiro cabe em 21 dias (24/08 a 14/09, e nada depois
 *   porque o ambiente está pausado desde D-350). Um seletor de período que
 *   devolve zero em "últimos 7 dias" se lê como tela quebrada. Fica registrado
 *   como candidata, como D-269 fez com "não lidas";
 * - **busca por entidade** — "o que aconteceu com o MLB…" já tem dono: o
 *   Dashboard do Anúncio e o diagnóstico do SKU leem `domain_events` pela
 *   entidade. Uma busca aqui seria o segundo dono da mesma pergunta (D-224);
 * - **origem (automática × manual)** — `domain_events.source` tem DOIS valores
 *   nesta base (`sync` 41.517 e `system` 12.789) e nenhum evento de usuário.
 *   O filtro existiria com um lado sempre vazio. `docs/NOTIFICATIONS.md` §7
 *   pede a distinção "quando a origem puder ser identificada"; hoje ela é
 *   sempre automática.
 */

import { buildFilterHref, resolvePageParam, summarizePagedWindow } from "./filters";
import { severityLabel } from "./labels";

/**
 * Cem por página — o mesmo teto que a tela já carregava antes de paginar
 * (D-183/D-269/D-290).
 *
 * **Sem seletor de tamanho** (`PAGE_SIZES` de D-315), de propósito: numa lista
 * cujo problema medido é ACHAR, 300 linhas por página é mais do mesmo, e cada
 * linha aqui é um componente cliente. Quem responde "não acho nada" são os
 * recortes, não o tamanho da página.
 */
export const PAGE_SIZE = 100;

/** `todas` é o default, e default fica FORA da URL. */
export type NotificationState = "todas" | "nao-lidas";

/**
 * `domain_events.severity` — os três níveis fixos de `docs/NOTIFICATIONS.md`
 * §2, na ordem em que interessam a quem tria (o pior primeiro).
 *
 * Lista FECHADA: a URL é entrada de terceiro, e `?severidade=urgentissimo` tem
 * de virar "todas", nunca um filtro que devolve vazio para sempre.
 */
export const NOTIFICATION_SEVERITIES = ["critico", "importante", "informativo"] as const;

export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/**
 * A FAMÍLIA do evento — o prefixo antes do primeiro ponto em
 * `domain_events.event_type`.
 *
 * **Por que família e não o tipo cru.** O catálogo de `EVENT_TYPE`
 * (`lib/labels.ts`) tem 24 entradas; um menu com 24 opções troca o problema de
 * achar na lista pelo problema de achar no menu. As seis famílias cobrem as
 * treze que a base do Dev realmente produz e respondem a pergunta que se faz
 * em voz alta — "mostre o que é de estoque", "o que é de pedido".
 *
 * `sync` e `ai` têm zero linha no Dev e entram assim mesmo: elas estão no
 * catálogo, e uma opção que hoje devolve vazio é diferente de uma opção que
 * não existe — a primeira responde "não houve", a segunda não responde nada.
 */
export const NOTIFICATION_FAMILIES = ["listing", "stock", "order", "support", "sync", "ai"] as const;

export type NotificationFamily = (typeof NOTIFICATION_FAMILIES)[number];

const FAMILY_LABEL: Record<NotificationFamily, string> = {
  listing: "Anúncio",
  stock: "Estoque",
  order: "Pedido",
  support: "Atendimento",
  sync: "Sincronização",
  ai: "Copiloto e IA",
};

export function notificationFamilyLabel(family: NotificationFamily): string {
  return FAMILY_LABEL[family];
}

/**
 * O PREFIXO da família — `listing.` — que é o que a RPC
 * `mark_notifications_read` recebe: ela mesma acrescenta o `%`, para o padrão
 * ficar preso à esquerda dentro do SQL e nunca chegar montado de fora.
 */
export function notificationFamilyPrefix(family: NotificationFamily): string {
  return `${family}.`;
}

/**
 * O padrão que o PostgREST recebe (`like`). O ponto é literal — `like` do
 * Postgres não tem curinga de um caractere que o atrapalhe — e o `%` final é o
 * que faz `listing.` alcançar `listing.price.changed`.
 */
export function notificationFamilyPattern(family: NotificationFamily): string {
  return `${notificationFamilyPrefix(family)}%`;
}

export interface NotificationFilters {
  state: NotificationState;
  severity: NotificationSeverity | null;
  family: NotificationFamily | null;
  /** `ml_accounts.id`. Validado contra as contas visíveis, não contra formato. */
  account: string | null;
  page: number;
}

function readParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;

  return value ?? null;
}

function resolveFromList<T extends string>(raw: unknown, lista: readonly T[]): T | null {
  if (typeof raw !== "string") return null;

  return (lista as readonly string[]).includes(raw) ? (raw as T) : null;
}

/**
 * Os dois validadores, exportados porque a **Server Action** também precisa
 * deles — e ali a diferença entre "não reconheci" e "sem recorte" é grave.
 *
 * Na tela, valor fora da lista cai em "todas" e o pior que acontece é ver mais
 * linhas do que se pediu. Na escrita em lote, o mesmo silêncio transformaria
 * "marcar as críticas como lidas" em "marcar TODAS" — por isso `actions.ts`
 * recusa em vez de alargar, e por isso os dois leem a mesma lista.
 */
export function resolveNotificationSeverity(raw: unknown): NotificationSeverity | null {
  return resolveFromList(raw, NOTIFICATION_SEVERITIES);
}

export function resolveNotificationFamily(raw: unknown): NotificationFamily | null {
  return resolveFromList(raw, NOTIFICATION_FAMILIES);
}

/**
 * `conta` é o único sem lista fechada aqui, e é de propósito: as contas moram
 * no banco, e conferi-las antes de montar a consulta poria uma leitura na
 * frente da outra — a fila que `check:waterfalls` existe para reprovar
 * (D-195/D-197).
 *
 * O que sobra é **formato**, e basta: um UUID de conta alheia não devolve
 * linha nenhuma porque a policy `domain_events_select_permitted` já recorta
 * por permissão de conta, e a página resolve o RÓTULO depois, contra as contas
 * que leu no mesmo `Promise.all`. Conta desconhecida cai no estado vazio, que
 * é a resposta certa.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveNotificationFilters(
  query: Record<string, string | string[] | undefined>,
): NotificationFilters {
  const conta = readParam(query.conta);

  return {
    state: readParam(query.estado) === "nao-lidas" ? "nao-lidas" : "todas",
    severity: resolveNotificationSeverity(readParam(query.severidade)),
    family: resolveNotificationFamily(readParam(query.tipo)),
    account: conta !== null && UUID.test(conta) ? conta : null,
    page: resolvePageParam(query.pagina),
  };
}

/**
 * Preserva as demais dimensões ao trocar uma, e **trocar o recorte volta à
 * página 1** (D-138/D-139): ir de "todas" na página 7 para "não lidas"
 * mantendo o offset mostraria uma página vazia que se lê como "não há não
 * lidas".
 *
 * Quem quer a página preservada pede por escrito (`{ page: filtros.page }`).
 */
export function buildNotificationHref(
  current: NotificationFilters,
  override: Partial<NotificationFilters>,
): string {
  const next = { ...current, ...override };

  return buildFilterHref(
    "/notificacoes",
    {
      estado: next.state === "todas" ? null : next.state,
      severidade: next.severity,
      tipo: next.family,
      conta: next.account,
    },
    override.page === undefined ? 1 : next.page,
  );
}

/** Quantas dimensões estão recortando — o "Limpar N filtros" da toolbar. */
export function countNotificationFilters(filters: NotificationFilters): number {
  return [
    filters.state === "todas" ? null : filters.state,
    filters.severity,
    filters.family,
    filters.account,
  ].filter((valor) => valor !== null).length;
}

/**
 * O recorte por extenso, para o estado vazio e para o rótulo da ação em lote.
 *
 * **Existe para que a escrita em lote nunca seja uma surpresa.** "Marcar todas
 * como lidas" com um recorte ligado é outra ação, e o botão tem de dizer qual
 * — a mesma lição de D-183, onde o botão sumia sem dizer que milhares
 * continuavam por ler.
 */
export function describeNotificationRecorte(
  filters: NotificationFilters,
  accountLabel: string | null,
): string {
  const partes = [
    filters.severity === null ? null : severityLabel(filters.severity).toLowerCase(),
    filters.family === null ? null : notificationFamilyLabel(filters.family).toLowerCase(),
    accountLabel,
  ].filter((parte): parte is string => parte !== null);

  return partes.length === 0 ? "toda a Central" : partes.join(" · ");
}

export { summarizePagedWindow };
