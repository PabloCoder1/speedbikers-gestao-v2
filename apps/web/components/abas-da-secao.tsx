import Link from "next/link";
import type { ReactNode } from "react";

import { CarregandoSeODemorar } from "./carregando-link";

export interface AbaDaSecao {
  readonly href: string;
  readonly label: string;
  readonly ativa: boolean;
}

/**
 * AS ABAS DE UMA ÁREA COM VÁRIAS TELAS (UX_SYSTEM §6, bloco 1).
 *
 * A mesma forma das abas do cabeçalho de entidade (`.sb-object-tabs`, as do SKU):
 * caixa-alta, a atual sublinhada em navy, e rolagem lateral em vez de quebra de
 * linha no celular. A diferença é o lugar: aqui elas ficam logo abaixo do título
 * da página, sem o cartão em volta (`.sb-abas-secao`).
 *
 * Cada aba tem o pendente próprio (`CarregandoSeODemorar`), e por isso se marca
 * com `data-pendente-proprio`: o `IndicadorDeNavegacao` não põe uma segunda
 * barra (D-512).
 */
export function AbasDaSecao({ rotulo, abas }: { rotulo: string; abas: readonly AbaDaSecao[] }): ReactNode {
  return (
    <nav aria-label={rotulo} className="sb-object-tabs sb-abas-secao">
      {abas.map((aba) => (
        <Link key={aba.label} href={aba.href} aria-current={aba.ativa ? "page" : undefined} data-pendente-proprio="">
          {aba.label}
          <CarregandoSeODemorar />
        </Link>
      ))}
    </nav>
  );
}
