/**
 * Filtros da Curadoria de produtos (`/produtos`, D-133), puros e testáveis sem
 * React nem banco.
 *
 * **Saiu de dentro de `page.tsx` em D-315**, quando a tela ganhou tamanho de
 * página e ordem: o `buildHref` inline já tinha cinco dimensões e ia para sete,
 * e nenhuma delas tinha teste. É o mesmo caminho que `/vinculacoes` e as outras
 * seis telas fizeram em D-141 — a mecânica compartilhada (href, página, janela,
 * tamanho) vive em `./filters`; aqui fica só o vocabulário desta tela.
 *
 * A regra que não muda: **todo o recorte vive na URL**, nunca em estado React.
 * É assim que os Filtros Salvos continuam funcionando e que o link de ida de
 * `/reposicao` chega com o recorte certo.
 */

import { buildFilterHref, resolvePageParam, resolvePageSize, type PageSize } from "./filters";

/**
 * 50, e não os 100 de antes (D-315). O pedido foi explícito — "diminua a
 * quantidade de produtos por tela, para ver se isso deixa mais rápido o site" —
 * e quem precisa de mais escolhe no menu, que é justamente o ponto.
 */
export const DEFAULT_PAGE_SIZE: PageSize = 50;

/** `p_classified` da RPC. `todos` é a ausência do filtro; `pendente` é o padrão. */
export const ESTADOS = { pendente: "PENDENTE", virtual: "VIRTUAL", fisico: "FISICO", todos: null } as const;

/** `p_signal` da RPC. `null` é "qualquer sinal". */
export const SINAIS = {
  sentinela: "SENTINELA",
  "sem-sinal": "SEM_SINAL",
  "sem-retrato": "SEM_RETRATO",
  divergente: "DIVERGENTE",
} as const;

/**
 * `p_order` da RPC (D-315).
 *
 * `curadoria` é o padrão e é a ordem que esta tela sempre teve: divergente
 * primeiro, depois quem tem assinatura de sentinela. **Ela não foi substituída
 * pelas datas** — é ela que faz a fila de trabalho ser uma fila; as datas são o
 * que o UpSeller oferece, e servem para achar "o que mexi agora".
 */
export const ORDENS = {
  curadoria: "curadoria",
  atualizado: "atualizado",
  criado: "criado",
} as const;

export type EstadoChave = keyof typeof ESTADOS;
export type SinalChave = keyof typeof SINAIS;
export type OrdemChave = keyof typeof ORDENS;

export interface CurationFilters {
  estado: EstadoChave;
  sinal: SinalChave | null;
  marca: string | null;
  busca: string;
  ordem: OrdemChave;
  tamanho: PageSize;
  page: number;
}

/** A marca ausente é um RECORTE, não um valor de marca — por isso o sentinela. */
export const SEM_MARCA = "__sem__";

function primeiro(bruto: string | string[] | undefined): string | undefined {
  return Array.isArray(bruto) ? bruto[0] : bruto;
}

/** Resolve contra lista fechada e cai no default EM SILÊNCIO — URL é entrada de terceiro. */
export function resolveEstado(bruto: unknown): EstadoChave {
  return typeof bruto === "string" && bruto in ESTADOS ? (bruto as EstadoChave) : "pendente";
}

export function resolveSinal(bruto: unknown): SinalChave | null {
  return typeof bruto === "string" && bruto in SINAIS ? (bruto as SinalChave) : null;
}

export function resolveOrdem(bruto: unknown): OrdemChave {
  return typeof bruto === "string" && bruto in ORDENS ? (bruto as OrdemChave) : "curadoria";
}

export function resolveCurationFilters(
  query: Record<string, string | string[] | undefined>,
): CurationFilters {
  return {
    estado: resolveEstado(primeiro(query.estado)),
    sinal: resolveSinal(primeiro(query.sinal)),
    marca: primeiro(query.marca) ?? null,
    busca: primeiro(query.busca) ?? "",
    ordem: resolveOrdem(primeiro(query.ordem)),
    tamanho: resolvePageSize(primeiro(query.tamanho), DEFAULT_PAGE_SIZE),
    /*
      `pagina` é o nome que todas as outras telas usam, e o que `buildFilterHref`
      escreve — esta era a única com `page`, e o teste pegou o desencontro no
      primeiro run (o href passou a dizer `pagina` e a leitura ainda esperava
      `page`, o que travaria a lista na primeira página).

      O `page` continua sendo LIDO: links salvos e abas abertas de ontem
      apontam para ele, e quebrá-los seria cobrar do usuário uma renomeação
      interna. Só não é mais ESCRITO.
    */
    page: resolvePageParam(primeiro(query.pagina) ?? primeiro(query.page)),
  };
}

/** Preserva as outras dimensões e omite o que é default. */
export function buildCurationHref(
  atual: CurationFilters,
  override: Partial<CurationFilters>,
): string {
  const proximo = { ...atual, ...override };

  return buildFilterHref(
    "/produtos",
    {
      // Os defaults ficam FORA da URL: `/produtos` limpo continua sendo a mesma
      // página de sempre, e o link salvo de ontem continua significando o
      // mesmo recorte.
      estado: proximo.estado === "pendente" ? null : proximo.estado,
      sinal: proximo.sinal,
      marca: proximo.marca,
      busca: proximo.busca,
      ordem: proximo.ordem === "curadoria" ? null : proximo.ordem,
      tamanho: proximo.tamanho === DEFAULT_PAGE_SIZE ? null : String(proximo.tamanho),
    },
    // `page` é a única dimensão que NÃO volta para 1 sozinha: quem pagina passa
    // a página de propósito; quem troca qualquer outra coisa muda o CONJUNTO, e
    // manter o offset mostraria uma página vazia.
    override.page === undefined ? 1 : proximo.page,
  );
}

/**
 * Argumentos de recorte da RPC — o único lugar que conhece os dois
 * vocabulários (o da URL, que é do usuário, e o do banco).
 *
 * `p_missing_brand` e `p_brand` saem da MESMA dimensão da URL: "sem marca" é
 * recorte, não marca.
 */
export function toCurationRpcArgs(filters: CurationFilters): {
  p_limit: number;
  p_offset: number;
  p_order: string;
  p_missing_brand: boolean;
  p_classified?: string;
  p_signal?: string;
  p_brand?: string;
  p_search?: string;
} {
  const semMarca = filters.marca === SEM_MARCA;
  const classificado = ESTADOS[filters.estado];

  return {
    p_limit: filters.tamanho,
    p_offset: (filters.page - 1) * filters.tamanho,
    p_order: ORDENS[filters.ordem],
    p_missing_brand: semMarca,
    // `exactOptionalPropertyTypes`: omitir a chave é diferente de mandar
    // `undefined`, e a RPC trata ausência como "sem filtro".
    ...(classificado === null ? {} : { p_classified: classificado }),
    ...(filters.sinal === null ? {} : { p_signal: SINAIS[filters.sinal] }),
    ...(filters.marca === null || semMarca ? {} : { p_brand: filters.marca }),
    ...(filters.busca === "" ? {} : { p_search: filters.busca }),
  };
}
