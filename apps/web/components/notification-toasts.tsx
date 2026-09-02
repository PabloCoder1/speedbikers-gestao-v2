"use client";

import type { Database } from "@sb/db";
import type { RealtimePostgresInsertPayload } from "@supabase/supabase-js";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { entityHref, entityLabel, formatEventDiff } from "../lib/event-format";
import { eventTypeLabel, severityLabel } from "../lib/labels";
import { shouldNotify, type NotificationPreferenceRule } from "../lib/notification-preferences";
import { createClient } from "../lib/supabase/browser";

/**
 * Toasts em tempo real, canto inferior direito (Fase 7, item 5, D-075,
 * `docs/NOTIFICATIONS.md` secoes 3/4). Transporte confirmado ao vivo contra
 * a documentação oficial da Supabase antes de implementar — a secao 4
 * marcava isso como pendência explícita ("API mudou em ciclos recentes,
 * não será assumida de memória"): `postgres_changes` autoriza CADA evento
 * contra a RLS da tabela de origem, por assinante, sem policy nova — a
 * mesma `notification_recipients_select_own` (D-073) já usada na Central.
 * Único passo de infraestrutura: a tabela entrar na publication
 * `supabase_realtime` (migration `20260824200000`).
 *
 * O payload do INSERT só tem `notification_id`/`user_id`/`read_at` — o
 * resumo (tipo de evento, conta, diff) exige uma busca curta por
 * notificação, RLS já concede acesso: a própria linha nova de
 * `notification_recipients` É a prova de que este usuário pode lê-la.
 *
 * Agrupamento por `(event_type, ml_account_id)` numa janela de 5 minutos
 * (secao 3, mesmo exemplo do texto: "trinta alterações de preço... viram
 * um toast com contador"). `groupsRef` é a fonte da verdade do
 * agrupamento — sobrevive ao toast sumir da tela, só expira depois de
 * `WINDOW_MS` desde o PRIMEIRO evento do grupo. `toasts` (estado) é só o
 * que está visível agora: cada toast fecha sozinho `DISMISS_MS` depois do
 * ÚLTIMO evento do grupo (reabre/atualiza se um evento novo chegar depois
 * de já ter sumido), ou fecha manualmente pelo "×" sem afetar o contador.
 *
 * `notification_preferences` (Fase 7, item 6, D-076) é consultada AQUI,
 * client-side, via `shouldNotify` (`lib/notification-preferences.ts`) — e
 * só aqui. A linha em `notification_recipients` (e portanto a visibilidade
 * na Central de Notificações) NUNCA é filtrada por preferência desde a
 * correção de D-076 (`docs/NOTIFICATIONS.md` secao 1: "o registro na
 * Central continua existindo para consulta, só o alerta em tempo real é
 * que respeita a preferência"). Preferências carregadas uma vez por
 * montagem — tolerável não recarregar se o usuário mudar a preferência
 * numa aba enquanto esta está aberta, mesma tolerância já aceita pro resto
 * do Realtime não ser fonte de verdade.
 */

type NotificationRecipientRow = Database["public"]["Tables"]["notification_recipients"]["Row"];

interface ToastNotificationRow {
  domain_events: {
    event_type: string;
    entity_type: string;
    entity_id: string;
    severity: string;
    ml_account_id: string | null;
    before: unknown;
    after: unknown;
    ml_accounts: { label: string } | null;
  } | null;
}

interface ToastGroup {
  key: string;
  eventType: string;
  entityType: string;
  entityId: string;
  severity: string;
  accountLabel: string | null;
  count: number;
  diff: string | null;
  firstEventAt: number;
}

const WINDOW_MS = 5 * 60 * 1000;
const DISMISS_MS = 8_000;

const SEVERITY_BORDER: Record<string, string> = {
  critico: "var(--sb-danger)",
  importante: "var(--sb-accent-ink)",
  informativo: "var(--sb-border)",
};

