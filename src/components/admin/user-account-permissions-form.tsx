"use client";

import {
  useActionState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  updateUserAccountPermissions,
  type UpdateAccountPermissionsState,
} from "@/features/admin/actions";
import type { OrganizationAccount } from "@/features/admin/get-organization-users";
import type { AppRole } from "@/features/auth/roles";

type UserAccountPermissionsFormProps = {
  userId: string;
  role: AppRole;
  accounts: OrganizationAccount[];
  selectedAccountIds: string[];
};

const initialState: UpdateAccountPermissionsState = {
  error: null,
  success: null,
};

export function UserAccountPermissionsForm({
  userId,
  role,
  accounts,
  selectedAccountIds,
}: UserAccountPermissionsFormProps) {
  const action =
    updateUserAccountPermissions.bind(
      null,
      userId,
    );

  const [
    state,
    formAction,
    pending,
  ] = useActionState(
    action,
    initialState,
  );

  if (role === "admin") {
    return (
      <p className="text-xs leading-5 text-gray-500">
        Administradores possuem acesso
        automático a todas as contas.
      </p>
    );
  }

  return (
    <form
      action={formAction}
      className="space-y-4"
    >
      <div className="grid gap-2 sm:grid-cols-2">
        {accounts.map(
          (account) => (
            <label
              key={account.id}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-700 transition hover:bg-gray-50"
            >
              <input
                type="checkbox"
                name="mlAccountIds"
                value={account.id}
                defaultChecked={
                  selectedAccountIds.includes(
                    account.id,
                  )
                }
                disabled={pending}
                className="h-4 w-4 rounded border-gray-300"
              />

              <span>
                {account.displayName}
              </span>
            </label>
          ),
        )}
      </div>

      {accounts.length === 0 ? (
        <p className="text-xs text-gray-500">
          Nenhuma conta Mercado Livre
          cadastrada.
        </p>
      ) : null}

      {state.error ? (
        <p
          role="alert"
          className="text-xs text-red-600"
        >
          {state.error}
        </p>
      ) : null}

      {state.success ? (
        <p className="text-xs text-green-600">
          {state.success}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="secondary"
        size="sm"
        disabled={
          pending ||
          accounts.length === 0
        }
      >
        {pending
          ? "Salvando..."
          : "Salvar contas"}
      </Button>
    </form>
  );
}