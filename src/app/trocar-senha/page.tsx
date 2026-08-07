import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { PasswordChangeForm } from "@/features/auth/password-change-form";

export const metadata: Metadata = {
  title: "Definir nova senha",
};

export default async function ChangePasswordPage() {
  const supabase = await createClient();

  const { data: authData } =
    await supabase.auth.getClaims();

  const claims = authData?.claims;

  if (!claims?.sub) {
    redirect("/login");
  }

  const {
    data: profile,
    error,
  } = await supabase
    .from("profiles")
    .select("must_change_password")
    .eq("id", claims.sub)
    .single();

  if (error || !profile) {
    redirect("/login");
  }

  if (!profile.must_change_password) {
    redirect("/");
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <section className="w-full max-w-md">
        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <span className="inline-flex rounded-full bg-amber-50 px-3 py-1 text-sm font-medium text-amber-700">
            Primeiro acesso
          </span>

          <h1 className="mt-6 text-2xl font-semibold tracking-tight text-gray-950">
            Defina sua senha permanente
          </h1>

          <p className="mt-3 text-sm leading-6 text-gray-600">
            A senha utilizada para acessar o sistema
            inicialmente é temporária. Defina agora uma
            senha pessoal antes de continuar.
          </p>

          <PasswordChangeForm />
        </div>
      </section>
    </main>
  );
}