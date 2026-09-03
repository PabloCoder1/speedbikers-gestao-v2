"use client";

import { useState, type ReactNode } from "react";

import { createClient } from "../../../lib/supabase/browser";
import { linkDocumentItem } from "../actions";

/**
 * Vínculo de um item da NF-e a um SKU — mesmo padrão de
 * `apps/web/app/vinculacoes/candidate-row.tsx`: busca lê `skus` direto do
 * navegador sob RLS (Modelo A), a escrita passa pela Server Action + RPC.
 *
 * Diferente da Central de Vinculações: aqui o vínculo pode ser TROCADO
 * (`p_sku_id` na RPC aceita relink) até o documento sair de `PARSED` — não
 * há estado "fechado" por item, só por documento inteiro.
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

export function DocumentItemRow({
  itemId,
  documentId,
  editable,
  linkedSku,
}: {
  itemId: number;
  documentId: string;
  editable: boolean;
  linkedSku: SkuResult | null;
}): ReactNode {
  const [current, setCurrent] = useState<SkuResult | null>(linkedSku);
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkuResult[]>([]);
  const [selected, setSelected] = useState<SkuResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(value: string): Promise<void> {
    setQuery(value);
    setSelected(null);

    if (value.trim().length < 2) {
      setResults([]);

      return;
    }

    const supabase = createClient();

    const { data, error: searchError } = await supabase
      .from("skus")
      .select("id, sku, title")
      .ilike("sku_key", `%${value.trim().toUpperCase()}%`)
      .order("sku")
      .limit(8);

    if (searchError !== null) {
      // Sem isto, falha de rede/RLS virava "nenhum SKU encontrado" — igual
      // a uma busca genuinamente vazia (D-067, Nível 3).
      setError("Não foi possível buscar SKUs — tente de novo.");

      return;
    }

    setResults(data);
  }

  async function confirm(): Promise<void> {
    if (selected === null) return;

    setBusy(true);
    setError(null);

    const result = await linkDocumentItem(itemId, selected.id, documentId);

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    setCurrent(selected);
    setEditing(false);
    setBusy(false);
  }

  async function unlink(): Promise<void> {
    setBusy(true);
    setError(null);

    const result = await linkDocumentItem(itemId, null, documentId);

    if (!result.ok) {
      setError(result.message);
      setBusy(false);

      return;
    }

    setCurrent(null);
    setEditing(false);
    setBusy(false);
  }

  if (!editable) {
    return current === null ? (
      <span style={{ color: "var(--sb-text-soft)", fontSize: "0.875rem" }}>Sem vínculo</span>
    ) : (
      <span style={{ fontSize: "0.875rem" }}>
        <strong>{current.sku}</strong>
        {current.title !== null && ` — ${current.title}`}
      </span>
    );
  }

  if (current !== null && !editing) {
    return (
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.875rem" }}>
          <strong>{current.sku}</strong>
          {current.title !== null && ` — ${current.title}`}
        </span>

        <button
          type="button"
          onClick={() => {
            setEditing(true);
          }}
          style={{
            ...buttonStyle,
            background: "transparent",
            border: "1px solid var(--sb-border)",
            color: "var(--sb-text-soft)",
          }}
        >
          Trocar
        </button>
      </div>
    );
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

        {current !== null && (
          <button
            type="button"
            onClick={() => {
              void unlink();
            }}
            disabled={busy}
            style={{
              ...buttonStyle,
              background: "transparent",
              border: "1px solid var(--sb-border)",
              color: "var(--sb-text-soft)",
            }}
          >
            Cancelar
          </button>
        )}
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
            background: "var(--sb-surface)",
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
