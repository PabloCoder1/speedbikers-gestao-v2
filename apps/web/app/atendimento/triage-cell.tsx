"use client";

import { useState, type ReactNode } from "react";

import { supportInternalStatusLabel, supportPriorityLabel } from "../../lib/labels";
import { assignToMe, changeInternalStatus, changePriority, unassign } from "./actions";

/**
 * Controles de triagem de uma linha da Caixa de Entrada (Fase 7B, D-094) —
 * mesmo padrão de `notificacoes/preferencias/preference-row.tsx`: componente
 * cliente por linha, com estado local de ocupado/erro, uma Server Action por
 * interação.
 *
 * A tela NÃO esconde o controle de quem não pode triar. A autorização real é
 * a RPC (`security definer`, refaz acesso à conta e papel), e esconder o
 * botão daria a impressão de que a interface é a barreira — que é justamente
 * o que `docs/ARCHITECTURE.md` secao 18 proíbe presumir. Quem não tiver
 * permissão recebe a mensagem da própria RPC ao tentar.
 */

const INTERNAL_STATUSES = [
  "NOVO",
  "EM_ATENDIMENTO",
  "AGUARDANDO_CLIENTE",
  "AGUARDANDO_MERCADO_LIVRE",
  "RESOLVIDO",
];

const PRIORITIES = ["NORMAL", "ALTA", "CRITICA"];

const select: React.CSSProperties = {
  border: "1px solid var(--sb-border)",
  borderRadius: "var(--sb-radius)",
  padding: "0.125rem 0.25rem",
  fontSize: "0.75rem",
  maxWidth: "100%",
};

const button: React.CSSProperties = {
  border: "1px solid var(--sb-border)",
  borderRadius: "999px",
  background: "transparent",
  padding: "0.125rem 0.5rem",
  fontSize: "0.75rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export interface TriageCellData {
  id: string;
  internalStatus: string;
  priority: string;
  assigneeId: string | null;
  assigneeName: string | null;
  /** Usuário da sessão — decide entre "Assumir" e "Sou eu". */
  viewerId: string | null;
}

export function TriageCell({ triage }: { triage: TriageCellData }): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<{ ok: boolean; message: string | null }>): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await action();

    if (!result.ok) {
      setError(result.message ?? "Não foi possível salvar a triagem.");
    }

    setBusy(false);
  }

  const mine = triage.assigneeId !== null && triage.assigneeId === triage.viewerId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
      <select
        aria-label="Status interno"
        value={triage.internalStatus}
        disabled={busy}
        style={select}
        onChange={(event) => void run(() => changeInternalStatus(triage.id, event.target.value))}
      >
        {INTERNAL_STATUSES.map((code) => (
          <option key={code} value={code}>
            {supportInternalStatusLabel(code)}
          </option>
        ))}
      </select>

      <select
        aria-label="Prioridade"
        value={triage.priority}
        disabled={busy}
        style={select}
        onChange={(event) => void run(() => changePriority(triage.id, event.target.value))}
      >
        {PRIORITIES.map((code) => (
          <option key={code} value={code}>
            {supportPriorityLabel(code)}
          </option>
        ))}
      </select>

      {triage.assigneeId === null ? (
        <button type="button" disabled={busy} style={button} onClick={() => void run(() => assignToMe(triage.id))}>
          Assumir
        </button>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: "0.375rem", flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>
            {mine ? "Você" : (triage.assigneeName ?? "Outro usuário")}
          </span>
          <button type="button" disabled={busy} style={button} onClick={() => void run(() => unassign(triage.id))}>
            Liberar
          </button>
        </div>
      )}

      {error !== null && (
        <span role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.75rem" }}>
          {error}
        </span>
      )}
    </div>
  );
}
