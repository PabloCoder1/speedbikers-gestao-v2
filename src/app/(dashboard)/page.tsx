import { getCurrentAccess } from "@/features/auth/get-current-access";

export default async function DashboardPage() {
  const access =
    await getCurrentAccess();

  if (!access) {
    return null;
  }

  return (
    <div className="px-6 py-8 sm:px-8 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header>
          <p className="text-sm font-medium text-gray-500">
            {access.organizationName}
          </p>

          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-gray-950">
            Visão Geral
          </h1>

          <p className="mt-3 max-w-2xl text-sm leading-6 text-gray-600">
            Esta será a visão consolidada
            da operação do Speed Bikers
            Gestão V2.
          </p>
        </header>

        <section className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          <article className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-gray-500">
              Autenticação
            </p>

            <p className="mt-3 text-2xl font-semibold text-gray-950">
              Ativa
            </p>

            <p className="mt-2 text-sm text-gray-500">
              Sessão protegida pelo Supabase.
            </p>
          </article>

          <article className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-gray-500">
              Organização
            </p>

            <p className="mt-3 text-2xl font-semibold text-gray-950">
              {access.organizationName}
            </p>

            <p className="mt-2 text-sm text-gray-500">
              Contexto organizacional ativo.
            </p>
          </article>

          <article className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-gray-500">
              Papel
            </p>

            <p className="mt-3 text-2xl font-semibold uppercase text-gray-950">
              {access.role}
            </p>

            <p className="mt-2 text-sm text-gray-500">
              Permissão atual do usuário.
            </p>
          </article>

          <article className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
            <p className="text-sm font-medium text-gray-500">
              Infraestrutura
            </p>

            <p className="mt-3 text-2xl font-semibold text-gray-950">
              Online
            </p>

            <p className="mt-2 text-sm text-gray-500">
              Fundação pronta para os módulos.
            </p>
          </article>
        </section>

        <section className="mt-6 rounded-2xl border border-gray-200 bg-white p-7 shadow-sm">
          <span className="inline-flex rounded-full bg-green-50 px-3 py-1 text-sm font-medium text-green-700">
            Fundação concluída
          </span>

          <h2 className="mt-5 text-xl font-semibold tracking-tight text-gray-950">
            A estrutura interna da V2
            está pronta.
          </h2>

          <p className="mt-3 max-w-3xl text-sm leading-6 text-gray-600">
            Os próximos módulos serão
            adicionados dentro desta estrutura,
            sem misturar autenticação,
            navegação e lógica de negócio em
            componentes gigantes.
          </p>
        </section>
      </div>
    </div>
  );
}