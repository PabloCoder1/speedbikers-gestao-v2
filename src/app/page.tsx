import { appConfig } from "@/config/app";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <section className="w-full max-w-3xl rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <span className="inline-flex rounded-full bg-gray-100 px-3 py-1 text-sm font-medium text-gray-700">
            Fundação do projeto
          </span>
        </div>

        <h1 className="text-3xl font-semibold tracking-tight text-gray-950 sm:text-4xl">
          {appConfig.name}
        </h1>

        <p className="mt-4 max-w-2xl text-base leading-7 text-gray-600">
          {appConfig.description}
        </p>

        <div className="mt-8 rounded-xl border border-gray-200 bg-gray-50 p-5">
          <p className="text-sm font-medium text-gray-900">
            Ambiente inicial configurado com sucesso.
          </p>

          <p className="mt-2 text-sm leading-6 text-gray-600">
            A autenticação, o banco de dados e as integrações serão adicionados
            nas próximas etapas.
          </p>
        </div>
      </section>
    </main>
  );
}