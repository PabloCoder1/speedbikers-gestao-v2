"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { deleteFilter, saveFilter } from "./saved-filters-actions";

/**
 * Filtros salvos — lista os presets já pré-buscados pelo servidor (mesmo
 * padrão de `apps/web/app/vinculacoes/candidate-row.tsx`: a LISTA vem
 * server-side, só a ação é cliente) e permite salvar o recorte atual da URL ou
 * apagar um preset existente.
 *
 * ## O que mudou em A2
 *
 * O Figma não desenha "filtros salvos" em tela nenhuma — é recurso real da V3,
 * e por isso ele segue o DESIGN SYSTEM em vez de um frame: a barra do
 * cabeçalho tem "Salvar visão" como `.button ghost` (o terceiro botão da
 * toolbar de `Sales`, App.tsx:1217) e as visões salvas viram um `.sb-menu`,
 * como os demais filtros da barra. Eram pílulas de raio 999px com borda
 * tracejada — a única forma de pílula que sobrava no app.
 *
 * E o nome deixou de vir de `window.prompt`. O prompt do navegador não é só
 * feio: ele não diz O QUE está sendo salvo. O `.sb-modal` mostra o recorte
 * atual antes de nomear — a mesma doutrina do painel de conferência da
 * curadoria (D-127), em escala menor.
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
  const [nomeando, setNomeando] = useState(false);
  const [nome, setNome] = useState("");

  useEffect(() => {
    if (!nomeando) return undefined;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") setNomeando(false);
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [nomeando]);

  // O recorte que será salvo, em texto — é o que o `window.prompt` não dizia.
  const atuais = [...searchParams.entries()];

  async function handleSave(): Promise<void> {
    const limpo = nome.trim();

    if (limpo === "") return;

    setBusy(true);
    setError(null);

    const params = Object.fromEntries(atuais);
    const result = await saveFilter(organizationId, screen, limpo, params);

    setBusy(false);

    if (!result.ok) {
      setError(result.message);

      return;
    }

    setNomeando(false);
    setNome("");
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
    <>
      {filters.length > 0 && (
        <details className="sb-menu">
          <summary className="sb-button">
            Visões salvas
            <span aria-hidden="true" className="sb-menu-chevron">
              ⌄
            </span>
          </summary>
          <div className="sb-menu-panel">
            {filters.map((filter) => (
              <span key={filter.id} className="sb-menu-row">
                <a className="sb-menu-item" href={toHref(screen, filter.params)}>
                  {filter.name}
                </a>
                <button
                  type="button"
                  className="sb-menu-remove"
                  aria-label={`Apagar filtro ${filter.name}`}
                  disabled={busy}
                  onClick={() => {
                    void handleDelete(filter.id);
                  }}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        </details>
      )}

      <button
        type="button"
        className="sb-button"
        disabled={busy}
        onClick={() => {
          setError(null);
          setNomeando(true);
        }}
      >
        Salvar visão
      </button>

      {error !== null && (
        <span role="alert" style={{ color: "var(--sb-danger)", fontSize: "0.6875rem" }}>
          {error}
        </span>
      )}

      {nomeando && (
        <div
          className="sb-backdrop"
          onClick={() => {
            setNomeando(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Salvar visão"
            className="sb-modal"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <span className="sb-modal-eyebrow">Salvar visão</span>
            <h2>Nomear este recorte</h2>
            <p>
              {atuais.length === 0
                ? "Nenhum filtro aplicado — a visão salva abre esta tela sem recorte."
                : `Serão salvos ${String(atuais.length)} ${atuais.length === 1 ? "parâmetro" : "parâmetros"} da URL: ${atuais
                    .map(([chave, valor]) => `${chave}=${valor}`)
                    .join(" · ")}`}
            </p>

            <form
              style={{ display: "grid", gap: "var(--sb-space-2)", marginTop: "var(--sb-space-3)" }}
              onSubmit={(event) => {
                event.preventDefault();
                void handleSave();
              }}
            >
              <input
                type="text"
                autoFocus
                className="sb-input"
                value={nome}
                onChange={(event) => {
                  setNome(event.target.value);
                }}
                placeholder="Ex.: Loja E2E, últimos 7 dias"
                aria-label="Nome da visão"
              />

              <div style={{ display: "flex", gap: "var(--sb-space-2)", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  className="sb-button"
                  disabled={busy}
                  onClick={() => {
                    setNomeando(false);
                  }}
                >
                  Cancelar
                </button>
                <button type="submit" className="sb-button sb-button-primary" disabled={busy || nome.trim() === ""}>
                  {busy ? "Salvando…" : "Salvar"}
                </button>
              </div>
            </form>

            <button
              type="button"
              className="sb-close"
              aria-label="Fechar"
              style={{ position: "absolute", right: 20, top: 18 }}
              onClick={() => {
                setNomeando(false);
              }}
            >
              ✕
            </button>
          </section>
        </div>
      )}
    </>
  );
}
