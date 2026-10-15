"use client";

import type { MouseEvent, ReactNode } from "react";

/**
 * "Pular para o conteúdo" (D-508): o primeiro ponto de foco de toda tela.
 *
 * A auditoria de acessibilidade contou **42 paradas de Tab** antes do primeiro
 * controle do conteúdo, em todas as 20 telas medidas — a sidebar inteira,
 * a busca e o cabeçalho, a cada página. O link fica invisível até receber
 * foco e leva o foco para o `<main id="conteudo">`.
 *
 * **Por que não um `<a href="#conteudo">` puro.** O salto por âncora cria uma
 * entrada no histórico que não é do roteador, e o App Router RECARREGA a
 * página inteira quando o "voltar" cai numa entrada dessas
 * (`next/dist/client/components/app-router.js`, `onPopState`). Aqui o clique
 * move o foco sem tocar no histórico. Sem JavaScript (antes da hidratação), o
 * `href` ainda funciona como âncora.
 */
export function PularParaConteudo(): ReactNode {
  function pular(evento: MouseEvent<HTMLAnchorElement>): void {
    const alvo = document.getElementById("conteudo");

    if (alvo === null) return;

    evento.preventDefault();
    alvo.focus();
    alvo.scrollIntoView({ block: "start" });
  }

  return (
    <a className="sb-pular" href="#conteudo" onClick={pular}>
      Pular para o conteúdo
    </a>
  );
}
