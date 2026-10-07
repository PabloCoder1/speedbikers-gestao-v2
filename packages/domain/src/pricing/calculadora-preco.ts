/**
 * Calculadora de preço (D-359) — quanto sobra de UMA venda, antes de anunciar.
 *
 * A conta é a mesma de `/faturamento` (`docs/METRICS.md` 5F), agora para um
 * preço que ainda não vendeu: recebido = preço − comissão − frete; resultado =
 * recebido − custo; margem = resultado ÷ preço. Pura, sem rede: o frete do
 * Mercado Livre chega pronto (cotação oficial), e esta função só compõe.
 *
 * As tarifas são as que o dono informou em 16/09/2026, e ficam aqui como
 * constantes nomeadas para a troca ser uma linha e um teste — não um número
 * espalhado pela tela:
 *
 * - **Mercado Livre:** 12% no Clássico, 17% no Premium.
 * - **Frete no Mercado Livre (D-421, revisa D-359):** a partir de R$ 79 o frete
 *   grátis é obrigatório e o vendedor paga a cotação com desconto. ABAIXO de
 *   R$ 79 o vendedor escolhe: oferecendo frete grátis, paga o frete inteiro; sem
 *   oferecer, paga só o "custo de envio por unidade" do Mercado Livre (de R$ 19
 *   a R$ 78,99 é o próprio Mercado Livre que dá o frete grátis ao comprador).
 *   Os dois valores vêm da MESMA cotação oficial, com `free_shipping` ligado ou
 *   desligado -- medido em 07/10/2026 numa conta real: Coleta, R$ 50, 500 g,
 *   R$ 13,85 com e R$ 8,25 sem, e R$ 8,25 é a mediana do que os pedidos de
 *   R$ 19 a R$ 78,99 pagaram nos 30 dias anteriores. A "tarifa fixa" por venda
 *   (`listing_prices`, desde 02/03/2026) só existe abaixo de R$ 79 e, no
 *   Mercado Envios, só no Flex.
 * - **Shopee:** percentual + valor fixo por faixa de preço (tabela abaixo). O
 *   valor fixo é o frete da Shopee. O "subsídio Pix" da tabela da Shopee não
 *   entra: decisão do dono.
 */

export type Plataforma = "mercado_livre" | "shopee";

export type TipoAnuncioMl = "classico" | "premium";

export const COMISSAO_ML: Readonly<Record<TipoAnuncioMl, number>> = { classico: 0.12, premium: 0.17 };

/** O `listing_type_id` do Mercado Livre de cada tipo — é o que a cotação de frete recebe. */
export const LISTING_TYPE_ML: Readonly<Record<TipoAnuncioMl, "gold_special" | "gold_pro">> = {
  classico: "gold_special",
  premium: "gold_pro",
};

/**
 * A partir deste preço o frete grátis é OBRIGATÓRIO no Mercado Livre e o
 * vendedor paga o frete (o "TH" de `listing_prices`). Abaixo dele, oferecer é
 * escolha do vendedor.
 */
export const FRETE_GRATIS_OBRIGATORIO_ML = 79;

/** O frete grátis vale nesta venda? A partir de R$ 79 sempre; abaixo, se o vendedor oferece. */
export function freteGratisEfetivo(preco: number, ofereceFreteGratis: boolean): boolean {
  return preco >= FRETE_GRATIS_OBRIGATORIO_ML || ofereceFreteGratis;
}

export interface FaixaShopee {
  /** Preço mínimo da faixa, inclusivo. */
  readonly desde: number;
  readonly percentual: number;
  /** O "+ R$" da tabela: o frete da Shopee. */
  readonly fixo: number;
}

/**
 * A tabela da Shopee, da maior faixa para a menor: a primeira cujo `desde` o
 * preço alcança é a que vale. "Até R$ 79,99" e "acima de R$ 80" deixam um vão
 * de centavo; aqui a fronteira é R$ 80 — R$ 79,995 fica na primeira faixa.
 */
export const FAIXAS_SHOPEE: readonly FaixaShopee[] = [
  { desde: 500, percentual: 0.14, fixo: 26 },
  { desde: 200, percentual: 0.14, fixo: 26 },
  { desde: 100, percentual: 0.14, fixo: 20 },
  { desde: 80, percentual: 0.14, fixo: 16 },
  { desde: 0, percentual: 0.2, fixo: 4 },
];

export function faixaShopee(preco: number): FaixaShopee {
  // A última faixa começa em zero, então sempre há uma.
  return FAIXAS_SHOPEE.find((faixa) => preco >= faixa.desde) ?? { desde: 0, percentual: 0.2, fixo: 4 };
}

