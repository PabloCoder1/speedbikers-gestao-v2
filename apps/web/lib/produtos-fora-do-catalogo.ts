/**
 * D-860 — a prévia dos produtos que ficariam FORA DO CATÁLOGO com a planilha
 * de produtos em conferência (`get_products_batch_absences`).
 *
 * O SQL conta; aqui só se lê o jsonb com cuidado e se decide o padrão da
 * caixa de marcar. Campo ausente ou de tipo errado invalida a prévia inteira:
 * uma contagem inventada aqui viraria uma decisão errada de catálogo lá.
 */

export interface AusenteDaPlanilha {
  readonly skuId: string;
  readonly sku: string;
  readonly title: string | null;
  /** Saldo LOCAL somado; `null` = o SKU não tem linha de saldo (não é zero). */
  readonly saldo: number | null;
  readonly comVinculo: boolean;
  /** Já estava marcado por uma planilha anterior, desde quando. */
  readonly foraDesde: string | null;
}

export interface PreviaForaDoCatalogo {
  /** SKUs que as planilhas de produtos já trouxeram: o denominador. */
  readonly conhecidos: number;
  readonly ausentes: number;
  readonly jaMarcados: number;
  readonly comSaldo: number;
  readonly comVinculo: number;
  /** Marcados antes que voltam nesta planilha. */
  readonly voltam: number;
  readonly amostra: readonly AusenteDaPlanilha[];
}

/**
 * Acima desta fração do catálogo conhecido, a planilha parece exportação
 * PARCIAL (um filtro, uma página): a caixa vem desmarcada e a tela avisa.
 * Decisão do dono em D-860.
 */
export const LIMITE_EXPORTACAO_PARCIAL = 0.1;

function contagem(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function texto(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function lerAusente(raw: unknown): AusenteDaPlanilha | null {
  if (typeof raw !== "object" || raw === null) return null;

  const r = raw as Record<string, unknown>;
  const skuId = texto(r.skuId);
  const sku = texto(r.sku);

  if (skuId === null || sku === null || typeof r.comVinculo !== "boolean") return null;

  const saldo = r.saldo === null || r.saldo === undefined ? null : Number(r.saldo);

  if (saldo !== null && !Number.isFinite(saldo)) return null;

  return {
    skuId,
    sku,
    title: texto(r.title),
    saldo,
    comVinculo: r.comVinculo,
    foraDesde: texto(r.foraDesde),
  };
}

export function lerPreviaForaDoCatalogo(raw: unknown): PreviaForaDoCatalogo | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const r = raw as Record<string, unknown>;
  const conhecidos = contagem(r.conhecidos);
  const ausentes = contagem(r.ausentes);
  const jaMarcados = contagem(r.jaMarcados);
  const comSaldo = contagem(r.comSaldo);
  const comVinculo = contagem(r.comVinculo);
  const voltam = contagem(r.voltam);

  if (
    conhecidos === null ||
    ausentes === null ||
    jaMarcados === null ||
    comSaldo === null ||
    comVinculo === null ||
    voltam === null ||
    !Array.isArray(r.amostra)
  ) {
    return null;
  }

  const amostra: AusenteDaPlanilha[] = [];

  for (const item of r.amostra) {
    const lido = lerAusente(item);

    if (lido === null) return null;

    amostra.push(lido);
  }

  return { conhecidos, ausentes, jaMarcados, comSaldo, comVinculo, voltam, amostra };
}

/** Quantos a marcação mudaria de fato: os já marcados continuam como estão. */
export function novosAusentes(previa: PreviaForaDoCatalogo): number {
  return Math.max(previa.ausentes - previa.jaMarcados, 0);
}

/**
 * A planilha parece parcial quando os que sairiam AGORA passam do limite do
 * catálogo conhecido. Sem catálogo conhecido (primeira planilha) não há o que
 * comparar, e também não há quem marcar.
 */
export function pareceExportacaoParcial(previa: PreviaForaDoCatalogo): boolean {
  if (previa.conhecidos === 0) return false;

  return novosAusentes(previa) / previa.conhecidos > LIMITE_EXPORTACAO_PARCIAL;
}

/** O padrão da caixa: marcada quando há quem marcar e a planilha não parece parcial. */
export function sugereMarcar(previa: PreviaForaDoCatalogo): boolean {
  return novosAusentes(previa) > 0 && !pareceExportacaoParcial(previa);
}
