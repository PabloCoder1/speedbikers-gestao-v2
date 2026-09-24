import { z } from "zod";

/**
 * Quem paga o frete de um envio (D-407), da resposta de
 * `GET /shipments/{id}/costs` que a captura de custos já lê (D-165).
 *
 * A forma foi conferida em 12 envios reais (24/09): `gross_amount` é o frete
 * cheio; `receiver` é o comprador (`cost` e `discounts[]`); `senders[]` é o
 * vendedor (`cost`, já gravado, e `discounts[]`). O frete cheio fecha com
 * comprador + desconto do comprador + vendedor + desconto do vendedor, pelo
 * `promoted_amount` de cada desconto -- o `save` veio menor em 2 das 12.
 *
 * Cada campo é lido à parte: uma parte fora da forma vira `null` (não
 * observado) sem apagar as outras e, principalmente, sem reprovar a resposta
 * inteira -- o frete do vendedor, que a margem usa, não pode depender disto.
 */
export interface DetalheDoFrete {
  readonly shipping_list_cost: number | null;
  readonly seller_shipping_subsidy: number | null;
  readonly buyer_shipping_cost: number | null;
  readonly buyer_shipping_subsidy: number | null;
}

export const DETALHE_NAO_OBSERVADO: DetalheDoFrete = {
  shipping_list_cost: null,
  seller_shipping_subsidy: null,
  buyer_shipping_cost: null,
  buyer_shipping_subsidy: null,
};

const valor = z.number().nonnegative();
const descontos = z.array(z.object({ promoted_amount: valor }));
const comprador = z.object({ cost: z.unknown(), discounts: z.unknown() });

/** Soma em centavos: 10,1 + 20 não pode virar 30,099999999999998. */
function centavos(total: number): number {
  return Math.round(total * 100) / 100;
}

/** Lista vazia é zero OBSERVADO: o endpoint enumerou os descontos e não havia nenhum. */
function somaDosDescontos(lista: unknown): number | null {
  const lido = descontos.safeParse(lista);

  return lido.success ? centavos(lido.data.reduce((total, d) => total + d.promoted_amount, 0)) : null;
}

function valorOuNulo(v: unknown): number | null {
  const lido = valor.safeParse(v);

  return lido.success ? lido.data : null;
}

export function detalheDoFrete(payload: {
  readonly gross_amount?: unknown;
  readonly receiver?: unknown;
  readonly senders: readonly { readonly cost: number; readonly discounts?: unknown }[];
}): DetalheDoFrete {
  const receiver = comprador.safeParse(payload.receiver);
  const subsidiosDoVendedor = payload.senders.map((s) => somaDosDescontos(s.discounts));
  const legiveis = subsidiosDoVendedor.filter((s): s is number => s !== null);

  return {
    shipping_list_cost: valorOuNulo(payload.gross_amount),
    // Um vendedor sem o desconto legível deixa a soma inteira não observada.
    seller_shipping_subsidy:
      legiveis.length > 0 && legiveis.length === subsidiosDoVendedor.length
        ? centavos(legiveis.reduce((total, s) => total + s, 0))
        : null,
    buyer_shipping_cost: receiver.success ? valorOuNulo(receiver.data.cost) : null,
    buyer_shipping_subsidy: receiver.success ? somaDosDescontos(receiver.data.discounts) : null,
  };
}

/**
 * O frete cheio fecha com as quatro partes? `null` quando falta alguma. Só
 * conta no log: o que o Mercado Livre diz é gravado como veio.
 */
export function detalheFecha(detalhe: DetalheDoFrete, custoDoVendedor: number): boolean | null {
  const { shipping_list_cost, seller_shipping_subsidy, buyer_shipping_cost, buyer_shipping_subsidy } = detalhe;

  if (
    shipping_list_cost === null ||
    seller_shipping_subsidy === null ||
    buyer_shipping_cost === null ||
    buyer_shipping_subsidy === null
  ) {
    return null;
  }

  const partes = buyer_shipping_cost + buyer_shipping_subsidy + custoDoVendedor + seller_shipping_subsidy;

  return Math.abs(shipping_list_cost - partes) < 0.015;
}
