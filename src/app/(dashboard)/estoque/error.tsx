"use client";

export default function StockError({
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    <div className="flex min-h-[55vh] items-center justify-center px-6 py-12">
      <div className="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <h2 className="text-lg font-semibold text-gray-950">
          Não foi possível carregar o estoque.
        </h2>
        <p className="mt-2 text-sm leading-6 text-gray-500">
          Tente novamente em alguns instantes.
        </p>
        <button
          type="button"
          onClick={retry}
          className="mt-6 rounded-xl bg-gray-950 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-gray-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-gray-200"
        >
          Tentar novamente
        </button>
      </div>
    </div>
  );
}

