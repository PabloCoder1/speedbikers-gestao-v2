"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { updateProfileName } from "./perfil-actions";

/**
 * Editar o nome no lugar (D-354) — na gaveta de `/usuarios` e no "Meu perfil".
 *
 * Fechado, é um link discreto ao lado do nome; aberto, é o campo com Salvar e
 * Cancelar. Um formulário sempre aberto na gaveta faria o nome parecer campo
 * vazio a preencher, e a gaveta existe para LER a pessoa primeiro.
 */
export function EditarNome({ userId, nome }: { userId: string; nome: string | null }): ReactNode {
  const router = useRouter();
  const [editando, setEditando] = useState(false);
  const [valor, setValor] = useState(nome ?? "");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function salvar(): Promise<void> {
    setSalvando(true);
    setErro(null);

    const resultado = await updateProfileName(userId, valor);

    setSalvando(false);

    if (!resultado.ok) {
      setErro(resultado.message);

      return;
    }

    setEditando(false);
    router.refresh();
  }

  if (!editando) {
    return (
      <button
        type="button"
        className="sb-text-button sb-editar-nome"
        onClick={() => {
          setValor(nome ?? "");
          setErro(null);
          setEditando(true);
        }}
      >
        {nome === null ? "Adicionar nome" : "Editar nome"}
      </button>
    );
  }

  return (
    <form
      className="sb-editar-nome-form"
      onSubmit={(event) => {
        event.preventDefault();
        void salvar();
      }}
    >
      <input
        className="sb-input"
        aria-label="Nome completo"
        value={valor}
        maxLength={200}
        autoFocus
        disabled={salvando}
        onChange={(event) => {
          setValor(event.target.value);
        }}
      />
      <button type="submit" className="sb-button sb-button-primary sb-button-sm" disabled={salvando || valor.trim() === ""}>
        {salvando ? "Salvando…" : "Salvar"}
      </button>
      <button
        type="button"
        className="sb-button sb-button-sm"
        disabled={salvando}
        onClick={() => {
          setEditando(false);
        }}
      >
        Cancelar
      </button>
      {erro !== null && (
        <span role="alert" className="sb-campo-erro">
          {erro}
        </span>
      )}
    </form>
  );
}
