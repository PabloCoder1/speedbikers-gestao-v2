/**
 * O cancelamento e o "hoje" no "Todos" e na Shopee de `/vendas` (D-620), sobre
 * o contrato C-70 do A1 (D-603): `get_marketplace_sales_cancellations` e
 * `get_marketplace_sales_today`, com as linhas e as regras do C-53 (TOTAL,
 * MARKETPLACE e CONTA; a loja de teste só em CONTA; a loja nunca lida NULA).
 *
 * Aqui mora só a forma: escolher a linha e dizer o número, a ausência ou a
 * falha. **Nada aqui soma** — a taxa e o total do dia chegam prontos do SQL.
 */

import type { KpiCellData } from "../components/kpi-strip";
import type { CodigoMarketplace, EscopoMulticanal } from "./vendas-multicanal";
import { formatPercent } from "./format";
import { sanitizeErrorText } from "./sanitize";

type Nivel = "TOTAL" | "MARKETPLACE" | "CONTA";

/** Uma linha de `get_marketplace_sales_cancellations`. */
export interface LinhaDeCancelamento {
  readonly nivel: Nivel;
  readonly marketplace: CodigoMarketplace | null;
  readonly account_id: string | null;
  readonly account_name: string | null;
  readonly environment: string | null;
  readonly compras_validas: number | null;
  readonly compras_canceladas: number | null;
  /** Fração (0,0832 = 8,3%); NULA sem compra no período ou na loja nunca lida. */
  readonly taxa_cancelamento: number | null;
}

/** Uma linha de `get_marketplace_sales_today`. */
export interface LinhaDeHoje {
  readonly nivel: Nivel;
  readonly marketplace: CodigoMarketplace | null;
  readonly account_id: string | null;
  readonly account_name: string | null;
  readonly environment: string | null;
  readonly compras: number | null;
  readonly unidades: number | null;
  readonly receita_bruta: number | null;
  readonly pedidos_sem_receita: number | null;
  readonly ticket_medio: number | null;
  /** A venda mais recente do recorte, de qualquer canal; NULA sem venda no dia. */
  readonly ultimo_pedido_em: string | null;
  /** Só da Shopee: a loja menos lida do recorte. NULO quando alguma nunca foi lida, e no ML (ao vivo). */
  readonly lido_ate: string | null;
}

/** A resposta de uma RPC como a página a recebe: o `code` separa a função ausente (PGRST202) da falha. */
export interface Leitura<T> {
  readonly data: readonly T[] | null;
  readonly error: { readonly message: string; readonly code?: string } | null;
}

/** A função que ainda não chegou a este banco: a migration `20261020150000` do C-70. */
export function funcaoAusente(error: { readonly code?: string } | null): boolean {
  return error?.code === "PGRST202";
}

/** O motivo da falha, limpo, para dizer ao lado do número. */
function motivo(error: { readonly message: string }): string {
  return sanitizeErrorText(error.message) ?? "sem resposta";
}

/** A identidade da célula: a mesma no esqueleto, na pronta e na que não pôde ser lida. */
export const CANCELAMENTO_MULTICANAL = {
  metricId: "multicanal_taxa_cancelamento",
  label: "Taxa de cancelamento",
  formula:
    "compras canceladas ÷ (válidas + canceladas), por compra: o pack do Mercado Livre (cancelado só se todos os pedidos foram) e o pedido da Shopee",
} as const;

/**
 * Por que a taxa daqui pode não ser a do recorte do ML: lá a conta é por pedido
 * (`docs/METRICS.md` 5T). Texto fixo: o esqueleto da célula o mostra também, e a
 * faixa não muda de altura quando o número chega.
 */
export const POR_COMPRA = "Por compra: no Mercado Livre pode diferir da taxa por pedido do recorte Mercado Livre.";

/**
 * O lugar da taxa de cada marketplace no esqueleto da célula (D-620): a mesma
 * forma do trecho que a célula pronta ganha no "Todos" com os dois. Medido
 * pelo A3: sem a reserva, a célula crescia de 15 a 30 px ao chegar.
 */
export const RESERVA_POR_MARKETPLACE = " Mercado Livre 00,0% · Shopee 00,0%.";

/** A frase de quando nada do recorte soma — a mesma das outras células da faixa. */
export const NADA_SOMAVEL = "nenhuma conta com venda somável neste recorte";

const ROTULO_CURTO: Readonly<Record<CodigoMarketplace, string>> = { ML: "Mercado Livre", SHOPEE: "Shopee" };

