"use client";

import { useLinkStatus } from "next/link";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

import { CarregandoTela } from "./carregando";

/**
 * A tela de carregamento para o `<Link>` que só troca o FILTRO da tela.
 *
 * `loading.tsx` só aparece quando um segmento do caminho muda. O "ver lista"
 * da faixa de KPIs e as pílulas de filtro levam para a MESMA página com outra
 * `?busca` — nenhum segmento muda, nenhum `loading.tsx` entra, e a tela velha
 * ficava parada até a nova chegar, sem sinal de que o clique pegou.
 *
 * Vai DENTRO do `<Link>` (é onde `useLinkStatus` enxerga o pendente) e, enquanto
 * a navegação pende, cobre a tela com a MESMA `CarregandoTela` do `loading.tsx`
 * — um carregamento só no app inteiro. A cobertura nasce transparente e só
 * aparece depois de 350 ms, o mesmo atraso do esqueleto: troca rápida não pisca.
 *
 * Por PORTAL no `body`: a tela tem links (a sidebar), e link dentro de link é
 * HTML inválido — o clique cairia no lugar errado. No React ela continua filha
 * do `<Link>` (o que o hook exige); no DOM, fica fora dele.
 */
export function CarregandoSeODemorar(): ReactNode {
  const { pending } = useLinkStatus();

  // `pending` só vira verdadeiro depois de um clique, no navegador: o
  // `document` existe sempre que este ramo roda.
  if (!pending) return null;

  // O portal muda o DOM, não a árvore do React: um clique na sidebar da
  // cobertura SUBIRIA até o `<Link>` de origem e navegaria para o filtro de
  // novo. Parar aqui deixa só o link clicado agir.
  return createPortal(
    <div
      className="sb-carregando-cobertura"
      onClick={(evento) => {
        evento.stopPropagation();
      }}
    >
      <CarregandoTela />
    </div>,
    document.body,
  );
}
