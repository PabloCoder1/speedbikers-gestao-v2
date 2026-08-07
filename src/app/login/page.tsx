import type { Metadata } from "next";

import { appConfig } from "@/config/app";
import { LoginForm } from "@/features/auth/login-form";

export const metadata: Metadata = {
  title: "Entrar",
};

type LoginPageProps = {
  searchParams: Promise<{
    passwordChanged?: string;
  }>;
};

export default async function LoginPage({
  searchParams,
}: LoginPageProps) {
  const params = await searchParams;

  const passwordChanged =
    params.passwordChanged === "1";

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <section className="w-full max-w-md">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <div className="mb-8">
            <div className="mb-6 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gray-950 text-lg font-bold text-white">
              SB
            </div>

            <h1 className="text-2xl font-semibold tracking-tight text-gray-950">
              Acessar o sistema
            </h1>

            <p className="mt-2 text-sm leading-6 text-gray-600">
              Entre com seu acesso interno para continuar
              no {appConfig.name}.
            </p>
          </div>

          {passwordChanged ? (
            <div className="mb-6 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm leading-6 text-green-700">
              Senha alterada com sucesso. Entre novamente
              utilizando sua nova senha.
            </div>
          ) : null}

          <LoginForm />
        </div>

        <p className="mt-5 text-center text-xs leading-5 text-gray-500">
          Acesso restrito a usuários autorizados.
        </p>
      </section>
    </main>
  );
}