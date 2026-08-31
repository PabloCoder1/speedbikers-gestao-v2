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
    // O hub. Desde D-169 a tela abre na Visão geral (estoque em cada estado,
    // venda da janela e custo); diagnóstico, simulador, custo detalhado e
    // linha do tempo passaram a viver em abas — e a aba tem URL própria,
    // então o atalho abaixo pode apontar direto para ela em vez de mandar
    // procurar.
    shortcuts.push({ label: "Dashboard do SKU", href: `/skus/${input.skuId}` });
  }

  if (input.kind === "venda_anomala" && input.skuId !== null) {
    // "Por que a venda mudou?" é a pergunta do diagnóstico — e desde D-169
    // ela é endereçável. Continua valendo a regra do módulo: a aba EXISTE, e
    // `diagnostico` é um dos valores que a tela aceita. Depende de `skuId`,
    // não de `sku`: sem id não há rota, e link morto é justamente o que este
    // módulo existe para impedir.
    shortcuts.push({ label: "Diagnóstico do SKU", href: `/skus/${input.skuId}?aba=diagnostico` });
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
