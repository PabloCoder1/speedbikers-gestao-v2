"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";

import { Icone, type NomeDoIcone } from "../../components/icons";
import { StatusPill } from "../../components/status-pill";
import { tomDeStatus, type Tom } from "../../components/tone";
import { formatDateTime } from "../../lib/format";
import { eventTypeLabel, severityLabel, statusTone } from "../../lib/labels";
import { entityHref, entityLabel, formatEventDiff } from "../../lib/event-format";
import { markNotificationRead } from "./actions";

/**
 * Uma notificação na Central (Fase 7, item 4) — mesmo padrão de
 * `apps/web/app/acoes/action-card.tsx`: componente cliente por linha (estado
 * local de lida/ocupado/erro), Server Action por clique, sem RPC.
 *
 * Leitura de `before`/`after`/entidade compartilhada com os toasts em tempo
 * real (`lib/event-format.ts`, item 5) — mesmo evento, mesma leitura.
 *
 * ## O que D-393 mudou na LINHA, e por quê
 *
 * A lista tinha **uma** pista de severidade: a pílula de texto. Numa parede de
 * cem linhas em que 25,4% da base é crítica e 60,4% é o mesmo aviso de rotina
 * (`listing.available_quantity.changed`, medido no Dev), ler cem pílulas é o
 * trabalho que a tela deveria poupar. Agora a severidade também é **a cor do
 * fio à esquerda** e o tipo é um **ícone de família** — duas pistas que o olho
 * pega sem ler, com a pílula intacta para quem lê e para o leitor de tela.
 *
 * **A cor nunca anda sozinha** (mesma regra de `status-pill.tsx`): o fio e o
 * ícone repetem o que a pílula já diz em palavras, e o `aria-label` do `<li>`
 * carrega estado e tipo. Nada aqui é informação que só existe em cor.
 *
 * **Aparência saiu do `style` e foi para `globals.css`**, endereçada por
 * `data-state`/`data-tom`. Era `style` inline com `!important` do outro lado
 * para o hover vencer; com atributo de dado, a folha manda sozinha — e cem
 * linhas param de carregar cem objetos de estilo para o cliente.
 */

export interface NotificationRowData {
  id: string;
  createdAt: string;
  readAt: string | null;
  eventType: string;
  entityType: string;
  entityId: string;
  severity: string;
  occurredAt: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  accountLabel: string | null;
  /**
   * "há 3 h" do FATO, já calculado NO SERVIDOR.
   *
   * Não é preciosismo: `formatAge` lê o relógio, e um componente cliente que o
   * chamasse no render devolveria no navegador um texto diferente do que o
   * servidor mandou — o descasamento de hidratação que o React acusa em
   * vermelho. O instante absoluto continua no `<time>` ao lado; isto é só o
   * atalho de leitura.
   */
  idade: string | null;
}

/**
 * O ÍCONE POR FAMÍLIA — o prefixo antes do primeiro ponto do `event_type`.
 *
 * Fica aqui, e não em `lib/`, porque tem **um** consumidor. A regra de
 * contenção do projeto (`docs/ARCHITECTURE.md` §1) é que algo vira peça
 * compartilhada quando o segundo aparece; os toasts são o candidato natural, e
 * o dia em que eles quiserem o mesmo ícone é o dia de mover isto para
 * `lib/event-format.ts`, junto do resto da leitura de evento.
 *
 * Família desconhecida cai em `pulso` — genérico de propósito: inventar um
 * ícone específico para um evento que ninguém catalogou seria afirmar sobre
 * ele mais do que se sabe.
 */
function iconeDaFamilia(eventType: string): NomeDoIcone {
  const familia = eventType.split(".")[0];

  switch (familia) {
    case "listing":
      return "etiqueta";
    case "stock":
      return "caixa";
    case "order":
      return "carrinho";
    case "support":
      return "mensagem";
    case "sync":
      return "sincronizar";
    case "ai":
      return "lampada";
    default:
      return "pulso";
  }
}

export function NotificationRow({ notification }: { notification: NotificationRowData }): ReactNode {
  const [readAt, setReadAt] = useState(notification.readAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isUnread = readAt === null;
  const diff = formatEventDiff(notification.eventType, notification.before, notification.after);
  const href = entityHref(notification.entityType, notification.entityId);
  const rotulo = eventTypeLabel(notification.eventType);
  const alvo = `${entityLabel(notification.entityType)} ${notification.entityId}`;

  /*
    O MESMO tom da pílula, pela MESMA função. `tone.ts` é o dono único dos
    cinco tons desde D-246, e o fio à esquerda não pode ser a sexta cópia do
    mapa — se um dia "importante" deixar de ser âmbar, as duas mudam juntas.
  */
  const tom: Tom = tomDeStatus(statusTone(notification.severity));

  async function handleMarkRead(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await markNotificationRead(notification.id);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setReadAt(new Date().toISOString());
  }

  return (
    <li
      className="sb-notification-row"
      data-state={isUnread ? "unread" : "read"}
      data-tom={tom}
      aria-label={`${isUnread ? "Não lida" : "Lida"}: ${rotulo}`}
    >
      <span className="sb-notification-icon" aria-hidden="true">
        <Icone nome={iconeDaFamilia(notification.eventType)} tamanho={16} />
      </span>

      <div className="sb-notification-content">
        <div className="sb-notification-head">
          <StatusPill code={notification.severity} label={severityLabel(notification.severity)} />

          <span className="sb-notification-title">{rotulo}</span>

          {notification.accountLabel !== null && (
            <span className="sb-notification-account">{notification.accountLabel}</span>
          )}
        </div>

        <p className="sb-notification-body">
          {href !== null ? (
            <Link className="sb-notification-target" href={href}>
              {alvo}
            </Link>
          ) : (
            <span className="sb-notification-target sb-notification-target-mudo">{alvo}</span>
          )}

          {diff !== null && <span className="sb-notification-diff">{diff}</span>}
        </p>

        <div className="sb-notification-meta">
          {/* O instante do FATO, não o do aviso — a mesma escolha de `/acoes`
              (a idade do fato, D-355). O cabeçalho do grupo acima diz o dia em
              que a notificação CHEGOU, e os dois podem não ser o mesmo dia:
              medido, 541 das 54.306 têm o fato num dia e a chegada em outro. */}
          <time dateTime={notification.occurredAt}>{formatDateTime(notification.occurredAt)}</time>
          {notification.idade !== null && <span>{notification.idade}</span>}
          {!isUnread && <span className="sb-notification-read-state">Lida</span>}
        </div>

        {error !== null && (
          <p role="alert" className="sb-notification-error">
            {error}
          </p>
        )}
      </div>

      {isUnread && (
        <button
          className="sb-button sb-notification-mark"
          type="button"
          disabled={busy}
          /* O nome acessível COMEÇA pelo texto visível (WCAG 2.5.3) e continua
             com o que distingue este botão dos outros noventa e nove da
             página — sem isso, um leitor de tela anuncia cem vezes a mesma
             coisa e nenhuma delas diz qual. */
          aria-label={`Marcar como lida: ${rotulo} — ${alvo}`}
          onClick={() => {
            void handleMarkRead();
          }}
        >
          {busy ? "Marcando…" : "Marcar como lida"}
        </button>
      )}
    </li>
  );
}
