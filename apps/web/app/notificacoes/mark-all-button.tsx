"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { formatCount } from "../../lib/format";
import { markAllNotificationsRead, type NotificationBulkScope } from "./actions";

/**
 * A ESCRITA EM LOTE, e as duas coisas que ela precisa dizer antes de escrever.
 *
 * **1. Quantas** — a confirmação em dois passos veio do trabalho aberto no
 * PR #53 (`feat/copiloto-notificacoes`) e está preservada aqui inteira, com o
 * mesmo `role="group"` e o mesmo rótulo: um clique que marca treze mil linhas
 * sem perguntar é irreversível pela interface, e o número é o que transforma
 * "marcar todas" numa decisão em vez de num susto.
 *
 * **2. Quais** — a parte nova de D-393. Com severidade, família e conta na
 * URL, "todas" deixou de querer dizer uma coisa só: quem está olhando os
 * 32.783 avisos de quantidade disponível quer limpar AQUELES, e continuar com
 * as críticas por ler. O botão passa a nomear o recorte, e a ação recebe o
 * recorte como parâmetro — nunca o deduz.
 *
 * O caminho de volta é honesto nos dois sentidos: quando há recorte, o rodapé
 * lembra que o resto da Central continua por ler, e o resultado diz quantas
 * linhas foram escritas de fato (a RPC devolve o número).
 */
export function MarkAllButton({
  unreadCount,
  scope,
  recorte,
}: {
  /** Não lidas DENTRO do recorte — o mesmo número que o painel mostra. */
  unreadCount: number;
  scope: NotificationBulkScope;
  /** O recorte por extenso ("toda a Central", "crítico · estoque"). */
  recorte: string;
}): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const temRecorte = scope.severity !== null || scope.family !== null || scope.account !== null;
  const plural = unreadCount !== 1;

  async function handleClick(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await markAllNotificationsRead(scope);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setConfirming(false);

    // A lista é Server Component (não recebe o novo `readAt` por props) —
    // `revalidatePath` na action já invalida o cache, `refresh()` busca a
    // versão nova. Mesmo raciocínio de `router.push` em command-palette.tsx.
    router.refresh();
  }

  if (!confirming) {
    return (
      <button
        className="sb-button"
        type="button"
        onClick={() => {
          setConfirming(true);
        }}
      >
        {temRecorte ? "Marcar este recorte como lido" : "Marcar todas como lidas"}
      </button>
    );
  }

  return (
    <div
      className="sb-notification-mark-all-confirm"
      role="group"
      aria-label="Confirmar leitura de todas as notificações"
    >
      <span>
        Marcar {formatCount(unreadCount)} {plural ? "notificações" : "notificação"} como lida
        {plural ? "s" : ""}
        {temRecorte ? ` em ${recorte}?` : "?"}
      </span>

      {temRecorte && (
        <span className="sb-notification-mark-all-nota">
          O resto da Central continua por ler.
        </span>
      )}

      <button
        className="sb-button sb-button-primary"
        type="button"
        disabled={busy}
        onClick={() => {
          void handleClick();
        }}
      >
        {busy ? "Marcando…" : "Confirmar"}
      </button>

      <button
        className="sb-button"
        type="button"
        disabled={busy}
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
      >
        Cancelar
      </button>

      {error !== null && (
        <p className="sb-notification-mark-all-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
