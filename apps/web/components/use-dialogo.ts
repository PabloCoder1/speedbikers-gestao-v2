"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * O comportamento mínimo de um diálogo modal (lote 3 do pente fino, 18/09):
 * Esc fecha, o foco entra no diálogo ao abrir e volta para quem o abriu ao
 * fechar, e a página por trás não rola. `/vinculacoes` já fazia as duas últimas
 * coisas à mão; três diálogos — um deles o de republicar, IRREVERSÍVEL — não
 * faziam nenhuma, e quem usa teclado ficava preso atrás do fundo escuro.
 *
 * O foco vai para o elemento marcado com `data-foco-inicial`, ou para o
 * primeiro controle do diálogo. Nos diálogos destrutivos a marca fica no
 * "Cancelar": Enter por reflexo não pode confirmar o que não tem volta.
 *
 * `podeFechar = false` enquanto grava: Esc no meio da escrita deixaria a tela
 * sem dizer se ela aconteceu.
 */
export function useDialogo<T extends HTMLElement>(
  aberto: boolean,
  fechar: () => void,
  podeFechar = true,
): RefObject<T | null> {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!aberto) return undefined;

    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialogo = ref.current;
    const alvo =
      dialogo?.querySelector<HTMLElement>("[data-foco-inicial]") ??
      dialogo?.querySelector<HTMLElement>("button, [href], input, select, textarea") ??
      null;

    alvo?.focus();

    const overflow = document.body.style.overflow;

    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
      anterior?.focus();
    };
  }, [aberto]);

  useEffect(() => {
    if (!aberto) return undefined;

    const tecla = (evento: KeyboardEvent): void => {
      if (evento.key === "Escape" && podeFechar) fechar();
    };

    window.addEventListener("keydown", tecla);

    return () => {
      window.removeEventListener("keydown", tecla);
    };
  }, [aberto, fechar, podeFechar]);

  return ref;
}
