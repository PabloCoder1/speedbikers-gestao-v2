/**
 * As campanhas do Mercado Livre de um anúncio (D-420): a no ar e as que ele
 * pode entrar, lidas de `listings.promotions` — a mesma leitura de
 * `in_promotion` (D-419), a cada sincronização do catálogo.
 *
 * Função pura, separada da página, para a leitura e o texto terem teste.
 */
import { formatBusinessDate, formatCurrency } from "./format";

export interface Campanha {
  type: string;
  status: "started" | "candidate";
  id: string | null;
  name: string | null;
  start_date: string | null;
  finish_date: string | null;
  price: number | null;
  original_price: number | null;
  suggested_price: number | null;
  min_price: number | null;
  max_price: number | null;
  meli_percentage: number | null;
  seller_percentage: number | null;
  fixed_percentage: number | null;
}

/**
 * Os tipos de `GET /seller-promotions/items/{id}` (`docs/MERCADO_LIVRE.md` 2.8),
 * com o nome que o vendedor reconhece. Tipo novo cai no código cru, nunca some.
 */
const TIPOS: Record<string, string> = {
  PRICE_DISCOUNT: "Desconto no preço",
  DEAL: "Campanha do Mercado Livre",
  SELLER_CAMPAIGN: "Campanha do vendedor",
  SELLER_COUPON_CAMPAIGN: "Cupom do vendedor",
  LIGHTNING: "Oferta relâmpago",
  DOD: "Oferta do dia",
  SMART: "Co-participada",
  MARKETPLACE_CAMPAIGN: "Co-participada",
  UNHEALTHY_STOCK: "Liquidação de estoque Full",
  VOLUME: "Desconto por quantidade",
  PRE_NEGOTIATED: "Desconto pré-negociado",
  PRICE_MATCHING: "Preço competitivo",
  BANK: "Campanha com banco",
};

export function rotuloDoTipo(type: string): string {
  return TIPOS[type] ?? type;
}

function numero(valor: unknown): number | null {
  return typeof valor === "number" && Number.isFinite(valor) ? valor : null;
}

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() !== "" ? valor : null;
}

/**
 * Lê a coluna `jsonb` sem confiar nela: entrada sem `type` ou com estado fora
 * de "no ar"/"candidata" fica de fora. `null` = não lido (e não "sem campanha").
 */
export function lerCampanhas(valor: unknown): Campanha[] | null {
  if (!Array.isArray(valor)) return null;

  return valor.flatMap((bruto: unknown): Campanha[] => {
    if (bruto === null || typeof bruto !== "object") return [];

    const e = bruto as Record<string, unknown>;
    const type = texto(e.type);

    if (type === null || (e.status !== "started" && e.status !== "candidate")) return [];

    return [
      {
        type,
        status: e.status,
        id: texto(e.id),
        name: texto(e.name),
        start_date: texto(e.start_date),
        finish_date: texto(e.finish_date),
        price: numero(e.price),
        original_price: numero(e.original_price),
        suggested_price: numero(e.suggested_price),
        min_price: numero(e.min_price),
        max_price: numero(e.max_price),
        meli_percentage: numero(e.meli_percentage),
        seller_percentage: numero(e.seller_percentage),
        fixed_percentage: numero(e.fixed_percentage),
      },
    ];
  });
}

/**
 * O dia de uma data do Mercado Livre. Ela vem no horário de Brasília, com ou
 * sem fuso ("2026-09-25T00:00:00", "2026-09-28T00:00:00-03:00"): o dia é o
 * começo do texto. Passar por `new Date` no servidor (UTC) trocaria o dia.
 */
function dia(valor: string | null): string | null {
  return valor === null ? null : formatBusinessDate(valor.slice(0, 10));
}

export function periodo(c: Campanha): string | null {
  const inicio = dia(c.start_date);
  const fim = dia(c.finish_date);

  if (inicio !== null && fim !== null) return `${inicio} a ${fim}`;
  if (fim !== null) return `até ${fim}`;

  return inicio === null ? null : `desde ${inicio}`;
}

const PERCENTUAL = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });

/**
 * O preço da candidata. Relâmpago e co-participada já propõem um (`price`); as
 * outras o vendedor escolhe, e o Mercado Livre sugere um valor e a faixa aceita.
 */
export function precoDaCampanha(c: Campanha): string | null {
  if (c.status === "started" || c.price !== null) {
    return c.price === null ? null : formatCurrency(c.price);
  }

  if (c.suggested_price === null) return null;

  const faixa =
    c.min_price !== null && c.max_price !== null
      ? ` (de ${formatCurrency(c.min_price)} a ${formatCurrency(c.max_price)})`
      : "";

  return `sugerido ${formatCurrency(c.suggested_price)}${faixa}`;
}

/** Quem paga o desconto: a co-participada divide, o cupom é um percentual fixo. */
export function quemPaga(c: Campanha): string | null {
  if (c.meli_percentage !== null && c.seller_percentage !== null) {
    return `Mercado Livre ${PERCENTUAL.format(c.meli_percentage)}% · você ${PERCENTUAL.format(c.seller_percentage)}%`;
  }

  return c.fixed_percentage === null ? null : `cupom de ${PERCENTUAL.format(c.fixed_percentage)}%`;
}

/** As candidatas, agrupadas na ordem em que chegaram — a no ar vai à parte. */
export function separarCampanhas(campanhas: readonly Campanha[]): { noAr: Campanha[]; candidatas: Campanha[] } {
  return {
    noAr: campanhas.filter((c) => c.status === "started"),
    candidatas: campanhas.filter((c) => c.status === "candidate"),
  };
}
