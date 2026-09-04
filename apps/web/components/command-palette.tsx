"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { searchEntityLabel } from "../lib/labels";
import { createClient } from "../lib/supabase/browser";

/**
 * Busca universal / Command Palette (Fase 5B, `docs/PRODUCT_REQUIREMENTS.md`
 * secao "Busca universal") — `Ctrl+K`/`Cmd+K` abre, digita, `Enter` ou clique
 * navega. Mesmo padrão de busca-enquanto-digita já usado em
 * `apps/web/app/compras/novo/item-row.tsx` (sem debounce, mínimo de 2
 * caracteres antes de consultar) — `search_entities` já limita 5 por tipo,
 * então o resultado nunca é grande o bastante para justificar debounce.
 *
 * "Filtros salvos" (mesma linha do checklist original) fica de fora desta
 * fatia — ver decisão. `organizationId` vem do `Shell` (resolvido no
 * servidor), não é buscado de novo aqui.
 */

interface SearchResult {
  entity_type: string;
  label: string;
  sublabel: string;
  href: string;
}

export function CommandPalette({ organizationId }: { organizationId: string | null }): ReactNode {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpen(true);

        return;
      }

      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  async function search(value: string): Promise<void> {
    setQuery(value);
    setSearchError(null);

    if (organizationId === null || value.trim().length < 2) {
      setResults([]);

      return;
    }

    const supabase = createClient();

    const { data, error } = await supabase.rpc("search_entities", {
      p_organization_id: organizationId,
      p_query: value.trim(),
    });

    if (error !== null) {
      // Sem isto, falha de rede/RLS virava "Nada encontrado" — igual a uma
      // busca genuinamente vazia (D-067, Nível 3).
      setResults([]);
      setSearchError("Não foi possível buscar — tente de novo.");

      return;
    }

    setResults(data);
  }

  function go(href: string): void {
    setOpen(false);
    setQuery("");
    setResults([]);
    router.push(href);
  }

  if (!open) {
    /*
     * O gatilho é o campo de busca do topbar do Figma (`.search`): 36px de
     * altura, ocupando metade da barra, com o texto do que se pode buscar e a
     * tecla de atalho num `<kbd>`. Era um botão pequeno de "Buscar… Ctrl+K", e
     * a diferença não é cosmética: no Figma a busca é o elemento MAIS À
     * ESQUERDA e o mais largo do topbar, porque ela é a forma primária de
     * navegar num sistema com 28 telas.
     */
    return (
      <button
        type="button"
        className="sb-search"
        onClick={() => {
          setOpen(true);
        }}
      >
        <span aria-hidden="true" className="sb-search-icon">⌕</span>
        <span className="sb-search-label">Buscar SKU, pedido, anúncio ou ação…</span>
        <kbd>Ctrl K</kbd>
      </button>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={() => {
        setOpen(false);
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "10vh",
        zIndex: 100,
      }}
    >
      <div
        onClick={(event) => {
          event.stopPropagation();
        }}
        style={{
          background: "var(--sb-surface)",
          borderRadius: "var(--sb-radius)",
          width: "32rem",
          maxWidth: "90vw",
          maxHeight: "70vh",
          overflowY: "auto",
          boxShadow: "0 8px 30px rgba(0,0,0,0.2)",
        }}
      >
        <input
          type="text"
          autoFocus
          value={query}
          onChange={(event) => {
            void search(event.target.value);
          }}
          placeholder="Buscar SKU, anúncio, conta, fornecedor, pedido de compra…"
          style={{
            width: "100%",
            padding: "0.75rem 1rem",
            border: "none",
            borderBottom: "1px solid var(--sb-border)",
            fontSize: "0.9375rem",
            outline: "none",
            background: "transparent",
            color: "inherit",
          }}
        />

        {searchError !== null && (
          <p role="alert" style={{ padding: "1rem", margin: 0, color: "var(--sb-danger)", fontSize: "0.8125rem" }}>
            {searchError}
          </p>
        )}

        {searchError === null && query.trim().length >= 2 && results.length === 0 && (
          <p style={{ padding: "1rem", margin: 0, color: "var(--sb-text-soft)", fontSize: "0.8125rem" }}>
            Nada encontrado.
          </p>
        )}

        {results.length > 0 && (
          <ul style={{ listStyle: "none", margin: 0, padding: "0.5rem 0" }}>
            {results.map((result, index) => (
              <li key={`${result.entity_type}:${result.href}:${String(index)}`}>
                <button
                  type="button"
                  onClick={() => {
                    go(result.href);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "0.5rem 1rem",
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    color: "inherit",
                  }}
                >
                  <span
                    style={{
                      fontSize: "0.6875rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.04em",
                      color: "var(--sb-text-soft)",
                    }}
                  >
                    {searchEntityLabel(result.entity_type)}
                  </span>
                  <div style={{ fontSize: "0.875rem" }}>{result.label}</div>
                  {result.sublabel !== "" && (
                    <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)" }}>{result.sublabel}</div>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
