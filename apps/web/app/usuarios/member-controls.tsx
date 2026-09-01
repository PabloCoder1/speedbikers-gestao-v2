"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { changeMemberRole, grantAccountAccess, revokeAccountAccess } from "./actions";

/**
 * Controles de acesso de UM membro (D-175).
 *
 * O componente só aparece para quem é ADMIN, mas isso é conveniência: a
 * autorização de verdade está nas policies, e a proteção contra lockout, no
 * trigger `guard_last_admin`. Se este componente sumisse, ninguém ganharia
 * nem perderia poder.
 */

const ROLES = ["ADMIN", "GESTOR", "ANALISTA", "OPERADOR", "VISUALIZADOR"] as const;

const selectStyle: React.CSSProperties = {
  padding: "0.25rem 0.5rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  fontSize: "0.8125rem",
};

export interface AccountOption {
  id: string;
  label: string;
}

export function RoleSelect({
  organizationId,
  userId,
  role,
}: {
  organizationId: string;
  userId: string;
  role: string;
}): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string): Promise<void> {
    if (next === role) return;

    setBusy(true);
    setError(null);

    const result = await changeMemberRole(organizationId, userId, next);

    setBusy(false);

    if (!result.ok) {
      // A recusa do banco é o que o usuário precisa ler — inclusive a do
      // último ADMIN, que explica o que fazer antes de tentar de novo.
      setError(result.message);

      return;
    }

    router.refresh();
  }

  return (
    <div style={{ display: "grid", gap: "0.25rem" }}>
      <select
        aria-label="Papel do membro"
        value={role}
        disabled={busy}
        onChange={(event) => void change(event.target.value)}
        style={selectStyle}
      >
        {ROLES.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {error !== null && (
        <span role="alert" style={{ fontSize: "0.75rem", color: "var(--sb-danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}

export function AccountAccessControls({
  userId,
  role,
  accounts,
  granted,
}: {
  userId: string;
  role: string;
  accounts: AccountOption[];
  granted: string[];
}): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ADMIN alcança todas as contas por `private.has_account_access`, sem linha
  // em `user_account_permissions`. Oferecer os interruptores aqui sugeriria
  // que eles mudam alguma coisa — e não mudam.
  if (role === "ADMIN") {
    return (
      <span style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
        todas as contas (por ser ADMIN)
      </span>
    );
  }

  async function toggle(accountId: string, on: boolean): Promise<void> {
    setBusy(true);
    setError(null);

    const result = on
      ? await grantAccountAccess(userId, accountId)
      : await revokeAccountAccess(userId, accountId);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    router.refresh();
  }

  return (
    <div style={{ display: "grid", gap: "0.25rem" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
        {accounts.map((account) => {
          const on = granted.includes(account.id);

          return (
            <label key={account.id} style={{ fontSize: "0.8125rem", display: "flex", gap: "0.25rem" }}>
              <input
                type="checkbox"
                checked={on}
                disabled={busy}
                onChange={(event) => void toggle(account.id, event.target.checked)}
              />
              {account.label}
            </label>
          );
        })}
      </div>
      {error !== null && (
        <span role="alert" style={{ fontSize: "0.75rem", color: "var(--sb-danger)" }}>
          {error}
        </span>
      )}
    </div>
  );
}
