"use client";

import {
  useActionState,
} from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  createOrganizationUser,
  type CreateUserState,
} from "@/features/admin/actions";
import {
  APP_ROLES,
  ROLE_LABELS,
} from "@/features/auth/roles";

const initialState: CreateUserState = {
  error: null,
  success: null,
  temporaryPassword: null,
};

export function CreateUserForm() {
  const [
    state,
    formAction,
    pending,
  ] = useActionState(
    createOrganizationUser,
    initialState,
  );

  return (
    <form
      action={formAction}
      className="space-y-5"
    >
      <div>
        <label
          htmlFor="fullName"
          className="mb-2 block text-sm font-medium text-gray-800"
        >
          Nome
        </label>

        <Input
          id="fullName"
          name="fullName"
          type="text"
          autoComplete="off"
          required
          minLength={2}
          maxLength={120}
          disabled={pending}
          placeholder="Nome completo"
        />
      </div>

      <div>
        <label
          htmlFor="email"
          className="mb-2 block text-sm font-medium text-gray-800"
        >
          E-mail
        </label>

        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="off"
          required
          disabled={pending}
          placeholder="usuario@empresa.com.br"
        />
      </div>

      <div>
        <label
          htmlFor="role"
          className="mb-2 block text-sm font-medium text-gray-800"
        >
          Papel inicial
        </label>

        <select
          id="role"
          name="role"
          defaultValue="visualizador"
          disabled={pending}
          className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm text-gray-950 outline-none transition focus:border-gray-500 focus:ring-4 focus:ring-gray-100 disabled:cursor-not-allowed disabled:bg-gray-50"
        >
          {APP_ROLES.map(
            (role) => (
              <option
                key={role}
                value={role}
              >
                {
                  ROLE_LABELS[
                    role
                  ]
                }
              </option>
            ),
          )}
        </select>
      </div>

      {state.error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {state.error}
        </div>
      ) : null}

      {state.success ? (
        <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-4">
          <p className="text-sm font-medium text-green-800">
            {state.success}
          </p>

          {state.temporaryPassword ? (
            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-green-700">
                Senha temporária
              </p>

              <code className="mt-2 block overflow-x-auto rounded-lg bg-white px-3 py-3 text-sm text-gray-950 ring-1 ring-inset ring-green-200">
                {
                  state.temporaryPassword
                }
              </code>

              <p className="mt-2 text-xs leading-5 text-green-700">
                Copie esta senha e
                entregue ao usuário por
                um canal seguro. No
                primeiro login ele será
                obrigado a substituí-la.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}

      <Button
        type="submit"
        disabled={pending}
      >
        {pending
          ? "Criando usuário..."
          : "Adicionar usuário"}
      </Button>
    </form>
  );
}