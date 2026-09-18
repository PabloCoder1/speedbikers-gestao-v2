/**
 * Ajuste manual de estoque — o vocabulário da tela, separado da tela.
 *
 * A pessoa escolhe a OPERAÇÃO (entrada, saída ou balanço) e digita uma
 * quantidade sempre positiva; o sinal do `qty_delta` é derivado aqui. Antes a
 * tela pedia o número negativo para saída, e esse é o erro que um estoquista
 * comete: digitar "5" querendo tirar 5.
 *
 * O motivo deixou de ser texto obrigatório: vira uma CATEGORIA escolhida num
 * clique (já vem uma marcada) mais uma observação opcional. A coluna
 * `stock_movements.reason` continua preenchida em todo AJUSTE_MANUAL — a
 * constraint `stock_movements_manual_has_reason` segue valendo sem migration —
 * e quem ajustou já é gravado pela RPC em `created_by` (`auth.uid()`).
 */

export const ADJUSTMENT_MODES = ["ENTRADA", "SAIDA", "BALANCO"] as const;

export type AdjustmentMode = (typeof ADJUSTMENT_MODES)[number];

export const ADJUSTMENT_LOCATIONS = ["LOCAL", "RESERVADO", "TRANSITO"] as const;

export type AdjustmentLocation = (typeof ADJUSTMENT_LOCATIONS)[number];

/** Categorias de motivo por operação — a primeira de cada lista já vem marcada. */
export const ADJUSTMENT_REASONS: Readonly<Record<AdjustmentMode, readonly string[]>> = {
  ENTRADA: ["Correção de saldo", "Devolução de cliente", "Compra sem nota", "Encontrado na contagem", "Troca de fornecedor"],
  SAIDA: ["Correção de saldo", "Avaria", "Perda ou extravio", "Uso interno", "Brinde ou amostra"],
  BALANCO: ["Inventário periódico", "Contagem cíclica", "Conferência de divergência"],
};

export const REFERENCE_MAX = 60;
export const NOTE_MAX = 300;

export function isAdjustmentMode(value: unknown): value is AdjustmentMode {
  return typeof value === "string" && (ADJUSTMENT_MODES as readonly string[]).includes(value);
}

export function isAdjustmentLocation(value: unknown): value is AdjustmentLocation {
  return typeof value === "string" && (ADJUSTMENT_LOCATIONS as readonly string[]).includes(value);
}

/**
 * O delta que vai para o ledger. Entrada e saída recebem a quantidade movida;
 * balanço recebe o saldo CONTADO e devolve a diferença contra o saldo atual.
 * `null` quando não há o que gravar (quantidade inválida ou diferença zero).
 */
export function adjustmentDelta(mode: AdjustmentMode, quantity: number, currentBalance: number): number | null {
  if (!Number.isFinite(quantity) || quantity < 0) return null;

  const delta = mode === "ENTRADA" ? quantity : mode === "SAIDA" ? -quantity : quantity - currentBalance;

  return delta === 0 ? null : delta;
}

const MODE_PREFIX: Readonly<Record<AdjustmentMode, string>> = {
  ENTRADA: "Entrada",
  SAIDA: "Saída",
  BALANCO: "Balanço",
};

/**
 * O texto gravado em `reason`: "Saída · Avaria · Ref. PED-123 · caixa amassada".
 * O prefixo da operação importa no balanço — sem ele, um "+3" no extrato não
 * diz que foi uma contagem.
 */
export function composeAdjustmentReason(
  mode: AdjustmentMode,
  category: string,
  reference: string,
  note: string,
): string {
  const parts = [MODE_PREFIX[mode], category.trim()];
  const ref = reference.trim().slice(0, REFERENCE_MAX);
  const obs = note.trim().replace(/\s+/g, " ").slice(0, NOTE_MAX);

  if (ref !== "") parts.push(`Ref. ${ref}`);
  if (obs !== "") parts.push(obs);

  return parts.filter((part) => part !== "").join(" · ");
}
