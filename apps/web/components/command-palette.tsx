"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";

import { filtrarPaginas } from "../lib/command-pages";
import { searchEntityLabel, textoDasEntidadesBuscaveis } from "../lib/labels";
import { createClient } from "../lib/supabase/browser";
import { paginasDoMenu } from "./nav";

/**
 * Busca universal / Command Palette (Fase 5B, `docs/PRODUCT_REQUIREMENTS.md`
 * secao "Busca universal") — `Ctrl+K`/`Cmd+K` abre, digita, `Enter` ou clique
 * navega. Espera 250 ms de digitação e cancela a busca anterior. A sequência
 * também protege contra respostas antigas quando o transporte não aborta.
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

/**
 * Uma linha navegável da caixa: tela do menu ou resultado da RPC. O índice
 * PLANO é o que as setas percorrem (lote 3 do pente fino, 18/09) — antes o `↵`
 * de cada linha prometia um Enter que não fazia nada.
 */
interface ItemNavegavel {
  href: string;
  indice: number;
}

export function CommandPalette({
  organizationId,
  papel = null,
}: {
  organizationId: string | null;
  /** Mesma regra do menu para as telas: quem não é ADMIN não vê as telas de ADMIN. */
  papel?: string | null;
}): ReactNode {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ativo, setAtivo] = useState(0);
  const paginas = useMemo(() => paginasDoMenu(papel), [papel]);

  const invalidate = useCallback(() => {
    sequence.current += 1;
    controller.current?.abort();
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  const fechar = useCallback(() => {
    invalidate();
    setOpen(false);
    setSearching(false);
    setQuery("");
    setResults([]);
    setSearchError(null);
  }, [invalidate]);

  useEffect(() => invalidate, [invalidate, organizationId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpen(true);

        return;
      }

      if (event.key === "Escape") {
        fechar();
      }
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fechar]);

  function search(value: string): void {
    invalidate();
    setQuery(value);
    setAtivo(0);
    setSearchError(null);
    setResults([]);
    setSearching(false);

    if (organizationId === null || value.trim().length < 2) {
      setResults([]);

      return;
    }

    setSearching(true);
    const requestId = sequence.current;
    const abort = new AbortController();
    controller.current = abort;
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const { data, error } = await createClient().rpc("search_entities", {
            p_organization_id: organizationId,
            p_query: value.trim(),
          }).abortSignal(abort.signal);
          if (requestId !== sequence.current) return;
          if (error !== null) {
            setSearchError("Não foi possível buscar — tente de novo.");
          } else {
            setResults(data);
          }
        } catch {
          if (requestId === sequence.current) setSearchError("Não foi possível buscar — tente de novo.");
        } finally {
          if (requestId === sequence.current) setSearching(false);
        }
      })();
    }, 250);
  }

  function go(href: string): void {
    fechar();
    router.push(href);
  }

  /*
   * O GATILHO FICA NA BARRA TAMBÉM COM A CAIXA ABERTA (D-326).
   *
   * O componente devolvia a caixa NO LUGAR do gatilho: abrir a busca tirava o
   * campo do topbar, e os botões à direita escorregavam por trás do fundo
   * escurecido. Achado na captura de A15. A caixa é `position: fixed` e não
   * ocupa espaço, então o gatilho pode continuar onde está — a barra atrás do
   * fundo fica igual à barra de antes de abrir.
   */
  const gatilho = (
    <button
      type="button"
      className="sb-search"
      onClick={() => {
        setOpen(true);
      }}
    >
      <span aria-hidden="true" className="sb-search-icon">⌕</span>
      <span className="sb-search-label">Buscar SKU, anúncio, NF-e…</span>
      <kbd>Ctrl K</kbd>
    </button>
  );

  if (!open) {
    /*
     * O gatilho é o campo de busca do topbar do Figma (`.search`): 36px de
     * altura, ocupando metade da barra, com o texto do que se pode buscar e a
     * tecla de atalho num `<kbd>`. Era um botão pequeno de "Buscar… Ctrl+K", e
     * a diferença não é cosmética: no Figma a busca é o elemento MAIS À
     * ESQUERDA e o mais largo do topbar, porque ela é a forma primária de
     * navegar num sistema com 28 telas.
     *
     * O TEXTO É CURTO E VERDADEIRO, E A PROMESSA INTEIRA MORA NA CAIXA (A15,
     * D-323). Este comentário dizia que o texto "nomeia o que a RPC REALMENTE
     * busca" — e ele nomeava cinco entidades desde que D-216 levou
     * `search_entities` a sete. Completar a lista não cabe: medido, as sete por
     * extenso pedem 474px e o campo tem 362px a 1440px (e 232px a 900px). Então
     * o gatilho diz três entidades verdadeiras com reticências, cabendo em todas
     * as larguras de tela larga, e a lista completa — derivada da lista de
     * entidades, com teste exato — aparece na caixa aberta, onde há espaço.
     *
     * O frame diz "SKU, pedido, anúncio ou ação", e as duas recusas continuam:
     * "ação" não tem destino por id, e "pedido" de VENDA não tem página.
     */
    return gatilho;
  }

  const grupos = agrupar(results);
  const paginasAchadas = filtrarPaginas(paginas, query);

  // A ordem das setas é a ordem da tela: telas primeiro, depois cada grupo.
  const navegaveis: ItemNavegavel[] = [
    ...paginasAchadas.map((pagina, indice) => ({ href: pagina.href, indice })),
    ...grupos.flatMap((grupo) => grupo.linhas).map((linha, i) => ({ href: linha.href, indice: paginasAchadas.length + i })),
  ];
  const selecionado = navegaveis.length === 0 ? -1 : Math.min(ativo, navegaveis.length - 1);
  const idDaLinha = (indice: number): string => `sb-command-opcao-${String(indice)}`;

  function aoTeclar(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (navegaveis.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setAtivo((atual) => (atual + 1) % navegaveis.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setAtivo((atual) => (atual - 1 + navegaveis.length) % navegaveis.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const alvo = navegaveis[selecionado];

      if (alvo !== undefined) go(alvo.href);
    }
  }

  let proximoIndice = paginasAchadas.length;

  return (
    <>
    {gatilho}
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
            className="sb-command-field"
            type="text"
            autoFocus
            role="combobox"
            aria-expanded={navegaveis.length > 0}
            aria-controls="sb-command-lista"
            aria-activedescendant={selecionado >= 0 ? idDaLinha(selecionado) : undefined}
            onKeyDown={aoTeclar}
            value={query}
            onChange={(event) => {
              search(event.target.value);
            }}
            // O que se DIGITA, e não uma segunda lista de entidades — a lista mora
            // na frase abaixo. "pedido" sozinho prometia pedido de venda.
            placeholder="Código, título, MLB, documento ou número…"
            aria-label="Buscar"
          />
          <kbd>ESC</kbd>
        </div>

        {searchError !== null && (
          <p role="alert" className="sb-empty" style={{ color: "var(--sb-danger)" }}>
            {searchError}
          </p>
        )}

        {searching && <p role="status" className="sb-empty">Buscando…</p>}

        {!searching && searchError === null && query.trim().length >= 2 && results.length === 0 && paginasAchadas.length === 0 && (
          <p className="sb-empty">Nada encontrado para “{query.trim()}”.</p>
        )}

        {searchError === null && query.trim().length < 2 && paginasAchadas.length === 0 && (
          <p className="sb-empty">
            Digite o nome de uma tela ou ao menos duas letras de um registro. A busca alcança{" "}
            {textoDasEntidadesBuscaveis()}. Use ↑ ↓ e Enter.
          </p>
        )}

        <div id="sb-command-lista" role="listbox" aria-label="Resultados">
          {paginasAchadas.length > 0 && (
            <div role="group" aria-label="Telas">
              <span className="sb-command-label">Telas</span>
              {paginasAchadas.map((pagina, indice) => (
                <button
                  key={pagina.href}
                  id={idDaLinha(indice)}
                  type="button"
                  role="option"
                  aria-selected={indice === selecionado}
                  className={`sb-command-row${indice === selecionado ? " is-active" : ""}`}
                  onMouseEnter={() => {
                    setAtivo(indice);
                  }}
                  onClick={() => {
                    go(pagina.href);
                  }}
                >
                  <span className="sb-command-row-text">
                    <b>{pagina.label}</b>
                    <small>{pagina.grupo}</small>
                  </span>
                  <kbd>↵</kbd>
                </button>
              ))}
            </div>
          )}

          {grupos.map((grupo) => (
            <div key={grupo.tipo} role="group" aria-label={searchEntityLabel(grupo.tipo)}>
              <span className="sb-command-label">{searchEntityLabel(grupo.tipo)}</span>
              {grupo.linhas.map((result, index) => {
                const indice = proximoIndice;
                proximoIndice += 1;

                return (
                  <button
                    key={`${result.href}:${String(index)}`}
                    id={idDaLinha(indice)}
                    type="button"
                    role="option"
                    aria-selected={indice === selecionado}
                    className={`sb-command-row${indice === selecionado ? " is-active" : ""}`}
                    onMouseEnter={() => {
                      setAtivo(indice);
                    }}
                    onClick={() => {
                      go(result.href);
                    }}
                  >
                    <span className="sb-command-row-text">
                      <b>{result.label}</b>
                      {result.sublabel !== "" && <small>{result.sublabel}</small>}
                    </span>
                    <kbd>↵</kbd>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </section>
    </div>
    </>
  );
}
