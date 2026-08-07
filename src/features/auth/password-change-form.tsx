"use client";

import { useActionState } from "react";

import {
  changePassword,
  type PasswordChangeState,
} from "@/features/auth/actions";

const initialState: PasswordChangeState = {
  error: null,
};

export function PasswordChangeForm() {
  const [state, formAction, pending] =
    useActionState(
      changePassword,
      initialState,
    );

  return (
    <form
      action={formAction}
      className="mt-8 space-y-5"
    >
      <div>
        <label
          htmlFor="currentPassword"
          className="mb-2 block text-sm font-medium text-gray-800"
        >
          Senha atual
        </label>

        <input
          id="currentPassword"
          name="currentPassword"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
          className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-950 outline-none transition focus:border-gray-500 focus:ring-4 focus:ring-gray-100 disabled:cursor-not-allowed disabled:bg-gray-50"
        />
      </div>

      <div>
        <label
          htmlFor="newPassword"
          className="mb-2 block text-sm font-medium text-gray-800"
        >
          Nova senha
        </label>

        <input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          disabled={pending}
          className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-950 outline-none transition focus:border-gray-500 focus:ring-4 focus:ring-gray-100 disabled:cursor-not-allowed disabled:bg-gray-50"
        />

        <p className="mt-2 text-xs leading-5 text-gray-500">
          Use no mínimo 12 caracteres, incluindo
          maiúscula, minúscula, número e caractere
          especial.
        </p>
      </div>

      <div>
        <label
          htmlFor="confirmPassword"
          className="mb-2 block text-sm font-medium text-gray-800"
        >
          Confirmar nova senha
        </label>

        <input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          disabled={pending}
          className="w-full rounded-xl border border-gray-300 bg-white px-4 py-3 text-gray-950 outline-none transition focus:border-gray-500 focus:ring-4 focus:ring-gray-100 disabled:cursor-not-allowed disabled:bg-gray-50"
        />
      </div>

      {state.error ? (
        <div
          role="alert"
          aria-live="polite"
          className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-700"
        >
          {state.error}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center rounded-xl bg-gray-950 px-4 py-3 text-sm font-semibold text-white transition hover:bg-gray-800 disabled:cursor-not-allowed disabled:bg-gray-400"
      >
        {pending
          ? "Alterando senha..."
          : "Definir nova senha"}
      </button>
    </form>
  );
}