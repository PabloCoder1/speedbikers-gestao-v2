import type { ReactNode } from "react";

/**
 * A EXPLICAÇÃO NO LUGAR, A UM TOQUE (UX_SYSTEM §6, bloco 2).
 *
 * Um termo que só faz sentido para quem fez o sistema (alíquota efetiva,
 * amostra mínima, ROAS) ganha a pergunta que a pessoa faria — "O que é a
 * alíquota efetiva?" — logo abaixo dele, e a resposta abre ali mesmo.
 *
 * `<details>` nativo, e não tooltip: o tooltip só existe com mouse (no toque ele
 * some ou nem abre) e não chega ao leitor de tela; o `<details>` abre com toque,
 * clique, Enter e espaço, e o texto fica no fluxo da página, sem sair da tela no
 * celular. A pergunta escrita, e não só um "?", é o que a torna achável.
 */
export function Ajuda({ pergunta, children }: { pergunta: string; children: ReactNode }): ReactNode {
  return (
    <details className="sb-ajuda">
      <summary>
        <span aria-hidden="true" className="sb-ajuda-icone">
          ?
        </span>
        {pergunta}
      </summary>
      <div className="sb-ajuda-texto">{children}</div>
    </details>
  );
}

export interface TermoDoGlossario {
  readonly termo: string;
  readonly definicao: ReactNode;
}

/**
 * Os termos de uma tela, juntos e recolhidos (UX_SYSTEM §6, bloco 2): para
 * siglas e níveis que aparecem em muitos lugares da mesma tela (ROAS nas
 * células, nas colunas e nos sinais), uma explicação por termo, perto do
 * conteúdo, em vez de repetir a ajuda em cada ocorrência.
 */
export function Glossario({ titulo, termos }: { titulo: string; termos: readonly TermoDoGlossario[] }): ReactNode {
  return (
    <details className="sb-recolhivel sb-glossario">
      <summary>{titulo}</summary>
      <dl className="sb-glossario-lista">
        {termos.map((item) => (
          <div key={item.termo}>
            <dt>{item.termo}</dt>
            <dd>{item.definicao}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
