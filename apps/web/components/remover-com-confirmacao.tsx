"use client";

import { useState, type ReactNode } from "react";

import { BotaoEnviar } from "./botao-enviar";

/**
 * A AÇÃO DESTRUTIVA PEDE CONFIRMAÇÃO, NO LUGAR (UX_SYSTEM §6, bloco 2).
 *
 * O "remover" das metas e da alíquota apagava com um clique só, e o "Voltar aos
 * padrões" dos limites desfazia tudo da mesma forma. Aqui o primeiro clique só
 * pergunta: o grupo "Confirmar…" aparece no lugar do botão, com o que vai
 * acontecer, a confirmação e "Cancelar". A confirmação manda o formulário para a
 * ação de servidor de quem chama, com o pendente do `BotaoEnviar` (D-502).
 *
 * O mesmo padrão que modelos de resposta, compras e fornecedores escreveram cada
 * um à sua maneira; este é o compartilhado, para a próxima ação destrutiva não
 * criar outra cópia.
 */
export function RemoverComConfirmacao({
  acao,
  campos = {},
  rotulo,
  consequencia,
  textoDoBotao = "remover",
  textoDaConfirmacao = "Remover",
  pendente = "Removendo…",
}: {
  /** A ação de servidor; recebe o formulário com os `campos`. */
  acao: (dados: FormData) => void | Promise<void>;
  /** Os campos escondidos que a ação lê (a tabela e o id, nas metas). */
  campos?: Readonly<Record<string, string>>;
  /** O nome acessível do botão, que diz O QUÊ sai ("Remover a meta de outubro de 2026"). */
  rotulo: string;
  /** O que acontece ao confirmar, numa frase curta. */
  consequencia: string;
  /** O texto do botão que abre a confirmação. */
  textoDoBotao?: string;
  /** O texto do botão que confirma. */
  textoDaConfirmacao?: string;
  /** O que o botão diz enquanto a ação corre. */
  pendente?: string;
}): ReactNode {
  const [confirmando, setConfirmando] = useState(false);

  if (!confirmando) {
    return (
      <button
        type="button"
        className="sb-text-button"
        aria-label={rotulo === textoDoBotao ? undefined : rotulo}
        onClick={() => {
          setConfirmando(true);
        }}
      >
        {textoDoBotao}
      </button>
    );
  }

  return (
    <form action={acao} className="sb-confirmacao sb-confirmacao-perigo sb-remover-confirmacao" role="group" aria-label={`Confirmar: ${rotulo}`}>
      {Object.entries(campos).map(([nome, valor]) => (
        <input key={nome} type="hidden" name={nome} value={valor} />
      ))}
      <span className="sb-remover-confirmacao-texto">{consequencia}</span>
      <BotaoEnviar className="sb-button sb-button-danger" pendente={pendente}>
        {textoDaConfirmacao}
      </BotaoEnviar>
      <button
        type="button"
        className="sb-button"
        onClick={() => {
          setConfirmando(false);
        }}
      >
        Cancelar
      </button>
    </form>
  );
}
