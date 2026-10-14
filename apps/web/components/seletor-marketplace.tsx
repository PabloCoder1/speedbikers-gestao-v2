import type { ReactNode } from "react";

import {
  MARKETPLACE_ROTULO,
  marketplacesVisiveis,
  opcoesDeMarketplace,
  type ContasPorMarketplace,
  type Marketplace,
} from "../lib/marketplace";
import { FilterMenu } from "./filter-menu";

/**
 * O seletor de marketplace do cabeçalho (D-431) — o primeiro menu da barra,
 * porque é o recorte mais largo: decide de que canal são todos os outros.
 *
 * É um `FilterMenu` como os demais (link por opção, estado na URL, sem estado
 * React). Cada tela diz para onde cada opção leva, levando só o que vale do
 * outro lado (`lib/marketplace.ts`). Sem um segundo marketplace com conta ou
 * loja, não desenha nada: a tela de quem só tem Mercado Livre não muda.
 */
export function SeletorDeMarketplace({
  ativo,
  contas,
  destinos,
}: {
  ativo: Marketplace;
  contas: ContasPorMarketplace;
  destinos: Readonly<Record<Marketplace, string>>;
}): ReactNode {
  const opcoes = opcoesDeMarketplace(ativo, marketplacesVisiveis(contas, ativo), destinos);

  if (opcoes === null) return null;

  // Primeiro da barra: abre pelo início, senão o painel some atrás da lateral.
  return <FilterMenu nome="Marketplace" rotulo={MARKETPLACE_ROTULO[ativo]} opcoes={opcoes} alinhamento="inicio" />;
}
