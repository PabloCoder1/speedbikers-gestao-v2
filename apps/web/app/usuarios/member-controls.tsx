"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import {
  changeMemberRole,
  grantAccountAccess,
  grantShopeeShopAccess,
  revokeAccountAccess,
  revokeShopeeShopAccess,
  type AccessResult,
} from "./actions";

/**
 * Controles de acesso de UM membro (D-175).
 *
 * O componente só aparece para quem é ADMIN, mas isso é conveniência: a
 * autorização de verdade está nas policies, e a proteção contra lockout, no
 * trigger `guard_last_admin`. Se este componente sumisse, ninguém ganharia
 * nem perderia poder.
 */

const ROLES = ["ADMIN", "GESTOR", "ANALISTA", "OPERADOR", "VISUALIZADOR"] as const;

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
        className="sb-input"
        aria-label="Papel do membro"
        value={role}
        disabled={busy}
        onChange={(event) => void change(event.target.value)}
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
  return (
    <AlcanceControls
      rotulo="Contas Mercado Livre permitidas"
      todas="todas as contas (por ser ADMIN)"
      role={role}
      opcoes={accounts}
      concedidos={granted}
      alternar={(accountId, on) => (on ? grantAccountAccess(userId, accountId) : revokeAccountAccess(userId, accountId))}
    />
  );
}

/**
 * As lojas Shopee (D-434): a mesma regra das contas (D-433) — ADMIN alcança
 * todas sem linha; os demais, as concedidas —, então o mesmo controle.
 */
export function ShopeeShopAccessControls({
  userId,
  role,
  lojas,
  concedidas,
}: {
  userId: string;
  role: string;
  lojas: AccountOption[];
  concedidas: string[];
}): ReactNode {
  return (
    <AlcanceControls
      rotulo="Lojas Shopee permitidas"
      todas="todas as lojas (por ser ADMIN)"
      role={role}
      opcoes={lojas}
      concedidos={concedidas}
      alternar={(lojaId, on) => (on ? grantShopeeShopAccess(userId, lojaId) : revokeShopeeShopAccess(userId, lojaId))}
    />
  );
}

/**
 * Os interruptores de alcance — um por conta ou loja. Era o corpo de
 * `AccountAccessControls`; virou peça comum quando a loja Shopee ganhou a
 * mesma regra (D-434), em vez de uma cópia que sairia de sincronia.
 */
function AlcanceControls({
  rotulo,
  todas,
  role,
  opcoes,
  concedidos,
  alternar,
}: {
  /** O nome do grupo para quem ouve a tela — as duas listas moram na mesma gaveta. */
  rotulo: string;
  todas: string;
  role: string;
  opcoes: AccountOption[];
  concedidos: string[];
  alternar: (id: string, on: boolean) => Promise<AccessResult>;
}): ReactNode {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ADMIN alcança tudo pelo papel (`private.has_account_access`,
  // `private.accessible_shopee_shops`), sem linha de concessão. Oferecer os
  // interruptores aqui sugeriria que eles mudam alguma coisa — e não mudam.
  if (role === "ADMIN") {
    return <span style={{ fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>{todas}</span>;
  }

  async function toggle(id: string, on: boolean): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await alternar(id, on);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    router.refresh();
  }

  return (
    <div role="group" aria-label={rotulo} style={{ display: "grid", gap: "0.25rem" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
        {opcoes.map((account) => {
          const on = concedidos.includes(account.id);

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
