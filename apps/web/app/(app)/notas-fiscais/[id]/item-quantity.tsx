"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { lerTokenDeSessao } from "../../../../lib/chamar-api";
import { formatCount } from "../../../../lib/format";
import { mensagemDaApi, respostaDeEdicaoDeItemValida } from "../../../../lib/saida-manual";

/**
 * Quantidade de um item lido, editável enquanto o documento está em
 * conferência (D-766): o envio ao Full traz 12 e saem 10; a nota traz um item
 * que não veio. "Alterar" muda a quantidade, "Remover" tira o item — o que for
 * confirmado depois é o que está na tela.
 *
 * A escrita passa pela `api` (POST, o CORS só libera GET/POST), que confere a
 * organização, o papel e o estado do documento. Depois, `router.refresh()`
 * traz de volta a contagem, o "Disponível" e a barra de confirmação.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "";

/** O que `document_items.quantity` (numeric(14,3), > 0) aceita. */
function quantidadeDoItem(texto: string): number | null {
  const limpo = texto.trim().replace(",", ".");

  if (!/^\d+(\.\d{1,3})?$/.test(limpo)) return null;

  const valor = Number(limpo);

  return valor > 0 && valor <= 1_000_000_000 ? valor : null;
}

export function ItemQuantity({
  documentId,
  itemId,
  quantity,
  unit,
  editable,
}: {
  documentId: string;
  itemId: number;
  quantity: number;
  unit: string | null;
  editable: boolean;
}): ReactNode {
  const router = useRouter();

  const [modo, setModo] = useState<"ver" | "editar" | "remover">("ver");
  const [valor, setValor] = useState(String(quantity));
  const [acao, setAcao] = useState<"salvando" | "removendo" | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const leitura = (
    <>
      <b>{formatCount(quantity)}</b>
      {unit === null ? "" : <small> {unit}</small>}
    </>
  );

  if (!editable) return leitura;

  async function enviar(comando: { acao: "quantidade"; quantidade: number } | { acao: "remover" }): Promise<void> {
    setAcao(comando.acao === "remover" ? "removendo" : "salvando");
    setErro(null);

    const sessao = await lerTokenDeSessao("Sua sessão expirou. Entre de novo.");

    if (!sessao.ok) {
      setErro(sessao.mensagem);
      setAcao(null);

      return;
    }

    let resposta: Response;

    try {
      resposta = await fetch(`${API_URL}/v1/nfe-imports/${documentId}/items/${String(itemId)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${sessao.token}`, "content-type": "application/json" },
        body: JSON.stringify(comando),
      });
    } catch {
      setErro("Não foi possível falar com o servidor.");
      setAcao(null);

      return;
    }

    const payload: unknown = await resposta.json().catch(() => null);

    if (!resposta.ok || !respostaDeEdicaoDeItemValida(payload)) {
      setErro(
        mensagemDaApi(payload) ??
          (resposta.ok
            ? "O servidor respondeu em formato inesperado. Recarregue e confira o item."
            : "Não foi possível alterar o item."),
      );
      setAcao(null);

      return;
    }

    setModo("ver");
    setAcao(null);
    router.refresh();
  }

  const nova = quantidadeDoItem(valor);
  const ocupado = acao !== null;

  return (
    <div className="sb-nf-qtd">
      {modo === "editar" ? (
        <span className="sb-nf-qtd-edicao">
          <input
            className="sb-input sb-saida-qtd"
            inputMode="decimal"
            value={valor}
            onChange={(event) => {
              setValor(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !ocupado && nova !== null && nova !== quantity) {
                void enviar({ acao: "quantidade", quantidade: nova });
              }

              if (event.key === "Escape" && !ocupado) {
                setModo("ver");
                setValor(String(quantity));
                setErro(null);
              }
            }}
            aria-label="Nova quantidade do item"
            aria-invalid={nova === null}
            disabled={ocupado}
            // O campo só aparece porque a pessoa pediu para alterar.
            autoFocus
          />
          <button
            className="sb-button sb-button-sm sb-button-primary"
            type="button"
            onClick={() => {
              if (nova !== null) void enviar({ acao: "quantidade", quantidade: nova });
            }}
            disabled={ocupado || nova === null || nova === quantity}
          >
            {acao === "salvando" ? "Salvando…" : "Salvar"}
          </button>
          <button
            className="sb-button sb-button-sm"
            type="button"
            onClick={() => {
              setModo("ver");
              setValor(String(quantity));
              setErro(null);
            }}
            disabled={ocupado}
          >
            Cancelar
          </button>
        </span>
      ) : (
        <span>{leitura}</span>
      )}

      {modo === "ver" && (
        <span className="sb-nf-qtd-acoes">
          <button
            className="sb-text-button"
            type="button"
            onClick={() => {
              setValor(String(quantity));
              setModo("editar");
            }}
          >
            Alterar
          </button>
          <button
            className="sb-text-button sb-saida-remover"
            type="button"
            onClick={() => {
              setModo("remover");
            }}
          >
            Remover
          </button>
        </span>
      )}

      {modo === "remover" && (
        <span className="sb-nf-qtd-acoes">
          <span>Tirar do documento?</span>
          <button
            className="sb-text-button sb-saida-remover"
            type="button"
            onClick={() => {
              void enviar({ acao: "remover" });
            }}
            disabled={ocupado}
          >
            {acao === "removendo" ? "Removendo…" : "Sim, remover"}
          </button>
          <button
            className="sb-text-button"
            type="button"
            onClick={() => {
              setModo("ver");
              setErro(null);
            }}
            disabled={ocupado}
          >
            Não
          </button>
        </span>
      )}

      {erro !== null && (
        <p role="alert" className="sb-nf-qtd-erro">
          {erro}
        </p>
      )}
    </div>
  );
}
