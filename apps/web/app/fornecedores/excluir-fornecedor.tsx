"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";

import { Icone } from "../../components/icons";
import { excluirFornecedor } from "./actions";

/**
 * Excluir um fornecedor (D-372).
 *
 * Só existe para fornecedor SEM pedido de compra — o cadastro feito por engano.
 * Com pedido, o botão não some: ele explica, na linha, por que não dá e aponta
 * para "Inativar", que é o caminho que preserva o histórico. O banco recusa de
 * qualquer jeito (`delete_supplier`); a tela só não deixa a pessoa descobrir
 * isso depois de confirmar.
 *
 * Confirmação na própria linha, como `AlternarAtivo`, e não um `confirm()` do
 * navegador. Aqui ela é mais explícita: excluir não se desfaz.
 */
export function ExcluirFornecedor({
  id,
  nome,
  pedidos,
}: {
  id: string;
  nome: string;
  /** Quantos pedidos de compra o fornecedor tem. `null` = não foi possível ler; o banco decide. */
  pedidos: number | null;
}): ReactNode {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [excluindo, startTransition] = useTransition();

  function excluir(): void {
    setErro(null);

    startTransition(async () => {
      const resultado = await excluirFornecedor(id);

      if (!resultado.ok) {
        setErro(resultado.mensagem);

        return;
      }

      router.push("/fornecedores");
      router.refresh();
    });
  }

  if (!aberto) {
    return (
      <button
        type="button"
        className="sb-button sb-forn-excluir"
        onClick={() => {
          setAberto(true);
        }}
      >
        <Icone nome="lixeira" tamanho={14} />
        Excluir
      </button>
    );
  }

  if (pedidos !== null && pedidos > 0) {
    return (
      <span className="sb-forn-alternar sb-forn-alternar-confirma sb-forn-excluir-confirma" role="group" aria-label="Excluir fornecedor">
        <span>
          Não dá para excluir: {pedidos === 1 ? "há 1 pedido de compra" : `há ${String(pedidos)} pedidos de compra`} com
          este fornecedor. Inative-o — ele sai de novos pedidos e o histórico fica.
        </span>
        <button
          type="button"
          className="sb-button"
          onClick={() => {
            setAberto(false);
          }}
        >
          Entendi
        </button>
      </span>
    );
  }

  return (
    <span className="sb-forn-alternar sb-forn-alternar-confirma sb-forn-excluir-confirma" role="group" aria-label="Confirmar exclusão">
      <span>
        Excluir <b>{nome}</b> de vez, com a logo? Não dá para desfazer.
      </span>
      <button type="button" className="sb-button sb-button-danger" disabled={excluindo} onClick={excluir}>
        {excluindo ? "Excluindo…" : "Excluir de vez"}
      </button>
      <button
        type="button"
        className="sb-button"
        disabled={excluindo}
        onClick={() => {
          setAberto(false);
          setErro(null);
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
