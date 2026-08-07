"use client";

import {
  useActionState,
} from "react";

import { Button } from "@/components/ui/button";
import {
  updateOrganizationUserAccess,
  type UpdateUserAccessState,
} from "@/features/admin/actions";
import {
  APP_ROLES,
  ROLE_LABELS,
  type AppRole,
} from "@/features/auth/roles";

type UserAccessFormProps = {
  userId: string;
  currentUserId: string;
  role: AppRole;
  isActive: boolean;
};

const initialState: UpdateUserAccessState = {
  error: null,
  success: null,
};

export function UserAccessForm({
  userId,
  currentUserId,
  role,
  isActive,
}: UserAccessFormProps) {
  const action =
    updateOrganizationUserAccess.bind(
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

  const isCurrentUser =
    userId === currentUserId;

  if (isCurrentUser) {
    return (
      <p className="text-xs text-gray-500">
        Seu próprio acesso não pode ser
        alterado por esta tela.
      </p>
    );
  }

  return (
    <form
      action={formAction}
      className="min-w-56 space-y-3"
    >
      <div>
        <label
          htmlFor={`role-${userId}`}
          className="sr-only"
        >
          Papel
        </label>

        <select
          id={`role-${userId}`}
          name="role"
          defaultValue={role}
          disabled={pending}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-gray-500 focus:ring-4 focus:ring-gray-100 disabled:cursor-not-allowed disabled:bg-gray-50"
        >
          {APP_ROLES.map(
            (availableRole) => (
              <option
                key={availableRole}
                value={availableRole}
              >
                {
                  ROLE_LABELS[
                    availableRole
                  ]
                }
              </option>
            ),
          )}
        </select>
      </div>

      <div>
        <label
          htmlFor={`active-${userId}`}
          className="sr-only"
        >
          Status
        </label>

        <select
          id={`active-${userId}`}
          name="isActive"
          defaultValue={
            isActive
              ? "true"
              : "false"
          }
          disabled={pending}
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-gray-500 focus:ring-4 focus:ring-gray-100 disabled:cursor-not-allowed disabled:bg-gray-50"
        >
          <option value="true">
            Ativo
          </option>

          <option value="false">
            Bloqueado
          </option>
        </select>
      </div>

      {state.error ? (
        <p
          role="alert"
          className="text-xs leading-5 text-red-600"
        >
          {state.error}
        </p>
      ) : null}

      {state.success ? (
        <p className="text-xs leading-5 text-green-600">
          {state.success}
        </p>
      ) : null}

      <Button
        type="submit"
        variant="secondary"
        size="sm"
        disabled={pending}
        className="w-full"
      >
        {pending
          ? "Salvando..."
          : "Salvar acesso"}
      </Button>
    </form>
  );
}