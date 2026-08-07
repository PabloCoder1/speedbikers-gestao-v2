import { redirect } from "next/navigation";

import { appConfig } from "@/config/app";
import { logout } from "@/features/auth/actions";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();

  const { data: authData } =
    await supabase.auth.getClaims();

  const claims = authData?.claims;

  if (!claims?.sub) {
    redirect("/login");
  }

  const {
    data: profile,
    error: profileError,
  } = await supabase
    .from("profiles")
    .select("must_change_password")
    .eq("id", claims.sub)
    .single();

  if (profileError || !profile) {
    redirect("/login");
  }

  if (profile.must_change_password) {
    redirect("/trocar-senha");
  }

  const {
    data: membership,
    error: membershipError,
  } = await supabase
    .from("organization_members")
    .select("role, organization_id")
    .eq("user_id", claims.sub)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();

  if (membershipError || !membership) {
    redirect("/login");
  }

  const {
    data: organization,
    error: organizationError,
  } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", membership.organization_id)
    .single();

  if (organizationError || !organization) {
    redirect("/login");
  }

  const email =
    typeof claims.email === "string"
      ? claims.email
      : "Usuário autenticado";

  return (
    <main className="min-h-screen p-6 sm:p-10">
      <div className="mx-auto max-w-5xl">
        <header className="flex flex-col gap-5 rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium text-gray-500">
              {organization.name}
            </p>

            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-gray-950">
              {appConfig.name}
            </h1>
          </div>

          <form action={logout}>
            <button
              type="submit"
              className="rounded-xl border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-800 transition hover:bg-gray-50"
            >
              Sair
            </button>
          </form>
        </header>

        <section className="mt-6 grid gap-6 sm:grid-cols-2">
          <article className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-gray-500">
              Usuário autenticado
            </p>

            <p className="mt-2 font-medium text-gray-950">
              {email}
            </p>
          </article>

          <article className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-gray-500">
              Papel na organização
            </p>

            <p className="mt-2 font-medium uppercase text-gray-950">
              {membership.role}
            </p>
          </article>
        </section>

        <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-sm font-medium text-green-700">
            Autenticação funcionando
          </span>

          <h2 className="mt-5 text-xl font-semibold text-gray-950">
            Fundação protegida com sucesso.
          </h2>

          <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-600">
            A sessão, o vínculo com a organização e as
            políticas de acesso estão sendo validados antes
            de disponibilizar os dados da aplicação.
          </p>
        </section>
      </div>
    </main>
  );
}