export function NotificationToasts({
  userId,
  preferenceRules,
}: {
  userId: string | null;
  /**
   * Preferências vindas do SERVIDOR, por prop (D-197).
   *
   * Antes este componente as lia do navegador dentro do `setup()`, em toda
   * página autenticada — o `Shell` o renderiza em todas elas. Era uma ida ao
   * banco a mais por carregamento, saindo do cliente, e ela ficava **na
   * frente** da assinatura de Realtime: o `.subscribe()` só acontecia depois
   * que a leitura voltasse.
   *
   * O `Shell` já faz um `Promise.all` de leituras do cabeçalho; esta entrou
   * nele e não custa latência nenhuma a mais. O componente deixou de ser o
   * dono da busca e passou a ser o dono do comportamento, que é o certo.
   */
  preferenceRules: NotificationPreferenceRule[];
}): ReactNode {
  const [toasts, setToasts] = useState<ToastGroup[]>([]);
  const groups = useRef(new Map<string, ToastGroup>());
  const dismissTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (userId === null) return;

    // Reatribuído a uma const própria: `userId` (parâmetro) não narrowa de
    // forma confiável dentro das funções aninhadas abaixo.
    const uid = userId;
    const supabase = createClient();
    let cancelled = false;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    function scheduleDismiss(key: string): void {
      const existingTimer = dismissTimers.current.get(key);
      if (existingTimer !== undefined) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        dismissTimers.current.delete(key);
        setToasts((current) => current.filter((toast) => toast.key !== key));
      }, DISMISS_MS);

      dismissTimers.current.set(key, timer);
    }

    async function handleInsert(payload: RealtimePostgresInsertPayload<NotificationRecipientRow>): Promise<void> {
      const { data } = await supabase
        .from("notifications")
        .select(
          "domain_events(event_type, entity_type, entity_id, severity, ml_account_id, before, after, ml_accounts(label))",
        )
        .eq("id", payload.new.notification_id)
        .maybeSingle();

      const event = (data as ToastNotificationRow | null)?.domain_events ?? null;

      if (event === null) return;

      // O recipient já existe (é por isso que este evento chegou aqui) —
      // a preferência só decide se aparece como toast, nunca se some da
      // Central de Notificações.
      if (!shouldNotify(preferenceRules, { eventType: event.event_type, mlAccountId: event.ml_account_id, severity: event.severity })) {
        return;
      }

      const key = `${event.event_type}:${event.ml_account_id ?? "org"}`;
      const now = Date.now();
      const previous = groups.current.get(key);
      const withinWindow = previous !== undefined && now - previous.firstEventAt < WINDOW_MS;
      const carriedOver = withinWindow ? previous : undefined;

      const group: ToastGroup = {
        key,
        eventType: event.event_type,
        entityType: event.entity_type,
        entityId: event.entity_id,
        severity: event.severity,
        accountLabel: event.ml_accounts?.label ?? null,
        count: (carriedOver?.count ?? 0) + 1,
        diff: formatEventDiff(
          event.event_type,
          event.before as Record<string, unknown> | null,
          event.after as Record<string, unknown> | null,
        ),
        firstEventAt: carriedOver?.firstEventAt ?? now,
      };

      groups.current.set(key, group);

      setToasts((current) => {
        const index = current.findIndex((toast) => toast.key === key);

        if (index === -1) return [...current, group];

        const next = [...current];
        next[index] = group;

        return next;
      });

      scheduleDismiss(key);
    }

    function setup(): void {
      if (cancelled) return;

      channel = supabase
        .channel(`notification-toasts:${uid}`)
        .on<NotificationRecipientRow>(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "notification_recipients",
            filter: `user_id=eq.${uid}`,
          },
          (payload) => {
            void handleInsert(payload);
          },
        )
        .subscribe();
    }

    setup();

    return () => {
      cancelled = true;
      if (channel !== null) void supabase.removeChannel(channel);

      for (const timer of dismissTimers.current.values()) clearTimeout(timer);
      dismissTimers.current.clear();
    };
  }, [userId, preferenceRules]);

  function dismiss(key: string): void {
    const timer = dismissTimers.current.get(key);
    if (timer !== undefined) clearTimeout(timer);
    dismissTimers.current.delete(key);

    setToasts((current) => current.filter((toast) => toast.key !== key));
  }

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        right: "var(--sb-space-4)",
        bottom: "var(--sb-space-4)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--sb-space-2)",
        zIndex: 200,
        width: "22rem",
        maxWidth: "calc(100vw - 2 * var(--sb-space-4))",
      }}
    >
      {toasts.map((toast) => {
        const href = toast.count === 1 ? (entityHref(toast.entityType, toast.entityId) ?? "/notificacoes") : "/notificacoes";

        return (
          <div
            key={toast.key}
            style={{
              background: "var(--sb-surface)",
              border: "1px solid var(--sb-border)",
              borderLeft: `3px solid ${SEVERITY_BORDER[toast.severity] ?? "var(--sb-border)"}`,
              borderRadius: "var(--sb-radius)",
              boxShadow: "0 8px 20px rgba(0,0,0,0.15)",
              padding: "var(--sb-space-3)",
              display: "flex",
              gap: "var(--sb-space-2)",
              alignItems: "flex-start",
            }}
          >
            <Link href={href} style={{ flex: 1, minWidth: 0, textDecoration: "none", color: "inherit" }}>
              <div
                style={{
                  fontSize: "0.6875rem",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: "var(--sb-text-soft)",
                }}
              >
                {severityLabel(toast.severity)}
              </div>

              <div style={{ fontSize: "0.875rem", fontWeight: 600, marginTop: "0.125rem" }}>
                {toast.count > 1 ? `${String(toast.count)}× ` : ""}
                {eventTypeLabel(toast.eventType)}
              </div>

              {toast.accountLabel !== null && (
                <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", marginTop: "0.125rem" }}>
                  {toast.accountLabel} — {entityLabel(toast.entityType)} {toast.entityId}
                </div>
              )}

              {toast.diff !== null && <div style={{ fontSize: "0.8125rem", marginTop: "0.25rem" }}>{toast.diff}</div>}
            </Link>

            <button
              type="button"
              onClick={() => {
                dismiss(toast.key);
              }}
              aria-label="Fechar notificação"
              style={{
                border: "none",
                background: "transparent",
                cursor: "pointer",
                color: "var(--sb-text-soft)",
                fontSize: "1rem",
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
