"use client";

import type { MouseEvent, ReactNode } from "react";

/**
 * A LINHA INTEIRA ABRE A GAVETA (D-355), como a linha clicável do frame.
 *
 * O gatilho de verdade continua sendo o botão do nome: é ele que recebe foco,
 * responde a Enter e dá nome à ação para o leitor de tela. Esta linha só
 * repassa a ele o clique que caiu em área neutra.
 *
 * **Por que não o `::after` esticado sobre a linha**, que é o truque de CSS
 * usual: ele depende de o `<tr>` servir de referência para `position:
 * absolute`, e isso não é garantido em tabela — medido na prévia, o clique no
 * meio da linha não chegava a lugar nenhum. Pior: quando o navegador ignora o
 * `position: relative` da linha, a camada sobe até a página inteira, e um
 * clique em qualquer lugar abriria a gaveta de alguém.
 *
 * Clique em botão, link, campo ou rótulo dentro da linha segue o dele — e texto
 * selecionado com o mouse não vira clique.
 */
export function LinhaClicavel({ className, children }: { className: string; children: ReactNode }): ReactNode {
  function aoClicar(evento: MouseEvent<HTMLTableRowElement>): void {
    const alvo = evento.target as HTMLElement;

    if (alvo.closest("button, a, input, select, textarea, label") !== null) return;

    if ((window.getSelection()?.toString() ?? "") !== "") return;

    evento.currentTarget.querySelector<HTMLButtonElement>(".sb-entity-button")?.click();
  }

  return (
    <tr className={className} onClick={aoClicar}>
      {children}
    </tr>
  );
}
