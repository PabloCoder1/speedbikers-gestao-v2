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
 * ## A caixa aberta, pelo frame (A2)
 *
 * O gatilho já era o `.search` do topbar desde R1; a CAIXA ainda era a antiga,
 * desenhada com `style={{}}`: 32rem a 10vh, sombra preta, lista plana com o
 * tipo repetido em cada linha. O `.command` do export é outra coisa —
 * **520px encostados a 16vh**, cabeçalho "BUSCAR NA SPEED BIKERS" com um ✕, o
 * campo com a lupa e um `ESC`, e os resultados **agrupados por tipo** sob um
 * rótulo monoespaçado, cada linha com um `↵` à direita.
 *
 * O agrupamento não é enfeite: `search_entities` devolve até 5 por tipo, então
 * uma lista plana de 25 linhas repete "SKU" cinco vezes e depois "ANÚNCIO"
 * cinco vezes. O rótulo de grupo diz isso uma vez.
 *
 * `organizationId` vem do `Shell` (resolvido no servidor), não é buscado de
 * novo aqui.
 */

interface SearchResult {
  entity_type: string;
  label: string;
  sublabel: string;
  href: string;
}

/**
 * Agrupa preservando a ordem em que os tipos apareceram — a RPC já devolve na
 * ordem de relevância dela, e reordenar aqui seria inventar outra.
 */
function agrupar(results: readonly SearchResult[]): { tipo: string; linhas: SearchResult[] }[] {
  const grupos: { tipo: string; linhas: SearchResult[] }[] = [];

  for (const linha of results) {
    const atual = grupos.find((g) => g.tipo === linha.entity_type);

    if (atual === undefined) {
      grupos.push({ tipo: linha.entity_type, linhas: [linha] });
    } else {
      atual.linhas.push(linha);
    }
  }

  return grupos;
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

  function fechar(): void {
    setOpen(false);
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
     *
     * O texto nomeia o que a RPC REALMENTE busca. O frame diz "SKU, pedido,
     * anúncio ou ação"; `search_entities` cobre SKU, anúncio, conta,
     * fornecedor e pedido de compra — prometer "ação" seria mandar procurar o
     * que não se acha.
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
        <span className="sb-search-label">Buscar SKU, anúncio, conta, fornecedor ou pedido de compra…</span>
        <kbd>Ctrl K</kbd>
      </button>
    );
  }

  const grupos = agrupar(results);

  return (
    <div
      className="sb-backdrop sb-backdrop-topo"
      onClick={fechar}
      // O `role` fica no CARTÃO, não no fundo: o fundo é a área de clique que
      // fecha, e um diálogo cujo rótulo é a página inteira não ajuda ninguém.
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Buscar na Speed Bikers"
        className="sb-command"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="sb-command-head">
          <span className="sb-modal-eyebrow">Buscar na Speed Bikers</span>
          <button type="button" className="sb-close" aria-label="Fechar busca" onClick={fechar}>
            ✕
          </button>
        </div>

        <div className="sb-command-input">
          <span aria-hidden="true" className="sb-search-icon">⌕</span>
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(event) => {
              void search(event.target.value);
            }}
            placeholder="Busque por SKU, MLB, título, fornecedor, pedido…"
            aria-label="Buscar"
          />
          <kbd>ESC</kbd>
        </div>

        {searchError !== null && (
          <p role="alert" className="sb-empty" style={{ color: "var(--sb-danger)" }}>
            {searchError}
          </p>
        )}

        {searchError === null && query.trim().length >= 2 && results.length === 0 && (
          <p className="sb-empty">Nada encontrado para “{query.trim()}”.</p>
        )}

        {searchError === null && query.trim().length < 2 && (
          <p className="sb-empty">Digite ao menos duas letras.</p>
        )}

        {grupos.map((grupo) => (
          <div key={grupo.tipo}>
            <span className="sb-command-label">{searchEntityLabel(grupo.tipo)}</span>
            {grupo.linhas.map((result, index) => (
              <button
                key={`${result.href}:${String(index)}`}
                type="button"
                className="sb-command-row"
                onClick={() => {
                  go(result.href);
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <b>{result.label}</b>
                  {result.sublabel !== "" && <small>{result.sublabel}</small>}
                </span>
                <kbd>↵</kbd>
              </button>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