export interface EntradaCalculadora {
  readonly plataforma: Plataforma;
  readonly preco: number;
  readonly custo: number;
  /** Só Mercado Livre. */
  readonly tipoAnuncio?: TipoAnuncioMl;
  /**
   * Só Mercado Livre: o custo do frete para o vendedor, da cotação oficial --
   * feita com o frete grátis da venda (`freteGratisEfetivo`). `null` = ainda não
   * cotado: a margem fica indefinida em vez de assumir zero.
   */
  readonly freteMl?: number | null;
  /**
   * Só Mercado Livre: o vendedor oferece frete grátis? Abaixo de R$ 79 é
   * escolha; a partir dele o valor é ignorado (obrigatório). Padrão: não.
   */
  readonly ofereceFreteGratis?: boolean;
  /**
   * Só Mercado Livre: a tarifa fixa por venda (`listing_prices`), que vem com a
   * cotação. `null` = não cotada -- margem indefinida, como o frete.
   */
  readonly tarifaFixaMl?: number | null;
}

export interface LinhaCusto {
  readonly rotulo: string;
  readonly valor: number;
  readonly detalhe: string;
}

export type ResultadoCalculadora =
  | {
      readonly ok: true;
      readonly preco: number;
      readonly comissao: number;
      /** Só Mercado Livre abaixo de R$ 79 no Flex (ou envio próprio); zero no resto. */
      readonly tarifaFixa: number;
      readonly frete: number;
      readonly recebido: number;
      readonly custo: number;
      readonly resultado: number;
      /** Fração: 0,183 = 18,3%. */
      readonly margem: number;
      /** O que sai do preço até "você recebe", na ordem da tela. */
      readonly linhas: readonly LinhaCusto[];
    }
  | { readonly ok: false; readonly motivo: string };

const centavos = (valor: number): number => Math.round(valor * 100) / 100;
const pct = (fracao: number): string => `${String(Math.round(fracao * 1000) / 10).replace(".", ",")}%`;
const reais = (valor: number): string =>
  `R$ ${valor.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function calcularPreco(entrada: EntradaCalculadora): ResultadoCalculadora {
  const { preco, custo } = entrada;

  if (!Number.isFinite(preco) || preco <= 0) return { ok: false, motivo: "informe o preço de venda" };
  if (!Number.isFinite(custo) || custo < 0) return { ok: false, motivo: "informe o custo do produto" };

  let comissao: number;
  let tarifaFixa = 0;
  let frete: number;
  let detalheComissao: string;
  let detalheFrete: string;

  if (entrada.plataforma === "shopee") {
    const faixa = faixaShopee(preco);

    comissao = centavos(preco * faixa.percentual);
    frete = faixa.fixo;
    detalheComissao = `${pct(faixa.percentual)} do preço`;
    detalheFrete = `valor fixo da faixa ${faixa.desde === 0 ? "até R$ 79,99" : `a partir de ${reais(faixa.desde)}`}`;
  } else {
    const tipo = entrada.tipoAnuncio ?? "classico";

    comissao = centavos(preco * COMISSAO_ML[tipo]);
    detalheComissao = `${pct(COMISSAO_ML[tipo])} — anúncio ${tipo === "classico" ? "Clássico" : "Premium"}`;

    // Todo preço tem frete para o vendedor -- até abaixo de R$ 19, onde a
    // regra antiga dizia "frete do comprador" e a venda real cobra o custo de
    // envio por unidade (R$ 5,65 de mediana). Sem cotação, sem margem.
    if (
      entrada.freteMl === undefined ||
      entrada.freteMl === null ||
      entrada.tarifaFixaMl === undefined ||
      entrada.tarifaFixaMl === null
    ) {
      return { ok: false, motivo: "cote o frete pelas medidas para ver a margem" };
    }

    frete = centavos(entrada.freteMl);
    tarifaFixa = centavos(entrada.tarifaFixaMl);
    detalheFrete = preco >= FRETE_GRATIS_OBRIGATORIO_ML
      ? `frete grátis obrigatório a partir de ${reais(FRETE_GRATIS_OBRIGATORIO_ML)} — cotação oficial`
      : entrada.ofereceFreteGratis === true
        ? "frete grátis oferecido por você — cotação oficial"
        : "sem frete grátis por sua conta — custo de envio por unidade do Mercado Livre";
  }

  const recebido = centavos(preco - comissao - tarifaFixa - frete);
  const resultado = centavos(recebido - custo);

  return {
    ok: true,
    preco,
    comissao,
    tarifaFixa,
    frete,
    recebido,
    custo,
    resultado,
    margem: resultado / preco,
    linhas: [
      { rotulo: "Comissão", valor: comissao, detalhe: detalheComissao },
      ...(tarifaFixa > 0
        ? [{ rotulo: "Tarifa fixa", valor: tarifaFixa, detalhe: "por venda, cobrada pelo Mercado Livre abaixo de R$ 79" }]
        : []),
      { rotulo: "Frete", valor: frete, detalhe: detalheFrete },
    ],
  };
}
