"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type ReactNode } from "react";

import { deleteFilter, saveFilter } from "./saved-filters-actions";

/**
 * Filtros salvos — lista os presets já pré-buscados pelo servidor (mesmo
 * padrão de `apps/web/app/vinculacoes/candidate-row.tsx`: a LISTA vem
 * server-side, só a ação é cliente) e permite salvar o filtro atual da URL
 * ou apagar um preset existente. `window.prompt` para o nome — sem modal
 * dedicado nesta primeira fatia, mesmo raciocínio de "escopo deliberadamente
 * menor" já usado em outras telas.
 */

export interface SavedFilter {
  id: string;
  name: string;
  params: Record<string, string>;
}

function toHref(screen: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params).toString();

  return search === "" ? screen : `${screen}?${search}`;
}

export function SavedFilters({
  screen,
  organizationId,
  filters,
}: {
  screen: string;
  organizationId: string;
  filters: SavedFilter[];
}): ReactNode {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave(): Promise<void> {
    const name = window.prompt("Nome para este filtro:");

    if (name === null || name.trim() === "") return;

    setBusy(true);
    setError(null);

    const params = Object.fromEntries(searchParams.entries());
    const result = await saveFilter(organizationId, screen, name.trim(), params);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    router.refresh();
  }

  async function handleDelete(id: string): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await deleteFilter(id, screen);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    router.refresh();
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.375rem" }}>
      {filters.map((filter) => (
        <span
          key={filter.id}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            border: "1px solid var(--sb-border)",
            borderRadius: "999px",
            padding: "0.125rem 0.25rem 0.125rem 0.625rem",
            fontSize: "0.75rem",
          }}
        >
          <a href={toHref(screen, filter.params)} style={{ color: "var(--sb-text-soft)" }}>
            {filter.name}
          </a>
          <button
            type="button"
            aria-label={`Apagar filtro ${filter.name}`}
            disabled={busy}
            onClick={() => {
              void handleDelete(filter.id);
            }}
            style={{
              border: "none",
              background: "transparent",
              color: "var(--sb-text-soft)",
              cursor: busy ? "not-allowed" : "pointer",
              padding: "0.125rem 0.375rem",
              fontSize: "0.75rem",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </span>
      ))}

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          void handleSave();
        }}
        style={{
          border: "1px dashed var(--sb-border)",
          borderRadius: "999px",
          background: "transparent",
          color: "var(--sb-text-soft)",
          padding: "0.1875rem 0.75rem",
          fontSize: "0.75rem",
          cursor: busy ? "not-allowed" : "pointer",
        }}
      >
        + Salvar filtro atual
      </button>

      {error !== null && (
        <span role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.75rem" }}>
          {error}
        </span>
      )}
    </div>
  );
}
