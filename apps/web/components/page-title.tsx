import type { ReactNode } from "react";

/**
 * Cabeçalho de página do Figma (`.page-title`).
 *
 * Três coisas à esquerda — sobrancelha, título, subtítulo — e uma barra de
 * ações à direita. É o primeiro dos componentes de composição desta frente:
 * até aqui cada tela montava o próprio cabeçalho inline, e por isso não havia
 * dois iguais.
 *
 * **A sobrancelha não é enfeite.** No Figma ela diz o caminho
 * ("COMERCIAL / RESULTADOS", "ESTOQUE / PLANEJAMENTO"), e é o que dá contexto
 * de seção agora que a navegação é uma sidebar com grupos: o rótulo do grupo
 * aceso e a sobrancelha dizem a mesma coisa, de dois lugares.
 *
 * `aside` recebe qualquer coisa que o Figma põe à direita do título — a barra
 * de filtros, um selo de frescor, um botão primário.
 */
export function PageTitle({
  eyebrow,
  title,
  subtitle,
  aside,
}: {
  eyebrow: string;
  title: string;
  subtitle?: ReactNode;
  aside?: ReactNode;
}): ReactNode {
  return (
    <div className="sb-page-title">
      <div style={{ minWidth: 0 }}>
        <span className="sb-eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {subtitle !== undefined && <p>{subtitle}</p>}
      </div>

      {aside !== undefined && <div className="sb-toolbar">{aside}</div>}
    </div>
  );
}
