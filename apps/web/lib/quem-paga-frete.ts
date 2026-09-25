import { formatBusinessDate, formatCount, formatCurrency, formatPercent } from "./format";

/**
 * Quem paga o frete (D-412), da resposta de `get_quem_paga_frete`.
 *
 * As somas chegam prontas do SQL, por envio (os pedidos de um pacote dividem
 * o envio). Aqui só se lê, se divide uma parte pelo todo para LER e se escreve
 * a frase -- nada é somado.
 */

export interface LogisticaDoFrete {
  readonly logistica: string;
  readonly envios: number;
  /** O que o vendedor pagou mais o desconto do Mercado Livre nele -- somado no SQL. */
  readonly frete_do_vendedor: number;
  readonly vendedor_pagou: number;
  readonly ml_bancou_vendedor: number;
  readonly comprador_pagou: number;
  readonly ml_bancou_comprador: number;
  readonly frete_gratis_comprador: number;
}

export interface QuemPagaFrete {
  readonly periodo: { readonly de: string; readonly ate: string };
  /** O primeiro dia com o detalhe gravado (D-407); `null` = nenhum ainda. */
  readonly detalhe_desde: string | null;
  readonly envios_com_frete: number;
  readonly envios_com_detalhe: number;
  /** `null` quando nenhum envio do período tem o detalhe -- não é zero. */
  readonly frete_cheio: number | null;
  readonly frete_do_vendedor: number | null;
  readonly vendedor_pagou: number | null;
  readonly ml_bancou_vendedor: number | null;
  readonly comprador_pagou: number | null;
  readonly ml_bancou_comprador: number | null;
  readonly frete_gratis_comprador: number;
  readonly nao_fecham: number;
  readonly por_logistica: readonly LogisticaDoFrete[];
}

class ForaDoContrato extends Error {}

type Registro = Record<string, unknown>;

function registro(valor: unknown): Registro {
  if (typeof valor !== "object" || valor === null || Array.isArray(valor)) throw new ForaDoContrato("objeto");

  return valor as Registro;
}

function numeroOuNulo(r: Registro, chave: string): number | null {
  if (!(chave in r)) throw new ForaDoContrato(chave);

  const v = r[chave];

  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);

  throw new ForaDoContrato(chave);
}

function numero(r: Registro, chave: string): number {
  const n = numeroOuNulo(r, chave);

  if (n === null) throw new ForaDoContrato(chave);

  return n;
}

function texto(r: Registro, chave: string): string {
  const v = r[chave];

  if (typeof v !== "string") throw new ForaDoContrato(chave);

  return v;
}

function lerLogistica(valor: unknown): LogisticaDoFrete {
  const r = registro(valor);

  return {
    logistica: texto(r, "logistica"),
    envios: numero(r, "envios"),
    frete_do_vendedor: numero(r, "frete_do_vendedor"),
    vendedor_pagou: numero(r, "vendedor_pagou"),
    ml_bancou_vendedor: numero(r, "ml_bancou_vendedor"),
    comprador_pagou: numero(r, "comprador_pagou"),
    ml_bancou_comprador: numero(r, "ml_bancou_comprador"),
    frete_gratis_comprador: numero(r, "frete_gratis_comprador"),
  };
}

/** `null` = resposta fora do contrato. */
export function lerQuemPagaFrete(valor: unknown): QuemPagaFrete | null {
  try {
    const r = registro(valor);
    const periodo = registro(r.periodo);
    const desde = r.detalhe_desde;

    if (desde !== null && typeof desde !== "string") throw new ForaDoContrato("detalhe_desde");
    if (!Array.isArray(r.por_logistica)) throw new ForaDoContrato("por_logistica");

    return {
      periodo: { de: texto(periodo, "de"), ate: texto(periodo, "ate") },
      detalhe_desde: desde,
      envios_com_frete: numero(r, "envios_com_frete"),
      envios_com_detalhe: numero(r, "envios_com_detalhe"),
      frete_cheio: numeroOuNulo(r, "frete_cheio"),
      frete_do_vendedor: numeroOuNulo(r, "frete_do_vendedor"),
      vendedor_pagou: numeroOuNulo(r, "vendedor_pagou"),
      ml_bancou_vendedor: numeroOuNulo(r, "ml_bancou_vendedor"),
      comprador_pagou: numeroOuNulo(r, "comprador_pagou"),
      ml_bancou_comprador: numeroOuNulo(r, "ml_bancou_comprador"),
      frete_gratis_comprador: numero(r, "frete_gratis_comprador"),
      nao_fecham: numero(r, "nao_fecham"),
      por_logistica: r.por_logistica.map(lerLogistica),
    };
  } catch (erro) {
    if (erro instanceof ForaDoContrato) return null;

    throw erro;
  }
}

