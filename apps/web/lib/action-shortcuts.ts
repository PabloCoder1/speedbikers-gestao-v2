/**
 * Atalhos operacionais da Central de Ações (D-154, Fase 6B).
 *
 * O ROADMAP nomeava a dor: "hoje não existe um único link, e a recomendação
 * gerada manda abrir telas que a interface não oferece". A regra deste
 * módulo é a inversa: **só se aponta para tela que EXISTE, com o filtro que
 * ela realmente tem** — `/anuncios?busca=` (D-138) e `/reposicao?busca=`
 * (D-147) existem; `/atendimento` NÃO tem filtro por SKU, então o atalho de
 * reclamações leva à Caixa de Entrada inteira, sem fingir um filtro.
 *
 * Puro e total: `kind` desconhecido degrada para os atalhos genéricos do
 * SKU, nunca para link morto.
 */

export interface ActionShortcut {
  readonly label: string;
  readonly href: string;
}

export function actionShortcuts(input: {
  kind: string;
  skuId: string | null;
  sku: string | null;
}): ActionShortcut[] {
  const shortcuts: ActionShortcut[] = [];

  if (input.skuId !== null) {
    // O hub: diagnóstico, simulador, custo e a linha do tempo (D-153).
    shortcuts.push({ label: "Dashboard do SKU", href: `/skus/${input.skuId}` });
  }

  if (input.kind === "venda_anomala" && input.sku !== null) {
    const busca = encodeURIComponent(input.sku);

    shortcuts.push(
      { label: "Anúncios do SKU", href: `/anuncios?busca=${busca}` },
      { label: "Reposição", href: `/reposicao?busca=${busca}` },
    );
  }

  if (input.kind === "reclamacoes_recorrentes") {
    shortcuts.push({ label: "Caixa de Entrada", href: "/atendimento" });
  }

  return shortcuts;
}
