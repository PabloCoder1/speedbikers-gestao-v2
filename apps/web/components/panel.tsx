import type { ReactNode } from "react";

/**
 * Superfície de conteúdo do Figma (`.panel` + `.panel-head`).
 *
 * O padrão canônico do `DesignSystem.tsx` é `bg-surface border border-border
 * rounded-lg shadow-sm`, e o cabeçalho é sempre o mesmo: título, subtítulo
 * fino embaixo, e uma coisa à direita (legenda, botão, selo).
 *
 * **A sombra é de propósito quase invisível** — o Figma usa navy a 3% —, e o
 * brief proíbe "sombras fortes". Ela não substitui a borda: as duas coexistem
 * no Figma, e é a borda que faz a separação (medido em D2: cartão branco sobre
 * o cinza da página se separa por 1,089:1, ou seja, quase nada).
 *
 * `subtitle` costuma carregar a ressalva da seção — a incompletude que vale
 * para o bloco inteiro mora aqui, não repetida em cada número.
 */
export function Panel({
  title,
  subtitle,
  aside,
  id,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  aside?: ReactNode;
  /** Âncora, para um link de outra parte da tela (a central de alertas aponta para o resumo). */
  id?: string;
  children: ReactNode;
}): ReactNode {
  return (
    <section className="sb-panel" aria-label={title} id={id}>
      <div className="sb-panel-head">
        <div style={{ minWidth: 0 }}>
          <h2>{title}</h2>
          {subtitle !== undefined && <p>{subtitle}</p>}
        </div>

        {aside !== undefined && <div className="sb-panel-aside">{aside}</div>}
      </div>

      {children}
    </section>
  );
}
