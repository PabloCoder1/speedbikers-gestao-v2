import Link from "next/link";
import type { ReactNode } from "react";

import { TOM, type Tom } from "./tone";

/**
 * Cabeçalho de entidade — o "Object Header" do `DesignSystem.tsx` do Figma, que
 * lá é declarado como **o padrão de SKU, anúncio, pedido de compra e
 * fornecedor**. É o componente de maior alavanca desta frente: quatro telas de
 * detalhe montavam quatro cabeçalhos diferentes.
 *
 * A ordem é a do design system, e cada linha tem um papel:
 *
 *   sobrancelha monoespaçada   o IDENTIFICADOR (SKU 5821, MLB440901) — o que
 *                              se copia, se busca e se cola em outro sistema
 *   título                     o nome humano
 *   selos + meta               o ESTADO, e quando foi visto pela última vez
 *   ações à direita            o que se pode fazer com a entidade
 *   abas                       separadas por uma borda, com a atual sublinhada
 *
 * **O identificador vem em mono e a sobrancelha, não no `<h1>`.** Era o
 * contrário: a tela de SKU abria com `<h1>E2E-SKU-001</h1>` e o nome do produto
 * como parágrafo cinza. O código do SKU é chave, não título — quem lê a tela
 * procura o produto, e quem copia procura a chave.
 *
 * `meta` é opcional e fica ao lado dos selos: no Figma é "Atualizado há 3
 * minutos". Só entra quando existe um instante real para mostrar — data
 * inventada de frescor é a classe de mentira que este projeto persegue.
 */
export interface ObjectBadge {
  readonly label: string;
  readonly tom: Tom;
}

export interface ObjectTab {
  readonly href: string;
  readonly label: string;
  readonly active: boolean;
}

export function ObjectHeader({
  identificador,
  titulo,
  badges = [],
  meta,
  acoes,
  abas,
  children,
}: {
  identificador: string;
  titulo: string;
  badges?: readonly ObjectBadge[];
  meta?: ReactNode;
  acoes?: ReactNode;
  abas?: readonly ObjectTab[];
  /** Conteúdo da aba, dentro do mesmo cartão — como no frame. */
  children?: ReactNode;
}): ReactNode {
  return (
    <section className="sb-object" aria-label={titulo}>
      <div className="sb-object-head">
        <div style={{ minWidth: 0 }}>
          <span className="sb-object-id">{identificador}</span>
          <h1 className="sb-object-title">{titulo}</h1>

          {(badges.length > 0 || meta !== undefined) && (
            <div className="sb-object-badges">
              {badges.map((badge) => (
                <span key={badge.label} className="sb-status" style={TOM[badge.tom]}>
                  {badge.label}
                </span>
              ))}
              {meta !== undefined && <span className="sb-object-meta">{meta}</span>}
            </div>
          )}
        </div>

        {acoes !== undefined && <div className="sb-object-actions">{acoes}</div>}
      </div>

      {abas !== undefined && abas.length > 0 && (
        <nav aria-label="Abas do SKU" className="sb-object-tabs">
          {abas.map((aba) => (
            <Link key={aba.href} href={aba.href} aria-current={aba.active ? "page" : undefined}>
              {aba.label}
            </Link>
          ))}
        </nav>
      )}

      {children !== undefined && <div className="sb-object-body">{children}</div>}
    </section>
  );
}
