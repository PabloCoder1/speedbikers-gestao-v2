"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { confirmarAplicacaoNaApi } from "../../../../lib/chamar-api";

/**
 * Confirmação humana da aplicação da NF-e.
 *
 * Mesmo padrão de `apps/web/app/(app)/importacoes/[id]/confirm-apply-form.tsx`,
 * com uma diferença: só fica habilitado quando TODOS os itens estão
 * vinculados (`confirmNfeApply` recusaria de qualquer forma — o botão
 * desabilitado evita a viagem ao servidor só para ouvir "não").
 */

export function ConfirmApplyForm({
  documentId,
  totalItems,
  resolvedItems,
  unidades,
  direcao,
}: {
  documentId: string;
  totalItems: number;
  resolvedItems: number;
  /** Soma das quantidades dos itens: o que entra ou sai da loja. */
  unidades: number;
  /** `ENTRADA` | `SAIDA` (D-375): o botão diz o que vai acontecer, como no UpSeller. */
  direcao: string | null;
}): ReactNode {
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = totalItems > 0 && resolvedItems === totalItems;
  const rotulo =
    direcao === "SAIDA" ? "Confirmar e dar saída" : direcao === "ENTRADA" ? "Confirmar e dar entrada" : "Confirmar aplicação";
  const quantas = `${unidades.toLocaleString("pt-BR")} unidade${unidades === 1 ? "" : "s"}`;
  const efeito =
    direcao === "SAIDA"
      ? `${unidades === 1 ? "Sai" : "Saem"} ${quantas} do estoque da loja.`
      : direcao === "ENTRADA"
        ? `${unidades === 1 ? "Entra" : "Entram"} ${quantas} no estoque da loja.`
        : "Confirmar gera os movimentos de estoque deste documento.";

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);

    const resultado = await confirmarAplicacaoNaApi(`/v1/nfe-imports/${documentId}/apply`);

    if (!resultado.ok) {
      setError(resultado.mensagem);
      setBusy(false);

      return;
    }

    router.refresh();
  }

  return (
    /*
      A barra fica presa ao pé da tela (`position: sticky`) enquanto a pessoa
      desce pela lista de itens: é o lugar onde o "quanto falta" e o botão
      precisam estar quando o último vínculo é feito, não lá em cima.
    */
    <div className={ready ? "sb-nf-confirmar sb-nf-confirmar-pronto" : "sb-nf-confirmar"}>
      <div className="sb-nf-confirmar-texto">
        {ready ? (
          <>
            <b>Tudo vinculado — {totalItems} de {totalItems} itens.</b>
            <span>{efeito} Isto não pode ser desfeito com um novo envio do mesmo arquivo.</span>
          </>
        ) : (
          <>
            <b>
              {resolvedItems} de {totalItems} itens vinculados
            </b>
            <span>Vincule todos antes de confirmar — um documento só é aplicado por completo, nunca parcialmente.</span>
          </>
        )}
        {error !== null && (
          <p role="alert" className="sb-nf-confirmar-erro">
            {error}
          </p>
        )}
      </div>

      <button
        className="sb-button sb-button-primary"
        type="button"
        onClick={() => {
          void confirm();
        }}
        disabled={busy || !ready}
      >
        {busy ? "Confirmando…" : rotulo}
      </button>
    </div>
  );
}
