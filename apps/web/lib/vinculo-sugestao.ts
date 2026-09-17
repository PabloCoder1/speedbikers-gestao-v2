/**
 * A sugestão de SKU do popup de vincular (D-374) — leitura de
 * `get_listing_link_suggestions` e a decisão de quando a sugestão é CERTA, sem
 * React e sem banco.
 *
 * A fonte é o `seller_sku` que o vendedor digitou no Mercado Livre, visto nos
 * pedidos do anúncio, cruzado com `skus.sku_key`. No Dev, 505 dos 867 anúncios
 * sem vínculo têm esse casamento exato.
 *
 * **Sugestão só quando é inequívoca** (a mesma regra da vinculação em massa da
 * D-362): se o mesmo anúncio — ou a mesma variação — aparece nos pedidos com
 * SKUs diferentes, a tela mostra as opções e NÃO pré-seleciona nenhuma. Um
 * vínculo errado baixa estoque do produto errado; um clique a mais não custa
 * nada.
 */

export interface VariacaoVista {
  /** Nulo = pedido do anúncio sem variação. */
  readonly variationId: string | null;
  readonly sellerSku: string | null;
  readonly pedidos: number;
  readonly unidades: number;
  readonly ultimoPedidoEm: string | null;
  readonly titulo: string | null;
  /** O SKU do catálogo cujo `sku_key` bate com `seller_sku`. Nulo sem casamento. */
  readonly skuId: string | null;
  readonly sku: string | null;
  readonly skuTitle: string | null;
}

export interface VinculoExistente {
  readonly linkId: string;
  readonly variationId: string | null;
  readonly skuId: string | null;
  readonly sku: string | null;
}

export interface SugestoesDoAnuncio {
  readonly variacoes: readonly VariacaoVista[];
  readonly vinculos: readonly VinculoExistente[];
}

type Obj = Record<string, unknown>;

const ehObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ehNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const textoOuNulo = (v: unknown): v is string | null => v === null || typeof v === "string";

/** `null` = resposta fora do contrato. Campos desconhecidos são ignorados. */
export function lerSugestoesDoAnuncio(dado: unknown): SugestoesDoAnuncio | null {
  if (!ehObj(dado) || !Array.isArray(dado.variacoes) || !Array.isArray(dado.vinculos)) return null;

  const variacoes: VariacaoVista[] = [];

  for (const v of dado.variacoes) {
    if (!ehObj(v) || !ehNum(v.pedidos) || !ehNum(v.unidades)) return null;
    if (![v.variation_id, v.seller_sku, v.ultimo_pedido_em, v.titulo, v.sku_id, v.sku, v.sku_title].every(textoOuNulo)) {
      return null;
    }

    variacoes.push({
      variationId: v.variation_id as string | null,
      sellerSku: v.seller_sku as string | null,
      pedidos: v.pedidos,
      unidades: v.unidades,
      ultimoPedidoEm: v.ultimo_pedido_em as string | null,
      titulo: v.titulo as string | null,
      skuId: v.sku_id as string | null,
      sku: v.sku as string | null,
      skuTitle: v.sku_title as string | null,
    });
  }

  const vinculos: VinculoExistente[] = [];

  for (const l of dado.vinculos) {
    if (!ehObj(l) || typeof l.link_id !== "string") return null;
    if (![l.variation_id, l.sku_id, l.sku].every(textoOuNulo)) return null;

    vinculos.push({
      linkId: l.link_id,
      variationId: l.variation_id as string | null,
      skuId: l.sku_id as string | null,
      sku: l.sku as string | null,
    });
  }

  return { variacoes, vinculos };
}

export interface OpcaoSku {
  readonly skuId: string;
  readonly sku: string;
  readonly title: string | null;
}

