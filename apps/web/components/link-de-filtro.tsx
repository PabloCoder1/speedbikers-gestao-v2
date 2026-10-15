import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { CarregandoSeODemorar } from "./carregando-link";

/**
 * O `<Link>` que fica na MESMA tela — paginação, aba, chip, ordenação, "limpar"
 * — com a atualização no lugar de D-500 já dentro (D-501).
 *
 * Um `<Link>` comum para outra `?busca` da mesma página não troca segmento, não
 * mostra `loading.tsx` e deixava a tela parada até a nova chegar. A D-500 pôs o
 * `CarregandoSeODemorar` nos componentes compartilhados; os links escritos à mão
 * nas telas (45 na auditoria) continuaram sem nada. Este componente é a forma
 * curta de não esquecer: troque `<Link>` por `<LinkDeFiltro>` quando o destino é
 * a própria tela. Para outra tela, `<Link>` comum — ali o `loading.tsx` cuida.
 *
 * Aceita tudo o que o `<Link>` aceita (classe, `aria-current`, `scroll`…).
 */
export function LinkDeFiltro({ children, ...props }: ComponentProps<typeof Link>): ReactNode {
  return (
    <Link {...props}>
      {children}
      <CarregandoSeODemorar />
    </Link>
  );
}
