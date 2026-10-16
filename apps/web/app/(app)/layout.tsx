import type { ReactNode } from "react";

import { Shell } from "../../components/shell";

/**
 * A MOLDURA PERSISTE ENTRE AS TELAS (D-512).
 *
 * O `Shell` morava dentro de cada `page.tsx`, e uma página não persiste entre
 * navegações: toda troca de tela refazia as 7 leituras do cabeçalho — depois
 * das leituras da própria página, em série, nas 44 telas sem `Suspense` — e
 * remontava sidebar, barra superior, gaveta do Copiloto e toasts. Num layout,
 * a moldura é desenhada uma vez e fica: medido na D-511, a troca de tela faz 4
 * a 6 leituras em vez de 10 a 11.
 *
 * O grupo `(app)` não muda URL nenhuma. Ficam fora dele só as rotas sem
 * moldura: a entrada (`/login`), o sign-out (`/auth`), a API e o
 * redirecionamento de `/cobertura`.
 *
 * As pastas do grupo NÃO têm `loading.tsx`: o React só deixa o conteúdo
 * substituir um esqueleto 300 ms depois de mostrá-lo, e com um esqueleto por
 * pasta toda troca de tela travava nesse piso. A troca mantém a tela anterior
 * com o sinal da D-500 (`IndicadorDeNavegacao` no `Shell`); o esqueleto fica
 * para a carga fria — o `app/loading.tsx`, acima deste layout — e para os
 * blocos lentos dentro da tela (`Suspense`). A guarda é `check:loading`.
 */
export default function AppLayout({ children }: { children: ReactNode }): ReactNode {
  return <Shell>{children}</Shell>;
}
