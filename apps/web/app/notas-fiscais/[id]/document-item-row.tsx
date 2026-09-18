"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { createClient } from "../../../lib/supabase/browser";
import { termoSeguroParaOr } from "../../../lib/postgrest-search";
import { linkDocumentItem } from "../actions";

/**
 * Vínculo de um item da NF-e a um SKU — mesmo padrão de
 * `apps/web/app/vinculacoes/candidate-row.tsx`: busca lê `skus` direto do
 * navegador sob RLS (Modelo A), a escrita passa pela Server Action + RPC.
 *
 * Diferente da Central de Vinculações: aqui o vínculo pode ser TROCADO
 * (`p_sku_id` na RPC aceita relink) até o documento sair de `PARSED` — não
 * há estado "fechado" por item, só por documento inteiro.
 *
 * A busca espera a pessoa parar de digitar (`ESPERA_MS`) e descarta resposta
 * velha: antes cada tecla era uma consulta, e a resposta de "PN" podia chegar
 * DEPOIS da de "PNEU" e trocar a lista certa pela errada.
 */

const ESPERA_MS = 200;

interface SkuResult {
  id: string;
  sku: string;
  title: string | null;
}

function SkuVinculado({ sku }: { sku: SkuResult }): ReactNode {
  return (
    <span className="sb-nf-sku">
      <b className="sb-mono">{sku.sku}</b>
      {sku.title !== null && <span title={sku.title}>{sku.title}</span>}
    </span>
  );
}

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
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SkuResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Número da busca mais recente: a resposta que não for dela é descartada.
  const ultimaBusca = useRef(0);

  useEffect(() => {
    const termo = query.trim();

    if (selected !== null || termo.length < 2) {
      setResults([]);
      setSearching(false);

      return;
    }

    const numero = ultimaBusca.current + 1;

    ultimaBusca.current = numero;
    setSearching(true);

    const espera = setTimeout(() => {
      void (async () => {
        // Código OU título (lote 3 do pente fino, 18/09): a linha da nota traz a
        // descrição do fornecedor, quase nunca o código do SKU da loja. O texto
        // passa por `termoSeguroParaOr` antes de entrar no `or=`.
        const seguro = termoSeguroParaOr(termo);
        const { data, error: searchError } = await createClient()
          .from("skus")
          .select("id, sku, title")
          .or(`sku_key.ilike.%${seguro.toUpperCase()}%,title.ilike.%${seguro}%`)
          .order("sku")
          .limit(8);

        if (numero !== ultimaBusca.current) return;

        setSearching(false);

        if (searchError !== null) {
          // Sem isto, falha de rede/RLS virava "nenhum SKU encontrado" — igual
          // a uma busca genuinamente vazia (D-067, Nível 3).
          setError("Não foi possível buscar SKUs — tente de novo.");

          return;
        }

        setError(null);
        setResults(data);
      })();
    }, ESPERA_MS);

    return () => {
      clearTimeout(espera);
    };
  }, [query, selected]);

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
    setSelected(null);
    setQuery("");
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
    return current === null ? <span className="sb-nf-sku-vazio">Sem vínculo</span> : <SkuVinculado sku={current} />;
  }

  if (current !== null && !editing) {
    return (
      <div className="sb-nf-sku-linha">
        <SkuVinculado sku={current} />

        <button
          className="sb-text-button"
          type="button"
          onClick={() => {
            setEditing(true);
          }}
        >
          Trocar
        </button>
      </div>
    );
  }

  const termo = query.trim();
  const tituloEscolhido = selected?.title ?? null;

  return (
    <div className="sb-nf-busca">
      <div className="sb-nf-busca-linha">
        <div className="sb-nf-busca-campo">
          <input
            className="sb-input sb-input-full"
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
            }}
            placeholder="Buscar SKU por código ou nome…"
            aria-label="Buscar SKU para este item"
            autoComplete="off"
            disabled={busy}
          />

          {selected === null && termo.length >= 2 && (
            <div className="sb-nf-busca-lista">
              {searching && results.length === 0 && <p className="sb-nf-busca-vazio">Buscando…</p>}

              {!searching && results.length === 0 && error === null && (
                <p className="sb-nf-busca-vazio">Nenhum SKU com “{termo}”.</p>
              )}

              {results.length > 0 && (
                <ul>
                  {results.map((sku) => (
                    <li key={sku.id}>
                      <button
                        className="sb-button"
                        type="button"
                        onClick={() => {
                          setSelected(sku);
                          setQuery(sku.sku);
                          setResults([]);
                        }}
                      >
                        <b className="sb-mono">{sku.sku}</b>
                        {sku.title !== null && <span>{sku.title}</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <button
          className="sb-button sb-button-primary"
          type="button"
          onClick={() => {
            void confirm();
          }}
          disabled={busy || selected === null}
        >
          Vincular
        </button>

        {/* Trocando um vínculo que existe: "Cancelar" desiste da troca e o SKU
            de antes fica. Antes este botão DESVINCULAVA — quem só queria
            desistir perdia o vínculo. Desvincular agora tem botão próprio. */}
        {current !== null && (
          <button
            className="sb-button"
            type="button"
            onClick={() => {
              setEditing(false);
              setSelected(null);
              setQuery("");
              setError(null);
            }}
            disabled={busy}
          >
            Cancelar
          </button>
        )}
      </div>

      {tituloEscolhido !== null && <p className="sb-nf-busca-escolhido">{tituloEscolhido}</p>}

      {current !== null && (
        <button
          className="sb-text-button sb-nf-desvincular"
          type="button"
          onClick={() => {
            void unlink();
          }}
          disabled={busy}
        >
          Desvincular {current.sku}
        </button>
      )}

      {error !== null && (
        <p role="alert" className="sb-nf-busca-erro">
          {error}
        </p>
      )}
    </div>
  );
}
