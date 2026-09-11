/**
 * Os anúncios de um SKU, como a tela precisa deles (D-316).
 *
 * A leitura vem de `get_sku_listings`, que aplica a definição canônica de
 * "vinculado" (D-122): união do cache `listings.sku_id` com as linhas de
 * `sku_listing_links`. Este módulo é a parte que NÃO é SQL — a forma da linha,
 * o que cada forma de vínculo permite fazer, e as frases que a tela diz quando
 * não pode fazer nada.
 *
 * **Por que a forma do vínculo importa na tela.** `remove_sku_listing_link`
 * age sobre UM `link_id`. Uma linha que só existe pela projeção do sync não
 * tem `link_id` nenhum — oferecer "Remover" ali seria um botão que a RPC
 * recusa. E um anúncio vinculado por VARIAÇÃO pode ter vários vínculos (um por
 * variação): remover "o vínculo" não é uma ação só.
 */
export interface VinculoDoAnuncio {
  readonly id: string;
  /** `null` quando o vínculo é do anúncio inteiro. */
  readonly variation_id: string | null;
  readonly source: string;
  readonly confirmed_at: string | null;
}

/**
 * A linha CRUA da RPC. `links` chega como `jsonb`, e o gerador de tipos o
 * chama de `Json` — um `as` direto para a forma final seria a mentira que o
 * compilador acusa. `lerVinculos` é a fronteira: valida o que usa e descarta o
 * resto, em vez de confiar.
 */
export interface LinhaDeAnuncio {
  readonly listing_id: string | null;
  readonly ml_account_id: string;
  readonly account_label: string | null;
  readonly item_id: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly price: number | null;
  readonly available_quantity: number | null;
  readonly synced_at: string | null;
  readonly vinculo_forma: string;
  readonly apenas_cache: boolean;
  readonly links: unknown;
}

export function lerVinculos(cru: unknown): VinculoDoAnuncio[] {
  if (!Array.isArray(cru)) return [];

  const vinculos: VinculoDoAnuncio[] = [];

  for (const item of cru) {
    if (typeof item !== "object" || item === null) continue;

    const linha = item as Record<string, unknown>;

    if (typeof linha.id !== "string") continue;

    vinculos.push({
      id: linha.id,
      variation_id: typeof linha.variation_id === "string" ? linha.variation_id : null,
      source: typeof linha.source === "string" ? linha.source : "MANUAL",
      confirmed_at: typeof linha.confirmed_at === "string" ? linha.confirmed_at : null,
    });
  }

  return vinculos;
}

/** A linha da RPC com `links` já lido — o que a tela usa. */
export function lerAnuncio(linha: LinhaDeAnuncio): AnuncioDoSku {
  return { ...linha, links: lerVinculos(linha.links) };
}

export interface AnuncioDoSku {
  /** `null` quando o anúncio tem vínculo e ainda não foi sincronizado. */
  readonly listing_id: string | null;
  readonly ml_account_id: string;
  readonly account_label: string | null;
  readonly item_id: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly price: number | null;
  readonly available_quantity: number | null;
  readonly synced_at: string | null;
  readonly vinculo_forma: string;
  readonly apenas_cache: boolean;
  readonly links: readonly VinculoDoAnuncio[];
}

/** O que a tela pode oferecer naquela linha, e a frase quando não pode. */
export interface AcaoDeVinculo {
  /** `null` = não há vínculo removível nesta linha. */
  readonly linkId: string | null;
  /** Mais de um vínculo (variações): a escolha é de quem opera, não da tela. */
  readonly variosVinculos: boolean;
  readonly rotuloForma: string;
  /** Por que não dá para remover, quando não dá. */
  readonly motivoSemAcao: string | null;
}

const ROTULO_FORMA: Record<string, string> = {
  item_inteiro: "anúncio inteiro",
  variacao: "por variação",
  cache_sem_linha: "herdado da sincronização",
};

/*
  A FRASE QUE EVITA UM BOTÃO MENTIROSO. `listings.sku_id` é cache que o sync
  reescreve a partir de `sku_listing_links`; uma linha sem vínculo pode ser um
  vínculo removido que o sync (de 6 em 6 h) ainda não apagou, ou o
  remapeamento de uma republicação, que copia o `sku_id` do anúncio pai. A
  tela diz o FATO — não há linha de vínculo — e não chuta a causa.
*/
const SEM_LINHA =
  "este anúncio aponta para o SKU pela última sincronização, e não há linha de vínculo para remover";

export function acaoDeVinculo(anuncio: AnuncioDoSku): AcaoDeVinculo {
  const rotuloForma = ROTULO_FORMA[anuncio.vinculo_forma] ?? anuncio.vinculo_forma;

  if (anuncio.links.length === 0) {
    return { linkId: null, variosVinculos: false, rotuloForma, motivoSemAcao: SEM_LINHA };
  }

  /*
    Com mais de um vínculo a remoção deixa de ser uma ação só — cada variação
    tem a sua linha. A tela oferece a remoção do vínculo do ANÚNCIO INTEIRO
    quando ele existe, e manda o resto para a tela dona (Vinculações), em vez
    de escolher por quem opera.
  */
  const inteiro = anuncio.links.find((link) => link.variation_id === null) ?? null;

  if (anuncio.links.length > 1 && inteiro === null) {
    return {
      linkId: null,
      variosVinculos: true,
      rotuloForma,
      motivoSemAcao: `${String(anuncio.links.length)} vínculos por variação — a remoção de uma variação específica é feita em Vinculações`,
    };
  }

  const alvo = inteiro ?? anuncio.links[0];

  return {
    linkId: alvo?.id ?? null,
    variosVinculos: anuncio.links.length > 1,
    rotuloForma,
    motivoSemAcao: null,
  };
}

/**
 * O motivo que `remove_sku_listing_link` exige — a constraint recusa vazio, e
 * o texto fica no histórico (`sku_listing_link_events.reason`).
 *
 * Quem remove pela tela do SKU não digita motivo: o contexto É o motivo, e
 * pedir uma frase a cada clique produziria "asdf" no registro de auditoria. O
 * que fica gravado diz de onde veio e sobre qual SKU.
 */
export function motivoDaRemocao(skuCode: string): string {
  return `Removido no Dashboard do SKU ${skuCode}`;
}

/**
 * A contagem que o painel mostra, com a régua junto.
 *
 * O número subiu quando a tela passou a usar a definição canônica (D-316), e
 * subir sem explicação se lê como defeito. A frase é a mesma régua que
 * `/produtos` usa na coluna "Anúncios" desde D-245.
 */
export function resumoDeAnuncios(total: number): string {
  const substantivo = total === 1 ? "anúncio" : "anúncios";

  return `${String(total)} ${substantivo} deste SKU — vínculo direto ou por variação, uma vez por conta e anúncio`;
}
