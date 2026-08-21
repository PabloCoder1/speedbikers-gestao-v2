import type { ReactNode } from "react";

/**
 * Fallback de Suspense do App Router enquanto o Server Component busca
 * `get_sales_summary`. Cobre o estado de "loading" do checklist da Fase 5A
 * (`docs/ROADMAP.md`) — nenhuma tela anterior tinha `loading.tsx` próprio.
 */
export default function Loading(): ReactNode {
  return (
    <div style={{ padding: "var(--sb-space-4)", color: "var(--sb-text-soft)", fontSize: "0.9375rem" }}>
      Carregando vendas…
    </div>
  );
}
