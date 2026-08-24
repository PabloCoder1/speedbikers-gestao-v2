"use client";

import { useState, type ReactNode } from "react";

import { createClient } from "../../../lib/supabase/browser";

/**
 * Uma linha de item do pedido — busca de SKU (mesmo padrão de
 * `apps/web/app/notas-fiscais/[id]/document-item-row.tsx`: lê `skus` direto
 * do navegador sob RLS, Modelo A). `skuId` fica nulo se o usuário digitar
 * um código livre sem selecionar da lista — mesmo raciocínio de
 * `document_items`: um item para um SKU ainda não catalogado continua
 * sendo informação, não é bloqueado.
 *
 * Exibe nacional/importado (`skus.is_imported`) quando o SKU é encontrado —
 * é o dado estruturado que atende o item do roadmap, sem coluna nova.
 */

export interface DraftItem {
  key: string;
  skuId: string | null;
  skuSnapshot: string;
  titleSnapshot: string | null;
  isImported: boolean | null;
  quantityOrdered: string;
  unitCost: string;
}

interface SkuResult {
  id: string;
  sku: string;
  title: string | null;
  /** Nulo quando o SKU não tem código fiscal de origem cadastrado (~2% do catálogo). */
  is_imported: boolean | null;
}

function originLabel(isImported: boolean | null): string {
  if (isImported === null) return "origem não cadastrada";

  return isImported ? "Importado" : "Nacional";
}

const inputStyle: React.CSSProperties = {
  padding: "0.375rem 0.5rem",
  borderRadius: "var(--sb-radius)",
  border: "1px solid var(--sb-border)",
  fontSize: "0.8125rem",
  width: "100%",
};

export function ItemRow({
  item,
  onChange,
  onRemove,
}: {
  item: DraftItem;
  onChange: (next: DraftItem) => void;
  onRemove: () => void;
}): ReactNode {
  const [results, setResults] = useState<SkuResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);

  async function search(value: string): Promise<void> {
    onChange({ ...item, skuSnapshot: value, skuId: null, titleSnapshot: null, isImported: null });
    setSearchError(null);

    if (value.trim().length < 2) {
      setResults([]);

      return;
    }

    const supabase = createClient();

    const { data, error } = await supabase
      .from("skus")
      .select("id, sku, title, is_imported")
      .ilike("sku_key", `%${value.trim().toUpperCase()}%`)
      .order("sku")
      .limit(8);

    if (error !== null) {
      // Sem isto, falha de rede/RLS virava "nenhum SKU encontrado" — igual
      // a uma busca genuinamente vazia (D-067, Nível 3).
      setSearchError("Não foi possível buscar SKUs — tente de novo.");

      return;
    }

    setResults(data);
  }

  function select(sku: SkuResult): void {
    onChange({
      ...item,
      skuId: sku.id,
      skuSnapshot: sku.sku,
      titleSnapshot: sku.title,
      isImported: sku.is_imported,
    });
    setResults([]);
  }

  return (
    <tr>
      <td style={{ padding: "0.375rem", verticalAlign: "top", position: "relative" }}>
        <input
          type="text"
          value={item.skuSnapshot}
          onChange={(event) => {
            void search(event.target.value);
          }}
          placeholder="SKU ou nome…"
          required
          style={inputStyle}
        />

        {results.length > 0 && (
          <ul
            style={{
              listStyle: "none",
              margin: "0.25rem 0 0",
              padding: 0,
              border: "1px solid var(--sb-border)",
              borderRadius: "var(--sb-radius)",
              maxHeight: "10rem",
              overflowY: "auto",
              position: "absolute",
              zIndex: 1,
              background: "var(--sb-surface)",
              width: "18rem",
            }}
          >
            {results.map((sku) => (
              <li key={sku.id}>
                <button
                  type="button"
                  onClick={() => {
                    select(sku);
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
                  <span style={{ color: "var(--sb-text-soft)" }}> ({originLabel(sku.is_imported)})</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {item.skuId !== null && (
          <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", marginTop: "0.25rem" }}>
            {item.titleSnapshot ?? "—"} · {originLabel(item.isImported)}
          </div>
        )}

        {item.skuId === null && item.skuSnapshot.trim() !== "" && searchError === null && (
          <div style={{ fontSize: "0.75rem", color: "var(--sb-text-soft)", marginTop: "0.25rem" }}>
            Sem SKU catalogado — vínculo fica pendente.
          </div>
        )}

        {searchError !== null && (
          <div role="alert" style={{ fontSize: "0.75rem", color: "var(--sb-danger)", marginTop: "0.25rem" }}>
            {searchError}
          </div>
        )}
      </td>

      <td style={{ padding: "0.375rem", verticalAlign: "top" }}>
        <input
          type="number"
          min="0.001"
          step="0.001"
          value={item.quantityOrdered}
          onChange={(event) => {
            onChange({ ...item, quantityOrdered: event.target.value });
          }}
          required
          style={inputStyle}
        />
      </td>

      <td style={{ padding: "0.375rem", verticalAlign: "top" }}>
        <input
          type="number"
          min="0"
          step="0.01"
          value={item.unitCost}
          onChange={(event) => {
            onChange({ ...item, unitCost: event.target.value });
          }}
          style={inputStyle}
        />
      </td>

      <td style={{ padding: "0.375rem", verticalAlign: "top" }}>
        <button
          type="button"
          onClick={onRemove}
          style={{
            padding: "0.375rem 0.625rem",
            borderRadius: "var(--sb-radius)",
            border: "1px solid var(--sb-border)",
            background: "transparent",
            color: "var(--sb-text-soft)",
            fontSize: "0.75rem",
            cursor: "pointer",
          }}
        >
          Remover
        </button>
      </td>
    </tr>
  );
}