const LOGISTICA: Readonly<Record<string, string>> = {
  fulfillment: "Full",
  cross_docking: "Coleta",
  xd_drop_off: "Ponto de coleta",
  drop_off: "Agência",
  self_service: "Flex",
  desconhecida: "Sem logística registrada",
};

/** O nome da logística como a operação fala; tipo novo aparece cru, nunca some. */
export function rotuloDaLogistica(logistica: string): string {
  return LOGISTICA[logistica] ?? logistica;
}

/** Parte de um todo, para LER; `null` sem o todo -- nunca 0% fingido. */
function fracao(parte: number | null, todo: number | null): number | null {
  if (parte === null || todo === null || todo <= 0) return null;

  return parte / todo;
}

/** Quanto do frete que cabia ao vendedor o Mercado Livre bancou. */
export function mlNoFreteDoVendedor(q: {
  readonly frete_do_vendedor: number | null;
  readonly ml_bancou_vendedor: number | null;
}): number | null {
  return fracao(q.ml_bancou_vendedor, q.frete_do_vendedor);
}

/**
 * As frases do bloco, só com o que os números sustentam: a parte do vendedor e
 * o quanto o Mercado Livre bancou dela, o comprador e o frete grátis, a
 * cobertura do detalhe e os envios cujas partes não fecham com o cheio.
 */
export function frasesDoQuemPaga(q: QuemPagaFrete): string[] {
  const frases: string[] = [];
  const ml = mlNoFreteDoVendedor(q);

  if (ml !== null) {
    frases.push(
      `Do frete que cabia ao vendedor (${formatCurrency(q.frete_do_vendedor)}), o Mercado Livre bancou ${formatPercent(ml)} ` +
        `(${formatCurrency(q.ml_bancou_vendedor)}) e o vendedor pagou ${formatCurrency(q.vendedor_pagou)}.`,
    );
  }

  if (q.comprador_pagou !== null && q.ml_bancou_comprador !== null && q.envios_com_detalhe > 0) {
    frases.push(
      `Os compradores pagaram ${formatCurrency(q.comprador_pagou)}, e o Mercado Livre bancou ` +
        `${formatCurrency(q.ml_bancou_comprador)} do frete deles: ${formatCount(q.frete_gratis_comprador)} dos ` +
        `${formatCount(q.envios_com_detalhe)} envios (${formatPercent(fracao(q.frete_gratis_comprador, q.envios_com_detalhe))}) ` +
        "saíram com frete grátis para o comprador.",
    );
  }

  return frases;
}

/** A ressalva de cobertura: quantos envios do período têm o detalhe, e desde quando ele existe. */
export function coberturaDoQuemPaga(q: QuemPagaFrete): string {
  if (q.detalhe_desde === null) {
    return "Nenhum envio tem ainda o detalhe de quem paga o frete: ele começa a ser gravado na próxima captura de custos.";
  }

  const parte = fracao(q.envios_com_detalhe, q.envios_com_frete);
  const base =
    `Detalhe em ${formatCount(q.envios_com_detalhe)} dos ${formatCount(q.envios_com_frete)} envios do período` +
    `${parte === null ? "" : ` (${formatPercent(parte)})`}: ele é gravado desde ${formatBusinessDate(q.detalhe_desde)}, ` +
    "e os envios anteriores têm só o frete do vendedor.";

  return q.nao_fecham > 0
    ? `${base} Em ${formatCount(q.nao_fecham)} deles as partes não fecham com o frete cheio (descontos do comprador que se sobrepõem): as somas são das partes.`
    : base;
}
