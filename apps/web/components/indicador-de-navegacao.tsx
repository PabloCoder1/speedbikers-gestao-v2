"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

import { AtualizandoTela } from "./carregando-link";

/** Rede de segurança: uma navegação que falhou ou foi cancelada não deixa a barra presa. */
const DESISTE_EM_MS = 15_000;

/**
 * O SINAL DE TODA TROCA DE TELA (D-512).
 *
 * Com o `Shell` num layout, as pastas do grupo `(app)` deixaram de ter
 * `loading.tsx`: trocar de tela mantém a tela anterior até a nova chegar, sem
 * a trava de ~300 ms que o React põe entre um esqueleto mostrado e o conteúdo
 * (`globalMostRecentFallbackTime + 300`, medido na D-511). Sem nada no lugar, o
 * clique num link para outra tela voltaria a ser o defeito da D-382: a tela
 * parada, sem sinal de que o clique pegou.
 *
 * Este componente mora no `Shell` — que agora persiste entre as telas — e dá a
 * toda troca de tela por link o MESMO retorno da atualização no lugar (D-500):
 * a barra da moldura aos 100 ms, o conteúdo esmaecido aos 400 ms e o
 * `aria-busy`. Ele escuta o clique em qualquer `<a>` interno, e o sinal some
 * quando o caminho muda — o fim da própria navegação, sem temporizador.
 *
 * Fica de fora o que já tem retorno próprio: troca só de `?filtro=` na mesma
 * tela (os componentes da D-500), links que se marcam com
 * `data-pendente-proprio` (a sidebar, com `useLinkStatus`), link externo, nova
 * aba, download e clique com tecla modificadora.
 */
export function IndicadorDeNavegacao(): ReactNode {
  const caminho = usePathname();
  const [navegando, setNavegando] = useState(false);

  // A tela nova chegou: o caminho mudou.
  useEffect(() => {
    setNavegando(false);
  }, [caminho]);

  useEffect(() => {
    function aoClicar(evento: MouseEvent): void {
      if (evento.button !== 0 || evento.metaKey || evento.ctrlKey || evento.shiftKey || evento.altKey) return;

      const alvo = evento.target instanceof Element ? evento.target.closest("a[href]") : null;

      if (!(alvo instanceof HTMLAnchorElement)) return;
      if (alvo.hasAttribute("data-pendente-proprio") || alvo.hasAttribute("download")) return;
      if (alvo.target !== "" && alvo.target !== "_self") return;

      const destino = new URL(alvo.href, window.location.href);

      if (destino.origin !== window.location.origin || destino.pathname === window.location.pathname) return;

      setNavegando(true);
    }

    document.addEventListener("click", aoClicar, { capture: true });

    return () => {
      document.removeEventListener("click", aoClicar, { capture: true });
    };
  }, []);

  useEffect(() => {
    if (!navegando) return;

    const desistir = window.setTimeout(() => {
      setNavegando(false);
    }, DESISTE_EM_MS);

    return () => {
      window.clearTimeout(desistir);
    };
  }, [navegando]);

  return navegando ? <AtualizandoTela /> : null;
}