/** A linha TOTAL e as de cada marketplace (ML primeiro). Só arrumação. */
export function linhasDoRecorte<T extends { readonly nivel: Nivel; readonly marketplace: CodigoMarketplace | null }>(
  linhas: readonly T[],
): { total: T | null; marketplaces: T[] } {
  return {
    total: linhas.find((linha) => linha.nivel === "TOTAL") ?? null,
    marketplaces: (["ML", "SHOPEE"] as const)
      .map((codigo) => linhas.find((linha) => linha.nivel === "MARKETPLACE" && linha.marketplace === codigo))
      .filter((linha): linha is T => linha !== undefined),
  };
}

/**
 * A 5ª célula da faixa (D-620): a taxa do TOTAL e, no "Todos", a de cada
 * marketplace na ressalva — cada uma já calculada no SQL.
 *
 * - Falha do período ATUAL: a célula diz que não leu, com o motivo; a função
 *   ausente (antes da migration) diz que ainda não chegou. Nunca "0%".
 * - Falha só do ANTERIOR: o número de agora aparece, e a comparação omitida é
 *   dita, não calada (a regra da D-509 na tela do ML).
 * - Sem nada somável, "—" com o porquê, como as outras quatro células.
 */
export function celulaDeCancelamentoMulticanal(
  atual: Leitura<LinhaDeCancelamento>,
  anterior: Leitura<LinhaDeCancelamento>,
  escopo: EscopoMulticanal,
): KpiCellData {
  if (atual.error !== null || atual.data === null) {
    const ressalva =
      atual.error !== null && funcaoAusente(atual.error)
        ? "ainda não disponível neste ambiente: a função do cancelamento por compra não chegou ao banco"
        : `não foi possível ler agora (${atual.error === null ? "sem resposta" : motivo(atual.error)})`;

    return { ...CANCELAMENTO_MULTICANAL, value: "—", previous: null, ressalva };
  }

  const { total, marketplaces } = linhasDoRecorte(atual.data);

  if (total === null) {
    return { ...CANCELAMENTO_MULTICANAL, value: "—", previous: null, ressalva: NADA_SOMAVEL };
  }

  const porMarketplace =
    escopo === "todos" && marketplaces.length > 1
      ? ` ${marketplaces.map((linha) => `${linha.marketplace === null ? "—" : ROTULO_CURTO[linha.marketplace]} ${formatPercent(linha.taxa_cancelamento)}`).join(" · ")}.`
      : "";
  const semCompra = total.taxa_cancelamento === null ? " Nenhuma compra no período." : "";

  if (anterior.error !== null || anterior.data === null) {
    const porque = anterior.error === null ? "sem resposta" : motivo(anterior.error);

    return {
      ...CANCELAMENTO_MULTICANAL,
      value: formatPercent(total.taxa_cancelamento),
      previous: null,
      ressalva: `${POR_COMPRA}${porMarketplace}${semCompra} A comparação foi omitida, e isso não é zero: o período anterior não pôde ser lido (${porque}).`,
    };
  }

  const totalAnterior = linhasDoRecorte(anterior.data).total;

  return {
    ...CANCELAMENTO_MULTICANAL,
    value: formatPercent(total.taxa_cancelamento),
    previous: totalAnterior === null ? null : formatPercent(totalAnterior.taxa_cancelamento),
    ressalva: `${POR_COMPRA}${porMarketplace}${semCompra}`,
  };
}

/**
 * O "hoje" do recorte (D-620), pronto para a linha da tela: o TOTAL do dia e a
 * linha da Shopee, que diz até quando ela foi lida (o ML é ao vivo).
 */
export type HojeDoRecorte =
  | { readonly estado: "ausente" }
  | { readonly estado: "falha"; readonly motivo: string }
  | { readonly estado: "nada-somavel" }
  | { readonly estado: "pronto"; readonly total: LinhaDeHoje; readonly shopee: LinhaDeHoje | null };

export function hojeDoRecorte(leitura: Leitura<LinhaDeHoje>): HojeDoRecorte {
  if (leitura.error !== null || leitura.data === null) {
    if (leitura.error !== null && funcaoAusente(leitura.error)) return { estado: "ausente" };

    return { estado: "falha", motivo: leitura.error === null ? "sem resposta" : motivo(leitura.error) };
  }

  const { total, marketplaces } = linhasDoRecorte(leitura.data);

  if (total === null) return { estado: "nada-somavel" };

  return { estado: "pronto", total, shopee: marketplaces.find((linha) => linha.marketplace === "SHOPEE") ?? null };
}
