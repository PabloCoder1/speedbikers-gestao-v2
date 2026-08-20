"use client";

import { useState, type ReactNode } from "react";

import { createClient } from "../../lib/supabase/browser";
import { dismissLinkCandidate, resolveLinkCandidate } from "./actions";

/**
 * Uma linha da Central de Vinculações: busca manual de SKU e as duas ações
 * finais — vincular ou descartar (`docs/PROMPT_MASTER.md` secao 15).
 *
 * A busca lê `skus` direto do navegador, sob RLS (Modelo A) — não é escrita,
 * não precisa de Server Action.
 */

interface SkuResult {
  id: string;
  sku: string;
  title: string | null;
}

const inputStyle: React.CSSProperties = {
  padding: "0.375rem 0.5rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  fontSize: "0.875rem",
  width: "100%",
};

const buttonStyle: React.CSSProperties = {
  padding: "0.375rem 0.75rem",
  borderRadius: "var(--sb-radius)",
  border: "none",
  fontSize: "0.8125rem",
  fontWeight: 600,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

export function CandidateRow({ candidateId }: { candidateId: string }): ReactNode {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkuResult[]>([]);
  const [selected, setSelected] = useState<SkuResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function search(value: string): Promise<void> {
    setQuery(value);
    setSelected(null);

    if (value.trim().length < 2) {
      setResults([]);

      return;
    }

    const supabase = createClient();

    const { data } = await supabase
      .from("skus")
      .select("id, sku, title")
      .ilike("sku_key", `%${value.trim().toUpperCase()}%`)
      .order("sku")
      .limit(8);

    setResults(data ?? []);
  }

  async function confirm(): Promise<void> {
    if (selected === null) return;

    setBusy(true);
    setError(null);

    const result = await resolveLinkCandidate(candidateId, selected.id);

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    setDone(true);
  }

  async function dismiss(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await dismissLinkCandidate(candidateId);

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    setDone(true);
  }

  if (done) {
    return <span style={{ color: "var(--sb-text-soft)", fontSize: "0.875rem" }}>Feito.</span>;
  }

  return (
    <div style={{ display: "grid", gap: "0.375rem", minWidth: "16rem" }}>
      <div style={{ display: "flex", gap: "0.375rem", position: "relative" }}>
        <input
          type="text"
          value={query}
          onChange={(event) => {
            void search(event.target.value);
          }}
          placeholder="Buscar SKU…"
          disabled={busy}
          style={inputStyle}
        />

        <button
          type="button"
          onClick={() => {
            void confirm();
          }}
          disabled={busy || selected === null}
          style={{
            ...buttonStyle,
            background: "var(--sb-primary)",
            color: "var(--sb-white)",
            opacity: busy || selected === null ? 0.5 : 1,
            cursor: busy || selected === null ? "not-allowed" : "pointer",
          }}
        >
          Vincular
        </button>

        <button
          type="button"
          onClick={() => {
            void dismiss();
          }}
          disabled={busy}
          style={{
            ...buttonStyle,
            background: "transparent",
            border: "1px solid var(--sb-border)",
            color: "var(--sb-text-soft)",
          }}
        >
          Descartar
        </button>
      </div>

      {selected !== null && (
        <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          Selecionado: <strong>{selected.sku}</strong> {selected.title !== null && `— ${selected.title}`}
        </p>
      )}

      {selected === null && results.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            border: "1px solid var(--sb-border)",
            borderRadius: "var(--sb-radius)",
            maxHeight: "10rem",
            overflowY: "auto",
          }}
        >
          {results.map((sku) => (
            <li key={sku.id}>
              <button
                type="button"
                onClick={() => {
                  setSelected(sku);
                  setResults([]);
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "0.375rem 0.5rem",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  fontSize: "0.8125rem",
                }}
              >
                <strong>{sku.sku}</strong>
                {sku.title !== null && ` — ${sku.title}`}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error !== null && (
        <p role="alert" style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-danger)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
