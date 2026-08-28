"use client";

import { useState } from "react";

import { createClient } from "../lib/supabase/browser";

/**
 * Busca de SKU por prefixo, sob RLS (Modelo A) — leitura direta do navegador,
 * sem Server Action.
 *
 * Extraído quando ganhou o segundo consumidor: `vinculacoes/candidate-row.tsx`
 * (resolver candidato) e `vinculacoes/manual-link-form.tsx` (vinculação manual
 * livre) tinham 29 linhas idênticas — mesma consulta, mesmo limite, mesma
 * mensagem de erro. A marcação de cada tela continua própria; só o estado e a
 * consulta são compartilhados.
 */

export interface SkuResult {
  id: string;
  sku: string;
  title: string | null;
}

export interface SkuSearch {
  readonly query: string;
  readonly results: SkuResult[];
  readonly selected: SkuResult | null;
  readonly error: string | null;
  /** Digitação: busca a partir de 2 caracteres e limpa a seleção. */
  search: (value: string) => Promise<void>;
  select: (sku: SkuResult) => void;
  reset: () => void;
}

export function useSkuSearch(): SkuSearch {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SkuResult[]>([]);
  const [selected, setSelected] = useState<SkuResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function search(value: string): Promise<void> {
    setQuery(value);
    setSelected(null);
    setError(null);

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
      // Sem isto, falha de rede/RLS virava "nenhum SKU encontrado" — igual a
      // uma busca genuinamente vazia (D-067, Nível 3).
      setError("Não foi possível buscar SKUs — tente de novo.");

      return;
    }

    setResults(data);
  }

  function select(sku: SkuResult): void {
    setSelected(sku);
    setQuery(sku.sku);
    setResults([]);
  }

  function reset(): void {
    setQuery("");
    setResults([]);
    setSelected(null);
    setError(null);
  }

  return { query, results, selected, error, search, select, reset };
}
