/**
 * AS SEIS TELAS DA CENTRAL E O CONTEXTO QUE VIAJA ENTRE ELAS (UX_SYSTEM §6, bloco 1).
 *
 * A Central não tinha navegação própria. O cabeçalho da `/central` levava os
 * atalhos das subpáginas na mesma fileira dos filtros, e as subpáginas só
 * tinham "Voltar à central". Saindo da `/central`, metas, limites, frete e Ads
 * perdiam o período e a conta escolhidos.
 *
 * Agora as seis telas têm as mesmas abas, e cada aba leva o período e a conta
 * da URL atual. As telas que não usam esses parâmetros os ignoram; eles servem
 * para a volta à `/central` (ou ao ranking) cair no mesmo recorte. Só os quatro
 * parâmetros de contexto viajam: a ordem do ranking e o nível do detector são
 * de cada tela, e ficam nela.
 */

export type TelaDaCentral = "central" | "metas" | "limites" | "frete" | "ads" | "produtos";

/** A ordem das abas é a da tarefa: a visão do período, o que a alimenta (metas, limites) e os diagnósticos. */
const TELAS: readonly { readonly tela: TelaDaCentral; readonly caminho: string; readonly rotulo: string }[] = [
  { tela: "central", caminho: "/central", rotulo: "Central" },
  { tela: "metas", caminho: "/central/metas", rotulo: "Metas e imposto" },
  { tela: "limites", caminho: "/central/limites", rotulo: "Limites" },
  { tela: "frete", caminho: "/central/frete", rotulo: "Detector de frete" },
  { tela: "ads", caminho: "/central/ads", rotulo: "Sinais de Ads" },
  { tela: "produtos", caminho: "/central/produtos", rotulo: "Ranking de produtos" },
];

type Consulta = Readonly<Record<string, string | string[] | undefined>>;

/**
 * Os parâmetros de contexto, só na forma que as telas aceitam. Valor fora da
 * forma não viaja: a aba não devolve à URL o que a tela de origem já recusou.
 */
const FORMA_DO_CONTEXTO: readonly (readonly [string, RegExp])[] = [
  ["p", /^[a-z0-9-]{1,20}$/],
  ["from", /^\d{4}-\d{2}-\d{2}$/],
  ["to", /^\d{4}-\d{2}-\d{2}$/],
  ["account", /^[A-Za-z0-9_-]{1,80}$/],
];

/** `p=7d&account=loja`: o período e a conta da URL atual, na ordem fixa acima. */
export function contextoDaCentral(consulta: Consulta): string {
  const search = new URLSearchParams();

  for (const [nome, forma] of FORMA_DO_CONTEXTO) {
    const valor = consulta[nome];

    if (typeof valor === "string" && forma.test(valor)) search.set(nome, valor);
  }

  return search.toString();
}

export interface AbaDaCentral {
  readonly href: string;
  readonly label: string;
  readonly ativa: boolean;
}

/** As seis abas, cada uma com o contexto da URL atual. */
export function abasDaCentral(atual: TelaDaCentral, consulta: Consulta): readonly AbaDaCentral[] {
  const contexto = contextoDaCentral(consulta);

  return TELAS.map(({ tela, caminho, rotulo }) => ({
    href: contexto === "" ? caminho : `${caminho}?${contexto}`,
    label: rotulo,
    ativa: tela === atual,
  }));
}
