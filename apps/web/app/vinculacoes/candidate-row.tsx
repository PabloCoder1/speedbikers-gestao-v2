"use client";

import { useState, type ReactNode } from "react";

import { useSkuSearch } from "../../components/use-sku-search";
import { dismissLinkCandidate, resolveLinkCandidate } from "./actions";

/**
 * Uma linha da Central de Vinculações: busca manual de SKU e as duas ações
 * finais — vincular ou descartar (`docs/PROMPT_MASTER.md` secao 15).
 *
 * A busca lê `skus` direto do navegador, sob RLS (Modelo A) — não é escrita,
 * não precisa de Server Action.
 */

export function CandidateRow({ candidateId }: { candidateId: string }): ReactNode {
  const skuSearch = useSkuSearch();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function confirm(): Promise<void> {
    if (skuSearch.selected === null) return;

    setBusy(true);
    setError(null);

    const result = await resolveLinkCandidate(candidateId, skuSearch.selected.id);

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
          className="sb-input sb-input-full"
          type="text"
          value={skuSearch.query}
          onChange={(event) => {
            void skuSearch.search(event.target.value);
          }}
          placeholder="Buscar SKU…"
          disabled={busy}
        />

        <button
          className="sb-button sb-button-primary"
          type="button"
          onClick={() => {
            void confirm();
          }}
          disabled={busy || skuSearch.selected === null}
        >
          Vincular
        </button>

        <button
          className="sb-button"
          type="button"
          onClick={() => {
            void dismiss();
          }}
          disabled={busy}
        >
          Descartar
        </button>
      </div>

      {skuSearch.selected !== null && (
        <p style={{ margin: 0, fontSize: "0.8125rem", color: "var(--sb-text-soft)" }}>
          Selecionado: <strong>{skuSearch.selected.sku}</strong> {skuSearch.selected.title !== null && `— ${skuSearch.selected.title}`}
        </p>
      )}

      {skuSearch.selected === null && skuSearch.results.length > 0 && (
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
          {skuSearch.results.map((sku) => (
            <li key={sku.id}>
              <button
                className="sb-menu-item"
                type="button"
                onClick={() => {
                  skuSearch.select(sku);
                }}
                style={{ width: "100%", textAlign: "left" }}
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