/** Um alvo possível de vínculo: o anúncio inteiro ou uma variação. */
export interface AlvoSugerido {
  /** Nulo = anúncio inteiro. */
  readonly variationId: string | null;
  /** SKUs do catálogo vistos para este alvo, do que mais vendeu ao que menos. */
  readonly opcoes: readonly OpcaoSku[];
  /** A sugestão CERTA: exatamente um SKU, e nenhum `seller_sku` sem casamento no mesmo alvo. */
  readonly sugestao: OpcaoSku | null;
  /** `seller_sku` dos pedidos que não existem no catálogo. */
  readonly semCadastro: readonly string[];
  readonly unidades: number;
  /** O alvo já tem vínculo — não é oferecido de novo. */
  readonly vinculado: VinculoExistente | null;
}

export type FormaDoAnuncio = "inteiro" | "variacoes";

export interface PlanoDeVinculo {
  /**
   * A forma que a RPC aceitaria sem "mistura de formas" (D-125): se já existe
   * vínculo por variação, só variação; se já existe do anúncio inteiro, nada;
   * sem vínculo, a forma dos pedidos (variação quando os pedidos têm variação).
   */
  readonly forma: FormaDoAnuncio;
  readonly alvos: readonly AlvoSugerido[];
  /** O anúncio inteiro já está vinculado: não há o que vincular. */
  readonly completo: boolean;
}

/**
 * Transforma o que os pedidos mostram em ALVOS de vínculo, com a sugestão de
 * cada um quando ela é certa.
 */
export function planejarVinculo(sugestoes: SugestoesDoAnuncio): PlanoDeVinculo {
  const inteiroVinculado = sugestoes.vinculos.find((l) => l.variationId === null) ?? null;

  if (inteiroVinculado !== null) {
    return {
      forma: "inteiro",
      alvos: [montarAlvo(null, sugestoes.variacoes, inteiroVinculado)],
      completo: true,
    };
  }

  const temVinculoPorVariacao = sugestoes.vinculos.some((l) => l.variationId !== null);
  const pedidosComVariacao = sugestoes.variacoes.some((v) => v.variationId !== null);
  const forma: FormaDoAnuncio = temVinculoPorVariacao || pedidosComVariacao ? "variacoes" : "inteiro";

  if (forma === "inteiro") {
    return { forma, alvos: [montarAlvo(null, sugestoes.variacoes, null)], completo: false };
  }

  const ids = [
    ...new Set([
      ...sugestoes.variacoes.flatMap((v) => (v.variationId === null ? [] : [v.variationId])),
      ...sugestoes.vinculos.flatMap((l) => (l.variationId === null ? [] : [l.variationId])),
    ]),
  ];

  const alvos = ids
    .map((id) =>
      montarAlvo(
        id,
        sugestoes.variacoes.filter((v) => v.variationId === id),
        sugestoes.vinculos.find((l) => l.variationId === id) ?? null,
      ),
    )
    // A variação que mais vende primeiro; as já vinculadas vão para o fim.
    .sort((a, b) => Number(a.vinculado !== null) - Number(b.vinculado !== null) || b.unidades - a.unidades);

  return { forma, alvos, completo: alvos.length > 0 && alvos.every((a) => a.vinculado !== null) };
}

function montarAlvo(
  variationId: string | null,
  vistas: readonly VariacaoVista[],
  vinculado: VinculoExistente | null,
): AlvoSugerido {
  const porSku = new Map<string, { opcao: OpcaoSku; unidades: number }>();
  const semCadastro = new Set<string>();
  let unidades = 0;

  for (const v of vistas) {
    unidades += v.unidades;

    if (v.skuId !== null && v.sku !== null) {
      const atual = porSku.get(v.skuId);

      porSku.set(v.skuId, {
        opcao: { skuId: v.skuId, sku: v.sku, title: v.skuTitle },
        unidades: (atual?.unidades ?? 0) + v.unidades,
      });
    } else if (v.sellerSku !== null) {
      semCadastro.add(v.sellerSku);
    }
  }

  const opcoes = [...porSku.values()].sort((a, b) => b.unidades - a.unidades).map((x) => x.opcao);

  return {
    variationId,
    opcoes,
    // Certa só com UM SKU e nenhum código sem cadastro disputando o mesmo alvo.
    sugestao: opcoes.length === 1 && semCadastro.size === 0 ? (opcoes[0] ?? null) : null,
    semCadastro: [...semCadastro],
    unidades,
    vinculado,
  };
}
