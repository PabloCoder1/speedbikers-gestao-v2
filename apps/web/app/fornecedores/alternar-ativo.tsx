"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

import { definirAtivo } from "./actions";

/**
 * Ativar ou inativar um fornecedor (D-366) — até aqui só existia como filtro.
 *
 * Inativar pede uma segunda confirmação NA PRÓPRIA LINHA, não um `confirm()`
 * do navegador: o efeito é pequeno e reversível (sai da lista do pedido de
 * compra; histórico e dashboard continuam), mas é fácil de clicar sem querer
 * ao lado de "Editar". Reativar é um clique só.
 */
export function AlternarAtivo({ id, ativo }: { id: string; ativo: boolean }): ReactNode {
  const router = useRouter();
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, startTransition] = useTransition();

  function aplicar(novo: boolean): void {
    setErro(null);

    startTransition(async () => {
      const resultado = await definirAtivo(id, novo);

      if (!resultado.ok) {
        setErro(resultado.mensagem ?? "Não foi possível alterar o estado.");

        return;
      }

      setConfirmando(false);
      router.refresh();
    });
  }

  if (!ativo) {
    return (
      <span className="sb-forn-alternar">
        <button
          type="button"
          className="sb-button"
          disabled={salvando}
          onClick={() => {
            aplicar(true);
          }}
        >
          {salvando ? "Reativando…" : "Reativar"}
        </button>
        {erro !== null && (
          <span className="sb-campo-erro" role="alert">
            {erro}
          </span>
        )}
      </span>
    );
  }

  if (!confirmando) {
    return (
      <button
        type="button"
        className="sb-button"
        onClick={() => {
          setConfirmando(true);
        }}
      >
        Inativar
      </button>
    );
  }

  return (
    <span className="sb-forn-alternar sb-forn-alternar-confirma" role="group" aria-label="Confirmar inativação">
      <span>Sai da lista de novos pedidos; o histórico fica.</span>
      <button
        type="button"
        className="sb-button sb-button-danger"
        disabled={salvando}
        onClick={() => {
          aplicar(false);
        }}
      >
        {salvando ? "Inativando…" : "Inativar"}
      </button>
      <button
        type="button"
        className="sb-button"
        disabled={salvando}
        onClick={() => {
          setConfirmando(false);
        }}
      >
        Cancelar
      </button>
      {erro !== null && (
        <span className="sb-campo-erro" role="alert">
          {erro}
        </span>
      )}
    </span>
  );
}
