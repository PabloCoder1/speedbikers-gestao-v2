"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A GAVETA do Figma (`.drawer` do export, `QuickDetailDrawer` e os quatro
 * irmãos dele no frame).
 *
 * Era o último elemento de COMPOSIÇÃO do desenho que a V3 nunca tinha
 * implementado — adiado desde A1, e a auditoria de fidelidade registrava a
 * ausência do `.sb-drawer` como a diferença que restava no design system.
 *
 * Ela nasce genérica de propósito: o frame tem CINCO gavetas (Inspeção
 * Rápida, MLB, pedido, fornecedor, usuário) e todas compartilham a mesma
 * moldura — sobrancelha + fechar no topo, corpo que rola, ações no rodapé. O
 * que muda é o conteúdo. Repetir a moldura em cada uma seria a duplicação que
 * D-246 encontrou nos cinco mapas de tom.
 *
 * ## O que ela NÃO faz, e por quê
 *
 * Não é um `<dialog>` nativo e não prende o foco. A camada flutuante desta
 * casa já tem uma forma — `.sb-backdrop` + `role="dialog"` + `Escape`, escrita
 * em `saved-filters.tsx` e na paleta de comando —, e uma gaveta com armadilha
 * de foco ao lado de dois modais sem ela seriam três comportamentos para a
 * mesma camada. Aprofundar acessibilidade da camada é uma fatia própria, e
 * vale para as três de uma vez.
 */
/**
 * A LINHA DE FATO da gaveta (`.detail-row` do export): rótulo à esquerda,
 * valor à direita, ressalva embaixo do valor.
 *
 * Nasceu componente na segunda gaveta, não na primeira: com um consumidor era
 * markup; com cinco, seria a mesma marcação repetida cinco vezes — que é como
 * os cinco mapas de tom de D-246 apareceram.
 */
export function DetailRow({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  /** A ressalva que diz DE ONDE o valor vem, ou por que ele é "—". */
  note?: ReactNode;
}): ReactNode {
  return (
    <div className="sb-detail-row">
      <span>{label}</span>
      <b>
        {value}
        {note !== undefined && <small>{note}</small>}
      </b>
    </div>
  );
}

export function Drawer({
  eyebrow,
  label,
  onClose,
  footer,
  children,
}: {
  /** A sobrancelha do frame: "INSPEÇÃO RÁPIDA", "DETALHE DE ANÚNCIO"… */
  eyebrow: string;
  /** O que o leitor de tela anuncia ao abrir. */
  label: string;
  onClose: () => void;
  /** As ações do rodapé. Sem elas o rodapé não é renderizado. */
  footer?: ReactNode;
  children: ReactNode;
}): ReactNode {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  /*
    PORTAL, e isso não é preferência de arquitetura — é correção de um defeito
    que só a captura mostrou.

    O gatilho da primeira gaveta mora dentro da célula "SKU 1234" da tabela de
    produtos, que é monoespaçada de propósito (o mono do Figma). Renderizada ali
    dentro, a gaveta ficava `position: fixed` — solta do layout — mas continuava
    HERDANDO a fonte: título, valores e botões saíam todos em DM Mono. Uma
    camada flutuante não pode depender de onde o botão que a abre está: pelo
    `document.body` ela herda do `<html>`, como o resto da aplicação.

    Nunca é renderizada no servidor (o pai só a monta depois do clique), então
    `document` existe sempre que esta linha roda.
  */
  return createPortal(
    <div className="sb-backdrop sb-backdrop-lateral" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="sb-drawer"
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        <div className="sb-drawer-head">
          <span className="sb-modal-eyebrow">{eyebrow}</span>
          <button type="button" className="sb-close" aria-label="Fechar" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="sb-drawer-body">{children}</div>

        {footer !== undefined && <div className="sb-drawer-foot">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}
